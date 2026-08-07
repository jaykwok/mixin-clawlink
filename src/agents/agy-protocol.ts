/** agy 1.1.10+ print-mode 结构化协议。 */
import { StringDecoder } from "node:string_decoder";
import type { AgentProgress, AgentRunMeta, AgentUsage } from "./base.ts";

export const AGY_MIN_VERSION = "1.1.10";
const RAW_OUTPUT_TAIL_CHARS = 2 * 1024 * 1024;

/**
 * 让 agy 直接返回正文与待发送文件，避免从自然语言中猜路径。
 * additionalProperties=false 能尽早暴露模型/CLI 输出契约漂移。
 */
export const AGY_REPLY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "发送给用户的最终回复正文；不要包含文件回传标记。",
    },
    files: {
      type: "array",
      description: "需要发送给用户的文件绝对路径；没有文件时返回空数组。",
      items: { type: "string" },
    },
  },
  required: ["text", "files"],
  additionalProperties: false,
});

export interface AgyStructuredReply {
  text: string;
  files: string[];
}

export interface AgyResult {
  conversationId?: string;
  status?: string;
  response: string;
  structured?: AgyStructuredReply;
  meta: AgentRunMeta;
}

export interface AgyStreamSummary {
  result?: AgyResult;
  conversationId?: string;
  rawOutput: string;
  progress: AgentProgress[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseUsage(value: unknown): AgentUsage | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const usage: AgentUsage = {
    inputTokens: finiteNumber(obj.input_tokens),
    outputTokens: finiteNumber(obj.output_tokens),
    thinkingTokens: finiteNumber(obj.thinking_tokens),
    cacheReadTokens: finiteNumber(obj.cache_read_tokens),
    totalTokens: finiteNumber(obj.total_tokens),
  };
  return Object.values(usage).some(v => v !== undefined) ? usage : undefined;
}

function parseStructured(value: unknown): AgyStructuredReply | undefined {
  if (typeof value === "string") {
    try { return parseStructured(JSON.parse(value)); } catch { return undefined; }
  }
  const obj = record(value);
  if (!obj || typeof obj.text !== "string" || !Array.isArray(obj.files)) return undefined;
  const files = obj.files.filter((v): v is string => typeof v === "string" && !!v.trim()).map(v => v.trim());
  return { text: obj.text.trim(), files: [...new Set(files)] };
}

/** 同时接受 --output-format json 的顶层对象与 stream-json 的 result payload。 */
export function parseAgyResult(value: unknown): AgyResult | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const response = typeof obj.response === "string" ? obj.response : "";
  const structured = parseStructured(obj.structured_output ?? obj.structuredOutput)
    ?? parseStructured(obj.response);
  // result 事件至少应带 response/status/conversation_id 之一，避免把普通 JSON 当结果。
  if (!("response" in obj) && !("status" in obj) && !("conversation_id" in obj)) return undefined;
  return {
    conversationId: nonEmptyString(obj.conversation_id),
    status: nonEmptyString(obj.status),
    response: response.trim(),
    structured,
    meta: {
      durationSeconds: finiteNumber(obj.duration_seconds),
      numTurns: finiteNumber(obj.num_turns),
      usage: parseUsage(obj.usage),
    },
  };
}

/** 解析一次性 --output-format json；主要用于测试、诊断和 stream 异常兜底。 */
export function parseAgyJsonOutput(output: string): AgyResult | undefined {
  const lines = output.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const outer = record(parsed);
      const payload = outer?.event === "result" ? outer.result : parsed;
      const result = parseAgyResult(payload);
      if (result) return result;
    } catch {
      /* 继续向前寻找真实结果行。 */
    }
  }
  return undefined;
}

function toolSummary(step: Record<string, unknown>): string {
  const info = record(step.tool_info);
  const params = record(info?.parameters);
  const name = nonEmptyString(info?.name) ?? nonEmptyString(step.tool_name) ?? "tool";
  const command = nonEmptyString(params?.CommandLine) ?? nonEmptyString(params?.command);
  const path = nonEmptyString(params?.Path) ?? nonEmptyString(params?.path) ?? nonEmptyString(params?.FilePath);
  if (command) return `${name}: ${command}`;
  if (path) return `${name}: ${path}`;
  return name;
}

function subagentSummary(step: Record<string, unknown>): string {
  const info = record(step.subagent_info);
  return nonEmptyString(info?.name)
    ?? nonEmptyString(info?.agent_name)
    ?? nonEmptyString(step.subagent_name)
    ?? "subagent";
}

/** 增量消费 agy 1.1.10 stream-json NDJSON，正确处理 UTF-8 与任意 chunk 边界。 */
export class AgyStreamParser {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private raw = "";
  private readonly narration = new Map<string, string>();
  private readonly emittedTools = new Set<string>();
  private readonly emittedSubagents = new Set<string>();
  private readonly progressEvents: AgentProgress[] = [];
  private resultValue?: AgyResult;
  private conversationIdValue?: string;

  constructor(private readonly onProgress?: (event: AgentProgress) => void) {}

  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    this.raw += text;
    if (this.raw.length > RAW_OUTPUT_TAIL_CHARS) this.raw = this.raw.slice(-RAW_OUTPUT_TAIL_CHARS);
    this.pending += text;
    this.drainLines(false);
  }

  finish(): AgyStreamSummary {
    const rest = this.decoder.end();
    this.raw += rest;
    if (this.raw.length > RAW_OUTPUT_TAIL_CHARS) this.raw = this.raw.slice(-RAW_OUTPUT_TAIL_CHARS);
    this.pending += rest;
    this.drainLines(true);
    if (!this.resultValue) this.resultValue = parseAgyJsonOutput(this.raw);
    const resultConversation = this.resultValue?.conversationId;
    return {
      result: this.resultValue,
      conversationId: resultConversation ?? this.conversationIdValue,
      rawOutput: this.raw,
      progress: [...this.progressEvents],
    };
  }

  private drainLines(flush: boolean): void {
    const lines = this.pending.split(/\r?\n/);
    this.pending = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) this.consumeLine(line);
    if (flush && this.pending.trim()) this.consumeLine(this.pending);
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    const event = record(value);
    if (!event) return;
    if (event.event === "init") {
      this.conversationIdValue = nonEmptyString(event.conversation_id)
        ?? nonEmptyString(record(event.init)?.conversation_id)
        ?? this.conversationIdValue;
      return;
    }
    if (event.event === "result") {
      const result = parseAgyResult(event.result);
      if (result) this.resultValue = result;
      return;
    }
    if (event.event !== "step_update") return;
    const step = record(event.step_update);
    if (!step) return;
    this.consumeStep(step);
  }

  private consumeStep(step: Record<string, unknown>): void {
    const index = String(step.step_index ?? "unknown");
    const state = String(step.state ?? "").toUpperCase();
    const type = String(step.step_type ?? "").toLowerCase();
    if (type === "agent_response") {
      const delta = typeof step.text_delta === "string" ? step.text_delta : "";
      this.narration.set(index, (this.narration.get(index) ?? "") + delta);
      if (state === "DONE") {
        const text = (this.narration.get(index) ?? "").trim();
        this.narration.delete(index);
        if (text) this.emit({ kind: "agent", state: "done", text });
      }
      return;
    }
    if (type === "tool") {
      if (state === "ACTIVE" && !this.emittedTools.has(index)) {
        this.emittedTools.add(index);
        this.emit({ kind: "tool", state: "active", text: toolSummary(step) });
      } else if (state === "DONE") {
        this.emit({ kind: "tool", state: "done", text: toolSummary(step) });
      }
      return;
    }
    if (type === "subagent") {
      if (state === "ACTIVE" && !this.emittedSubagents.has(index)) {
        this.emittedSubagents.add(index);
        this.emit({ kind: "subagent", state: "active", text: subagentSummary(step) });
      } else if (state === "DONE") {
        this.emit({ kind: "subagent", state: "done", text: subagentSummary(step) });
      }
    }
  }

  private emit(event: AgentProgress): void {
    this.progressEvents.push(event);
    try { this.onProgress?.(event); } catch { /* 进度观察者不得中断 stdout。 */ }
  }
}
