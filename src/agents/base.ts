/**
 * Agent 抽象接口。bot 负责下载入站附件、调用 reply、发送结构化文件结果。
 *
 * 多轮记忆由各适配器通过 opts.sessionId 使用原生续接机制，不由 bot 注入历史。
 * 危险操作审批：opts.askPermission 回调；中断：opts.abortController（/stop）。
 */
export type AskPermission = (uid: string, tool: string, summary: string) => Promise<boolean>;

export interface AgentProgress {
  kind: "agent" | "tool" | "subagent";
  state: "active" | "done";
  text: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface AgentRunMeta {
  durationSeconds?: number;
  numTurns?: number;
  usage?: AgentUsage;
}

export interface ReplyOpts {
  /** 当前槽位的原生 agent session ID（有则续接上下文；无则新会话）。 */
  sessionId?: string | null;
  /** 危险操作征求用户同意的回调。提供则启用 canUseTool 闸门。 */
  askPermission?: AskPermission;
  /** /stop 用：中断本次 query。 */
  abortController?: AbortController;
  /** 结构化 headless agent 的进度事件；不得阻塞 stdout 消费。 */
  onProgress?: (event: AgentProgress) => void;
}

export interface ReplyResult {
  /** agent 的文本回复。 */
  text: string;
  /** agent 明确声明要回传的文件；Claude 适配器仍可在 text 中使用 [[FILE:]]。 */
  files?: string[];
  /** 本次 query 的原生会话 ID，供 registry 回写以便下次精确续接。 */
  sessionId?: string;
  /** 本轮耗时、轮次和 token 用量。 */
  meta?: AgentRunMeta;
}

export interface Agent {
  readonly name: string;
  startup?(): Promise<void>;
  shutdown?(): Promise<void>;
  reply(uid: string, text: string, workspace: string, attachments: string[], opts?: ReplyOpts): Promise<ReplyResult>;
}
