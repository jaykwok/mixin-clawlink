/**
 * 集中配置：从 .env 读取，支持运行时热改（/config）+ 软重启重载（/reboot）。
 *
 * - import 时 dotenv.config() + apply() 把 env 写进可变对象 cfg。
 * - reload() 重读 .env(override) 再 apply()：/reboot 让"重建才生效"的项（AGENT/WORKSPACE）落地。
 * - /config 改热项：setValue() 校验 → 写回 .env → reload() → 消费方读 cfg.X 即生效。
 * - 消费方一律 `cfg.X` 属性访问（不要解构捕获，reload 后会陈旧）。
 */
import dotenv from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 展开 ~ 为家目录（Node 没有 pathlib 的 expanduser）。 */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, homedir());
}

const DOTENV = resolve(process.cwd(), ".env");

const _ENDPOINTS: Record<string, string> = {
  production: "https://imtwo.zdxlz.com/open-apis/v1",
  staging: "https://mxpre.zdxlz.com:1443/open-apis/v1",
  impre: "https://impre.zdxlz.com:1443/open-apis/v1",
  test: "https://test-mx.zdxlz.com:1443/open-apis/v1",
};

// 默认危险命令模式（命中即在聊天框问 y/n）；可用 MIXIN_CLAUDE_DANGER_PATTERNS 覆盖（|| 分隔）
const _DEFAULT_DANGER_RE: RegExp[] = [
  /\brm\b/, /\brmdir\b/, /\bdel\b/, /\berase\b/, /\brd\s/,
  /Remove-?Item/, /\bformat\b/, /mkfs/, /\bdd\b/,
  /git\s+reset\s+--hard/, /git\s+clean\s+-[a-z]*f/,
  /\btruncate\b/, /\bDROP\s+(TABLE|DATABASE|INDEX)\b/,
  /\bTRUNCATE\s+TABLE\b/, /\bDELETE\s+FROM\b/,
  /\bshutdown\b/, /\breboot\b/,
];

const _DEFAULT_FILE_RETURN_INSTRUCTION =
  "\n\n【回传文件约定】当你想把某个文件（你生成的，或从工作目录里找到的）发给用户时，" +
  "在回复末尾为每个文件加一行，格式严格为：[[FILE: 文件的绝对路径]]。" +
  "只回传用户真正需要的文件，不要回传整个目录或无关文件。其余正文照常写。" +
  "路径必须是工作目录里真实存在的文件。";

export interface Cfg {
  ENV: string;
  API_BASE: string;
  WS_BASE: string;
  APP_ID: string;
  APP_SECRET: string;
  QUANTUM_ACCOUNT: string | null;
  BOT_USER_ID: string | null;
  AGENT: string;
  WORKSPACE: string;
  SYSTEM_PROMPT: string;
  FILE_RETURN_INSTRUCTION: string;
  CLAUDE_ALLOWED_TOOLS: string[];
  CLAUDE_MODEL: string | null;
  CLAUDE_CLI_PATH: string | null;
  CLAUDE_PERMISSION: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  MAX_FILE_MB: number;
  CLAUDE_DANGER_CONFIRM: boolean;
  CLAUDE_DANGER_PATTERNS: string[]; // 正则源串（isDangerous 时编译）
  // agy CLI 适配器配置（AGENT=agy 时生效）
  AGY_CLI_PATH: string | null;
  AGY_MODEL: string | null;
  AGY_AGENT: string | null;
  AGY_MODE: "default" | "accept-edits" | "plan" | null;
  /** agy 权限策略：bypass=--dangerously-skip-permissions 全自动（旧）；settings=靠 settings.json 权限/sandbox 控制（需 agy≥1.1.4） */
  AGY_PERMISSION: "bypass" | "settings";
  // 运维参数（非 env 派生，不参与热改；改了需重启进程）
  HTTP_TIMEOUT: number;
  TOKEN_REFRESH_LEAD_S: number;
  WS_PING_INTERVAL_S: number;
  WS_PING_TIMEOUT_S: number;
  UPLOAD_CHUNK_MB: number;
  DEDUP_MAX: number;
  LOG_DIR: string;
  LOG_FILE: string;
  LOG_MAX_BYTES: number;
  LOG_BACKUP_COUNT: number;
}

export const cfg: Cfg = {
  ENV: "production",
  API_BASE: "",
  WS_BASE: "",
  APP_ID: "",
  APP_SECRET: "",
  QUANTUM_ACCOUNT: null,
  BOT_USER_ID: null,
  AGENT: "echo",
  WORKSPACE: "./workspace",
  SYSTEM_PROMPT: "",
  FILE_RETURN_INSTRUCTION: "",
  CLAUDE_ALLOWED_TOOLS: [],
  CLAUDE_MODEL: null,
  CLAUDE_CLI_PATH: null,
  CLAUDE_PERMISSION: "auto",
  MAX_FILE_MB: 30,
  CLAUDE_DANGER_CONFIRM: true,
  CLAUDE_DANGER_PATTERNS: [],
  AGY_CLI_PATH: null,
  AGY_MODEL: null,
  AGY_AGENT: null,
  AGY_MODE: null,
  AGY_PERMISSION: "bypass",
  HTTP_TIMEOUT: 30,
  TOKEN_REFRESH_LEAD_S: 60,
  WS_PING_INTERVAL_S: 30,
  WS_PING_TIMEOUT_S: 10,
  UPLOAD_CHUNK_MB: 5,
  DEDUP_MAX: 10000,
  LOG_DIR: "logs",
  LOG_FILE: "clawlink.log",
  LOG_MAX_BYTES: 5 * 1024 * 1024,
  LOG_BACKUP_COUNT: 3,
};

function env(k: string): string | undefined {
  const v = process.env[k];
  return v === undefined ? undefined : v;
}
function envStr(k: string, def: string): string {
  const v = env(k);
  return v === undefined ? def : v;
}

function apply(): void {
  cfg.ENV = (envStr("MIXIN_ENV", "production")).trim() || "production";
  const base = _ENDPOINTS[cfg.ENV] ?? _ENDPOINTS.production;
  cfg.API_BASE = (envStr("MIXIN_API_URL", base)).trim().replace(/\/+$/, "");
  cfg.WS_BASE = (envStr("MIXIN_WS_URL",
    cfg.API_BASE.replace("https://", "wss://").replace("http://", "ws://"))).trim().replace(/\/+$/, "");

  cfg.APP_ID = envStr("MIXIN_APP_ID", "").trim();
  cfg.APP_SECRET = envStr("MIXIN_APP_SECRET", "").trim();
  cfg.QUANTUM_ACCOUNT = envStr("MIXIN_QUANTUM_ACCOUNT", "").trim() || null;
  cfg.BOT_USER_ID = envStr("MIXIN_BOT_USER_ID", "").trim() || null;

  cfg.AGENT = envStr("MIXIN_AGENT", "echo").trim().toLowerCase();
  cfg.WORKSPACE = resolve(expandHome(envStr("MIXIN_WORKSPACE", "./workspace")));
  cfg.SYSTEM_PROMPT = env("MIXIN_SYSTEM_PROMPT") ?? "你是用户的私人助理，用中文简洁回复。";
  cfg.FILE_RETURN_INSTRUCTION = env("MIXIN_FILE_RETURN_INSTRUCTION") ?? _DEFAULT_FILE_RETURN_INSTRUCTION;

  cfg.CLAUDE_ALLOWED_TOOLS = (envStr("MIXIN_CLAUDE_ALLOWED_TOOLS", "Read,Write,Edit,Bash,Glob,Grep"))
    .split(",").map(t => t.trim()).filter(Boolean);
  cfg.CLAUDE_MODEL = envStr("MIXIN_CLAUDE_MODEL", "").trim() || null;
  cfg.CLAUDE_CLI_PATH = envStr("MIXIN_CLAUDE_CLI_PATH", "").trim() || null;
  const permission = envStr("MIXIN_CLAUDE_PERMISSION", "auto").trim();
  cfg.CLAUDE_PERMISSION = (["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const)
    .includes(permission as Cfg["CLAUDE_PERMISSION"])
    ? permission as Cfg["CLAUDE_PERMISSION"]
    : "auto";
  cfg.MAX_FILE_MB = parseInt(envStr("MIXIN_MAX_FILE_MB", "30"), 10) || 30;

  cfg.CLAUDE_DANGER_CONFIRM = ["1", "true", "yes", "on"].includes(envStr("MIXIN_CLAUDE_DANGER_CONFIRM", "1").trim().toLowerCase());
  const pats = envStr("MIXIN_CLAUDE_DANGER_PATTERNS", "").trim();
  cfg.CLAUDE_DANGER_PATTERNS = pats ? pats.split("||").map(s => s.trim()).filter(Boolean) : _DEFAULT_DANGER_RE.map(r => r.source);

  cfg.AGY_CLI_PATH = envStr("MIXIN_AGY_CLI_PATH", "").trim() || null;
  cfg.AGY_MODEL = envStr("MIXIN_AGY_MODEL", "").trim() || null;
  cfg.AGY_AGENT = envStr("MIXIN_AGY_AGENT", "").trim() || null;
  const agyMode = envStr("MIXIN_AGY_MODE", "").trim();
  cfg.AGY_MODE = (agyMode && (["default", "accept-edits", "plan"] as const).includes(agyMode as "default" | "accept-edits" | "plan"))
    ? agyMode as Cfg["AGY_MODE"]
    : null;
  const agyPerm = envStr("MIXIN_AGY_PERMISSION", "bypass").trim();
  cfg.AGY_PERMISSION = agyPerm === "settings" ? "settings" : "bypass";
}

dotenv.config({ path: DOTENV });
apply();

export function reload(): void {
  dotenv.config({ path: DOTENV, override: true });
  apply();
}

export function checkCredentials(): void {
  if (!cfg.APP_ID || !cfg.APP_SECRET) {
    throw new Error("缺少 MIXIN_APP_ID / MIXIN_APP_SECRET —— 请在 .env 配置智能助理 apikey（见 .env.example）");
  }
}

// ── /config：可热改项 ────────────────────────────────────────────
export type EditableKind = "int" | "bool" | "choice" | "tools" | "path" | "str" | "regexlist";

export interface EditableEntry {
  key: keyof Cfg;
  env: string;
  kind: EditableKind;
  restart?: boolean;
  desc: string;
  choices?: string[];
  allowEmpty?: boolean;
}

// APP_ID / APP_SECRET 故意不在此列（凭据，不走聊天框）。HISTORY_TURNS 已废弃（改用 SDK resume）。
export const EDITABLE: EditableEntry[] = [
  { key: "AGENT", env: "MIXIN_AGENT", kind: "choice", restart: true, choices: ["echo", "claude", "antigravity"], desc: "agent 类型（echo 测试 / claude 实战 / antigravity Antigravity CLI）" },
  { key: "WORKSPACE", env: "MIXIN_WORKSPACE", kind: "path", restart: true, desc: "默认工作目录根" },
  { key: "SYSTEM_PROMPT", env: "MIXIN_SYSTEM_PROMPT", kind: "str", desc: "agent 系统提示词" },
  { key: "CLAUDE_MODEL", env: "MIXIN_CLAUDE_MODEL", kind: "str", allowEmpty: true, desc: "模型（走 router 填 deepseek-chat 等；留空用默认）" },
  { key: "CLAUDE_ALLOWED_TOOLS", env: "MIXIN_CLAUDE_ALLOWED_TOOLS", kind: "tools", desc: "允许的工具（逗号分隔）" },
  { key: "CLAUDE_CLI_PATH", env: "MIXIN_CLAUDE_CLI_PATH", kind: "str", allowEmpty: true, desc: "自定义/router 的 claude CLI 路径" },
  { key: "CLAUDE_PERMISSION", env: "MIXIN_CLAUDE_PERMISSION", kind: "choice", choices: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"], desc: "Claude Code 权限模式（危险确认开启时不会直接 bypass）" },
  { key: "FILE_RETURN_INSTRUCTION", env: "MIXIN_FILE_RETURN_INSTRUCTION", kind: "str", desc: "回传文件约定提示词" },
  { key: "MAX_FILE_MB", env: "MIXIN_MAX_FILE_MB", kind: "int", desc: "单文件上限 MB" },
  { key: "CLAUDE_DANGER_CONFIRM", env: "MIXIN_CLAUDE_DANGER_CONFIRM", kind: "bool", desc: "危险操作是否在聊天框问 y/n（开/关）" },
  { key: "CLAUDE_DANGER_PATTERNS", env: "MIXIN_CLAUDE_DANGER_PATTERNS", kind: "regexlist", desc: "危险命令模式（|| 分隔的正则，对 Bash 命令匹配）" },
  { key: "AGY_CLI_PATH", env: "MIXIN_AGY_CLI_PATH", kind: "str", allowEmpty: true, desc: "agy CLI 可执行路径（留空自动 PATH 查找）" },
  { key: "AGY_MODEL", env: "MIXIN_AGY_MODEL", kind: "str", allowEmpty: true, desc: "agy 模型名（留空用 agy 默认）" },
  { key: "AGY_AGENT", env: "MIXIN_AGY_AGENT", kind: "str", allowEmpty: true, desc: "agy agent 名（留空用 agy 默认）" },
  { key: "AGY_MODE", env: "MIXIN_AGY_MODE", kind: "choice", allowEmpty: true, choices: ["default", "accept-edits", "plan"], desc: "agy --mode（default/accept-edits/plan；留空不传）" },
  { key: "AGY_PERMISSION", env: "MIXIN_AGY_PERMISSION", kind: "choice", choices: ["bypass", "settings"], desc: "agy 权限策略：bypass=--dangerously-skip-permissions 全自动；settings=靠 agy settings.json 的 toolPermission/sandbox 控制（需 agy≥1.1.4）" },
];

export function lookup(keyOrNum: string): EditableEntry | undefined {
  const s = keyOrNum.trim();
  if (/^\d+$/.test(s)) {
    const i = parseInt(s, 10);
    return EDITABLE[i - 1];
  }
  const up = s.toUpperCase();
  return EDITABLE.find(e => String(e.key).toUpperCase() === up);
}

/** 当前值的展示串（bool→开/关，array→join，null→""）。 */
export function getValue(key: keyof Cfg): string {
  const v = cfg[key];
  if (typeof v === "boolean") return v ? "开" : "关";
  if (Array.isArray(v)) return v.join(key === "CLAUDE_DANGER_PATTERNS" ? " || " : ",");
  if (v === null) return "";
  return String(v);
}

/** 校验 + 写 .env + reload。返回规范化串（供回显）。校验失败 throw Error。 */
export function setValue(key: string, raw: string): string {
  const e = lookup(key);
  if (!e) throw new Error(`未知配置项: ${key}`);
  const val = raw.trim();

  let normalized: string;
  if (e.kind === "int") {
    if (!/^\d+$/.test(val) || parseInt(val, 10) <= 0) throw new Error(`${key} 必须是正整数`);
    normalized = String(parseInt(val, 10));
  } else if (e.kind === "bool") {
    const tl = val.toLowerCase();
    if (["1", "true", "yes", "on", "开", "是"].includes(tl)) normalized = "1";
    else if (["0", "false", "no", "off", "关", "否"].includes(tl)) normalized = "0";
    else throw new Error(`${key} 只能 1/0（或 开/关）`);
  } else if (e.kind === "regexlist") {
    const toks = val.split("||").map(t => t.trim()).filter(Boolean);
    if (!toks.length) throw new Error(`${key} 至少要一个模式（用 || 分隔）`);
    for (const t of toks) {
      try {
        new RegExp(t);
      } catch (err) {
        throw new Error(`${key} 无效正则 ${JSON.stringify(t)}: ${(err as Error).message}`);
      }
    }
    normalized = toks.join("||");
  } else if (e.kind === "choice") {
    if (!val && e.allowEmpty) {
      normalized = "";
    } else if (!e.choices!.some(c => c.toLowerCase() === val.toLowerCase())) {
      throw new Error(`${key} 只能是: ${e.choices!.join(", ")}`);
    } else {
      normalized = val.toLowerCase();
    }
  } else if (e.kind === "tools") {
    const toks = val.replace(/，/g, ",").split(",").map(t => t.trim()).filter(Boolean);
    if (!toks.length) throw new Error(`${key} 至少要有一个工具`);
    normalized = toks.join(",");
  } else if (e.kind === "path") {
    if (!val) throw new Error(`${key} 不能为空（工作目录是 agent 读写文件的根目录，必须指定）`);
    // 跨平台路径规范化：展开 ~ → 统一正斜杠 → resolve 成绝对路径
    // Windows 反斜杠、Unix 正斜杠、相对路径、~ 家目录均支持
    normalized = resolve(expandHome(val.replace(/\\/g, "/")));
  } else {
    // str
    if (!val && !e.allowEmpty) throw new Error(`${key} 不能为空`);
    normalized = val;
  }

  writeEnv(e.env, normalized);
  reload();
  return normalized;
}

/** 把 env_name=value 写回 .env：有则改、无则追加；其它行（含 APP_ID/SECRET）原样保留。 */
function writeEnv(envName: string, value: string): void {
  const lineToWrite = `${envName}="${value}"`;
  const lines: string[] = [];
  let found = false;
  if (existsSync(DOTENV)) {
    const text = readFileSync(DOTENV, "utf8");
    for (const ln of text.split(/\r?\n/)) {
      const stripped = ln.trim();
      if (!stripped.startsWith("#") && stripped.includes("=")) {
        const k = stripped.split("=", 1)[0].trim();
        if (k === envName) {
          lines.push(lineToWrite);
          found = true;
          continue;
        }
      }
      lines.push(ln);
    }
  }
  if (!found) lines.push(lineToWrite);
  writeFileSync(DOTENV, lines.join("\n") + "\n", "utf8");
}

/** 写任意 env（含非 EDITABLE 项：APP_ID/SECRET/MIXIN_ENV）到 .env 并 reload。供 TUI 向导用。 */
export function writeEnvRaw(envName: string, value: string): void {
  writeEnv(envName, value);
  reload();
}

/** 是否危险操作（canUseTool 用）。针对 Bash 命令内容做模式匹配。 */
export function isDangerous(_toolName: string, toolInput: Record<string, unknown> | undefined): boolean {
  const cmd = typeof toolInput === "object" && toolInput
    ? String((toolInput.command as string | undefined) ?? (toolInput.Command as string | undefined) ?? "")
    : "";
  if (!cmd) return false;
  for (const src of cfg.CLAUDE_DANGER_PATTERNS) {
    try {
      if (new RegExp(src, "i").test(cmd)) return true;
    } catch {
      /* 坏模式跳过 */
    }
  }
  return false;
}
