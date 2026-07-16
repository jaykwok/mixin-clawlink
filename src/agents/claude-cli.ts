import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
    const native = join(binDir, "claude.exe");
    if (existsSync(native)) return native;
    const npmCli = join(binDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(npmCli)) return npmCli;
    return null;
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
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js") : "",
      ]
    : [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/usr/bin/claude"];

  for (const candidate of candidates) {
    const path = usableFile(candidate);
    if (path) return path;
  }
  return findOnPath();
}
