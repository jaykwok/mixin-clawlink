/**
 * Claude Code 适配器（Claude Agent SDK）。
 *
 * - 多轮记忆：用 SDK 原生 resume（opts.sessionId），不再注入 JSONL 历史。
 * - 多模态：图片优先作为 image block 注入 prompt（不依赖 Read）；失败回退到 Read。
 * - 危险操作审批：CLAUDE_DANGER_CONFIRM 开启 + 提供 askPermission 时，装 canUseTool；
 *   ⚠️ canUseTool 只对"未在 allowedTools 里、又未被自动拒"的工具触发，所以危险确认开启时
 *   把 Bash 从 allowedTools 移除，让它走闸门；关闭时 bypassPermissions 全自动（headless 不挂）。
 * - 中断：opts.abortController 透传给 options.abortController（/stop）。
 *
 * query() 无状态，每消息独立；session_id 从 result 消息抓取回写 registry。
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { cfg, isDangerous } from "../config.ts";
import { getLogger } from "../logger.ts";
import { guessMime } from "../mime.ts";
import type { Agent, AskPermission, ReplyOpts, ReplyResult } from "./base.ts";
import { resolveClaudeCliPath } from "./claude-cli.ts";

const log = getLogger("agent:claude");
const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export class ClaudeAgent implements Agent {
  readonly name = "claude";
  private claudeCliPath = "";

  async startup(): Promise<void> {
    const path = resolveClaudeCliPath(cfg.CLAUDE_CLI_PATH);
    if (!path) {
      const detail = cfg.CLAUDE_CLI_PATH
        ? `配置的 CLAUDE_CLI_PATH 不存在或不是可执行入口：${cfg.CLAUDE_CLI_PATH}`
        : "未找到本机 Claude Code。请先安装 Claude Code，或在 TUI 中填写 CLAUDE_CLI_PATH。";
      throw new Error(detail);
    }
    this.claudeCliPath = path;
    log.info("使用本机 Claude Code: %s", path);
  }
  async shutdown(): Promise<void> {}

  async reply(uid: string, text: string, workspace: string, attachments: string[], opts: ReplyOpts = {}): Promise<ReplyResult> {
    const images = attachments.filter(a => IMG_EXTS.has(extname(a).toLowerCase()));
    const others = attachments.filter(a => !IMG_EXTS.has(extname(a).toLowerCase()));
    const promptText = buildPrompt(text, others, images, workspace);
    log.info("claude query: cwd=%s model=%s permission=%s imgs=%d resume=%s", workspace, cfg.CLAUDE_MODEL || "(默认)", cfg.CLAUDE_PERMISSION, images.length, opts.sessionId ? "(续)" : "(新)");

    const dangerOn = !!cfg.CLAUDE_DANGER_CONFIRM && !!opts.askPermission;
    // bypassPermissions 会绕开 canUseTool；危险确认开启时强制退回 default，确保危险 Bash 仍会询问用户。
    const permissionMode = dangerOn && cfg.CLAUDE_PERMISSION === "bypassPermissions"
      ? "default"
      : dangerOn ? cfg.CLAUDE_PERMISSION : "bypassPermissions";
    const baseOptions: Options = {
      cwd: workspace,
      systemPrompt: cfg.SYSTEM_PROMPT + cfg.FILE_RETURN_INSTRUCTION,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions" ? true : undefined,
      // 危险确认开启时移除 Bash，让它流入 canUseTool 闸门；关闭时全量放行
      allowedTools: dangerOn ? cfg.CLAUDE_ALLOWED_TOOLS.filter(t => t !== "Bash") : [...cfg.CLAUDE_ALLOWED_TOOLS],
    };
    if (cfg.CLAUDE_MODEL) baseOptions.model = cfg.CLAUDE_MODEL;
    baseOptions.pathToClaudeCodeExecutable = this.claudeCliPath;
    if (opts.abortController) baseOptions.abortController = opts.abortController;
    if (dangerOn && opts.askPermission) baseOptions.canUseTool = makeCanUseTool(uid, opts.askPermission);

    // 执行一次 query；返回 { sessionId, text, error }。error 非 null 表示 resume 失败等可重试错误。
    const runOnce = async (resume?: string): Promise<{ sessionId?: string; text: string; retryable?: boolean }> => {
      const options: Options = { ...baseOptions };
      if (resume) options.resume = resume;
      let capturedSessionId: string | undefined;
      let resultError = false;
      const parts: string[] = [];
      const collect = async (prompt: string | AsyncIterable<unknown>) => {
        for await (const msg of query({ prompt: prompt as any, options })) {
          const m = msg as any;
          if (m.type === "assistant") {
            for (const block of m.message.content) {
              if (block.type === "text" && block.text) parts.push(block.text);
            }
          } else if (m.type === "result") {
            capturedSessionId = m.session_id;
            if (m.subtype !== "success") {
              log.warn("claude result 非成功: %s is_error=%s", m.subtype, m.is_error);
              // error_during_execution 通常是 resume 的 session 不存在（跨机器/被清理）
              if (m.subtype === "error_during_execution") resultError = true;
            }
          }
        }
      };
      try {
        const imageBlocks = makeImageBlocks(images);
        if (imageBlocks.length) {
          try {
            await collect(userStream(promptText, imageBlocks));
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            log.warn("图片 image block 注入失败，回退到 Read 方式: %s", (e as Error).message);
            await collect(buildPrompt(text, attachments, [], workspace));
          }
        } else {
          await collect(promptText);
        }
      } catch (e) {
        // /stop 或会话切换触发的中断：不重试，直接上抛
        if ((e as Error).name === "AbortError") throw e;
        // resume 的 session 不存在时 SDK 会抛 "No conversation found with session ID"
        const msg = (e as Error).message ?? "";
        if (resume && /No conversation found/i.test(msg)) {
          log.warn("resume 的 session 不存在，降级为新会话重试: %s", msg);
          return { text: "", retryable: true };
        }
        throw e;
      }
      return { sessionId: capturedSessionId, text: parts.join("").trim(), retryable: resultError };
    };

    // 首次带 resume（若有）；resume 失败（session 不存在 / error_during_execution）自动降级为新会话
    let res = await runOnce(opts.sessionId ?? undefined);
    if (res.retryable) {
      log.warn("首次 query 失败，降级为新会话重试（旧 sessionId=%s）", opts.sessionId ?? "(无)");
      res = await runOnce(undefined);
    }

    const resultText = res.text || "(已完成，无文本输出。若需要请查看回传的文件。)";
    return { text: resultText, sessionId: res.sessionId };
  }
}

function makeCanUseTool(uid: string, askPermission: AskPermission) {
  const cb = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    try {
      if (isDangerous(toolName, input)) {
        const ok = await askPermission(uid, toolName, summarize(toolName, input));
        if (!ok) return { behavior: "deny", message: "用户在聊天框拒绝了该操作。" };
      }
      return { behavior: "allow" };
    } catch (e) {
      log.warn("canUseTool 异常，默认放行: %s", (e as Error).message);
      return { behavior: "allow" };
    }
  };
  return cb as any; // SDK 的 CanUseTool 多一个 options 参数；我们忽略它
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (input && typeof input === "object") {
    const cmd = input.command as string | undefined;
    if (cmd) return `$ ${cmd}`;
    const fp = input.file_path as string | undefined;
    if (fp) return `${toolName}: ${fp}`;
  }
  return String(toolName);
}

function makeImageBlocks(images: string[]): any[] {
  const blocks: any[] = [];
  for (const a of images) {
    try {
      const data = readFileSync(a).toString("base64");
      const media = guessMime(a) || "image/png";
      blocks.push({ type: "image", source: { type: "base64", media_type: media, data } });
    } catch (e) {
      log.warn("读取图片失败 %s: %s", a, (e as Error).message);
    }
  }
  return blocks;
}

function userStream(text: string, imageBlocks: any[]): AsyncIterable<unknown> {
  return (async function* gen() {
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }, ...imageBlocks] },
      parent_tool_use_id: null,
    };
  })();
}

function buildPrompt(text: string, others: string[], images: string[], workspace: string): string {
  const out: string[] = [`（你的工作目录是 ${workspace}；不确定路径时先用 pwd/ls 确认，不要凭记忆回答路径。）`];
  out.push(text || "(用户发来了附件)");
  if (images.length) out.push("(用户发来了图片，见下方消息内容。)");
  if (others.length) {
    out.push(`(非图片附件已下载到 inbox，可用 Read 工具读取绝对路径：${others.join(", ")})`);
  }
  return out.join("\n");
}
