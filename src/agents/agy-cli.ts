/**
 * agy CLI 路径查找 + 会话 ID 解析 + 版本探测。
 *
 * - resolveAgyCliPath：优先 AGY_CLI_PATH，否则 where/which agy。
 * - agy 会话按 workspace（cwd）隔离，有缓存文件：
 *   ~/.gemini/antigravity-cli/cache/last_conversations.json
 *   格式 { "/abs/workspace": "conversation-uuid" }
 * - latestConversationId(workspace)：优先读缓存文件按 cwd 精确查；
 *   fallback 扫 conversations 目录取最新 .db（不区分 workspace，可能不准）。
 * - detectAgyVersion(cliPath)：spawn `agy --version` 解析版本号，用于行为分支。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function usableFile(path: string | undefined | null): string | null {
  if (!path) return null;
  const full = resolve(expandHome(path.trim().replace(/^"|"$/g, "")));
  return existsSync(full) ? full : null;
}

function findOnPath(): string | null {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const names = process.platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  for (const name of names) {
    const found = spawnSync(command, [name], { encoding: "utf8", windowsHide: true });
    if (found.status !== 0) continue;
    for (const line of found.stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean)) {
      const path = usableFile(line);
      if (path) return path;
    }
  }
  return null;
}

/** 优先使用显式路径，否则 PATH 查找。 */
export function resolveAgyCliPath(configured?: string | null): string | null {
  if (configured?.trim()) {
    const p = usableFile(configured);
    if (p) return p;
  }
  const envPath = usableFile(process.env.AGY_CLI_PATH);
  if (envPath) return envPath;
  return findOnPath();
}

/** agy 会话存储目录。 */
function conversationsDir(): string {
  return resolve(homedir(), ".gemini", "antigravity-cli", "conversations");
}

/** agy workspace→conversation 缓存文件路径。 */
function lastConversationsCachePath(): string {
  return resolve(homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
}

/**
 * 读 last_conversations.json，按 workspace 路径查 conversation uuid。
 * agy 会话按 cwd 隔离，这个缓存文件是精确映射。
 */
function conversationIdByWorkspace(workspace: string): string | null {
  const cacheFile = lastConversationsCachePath();
  try {
    const raw = readFileSync(cacheFile, "utf8");
    const map = JSON.parse(raw) as Record<string, string>;
    // key 是绝对路径，需要规范化比较（resolve 已去 trailing sep）
    const key = resolve(workspace);
    return map[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * 扫描会话目录，返回最新修改的 .db 文件对应的 conversation uuid。
 * Fallback：当缓存文件不存在或没命中时使用。
 * 注意：此方法不区分 workspace，可能拿到其他工作目录的会话。
 */
function latestConversationIdFromDir(): string | null {
  const dir = conversationsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  for (const name of entries) {
    if (extname(name).toLowerCase() !== ".db") continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!best || st.mtimeMs > best.mtime) {
        best = { name, mtime: st.mtimeMs };
      }
    } catch {
      /* 跳过不可访问的文件 */
    }
  }
  if (!best) return null;
  const base = best.name.replace(/\.db$/i, "");
  return base || null;
}

/**
 * 获取最新会话 ID。优先读缓存文件按 workspace 精确查（agy 会话按 cwd 隔离）；
 * 缓存未命中则 fallback 扫 conversations 目录取最新 .db。
 *
 * @param workspace 当前工作目录（cwd），agy 按此隔离会话
 */
export function latestConversationId(workspace?: string): string | null {
  if (workspace) {
    const id = conversationIdByWorkspace(workspace);
    if (id) return id;
  }
  return latestConversationIdFromDir();
}

/**
 * 探测 agy CLI 版本号。spawn `agy --version`，解析输出中的 semver。
 * 失败返回 null（不阻断主流程，仅影响行为分支）。
 *
 * @param cliPath agy 可执行文件路径（来自 resolveAgyCliPath）
 * @returns 如 "1.1.3"，探测失败返回 null
 */
export function detectAgyVersion(cliPath: string): string | null {
  try {
    const r = spawnSync(cliPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    if (r.status !== 0 && !r.stdout) return null;
    const out = (r.stdout || r.stderr || "").trim();
    // agy --version 输出形如 "Antigravity CLI v1.1.3" 或 "1.1.3"
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 比较两个 semver 字符串（如 "1.1.3" vs "1.1.0"）。
 * @returns -1 if a<b, 0 if a==b, 1 if a>b；无法解析时按 0 处理。
 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
