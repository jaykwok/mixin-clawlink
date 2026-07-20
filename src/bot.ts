/**
 * 编排：WS 收消息 → 下载入站附件 → agent 执行 → 回传文本 + agent 声明的文件。
 *
 * 支持斜杠命令（会话管理 / 工作目录 / 配置热改 / 软重启）、危险操作聊天框审批、/stop 中断。
 * TS 单线程：每用户用 Promise 链串行（withLock）；/stop 用 AbortController 中断 query。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { checkCredentials, cfg, EDITABLE, getValue, lookup, setValue, INBOX_DIR } from "./config.ts";
import { expandHome } from "./config.ts";
import { makeAgent } from "./agents/index.ts";
import type { Agent } from "./agents/base.ts";
import { fetchAgentModels, type ModelInfo } from "./agents/models.ts";
import { TokenManager } from "./im/auth.ts";
import { MessagePipe } from "./im/messages.ts";
import type { InboundMessage } from "./im/messages.ts";
import { ConnectionManager } from "./im/transport.ts";
import { getLogger } from "./logger.ts";
import { guessMime, inferMsgType } from "./mime.ts";
import { registry } from "./session/registry.ts";
import { Workspace, uniqueInboxPath } from "./session/workspace.ts";

const log = getLogger("bot");

// 匹配回复里的 [[FILE: 路径]] 标记
const FILE_RE = /\[\[FILE:\s*(.+?)\]\]/g;

const COMMANDS: Record<string, string> = {
  "/new": "新开一个会话（并切到它）",
  "/list": "列出所有会话（带编号 1,2,3…）",
  "/use": "切到指定会话：/use <编号>",
  "/reset": "清空当前会话的对话记录",
  "/del": "删除会话：/del 1 或 /del 1,3",
  "/config": "查看/修改配置：/config 或 /config <编号|名称> <值>",
  "/model": "查看/选择模型：/model 或 /model <编号|名称>，/model default 用默认",
  "/reboot": "软重启（重读 .env、重建 agent/WS）",
  "/stop": "停止当前正在执行的任务",
  "/cwd": "查看/切换工作目录：/cwd 或 /cwd <绝对路径|相对根目录>",
  "/send": "手动发送一个文件：/send <文件路径>",
  "/status": "查看 agent / 工作目录 / 当前会话",
  "/help": "显示本帮助",
};

const YES_PREFIX = ["y", "yes", "是", "好", "可以", "允许", "确认", "同意", "对", "行", "ok"];
const NO_PREFIX = ["n", "no", "不", "否", "拒绝", "取消", "算了", "别"];

export class Bot {
  agent!: Agent;
  rebootRequested = false;
  /** 触发 /reboot 的用户（重启后给 TA 发"完成"提示）。 */
  rebootByUid: string | null = null;
  private notifyStart: string | null = null;
  private readonly tm = new TokenManager();
  private readonly pipe = new MessagePipe(this.tm);
  private readonly ws: ConnectionManager;
  private readonly workspace = new Workspace();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly running = new Map<string, AbortController>(); // uid -> 当前任务的 AbortController
  private readonly pending = new Map<string, (allow: boolean) => void>(); // uid -> 审批 resolver
  private serveResolve: (() => void) | null = null;
  private stopped = false;

  private constructor() {
    checkCredentials();
    this.ws = new ConnectionManager(this.tm, (raw) => this.onRaw(raw));
  }

  static async create(opts?: { notifyStart?: string }): Promise<Bot> {
    const bot = new Bot();
    bot.notifyStart = opts?.notifyStart ?? null;
    bot.agent = await makeAgent();
    return bot;
  }

  async start(): Promise<void> {
    await this.agent.startup?.();
    await this.ws.start();
    log.info("Mixin ClawLink 已启动 (agent=%s)", this.agent.name);
    if (this.notifyStart) {
      const uid = this.notifyStart;
      this.notifyStart = null;
      try {
        await this.pipe.sendText(uid, `✅ 软重启完成（agent=${this.agent.name}，已重读 .env）`);
      } catch (e) {
        log.warn("发送重启完成提示失败: %s", (e as Error).message);
      }
    }
  }

  /** start 后常驻，直到 stop / requestReboot。 */
  async serve(): Promise<void> {
    await this.start();
    await new Promise<void>((resolve) => {
      this.serveResolve = resolve;
    });
  }

  requestReboot(uid?: string): void {
    this.rebootByUid = uid ?? null;
    this.rebootRequested = true;
    this.stopServe();
  }

  private stopServe(): void {
    if (this.serveResolve) {
      const r = this.serveResolve;
      this.serveResolve = null;
      r();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopServe();
    for (const ac of this.running.values()) {
      try {
        ac.abort();
      } catch {
        /* 忽略 */
      }
    }
    this.running.clear();
    await this.ws.stop();
    await this.agent.shutdown?.();
    await this.pipe.aclose();
    log.info("Mixin ClawLink 已停止");
  }

  async onRaw(raw: string): Promise<void> {
    const msg = await this.pipe.parseInbound(raw);
    if (!msg) return;
    const uid = msg.senderId;
    const text = (msg.text ?? "").trim();

    // 危险操作审批答复：有待审批 resolver、且这条不是斜杠命令 → 当 y/n（绕开用户锁）
    const resolve = this.pending.get(uid);
    if (resolve && !text.startsWith("/")) {
      resolve(answerIsYes(text));
      return;
    }

    // 斜杠命令：直接处理，不进 agent、不占用户锁
    if (text.startsWith("/")) {
      await this.handleCommand(msg, text);
      return;
    }
    // 普通消息：异步处理，不阻塞 WS 接收
    void this.dispatch(msg);
  }

  private async handleCommand(msg: InboundMessage, text: string): Promise<void> {
    const uid = msg.senderId;
    const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase();
    const send = (s: string) => this.pipe.sendText(uid, s);

    if (cmd === "/new") {
      this.stopRunning(uid);
      const n = await registry.newSession(uid);
      await send(`🆕 已新开会话（第 ${n} 个，已切到它）。`);
    } else if (cmd === "/list") {
      await send(await this.fmtSessions(uid));
    } else if (cmd === "/use") {
      const num = parseInt1(text);
      if (num && await registry.switchSession(uid, num)) {
        this.stopRunning(uid);
        await send(`↪ 已切到第 ${num} 个会话。`);
      } else {
        await send("⚠️ 没有这个编号的会话，/list 看看。");
      }
    } else if (cmd === "/reset") {
      this.stopRunning(uid);
      await registry.resetSession(uid);
      await send("🧹 已清空当前会话（下次对话开新 claude session）。");
    } else if (cmd === "/del") {
      const nums = parseIntList(text);
      if (!nums.length) {
        await send("⚠️ 用法: /del 1 或 /del 1,3");
      } else {
        this.stopRunning(uid);
        const { deleted, activeDeleted, remaining } = await registry.deleteSessions(uid, nums);
        const extra = activeDeleted ? "（当前会话被删，已切到最近一个）" : "";
        await send(`🗑 已删除 ${deleted} 个会话，剩余 ${remaining} 个。${extra}`);
      }
    } else if (cmd === "/config") {
      await this.handleConfig(uid, text);
    } else if (cmd === "/reboot") {
      log.info("用户 %s 请求软重启", mask(uid));
      await send("🔄 软重启中（重读 .env、重建 agent/WS，几秒后恢复）…");
      this.requestReboot(uid);
    } else if (cmd === "/stop") {
      const stopped = this.stopRunning(uid);
      await send(stopped ? "⏹ 已停止当前任务。" : "（当前没有正在执行的任务）");
    } else if (cmd === "/cwd") {
      const arg = text.slice(text.indexOf(" ") >= 0 ? text.indexOf(" ") + 1 : text.length).trim();
      if (!arg) {
        await send(`当前工作目录: ${this.workspace.currentDir(uid)}\n用法: /cwd <绝对路径 或 相对 MIXIN_WORKSPACE 的路径>`);
      } else {
        try {
          const nw = await this.workspace.setCwd(uid, arg);
          await send(`📁 工作目录已切换: ${nw}`);
        } catch (e) {
          await send(`⚠️ 切换失败: ${(e as Error).message}`);
        }
      }
    } else if (cmd === "/send") {
      const arg = text.slice(text.indexOf(" ") >= 0 ? text.indexOf(" ") + 1 : text.length).trim();
      if (!arg) {
        await send("用法: /send <文件路径，绝对或相对当前工作目录>");
      } else {
        await this.sendPath(uid, this.workspace.currentDir(uid), arg);
      }
    } else if (cmd === "/status") {
      const wd = this.workspace.currentDir(uid);
      const sessions = await registry.listSessions(uid);
      const active = sessions.find(s => s.active)?.num;
      const turns = await registry.countTurns(uid);
      await send(`agent: ${this.agent.name}\n工作目录: ${wd}\n当前会话: ${active ? `第${active}个` : "无"}/${sessions.length}（${turns} 轮）`);
    } else if (cmd === "/model") {
      await this.handleModel(uid, text);
    } else if (cmd === "/help") {
      const lines = ["命令列表:"];
      for (const [c, d] of Object.entries(COMMANDS)) lines.push(`${c} — ${d}`);
      lines.push("\n（其它消息会作为指令发给 agent 执行）");
      await send(lines.join("\n"));
    } else {
      await send(`未知命令: ${cmd}\n发送 /help 查看可用命令。`);
    }
  }

  private async handleConfig(uid: string, text: string): Promise<void> {
    const send = (s: string) => this.pipe.sendText(uid, s);
    const m = /^\s*\/config\s+(.*)$/s.exec(text);
    const rest = m ? m[1].trim() : "";
    if (!rest) {
      await send(fmtConfig());
      return;
    }
    const sp = rest.indexOf(" ");
    const keyOrNum = sp < 0 ? rest : rest.slice(0, sp);
    const value = sp < 0 ? null : rest.slice(sp + 1).trim() || null;
    const entry = lookup(keyOrNum);
    if (!entry) {
      await send(`⚠️ 没有这个配置项: ${keyOrNum}\n/config 看列表`);
      return;
    }
    if (value === null) {
      await send(`${String(entry.key)} = ${getValue(entry.key)}\n${entry.desc} ${entry.restart ? "（需 /reboot 生效）" : "（即时生效）"}`);
      return;
    }
    try {
      const norm = setValue(String(entry.key), value);
      await send(`✅ ${String(entry.key)} = ${norm} ${entry.restart ? "（已写 .env，发 /reboot 生效）" : "（已写 .env，下条消息即生效）"}`);
    } catch (e) {
      await send(`⚠️ ${(e as Error).message}`);
    }
  }

  /** /model：按 agent 类型从对应来源拉模型列表，编号选（仿 /use）；拉不到允许手填。 */
  private async handleModel(uid: string, text: string): Promise<void> {
    const send = (s: string) => this.pipe.sendText(uid, s);
    const arg = text.slice(text.indexOf(" ") >= 0 ? text.indexOf(" ") + 1 : text.length).trim();
    const isAgy = cfg.AGENT.toLowerCase() === "antigravity" || cfg.AGENT.toLowerCase() === "agy";
    const modelKey = isAgy ? "AGY_MODEL" : "CLAUDE_MODEL";
    const cur = isAgy ? cfg.AGY_MODEL : cfg.CLAUDE_MODEL;
    const sourceLabel = isAgy ? "agy models" : "Claude Code 网关";

    if (!arg) {
      try {
        await send(fmtModels(await fetchAgentModels(), cur, sourceLabel));
      } catch (e) {
        await send(`⚠️ 拉不到模型列表: ${(e as Error).message}\n可直接 /model <模型名> 指定，或 /model default 用默认。`);
      }
      return;
    }
    if (arg.toLowerCase() === "default" || arg === "默认") {
      setValue(modelKey, "");
      await send("✅ 已切回默认模型（下条消息生效）。");
      return;
    }
    if (/^\d+$/.test(arg)) {
      const n = parseInt(arg, 10);
      try {
        const models = await fetchAgentModels();
        const m = models[n - 1];
        if (!m) { await send(`⚠️ 没有第 ${n} 个模型，/model 看列表。`); return; }
        setValue(modelKey, m.id);
        await send(`✅ 模型已切到 ${m.id}（下条消息生效）。`);
      } catch (e) {
        await send(`⚠️ 拉不到模型列表: ${(e as Error).message}\n可直接 /model <模型名> 指定。`);
      }
      return;
    }
    // 自由名兜底
    try {
      setValue(modelKey, arg);
      await send(`✅ 模型已切到 ${arg}（下条消息生效）。`);
    } catch (e) {
      await send(`⚠️ ${(e as Error).message}`);
    }
  }

  async askPermission(uid: string, tool: string, summary: string): Promise<boolean> {
    const preview = summary.length > 400 ? summary.slice(0, 400) + "…" : summary;
    await this.pipe.sendText(
      uid,
      `🔐 agent 要执行危险操作 \`${tool}\`：\n\`\`\`\n${preview}\n\`\`\`\n回复 y 允许 / n 拒绝（120 秒不回默认拒绝）`,
    );
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(uid);
        log.info("危险操作审批超时（默认拒绝）: user=%s tool=%s", mask(uid), tool);
        resolve(false);
      }, 120000);
      this.pending.set(uid, (allow: boolean) => {
        clearTimeout(timer);
        this.pending.delete(uid);
        resolve(allow);
      });
    });
  }

  // ── TUI / 运维只读访问器 ──────────────────────────────────────────
  getRunningUsers(): string[] { return [...this.running.keys()]; }
  getPendingApprovals(): string[] { return [...this.pending.keys()]; }
  getWsStatus() { return this.ws.getStatus(); }
  /** 订阅 WS 连接状态变化（TUI 状态栏）。返回取消订阅。 */
  onWsStatus(cb: (s: string, attempt: number) => void): () => void {
    this.ws.onStatus = cb;
    return () => { this.ws.onStatus = undefined; };
  }
  getAuthStatus() { return this.tm.getStatus(); }
  async sendTest(uid: string, text: string): Promise<boolean> { return this.pipe.sendText(uid, text); }

  private stopRunning(uid: string): boolean {
    // 先取消挂起的危险操作审批，否则它会吞掉用户的下一条普通消息
    const pend = this.pending.get(uid);
    if (pend) pend(false); // resolver 内部会清 timer + 删 entry
    const ac = this.running.get(uid);
    if (ac) {
      ac.abort();
      return true;
    }
    return !!pend;
  }

  private withLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(uid) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    this.locks.set(uid, run.then(
      () => {},
      () => {},
    ));
    return run;
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    await this.withLock(msg.senderId, async () => {
      const ac = new AbortController();
      this.running.set(msg.senderId, ac);
      try {
        await this.handle(msg, ac);
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          log.info("用户 %s 的任务被取消（/stop 或会话切换）", msg.senderId);
        } else {
          log.error("处理消息异常: %s", (e as Error).stack ?? String(e));
          await this.pipe.sendTip(msg.senderId, "⚠️ 处理时出错，请稍后再试。");
        }
      } finally {
        this.running.delete(msg.senderId);
      }
    });
  }

  private async handle(msg: InboundMessage, ac: AbortController): Promise<void> {
    const uid = msg.senderId;
    const wd = this.workspace.currentDir(uid);

    // 1) 下载入站附件到全局 inbox/（workspace 根目录下，不随 /cwd 散落；时间戳命名避免覆盖）
    const attachments: string[] = [];
    let attachFailed = false;
    if (msg.fileId) {
      const res = await this.pipe.downloadFile(msg.fileId);
      if (res) {
        // 附件统一存到程序目录下 inbox/（独立于工作目录，不污染 agent 的项目目录）；agent 用绝对路径读取
        const isImage = inferMsgType(guessMime(res.name)) === "image";
        // 图片用纯时间戳命名；文档(xlsx/docx 等)保留原文件名+时间戳，方便用户按名描述
        const p = uniqueInboxPath(INBOX_DIR, res.name, new Date(), !isImage);
        await mkdir(INBOX_DIR, { recursive: true });
        await writeFile(p, res.data);
        attachments.push(p);
        log.info("入站附件已落盘: %s", p);
      } else {
        // 下载失败（多为服务端预签名 URL 签名无效）：提示用户，避免 agent 读旧文件误识别
        attachFailed = true;
        await this.pipe.sendTip(uid, "⚠️ 附件下载失败（服务端预签名 URL 签名无效），请联系运维排查或重发。");
      }
    }

    // 2) 记首条消息作标题 + 取当前槽位 claude sessionId（供 resume）
    const userText = attachFailed
      ? (msg.text ? `${msg.text}\n（注：你发的附件下载失败，无法读取，请基于文字内容回复。）` : "(用户发来了附件，但下载失败，无法读取)")
      : (msg.text || "(用户发来了附件)");
    await registry.noteUser(uid, userText);
    const sessionId = await registry.getActiveSessionId(uid);

    // 3) agent 执行（带 resume + 危险审批 + 中断）
    const result = await this.agent.reply(uid, userText, wd, attachments, {
      sessionId,
      askPermission: (u, t, s) => this.askPermission(u, t, s),
      abortController: ac,
    });
    if (result.sessionId) await registry.finishTurn(uid, result.sessionId);

    // 4) 解析 [[FILE: ...]] → 回传文件；正文去掉标记后发送
    const [cleanText, filePaths] = extractFiles(result.text);
    if (cleanText) await this.pipe.sendText(uid, cleanText);
    for (const fp of filePaths) await this.sendPath(uid, wd, fp);
  }

  private async sendPath(uid: string, cwd: string, rawPath: string): Promise<void> {
    let p = expandHome(rawPath);
    p = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
    let st;
    try {
      st = await stat(p);
    } catch {
      await this.pipe.sendTip(uid, `⚠️ 文件不存在: ${p}`);
      return;
    }
    if (!st.isFile()) {
      await this.pipe.sendTip(uid, `⚠️ 不是文件: ${p}`);
      return;
    }
    if (st.size > cfg.MAX_FILE_MB * 1024 * 1024) {
      await this.pipe.sendTip(uid, `⚠️ ${basename(p)} 太大（${(st.size / 1048576).toFixed(1)}MB），超过 ${cfg.MAX_FILE_MB}MB 上限，无法发送。`);
      return;
    }
    const mime = guessMime(p);
    const data = await readFile(p);
    const ok = await this.pipe.sendFile(uid, data, basename(p), mime);
    if (!ok) await this.pipe.sendTip(uid, `⚠️ 发送失败: ${basename(p)}`);
  }

  private async fmtSessions(uid: string): Promise<string> {
    const sessions = await registry.listSessions(uid);
    if (!sessions.length) return "（暂无会话）";
    const lines = ["会话列表:"];
    for (const s of sessions) lines.push(`  ${s.num}. ${s.title}（${s.turns} 轮）${s.active ? " ← 当前" : ""}`);
    lines.push("\n（/use <编号> 切换，/del <编号> 删除）");
    return lines.join("\n");
  }
}

function extractFiles(text: string): [string, string[]] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(text)) !== null) paths.push(m[1].trim());
  return [text.replace(FILE_RE, "").trim(), paths];
}

function parseInt1(text: string): number | null {
  const parts = text.split(/\s+/);
  return parts.length >= 2 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : null;
}

function parseIntList(text: string): number[] {
  const idx = text.indexOf(" ");
  if (idx < 0) return [];
  const out: number[] = [];
  for (const tok of text.slice(idx + 1).replace(/，/g, ",").replace(/、/g, ",").replace(/\s+/g, ",").split(",")) {
    const t = tok.trim();
    if (/^\d+$/.test(t)) out.push(parseInt(t, 10));
  }
  return out;
}

function answerIsYes(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (NO_PREFIX.some(p => t.startsWith(p))) return false;
  return YES_PREFIX.some(p => t.startsWith(p)); // 含糊不清默认拒绝
}

function fmtConfig(): string {
  const lines = ["当前配置（/config <编号|名称> <值> 修改）:"];
  EDITABLE.forEach((e, i) => {
    let v = String(getValue(e.key)).replace(/\n/g, " ");
    if (v.length > 48) v = v.slice(0, 48) + "…";
    lines.push(`  ${String(i + 1).padStart(2)}. ${String(e.key).padEnd(22)} = ${v}${e.restart ? " [重启]" : ""}`);
  });
  return lines.join("\n");
}

function fmtModels(models: ModelInfo[], current: string | null, sourceLabel: string): string {
  const lines = [`模型列表（来自 ${sourceLabel}）:`];
  models.forEach((m, i) => {
    const mark = m.id === current ? " ← 当前" : "";
    const label = m.name && m.name !== m.id ? `${m.id}（${m.name}）` : m.id;
    lines.push(`  ${i + 1}. ${label}${mark}`);
  });
  lines.push("\n（/model <编号|名称> 选择，/model default 用默认）");
  return lines.join("\n");
}

function mask(s: string): string {
  return s.length > 8 ? s.slice(0, 6) + "***" : "***";
}
