/**
 * WebSocket 事件流连接管理：握手鉴权、心跳与三阶段退避重连。
 *
 * 关键：握手带 Authorization(裸 token) + X-App-ID 两个自定义头。Node 24 原生 WebSocket
 * 不支持自定义头，故用 ws 包。ws 不自动心跳，需自己 ping + pong 超时判假死。
 *
 * 脏断(token 失败 / ws error / 心跳超时)→ 抛错 → run() catch → 退避升级；
 * 干净关闭 → 正常返回 → attempt 重置（立即重连）。
 */
import WebSocket from "ws";
import { cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import type { TokenManager } from "./auth.ts";

const log = getLogger("transport");

export type OnMessage = (raw: string) => Promise<void>;

// 三阶段退避参数
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 10;
const TAIL_BACKOFF_MS = [120000, 240000, 480000];
const PERSISTENT_RETRY_MS = 300000;

function backoffMs(a: number): number {
  if (a >= MAX_RECONNECT_ATTEMPTS) return PERSISTENT_RETRY_MS;
  const tailStart = MAX_RECONNECT_ATTEMPTS - TAIL_BACKOFF_MS.length;
  if (a >= tailStart) return TAIL_BACKOFF_MS[a - tailStart];
  return Math.min(RECONNECT_BASE_MS * 2 ** a, RECONNECT_MAX_MS);
}

export class ConnectionManager {
  private readonly tm: TokenManager;
  private readonly onMessage: OnMessage;
  private ws: WebSocket | null = null;
  private running = false;
  private runPromise: Promise<void> = Promise.resolve();
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  /** 可观测连接状态（TUI 状态栏轮询 / onStatus 订阅）。 */
  status: "connecting" | "connected" | "reconnecting" = "connecting";
  attemptCount = 0;
  onStatus?: (status: "connecting" | "connected" | "reconnecting", attempt: number) => void;

  constructor(tm: TokenManager, onMessage: OnMessage) {
    this.tm = tm;
    this.onMessage = onMessage;
    this.url = `${cfg.WS_BASE}/events/stream`;
  }

  start(): void {
    this.running = true;
    this.runPromise = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sleepTimer) {
      // 打断退避睡眠，让 run() 立刻看到 running=false
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    await this.runPromise.catch(() => {});
  }

  /** 可被 stop() 打断的 sleep。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        resolve();
      }, ms);
    });
  }

  private async run(): Promise<void> {
    this.attemptCount = 0;
    while (this.running) {
      try {
        await this.connectAndReceive();
        this.attemptCount = 0; // 干净关闭 → 重置退避
      } catch (e) {
        log.warn("ws 断开: %s", (e as Error).message ?? e);
      }
      if (!this.running) break;
      const delay = backoffMs(this.attemptCount);
      this.attemptCount++;
      this.setStatus("reconnecting");
      log.warn("ws %ds 后重连 (第 %d 次)", Math.round(delay / 1000), this.attemptCount);
      await this.sleep(delay);
    }
  }

  private setStatus(s: "connecting" | "connected" | "reconnecting"): void {
    this.status = s;
    try { this.onStatus?.(s, this.attemptCount); } catch { /* 回调异常不影响连接 */ }
  }
  getStatus(): { status: "connecting" | "connected" | "reconnecting"; attempt: number } {
    return { status: this.status, attempt: this.attemptCount };
  }

  private async connectAndReceive(): Promise<void> {
    const token = await this.tm.get(); // 失败抛错 → run() catch 升级退避
    const headers: Record<string, string> = { Authorization: token }; // 裸 token，非 Bearer
    if (cfg.APP_ID) headers["X-App-ID"] = cfg.APP_ID;
    this.setStatus("connecting");
    log.info("ws 连接中: %s", this.url);

    const ws = new WebSocket(this.url, { headers, maxPayload: 5 * 1024 * 1024 });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let pongTimer: ReturnType<typeof setTimeout> | null = null;
      let waitingForPong = false;
      let errorSeen: Error | null = null;
      let settled = false;

      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (pongTimer) clearTimeout(pongTimer);
        heartbeat = null;
        pongTimer = null;
        ws.removeAllListeners();
      };
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err); // 脏断 → run() catch 升级退避
        else resolve(); // 干净关闭 → attempt 重置
      };
      // 心跳判定的"非干净"关闭：记 errorSeen 让 close 走 reject 分支
      const forceDead = (reason: string) => {
        errorSeen = new Error(reason);
        ws.terminate();
      };

      ws.on("open", () => {
        this.setStatus("connected");
        log.info("ws 已连接 ✓");
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (waitingForPong) {
            forceDead("连续未收到 pong");
            return;
          }
          waitingForPong = true;
          ws.ping();
          pongTimer = setTimeout(() => {
            if (waitingForPong && ws.readyState === WebSocket.OPEN) {
              forceDead(`心跳超时（${cfg.WS_PING_TIMEOUT_S}s 无 pong）`);
            }
          }, cfg.WS_PING_TIMEOUT_S * 1000);
        }, cfg.WS_PING_INTERVAL_S * 1000);
      });

      ws.on("pong", () => {
        waitingForPong = false;
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
      });

      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
        // 单条消息处理异常不应断开整条连接
        this.onMessage(raw).catch((e) =>
          log.error("处理入站帧出错: %s", e instanceof Error ? e.message : e),
        );
      });

      ws.on("error", (err) => {
        log.warn("ws 错误: %s", err.message);
        errorSeen = err;
      });

      ws.on("close", () => settle(errorSeen));
    });
  }
}
