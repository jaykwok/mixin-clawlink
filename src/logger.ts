/**
 * 极简日志：控制台 + 按大小轮转的文件（无第三方依赖，保持分发精简）。
 * 同步写入（个人 bot 日志量小，sync 简单且不会交错）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "node:util";

let LOG_PATH = "";
let LOG_MAX = 5 * 1024 * 1024;
let LOG_BACKUP = 3;
let written = 0;
let inited = false;
let suppressConsole = false; // TUI 接管终端时关掉 stderr 直写，避免刷花屏幕
const consoleSinks = new Set<(line: string) => void>(); // 日志订阅者（TUI 日志面板订阅一个）

export function setupLogging(opts?: { dir?: string; file?: string; maxBytes?: number; backupCount?: number }) {
  const dir = opts?.dir ?? "logs";
  const file = opts?.file ?? "clawlink.log";
  LOG_MAX = opts?.maxBytes ?? 5 * 1024 * 1024;
  LOG_BACKUP = opts?.backupCount ?? 3;
  mkdirSync(dir, { recursive: true });
  LOG_PATH = resolve(dir, file);
  try {
    written = statSync(LOG_PATH).size;
  } catch {
    written = 0;
  }
  inited = true;
}

/** TUI 启动渲染前调用：抑制 stderr 直写（终端被 TUI 接管，不能再往 stderr 刷）。 */
export function setSuppressConsole(b: boolean): void {
  suppressConsole = b;
}

/** 订阅每条日志行；返回取消订阅函数（TUI 日志面板用，推到环形缓冲）。 */
export function subscribeConsole(fn: (line: string) => void): () => void {
  consoleSinks.add(fn);
  return () => {
    consoleSinks.delete(fn);
  };
}

function rotate() {
  // clawlink.log → .1 → .2 → … 丢弃 .<backup>
  for (let i = LOG_BACKUP; i >= 1; i--) {
    const from = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`;
    const to = `${LOG_PATH}.${i}`;
    try {
      if (existsSync(from)) renameSync(from, to);
    } catch {
      /* 忽略单次轮转错误 */
    }
  }
  written = 0;
}

function fmtTime(d = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}

function fmtArg(x: unknown): string {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack ?? `${x.name}: ${x.message}`;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/** 首参为格式串时按 printf(%s/%d/…) 替换（对齐 Python logging 语义）；否则原样拼接。 */
function compose(fmt: unknown, args: unknown[]): string {
  if (typeof fmt === "string" && args.length) return format(fmt, ...args);
  if (args.length) return [fmt, ...args].map(fmtArg).join(" ");
  return fmtArg(fmt);
}

function emit(level: string, name: string, msg: string) {
  const line = `${fmtTime()} [${level}] ${name}: ${msg}\n`;
  if (!suppressConsole) process.stderr.write(line); // 日志走 stderr；TUI 模式下抑制
  for (const s of consoleSinks) {
    try { s(line); } catch { /* 订阅者异常不影响日志主流程 */ }
  }
  if (!inited) return;
  if (written + Buffer.byteLength(line) > LOG_MAX) rotate();
  try {
    appendFileSync(LOG_PATH, line, "utf8");
    written += Buffer.byteLength(line);
  } catch {
    /* 写盘失败不应影响主流程 */
  }
}

export interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  debug(...a: unknown[]): void;
}

export function getLogger(name: string): Logger {
  const mk = (level: string) => (fmt: unknown, ...args: unknown[]) => emit(level, name, compose(fmt, args));
  return { info: mk("INFO"), warn: mk("WARN"), error: mk("ERROR"), debug: mk("DEBUG") };
}
