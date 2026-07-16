/** 回声 agent：原样回显，用于验证密信 IM 通道（收发、附件下载）是否打通。无需任何 SDK。 */
import { basename } from "node:path";
import type { Agent, ReplyOpts, ReplyResult } from "./base.ts";

export class EchoAgent implements Agent {
  readonly name = "echo";

  async startup(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async reply(_uid: string, text: string, _workspace: string, attachments: string[], _opts?: ReplyOpts): Promise<ReplyResult> {
    const parts = [`🦞 echo: ${text || "(无文本)"}`];
    for (const a of attachments) parts.push(`📎 收到附件: ${basename(a)}`);
    return { text: parts.join("\n") };
  }
}
