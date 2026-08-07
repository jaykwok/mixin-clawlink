/** agy CLI 路径查找与版本探测（仅支持 1.1.10+）。 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function usableFile(path: string | undefined | null): string | null {
  if (!path) return null;
  const full = resolve(expandHome(path.trim().replace(/^"|"$/g, "")));
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function findOnPath(): string | null {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const names = process.platform === "win32"
    ? ["agy.exe", "agy", "antigravity.exe", "antigravity"]
    : ["agy", "antigravity"];
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

/** 优先使用显式路径，其次 AGY_CLI_PATH，最后查 PATH。 */
export function resolveAgyCliPath(configured?: string | null): string | null {
  if (configured?.trim()) {
    const p = usableFile(configured);
    if (p) return p;
  }
  const envPath = usableFile(process.env.AGY_CLI_PATH);
  if (envPath) return envPath;
  return findOnPath();
}

export function detectAgyVersion(cliPath: string): string | null {
  try {
    const r = spawnSync(cliPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      shell: false,
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function compareAgyVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}
