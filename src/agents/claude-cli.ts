import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getLogger } from "../logger.ts";

const log = getLogger("agent:claude-cli");

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function usableFile(path: string | undefined | null): string | null {
  if (!path) return null;
  const full = resolve(expandHome(path.trim().replace(/^"|"$/g, "")));
  if (!existsSync(full)) return null;

  const ext = extname(full).toLowerCase();
  if (ext === ".cmd" || ext === ".ps1") {
    const binDir = dirname(full);
    // 1. 同目录有 claude.exe（独立安装器）
    const native = join(binDir, "claude.exe");
    if (existsSync(native)) return native;
    // 2. 读 .cmd 内容解析 cli.js 路径（npm 安装的 wrapper 脚本里有 node "path/to/cli.js"）
    try {
      const content = readFileSync(full, "utf8");
      const m = content.match(/"([^"]+cli\.js)"/);
      if (m && existsSync(m[1])) {
        log.debug("从 %s 解析出 cli.js: %s", extname(full), m[1]);
        return m[1];
      }
    } catch { /* ignore */ }
    // 3. 猜测标准 npm 路径
    const npmCli = join(binDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    log.debug("claude.cmd 解析: binDir=%s, cli.js=%s, exists=%s", binDir, npmCli, existsSync(npmCli));
    if (existsSync(npmCli)) return npmCli;
    return null;
  }
  // Windows 上无扩展名的 "claude" 是 npm shell wrapper，SDK 无法直接 spawn
  // 依次尝试：claude.exe → claude.cmd 解析 → cli.js → 放行（scoop 等真二进制）
  if (process.platform === "win32" && ext === "") {
    const binDir = dirname(full);
    // 1. 同目录有 claude.exe（独立安装器）
    const exe = join(binDir, "claude.exe");
    if (existsSync(exe)) return exe;
    // 2. 同目录有 claude.cmd（npm 安装）→ 读 cmd 解析 cli.js
    const cmd = join(binDir, "claude.cmd");
    if (existsSync(cmd)) {
      try {
        const content = readFileSync(cmd, "utf8");
        const m = content.match(/"([^"]+cli\.js)"/);
        if (m && existsSync(m[1])) {
          log.debug("从 claude.cmd 解析出 cli.js: %s", m[1]);
          return m[1];
        }
      } catch { /* ignore */ }
      const npmCli = join(binDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (existsSync(npmCli)) return npmCli;
      return null;
    }
    // 3. 既没有 .exe 也没有 .cmd，可能是真正无扩展名的二进制（如 scoop），放行
  }
  return full;
}

function findOnPath(): string | null {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const names = process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
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

/** 优先使用显式路径，否则寻找用户自己安装的 Claude Code；不依赖 SDK 附带 CLI。 */
export function resolveClaudeCliPath(configured?: string | null): string | null {
  if (configured?.trim()) return usableFile(configured);

  const envPath = usableFile(process.env.CLAUDE_CODE_EXECUTABLE);
  if (envPath) return envPath;

  const home = homedir();
  const candidates = process.platform === "win32"
    ? [
        join(home, ".local", "bin", "claude.exe"),
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.exe") : "",
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude") : "",
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : "",
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js") : "",
      ]
    : [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/usr/bin/claude"];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = usableFile(candidate);
    log.debug("候选: %s → %s", candidate, path ?? "(null)");
    if (path) return path;
  }
  const pathResult = findOnPath();
  log.debug("findOnPath → %s", pathResult ?? "(null)");
  return pathResult;
}
