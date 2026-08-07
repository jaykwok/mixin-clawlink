/** Agent 工厂：按 MIXIN_AGENT 选择适配器。Claude/Antigravity 惰性加载，echo 无需加载外部运行时。 */
import { cfg } from "../config.ts";
import type { Agent } from "./base.ts";
import { EchoAgent } from "./echo.ts";
import { normalizeAgentKind } from "./kind.ts";

export async function makeAgent(kind?: string): Promise<Agent> {
  const k = normalizeAgentKind(kind ?? cfg.AGENT);
  if (k === "echo") return new EchoAgent();
  if (k === "claude") {
    const { ClaudeAgent } = await import("./claude.ts");
    return new ClaudeAgent();
  }
  if (k === "antigravity") {
    const { AgyAgent } = await import("./agy.ts");
    return new AgyAgent();
  }
  throw new Error(`未知 agent: ${k}（支持: echo / claude / antigravity）`);
}
