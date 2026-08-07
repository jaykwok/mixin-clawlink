/** agy 1.1.10+ 适配器：stream-json + JSON Schema + 精确会话续接。 */
import { dirname, extname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { cfg, type Cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import type { Agent, AgentProgress, AgentRunMeta, ReplyOpts, ReplyResult } from "./base.ts";
import { compareAgyVersions, resolveAgyCliPath, detectAgyVersion } from "./agy-cli.ts";
import { AGY_MIN_VERSION, AGY_REPLY_SCHEMA, AgyStreamParser, type AgyResult } from "./agy-protocol.ts";

const log = getLogger("agent:agy");
const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export class AgyAgent implements Agent {
  readonly name = "antigravity";
  private agyCliPath = "";

  async startup(): Promise<void> {
    const path = resolveAgyCliPath(cfg.AGY_CLI_PATH);
    if (!path) {
      const detail = cfg.AGY_CLI_PATH
        ? `配置的 AGY_CLI_PATH 不存在：${cfg.AGY_CLI_PATH}`
        : "未找到 agy/antigravity CLI。请安装 Antigravity CLI，或在 TUI 中填写 AGY_CLI_PATH。";
      throw new Error(detail);
    }
    const version = detectAgyVersion(path);
    if (!version) throw new Error(`无法探测 agy 版本：${path}。本适配器要求 v${AGY_MIN_VERSION}+ 的结构化输出。`);
    if (compareAgyVersions(version, AGY_MIN_VERSION) < 0) {
      throw new Error(`agy 版本过低：当前 v${version}，本适配器要求 v${AGY_MIN_VERSION}+。`);
    }
    this.agyCliPath = path;
    log.info("使用本机 agy CLI: %s (v%s, stream-json)", path, version);
  }

  async shutdown(): Promise<void> {}

  async reply(_uid: string, text: string, workspace: string, attachments: string[], opts: ReplyOpts = {}): Promise<ReplyResult> {
    const prompt = buildAgyPrompt(text, attachments, workspace);
    const extraDirs = [...new Set(attachments.map(path => resolve(dirname(path))))];
    log.info(
      "agy query: cwd=%s model=%s effort=%s agent=%s mode=%s sandbox=%s files=%d conv=%s",
      workspace,
      cfg.AGY_MODEL || "(默认)",
      cfg.AGY_EFFORT || "(默认)",
      cfg.AGY_AGENT || "(默认)",
      cfg.AGY_MODE || "(默认)",
      cfg.AGY_SANDBOX,
      attachments.length,
      opts.sessionId ? `${opts.sessionId.slice(0, 8)}…` : "(新)",
    );

    const run = await runAgyPrint(
      this.agyCliPath,
      prompt,
      workspace,
      opts.sessionId ?? null,
      extraDirs,
      opts.abortController,
      opts.onProgress,
    );
    const result = run.result;
    if (!result) {
      const excerpt = run.rawOutput.trim().slice(0, 1000);
      throw new Error(`agy 未返回 terminal result 事件${excerpt ? `：${excerpt}` : ""}`);
    }
    logRunMeta(result);
    return agyResultToReply(result, run.conversationId);
  }
}

/**
 * agy 1.1.10 可能在 status=ERROR 时仍把通过 schema 的完整 JSON 放进 response。
 * 可验证的结构化结果或非空正文优先保留；只有完全没有可用结果时才抛错。
 */
export function agyResultToReply(result: AgyResult, streamConversationId?: string): ReplyResult {
  const structured = result.structured;
  const response = result.response.trim();
  const hasUsableResult = structured !== undefined || response.length > 0;
  const status = result.status?.toUpperCase();
  if (status && status !== "SUCCESS") {
    const reason = result.error ? `：${result.error}` : "";
    if (!hasUsableResult) throw new Error(`agy 返回失败状态 ${result.status}，且没有可用结果${reason}`);
    log.warn(
      "agy status=%s，但返回了可用%s；保留结果。error=%s",
      result.status,
      structured ? "结构化结果" : "正文",
      result.error?.slice(0, 1000) ?? "(无)",
    );
  }
  const text = structured ? structured.text : response;
  return {
    text: text || (structured?.files.length ? "" : "(已完成，无文本输出。若需要请查看回传的文件。)"),
    files: structured?.files ?? [],
    sessionId: result.conversationId ?? streamConversationId,
    meta: result.meta,
  };
}

interface AgyProcessResult {
  result?: AgyResult;
  conversationId?: string;
  rawOutput: string;
}

function runAgyPrint(
  cliPath: string,
  prompt: string,
  cwd: string,
  convId: string | null,
  extraDirs: string[],
  abortController?: AbortController,
  onProgress?: (event: AgentProgress) => void,
): Promise<AgyProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const args = buildAgyArgs(prompt, convId, cfg, extraDirs);
    log.info("spawn: %s %s", cliPath, summarizeArgs(args));
    const child = spawn(cliPath, args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      // Unix 下建立独立进程组，/stop 可连同工具/子 Agent 一起终止。
      detached: process.platform !== "win32",
    });

    const parser = new AgyStreamParser(event => {
      if (event.kind !== "agent") log.debug("agy progress: %s %s %s", event.kind, event.state, event.text.slice(0, 500));
      onProgress?.(event);
    });
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortController?.signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }
      const summary = parser.finish();
      if (summary.result) {
        summary.result = applyInvocationMeta(
          summary.result,
          summary.invocationMeta,
          (Date.now() - startedAt) / 1000,
          convId !== null,
        );
      }
      resolvePromise(summary);
    };
    const stopChild = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        try {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
            shell: false,
          });
          killer.once("error", () => { try { child.kill("SIGKILL"); } catch { /* 已退出。 */ } });
          killer.unref();
        } catch {
          try { child.kill("SIGKILL"); } catch { /* 已退出。 */ }
        }
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch { /* 已退出。 */ } }
      }
    };
    const onAbort = () => stopChild();
    if (abortController?.signal.aborted) onAbort();
    else abortController?.signal.addEventListener("abort", onAbort, { once: true });

    // agy 自己先按 --print-timeout 结束；外围多留 15 秒用于输出 terminal result/错误。
    const timer = setTimeout(() => {
      stopChild();
      const error = new Error(`agy --print 超时（${cfg.AGY_TIMEOUT_S}s）`);
      error.name = "TimeoutError";
      finish(error);
    }, (cfg.AGY_TIMEOUT_S + 15) * 1000);

    child.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", error => finish(new Error(`spawn agy 失败: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (abortController?.signal.aborted) {
        const error = new Error("用户中断（/stop）");
        error.name = "AbortError";
        finish(error);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        const detail = stderr || `退出码 ${code}${signal ? ` (signal ${signal})` : ""}`;
        finish(new Error(`agy 执行失败: ${detail}`));
        return;
      }
      if (stderr) log.debug("agy stderr: %s", stderr.slice(0, 1000));
      finish();
    });
  });
}

/**
 * stream-json 的 terminal meta 在续接时可能是整段 conversation 的累计值。
 * `/status` 需要的是本次进程指标，因此优先采用本次流中的 DONE step 汇总。
 */
export function applyInvocationMeta(
  result: AgyResult,
  invocationMeta: AgentRunMeta,
  elapsedSeconds: number,
  resumed: boolean,
): AgyResult {
  const hasResult = result.structured !== undefined || result.response.trim().length > 0;
  return {
    ...result,
    meta: {
      durationSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : invocationMeta.durationSeconds,
      numTurns: invocationMeta.numTurns ?? (hasResult ? 1 : undefined),
      // 新会话缺少 step usage 时 terminal usage 仍可信；续接时宁可不显示，也不显示历史累计值。
      usage: invocationMeta.usage ?? (resumed ? undefined : result.meta.usage),
    },
  };
}

type AgyArgConfig = Pick<
  Cfg,
  "AGY_PERMISSION" | "AGY_MODEL" | "AGY_EFFORT" | "AGY_AGENT" | "AGY_MODE" | "AGY_SANDBOX" | "AGY_TIMEOUT_S"
>;

/** 所有 flag 放在 --print prompt 之前，避免 Go flag parser 把后续参数误作 prompt 内容。 */
export function buildAgyArgs(
  prompt: string,
  convId: string | null,
  options: AgyArgConfig,
  extraDirs: string[] = [],
): string[] {
  const args: string[] = [];
  if (options.AGY_PERMISSION === "bypass") args.push("--dangerously-skip-permissions");
  if (options.AGY_SANDBOX) args.push("--sandbox");
  if (convId) args.push("--conversation", convId);
  if (options.AGY_MODEL) args.push("--model", options.AGY_MODEL);
  if (options.AGY_EFFORT) args.push("--effort", options.AGY_EFFORT);
  if (options.AGY_AGENT) args.push("--agent", options.AGY_AGENT);
  if (options.AGY_MODE) args.push("--mode", options.AGY_MODE);
  for (const dir of [...new Set(extraDirs.map(path => resolve(path)))]) args.push("--add-dir", dir);
  args.push(
    "--output-format", "stream-json",
    "--json-schema", AGY_REPLY_SCHEMA,
    "--print-timeout", `${options.AGY_TIMEOUT_S}s`,
    "--print", prompt,
  );
  return args;
}

export function buildAgyPrompt(
  text: string,
  attachments: string[],
  workspace: string,
  systemPrompt = cfg.SYSTEM_PROMPT,
): string {
  const userText = text.trim() || "(用户发来了附件)";
  const context: string[] = ["<clawlink-context>"];
  if (systemPrompt.trim()) context.push(`系统指令：${systemPrompt.trim()}`);
  context.push(`当前工作目录：${workspace}`);
  context.push("最终结果必须遵守调用方提供的 JSON Schema；files 只列出用户明确需要接收且确实存在的文件绝对路径。");
  if (attachments.length) {
    context.push("用户附件已下载到以下绝对路径（对应目录已通过 --add-dir 授权）：");
    for (const path of attachments) {
      const kind = IMG_EXTS.has(extname(path).toLowerCase()) ? "图片" : "文件";
      context.push(`- [${kind}] ${path}`);
    }
  }
  context.push("</clawlink-context>");
  // 1.1.9+ 只展开 leading slash command；/agy 透传时必须让原命令保持第一个 token。
  return userText.startsWith("/")
    ? `${userText}\n\n${context.join("\n")}`
    : `${context.join("\n")}\n\n<user-request>\n${userText}\n</user-request>`;
}

function summarizeArgs(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json-schema") { out.push(arg, "<schema>"); i++; continue; }
    if (arg === "--print") { out.push(arg, "<prompt>"); i++; continue; }
    out.push(arg.includes(" ") ? JSON.stringify(arg) : arg);
  }
  return out.join(" ");
}

function logRunMeta(result: AgyResult): void {
  const usage = result.meta.usage;
  log.info(
    "agy result: status=%s conv=%s duration=%ss turns=%s tokens=%s cache=%s",
    result.status ?? "(未知)",
    result.conversationId ? `${result.conversationId.slice(0, 8)}…` : "(无)",
    result.meta.durationSeconds?.toFixed(2) ?? "?",
    result.meta.numTurns ?? "?",
    usage?.totalTokens ?? "?",
    usage?.cacheReadTokens ?? "?",
  );
}
