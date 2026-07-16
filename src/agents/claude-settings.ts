/**
 * 读取 Claude Code 用户配置中的 env。
 *
 * Claude Code 常把 ANTHROPIC_BASE_URL / token 写在 ~/.claude/settings.json，
 * 它们不一定会出现在启动本进程的 shell 环境里。这里按“进程环境优先，用户配置兜底”
 * 动态读取，方便 cc-switch 等工具切换后无需重启即可生效。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ClaudeEnvValue {
  value: string;
  source: "process.env" | string;
}

export function claudeSettingsPath(): string {
  const configured = (process.env.CLAUDE_CONFIG_DIR ?? "").trim();
  const dir = configured
    ? configured.replace(/^~(?=$|[\\/])/, homedir())
    : resolve(homedir(), ".claude");
  return resolve(dir, "settings.json");
}

/** 每次调用都重新读文件，使 Claude 配置切换可立即反映到 TUI。 */
export function readClaudeEnv(name: string): ClaudeEnvValue | undefined {
  const direct = (process.env[name] ?? "").trim();
  if (direct) return { value: direct, source: "process.env" };

  const path = claudeSettingsPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, unknown> };
    const value = parsed.env?.[name];
    if (typeof value === "string" && value.trim()) return { value: value.trim(), source: path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`读取 Claude Code 配置失败 ${path}: ${(error as Error).message}`);
    }
  }
  return undefined;
}
