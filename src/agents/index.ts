/** Agent 工厂：按 MIXIN_AGENT 选择适配器。claude/agy 用惰性动态 import，echo 模式无需加载 SDK。 */
import { cfg } from "../config.ts";
import type { Agent } from "./base.ts";
import { EchoAgent } from "./echo.ts";

export async function makeAgent(kind?: string): Promise<Agent> {
  const k = (kind ?? cfg.AGENT).trim().toLowerCase();
  if (k === "echo") return new EchoAgent();
  if (k === "claude") {
    const { ClaudeAgent } = await import("./claude.ts");
    return new ClaudeAgent();
  }
  if (k === "antigravity" || k === "agy") {
    const { AgyAgent } = await import("./agy.ts");
    return new AgyAgent();
  }
  throw new Error(`未知 agent: ${k}（支持: echo / claude / antigravity）`);
}
