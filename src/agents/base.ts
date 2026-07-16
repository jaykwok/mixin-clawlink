/**
 * Agent 抽象接口。bot 负责下载入站附件、调用 reply、解析 [[FILE:]] 回传文件。
 *
 * 多轮记忆：Claude 靠 SDK 原生 resume（opts.sessionId），不再注入历史。
 * 危险操作审批：opts.askPermission 回调；中断：opts.abortController（/stop）。
 */
export type AskPermission = (uid: string, tool: string, summary: string) => Promise<boolean>;

export interface ReplyOpts {
  /** 当前槽位的 claude session_id（有则 resume 续上下文；无则新会话）。 */
  sessionId?: string | null;
  /** 危险操作征求用户同意的回调。提供则启用 canUseTool 闸门。 */
  askPermission?: AskPermission;
  /** /stop 用：中断本次 query。 */
  abortController?: AbortController;
}

export interface ReplyResult {
  /** agent 的文本回复。 */
  text: string;
  /** 本次 query 的 claude session_id（首轮抓取，供 registry 回写以便下次 resume）。 */
  sessionId?: string;
}

export interface Agent {
  readonly name: string;
  startup?(): Promise<void>;
  shutdown?(): Promise<void>;
  reply(uid: string, text: string, workspace: string, attachments: string[], opts?: ReplyOpts): Promise<ReplyResult>;
}
