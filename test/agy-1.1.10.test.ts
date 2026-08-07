import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { agyResultToReply, applyInvocationMeta, buildAgyArgs, buildAgyPrompt } from "../src/agents/agy.ts";
import {
  AGY_REPLY_SCHEMA,
  AgyStreamParser,
  parseAgyJsonOutput,
  parseAgyResult,
} from "../src/agents/agy-protocol.ts";
import { parseAgyModelsOutput } from "../src/agents/models.ts";

const OPTIONS = {
  AGY_PERMISSION: "bypass" as const,
  AGY_MODEL: "gemini-3.5-flash",
  AGY_EFFORT: "high" as const,
  AGY_AGENT: "reviewer",
  AGY_MODE: "plan" as const,
  AGY_SANDBOX: true,
  AGY_TIMEOUT_S: 600,
};

test("1.1.10 参数全部位于 --print prompt 之前并启用结构化协议", () => {
  const inbox = resolve("D:\\clawlink\\inbox");
  const args = buildAgyArgs("修复测试", "conversation-id", OPTIONS, [inbox, inbox]);
  expect(args.slice(0, 12)).toEqual([
    "--dangerously-skip-permissions",
    "--sandbox",
    "--conversation", "conversation-id",
    "--model", "gemini-3.5-flash",
    "--effort", "high",
    "--agent", "reviewer",
    "--mode", "plan",
  ]);
  expect(args.filter(v => v === "--add-dir")).toHaveLength(1);
  expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(args[args.indexOf("--json-schema") + 1]).toBe(AGY_REPLY_SCHEMA);
  expect(args[args.indexOf("--print-timeout") + 1]).toBe("600s");
  expect(args.slice(-2)).toEqual(["--print", "修复测试"]);
  expect(JSON.parse(AGY_REPLY_SCHEMA).required).toEqual(["text", "files"]);
});

test("settings 权限不传 bypass，默认项不产生空 flag", () => {
  expect(buildAgyArgs("ping", null, {
    AGY_PERMISSION: "settings",
    AGY_MODEL: null,
    AGY_EFFORT: null,
    AGY_AGENT: null,
    AGY_MODE: null,
    AGY_SANDBOX: false,
    AGY_TIMEOUT_S: 30,
  })).toEqual([
    "--output-format", "stream-json",
    "--json-schema", AGY_REPLY_SCHEMA,
    "--print-timeout", "30s",
    "--print", "ping",
  ]);
});

test("解析 1.1.10 --output-format json 的真实输出", () => {
  const output = '{"conversation_id":"7175a105-c096-4a02-bc23-e4a745c0579c","status":"SUCCESS","response":"PONG\\n","duration_seconds":3.0227077,"num_turns":1,"usage":{"input_tokens":16923,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":16928}}';
  expect(parseAgyJsonOutput(output)).toEqual({
    conversationId: "7175a105-c096-4a02-bc23-e4a745c0579c",
    status: "SUCCESS",
    response: "PONG",
    error: undefined,
    structured: undefined,
    meta: {
      durationSeconds: 3.0227077,
      numTurns: 1,
      usage: {
        inputTokens: 16923,
        outputTokens: 5,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 16928,
      },
    },
  });
});

test("JSON Schema structured_output 提供正文和去重后的文件列表", () => {
  const result = parseAgyResult({
    conversation_id: "conv-1",
    status: "SUCCESS",
    response: "fallback",
    structured_output: { text: "报告完成", files: ["D:\\out.pdf", "D:\\out.pdf", ""] },
  });
  expect(result?.structured).toEqual({ text: "报告完成", files: ["D:\\out.pdf"] });
  expect(parseAgyResult({
    status: "SUCCESS",
    response: '{"text":"字符串结构结果","files":[]}',
  })?.structured).toEqual({ text: "字符串结构结果", files: [] });
});

test("真实异常形态：status=ERROR 但 response 是有效 schema 时保留回复", () => {
  const result = parseAgyResult({
    conversation_id: "06db4681-22e8-4917-aade-80254c6691ec",
    status: "ERROR",
    response: '{"files":[],"text":"您好！请问有什么我可以帮您的？"}',
    error: "error executing cascade step: CORTEX_STEP_TYPE_RUN_COMMAND: D:\\网信安\\scratch: no such directory",
  });
  expect(result).toBeDefined();
  expect(result?.error).toContain("CORTEX_STEP_TYPE_RUN_COMMAND");
  expect(agyResultToReply(result!)).toMatchObject({
    text: "您好！请问有什么我可以帮您的？",
    files: [],
    sessionId: "06db4681-22e8-4917-aade-80254c6691ec",
  });
});

test("status=ERROR 且没有任何可用结果时仍抛错", () => {
  const result = parseAgyResult({ status: "ERROR", response: "", error: "模型不可用" });
  expect(() => agyResultToReply(result!)).toThrow("没有可用结果：模型不可用");
});

test("真实续接异常流：保留 error，并用当前 DONE step 隔离历史累计指标", () => {
  const parser = new AgyStreamParser();
  const stream = [
    { event: "init", conversation_id: "06db4681-22e8-4917-aade-80254c6691ec", init: { cwd: "D:\\mixin\\workspace" } },
    { event: "step_update", step_update: { conversation_id: "06db4681-22e8-4917-aade-80254c6691ec", step_index: 171, state: "DONE", step_type: "user_input" } },
    { event: "step_update", step_update: { conversation_id: "06db4681-22e8-4917-aade-80254c6691ec", step_index: 173, state: "DONE", step_type: "agent_response", text_delta: '{"files":[],"text":"续接测试成功"}\n', duration_seconds: 2.6848235, usage: { input_tokens: 88891, output_tokens: 69, thinking_tokens: 49, cache_read_tokens: 8162, total_tokens: 88960 } } },
    { event: "step_update", step_update: { conversation_id: "06db4681-22e8-4917-aade-80254c6691ec", step_index: 174, state: "DONE", step_type: "finish", duration_seconds: 0.0862671 } },
    { event: "result", result: { conversation_id: "06db4681-22e8-4917-aade-80254c6691ec", status: "ERROR", response: '{"files":[],"text":"续接测试成功"}\n', error: "error executing cascade step: CORTEX_STEP_TYPE_RUN_COMMAND: D:\\网信安\\scratch: no such directory", duration_seconds: 1455773.2667082, num_turns: 9, structured_output: { files: [], text: "续接测试成功" }, usage: { input_tokens: 845915, output_tokens: 27559, thinking_tokens: 12254, cache_read_tokens: 3544066, total_tokens: 873474 } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  parser.push(Buffer.from(stream, "utf8"));
  const summary = parser.finish();

  expect(summary.result?.error).toContain("D:\\网信安\\scratch");
  expect(summary.invocationMeta).toEqual({
    durationSeconds: 2.7710906,
    numTurns: 1,
    usage: {
      inputTokens: 88891,
      outputTokens: 69,
      thinkingTokens: 49,
      cacheReadTokens: 8162,
      totalTokens: 88960,
    },
  });

  const normalized = applyInvocationMeta(summary.result!, summary.invocationMeta, 3.1, true);
  expect(normalized.meta).toEqual({
    durationSeconds: 3.1,
    numTurns: 1,
    usage: summary.invocationMeta.usage,
  });
  expect(agyResultToReply(normalized).text).toBe("续接测试成功");
});

test("stream-json 跨 UTF-8 chunk 解析 init、step_update 和 terminal result", () => {
  const seen: string[] = [];
  const parser = new AgyStreamParser(event => seen.push(`${event.kind}:${event.state}:${event.text}`));
  const stream = [
    JSON.stringify({ event: "init", conversation_id: "conv-stream", init: { cwd: "D:\\工作区" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "正在检查" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "文件。" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "bun test" } } } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-stream", status: "SUCCESS", response: "完成", structured_output: { text: "测试通过", files: [] }, duration_seconds: 2.5, num_turns: 1 } }),
  ].join("\n") + "\n";
  const bytes = Buffer.from(stream, "utf8");
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
  const summary = parser.finish();
  expect(summary.conversationId).toBe("conv-stream");
  expect(summary.result?.structured).toEqual({ text: "测试通过", files: [] });
  expect(seen).toContain("agent:done:正在检查文件。");
  expect(seen).toContain("tool:active:run_command: bun test");
});

test("slash command 保持为 prompt 第一个 token，普通请求使用显式用户区块", () => {
  const slash = buildAgyPrompt("/review 检查这个 diff", [], "D:\\work", "请用中文回复。");
  expect(slash).toStartWith("/review 检查这个 diff");
  expect(slash).toContain("<clawlink-context>");
  const normal = buildAgyPrompt("检查这个 diff", ["D:\\inbox\\图.png"], "D:\\work", "请用中文回复。");
  expect(normal).toStartWith("<clawlink-context>");
  expect(normal).toContain("<user-request>\n检查这个 diff");
  expect(normal).toContain("[图片] D:\\inbox\\图.png");
});

test("解析稳定 slug 模型列表并过滤拉取进度", () => {
  const output = [
    "Fetching available models...",
    "gemini-3.5-flash-high     Gemini 3.5 Flash (High)",
    "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
  ].join("\r\n");
  expect(parseAgyModelsOutput(output)).toEqual([
    { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ]);
});
