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

/**
 * 在 npm 全局 bin 目录下猜测 Claude Code 入口的常见位置。
 * npm 包 @anthropic-ai/claude-code 新版自带 bin/claude.exe 原生二进制；
 * 旧版只有 cli.js（需 node 启动）。两种都列，由 existsSync 决定。
 */
function npmEntryCandidates(binDir: string): string[] {
  const pkg = ["node_modules", "@anthropic-ai", "claude-code"];
  return [
    join(binDir, ...pkg, "bin", "claude.exe"),            // 新版: 包内原生二进制
    join(binDir, ...pkg, "cli.js"),                        // 旧版: node cli.js
    join(dirname(binDir), ...pkg, "bin", "claude.exe"),   // bin 是 <prefix>/npm 时
    join(dirname(binDir), ...pkg, "cli.js"),
    join(binDir, "node_modules", "claude-code", "cli.js"), // 更旧包名
  ];
}

/**
 * 解析 npm wrapper（.cmd / 无扩展名 shell wrapper）里的 Claude Code 入口真实路径。
 * wrapper 里常含 %~dp0、%dp0% 等 cmd 变量（读文件读到的是字面量，不会展开），
 * 必须先替换成 binDir 再 existsSync，否则永远 false。
 * 入口可能是 cli.js（旧版，node 启动）或 bin/claude.exe（新版，原生二进制），都匹配。
 * 返回找到的绝对路径，或 null。
 */
function resolveCliFromCmd(cmdPath: string): string | null {
  const binDir = dirname(cmdPath);
  let content: string;
  try {
    content = readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }

  // 匹配入口引用（cli.js 或 claude.exe / claude）：双引号 / 单引号 / 无引号 均兼容
  const matches = content.matchAll(/['"]?([^'"\s]+(?:cli\.js|claude(?:\.exe)?))['"]?/g);
  for (const m of matches) {
    let raw = m[1];
    // 替换 cmd 变量为 binDir（这些变量末尾已带分隔符，直接替换避免双斜杠）
    raw = raw
      .replace(/%~dp0/gi, binDir + "\\")
      .replace(/%dp0%/gi, binDir + "\\")
      .replace(/%CMD_SOURCE%/gi, binDir + "\\")
      .replace(/\$basedir/gi, binDir + "\\");
    const full = resolve(raw);
    if (existsSync(full)) {
      log.debug("从 %s 解析出入口: %s", cmdPath, full);
      return full;
    }
  }

  // 正则没命中可校验的路径 → 回退到标准位置猜测
  for (const cand of npmEntryCandidates(binDir)) {
    if (existsSync(cand)) {
      log.debug("claude.cmd 回退命中标准路径: %s", cand);
      return cand;
    }
  }
  log.debug("claude.cmd 解析失败: binDir=%s, 候选均不存在", binDir);
  return null;
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
    // 2. 读 .cmd 内容解析 cli.js 路径（处理 %~dp0 等变量 + 多种引号写法）
    const cli = resolveCliFromCmd(full);
    if (cli) return cli;
    return null;
  }
  // Windows 上无扩展名的 "claude" 是 npm shell wrapper，SDK 无法直接 spawn
  // 依次尝试：claude.exe → claude.cmd 解析 → 放行（scoop 等真二进制）
  if (process.platform === "win32" && ext === "") {
    const binDir = dirname(full);
    // 1. 同目录有 claude.exe（独立安装器）
    const exe = join(binDir, "claude.exe");
    if (existsSync(exe)) return exe;
    // 2. 同目录有 claude.cmd（npm 安装）→ 读 cmd 解析 cli.js
    const cmd = join(binDir, "claude.cmd");
    if (existsSync(cmd)) {
      const cli = resolveCliFromCmd(cmd);
      if (cli) return cli;
      return null;
    }
    // 3. 既没有 .exe 也没有 .cmd，可能是真正无扩展名的二进制（如 scoop），放行
  }
  return full;
}

function findOnPath(): string | null {
  const command = process.platform === "win32" ? "where.exe" : "which";
  // Windows 上 npm 安装会生成 claude.cmd + 无扩展名 claude；独立安装器是 claude.exe。
  // where.exe claude 会按 PATHEXT 返回 .cmd/.exe 等，这里三个名字都试，覆盖全。
  const names = process.platform === "win32" ? ["claude", "claude.exe", "claude.cmd"] : ["claude"];
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

/**
 * 优先使用显式路径，否则寻找用户自己安装的 Claude Code；不依赖 SDK 附带 CLI。
 *
 * 以 `claude` 命令为共同锚点：无论官方安装器（claude.exe）还是 npm 全局安装
 * （claude.cmd → bin/claude.exe 或 cli.js），终端里 `claude` 能启动就意味着
 * where/which 能定位到入口。因此 findOnPath（系统真相）优先，硬编码候选路径
 * 仅在 where 失败（PATH 未配置等极端情况）时兜底。
 */
export function resolveClaudeCliPath(configured?: string | null): string | null {
  if (configured?.trim()) return usableFile(configured);

  const envPath = usableFile(process.env.CLAUDE_CODE_EXECUTABLE);
  if (envPath) return envPath;

  // 1. 主路径：where/which claude —— 系统真相，覆盖所有"终端能启动"的安装方式
  const pathResult = findOnPath();
  log.debug("findOnPath → %s", pathResult ?? "(null)");
  if (pathResult) return pathResult;

  // 2. 兜底：where 失败时（PATH 未含 claude 等）按常见安装位置猜测
  const home = homedir();
  const candidates = process.platform === "win32"
    ? [
        join(home, ".local", "bin", "claude.exe"),
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : "",
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude") : "",
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.exe") : "",
      ]
    : [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/usr/bin/claude"];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = usableFile(candidate);
    log.debug("候选: %s → %s", candidate, path ?? "(null)");
    if (path) return path;
  }
  return null;
}
