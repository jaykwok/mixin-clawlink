/**
 * agy CLI 适配器（headless 子进程模式）。
 *
 * agy（Antigravity CLI）没有等价 SDK，只能走终端 --print 模式：
 *   agy --print "prompt" --dangerously-skip-permissions [--conversation <uuid>] [--model <slug>] [--effort <level>] [--agent <a>]
 *
 * - 多轮记忆：首轮不续；跑完扫 ~/.gemini/antigravity-cli/conversations/ 取最新 .db 的 uuid
 *   存进 registry。续轮用 --conversation <uuid> 精确续接。
 * - /use 切换：registry 每个槽位存各自的 uuid，切换后用对应 uuid 续接。
 * - /stop：abortController.signal 触发 → kill 子进程。
 * - 危险操作审批：agy --print 一次性跑完，无 canUseTool 回调；skip-permissions 全自动。
 *   CLAUDE_DANGER_CONFIRM 对 agy 无效（无法中途拦截）。
 * - 附件：写进 prompt 让 agy 用工具读（和 claude 一样）。
 * - --continue 偶发报错，加 1 次重试（仅对 --conversation 模式）。
 */
import { extname } from "node:path";
import { spawn } from "node:child_process";
import { cfg, type Cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import type { Agent, ReplyOpts, ReplyResult } from "./base.ts";
import { compareAgyVersions, resolveAgyCliPath, latestConversationId, detectAgyVersion, isAgyAuthenticated } from "./agy-cli.ts";

const log = getLogger("agent:agy");
const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** agy --print 的超时（ms）；--print-timeout 默认 5m，这里给 10m 余量。 */
const PRINT_TIMEOUT_MS = 10 * 60 * 1000;

export class AgyAgent implements Agent {
  readonly name = "antigravity";
  private agyCliPath = "";

  async startup(): Promise<void> {
    const path = resolveAgyCliPath(cfg.AGY_CLI_PATH);
    if (!path) {
      const detail = cfg.AGY_CLI_PATH
        ? `配置的 AGY_CLI_PATH 不存在：${cfg.AGY_CLI_PATH}`
        : "未找到本机 agy CLI。请先安装 Antigravity CLI，或在 TUI 中填写 AGY_CLI_PATH。";
      throw new Error(detail);
    }
    this.agyCliPath = path;
    const version = detectAgyVersion(path);
    log.info("使用本机 agy CLI: %s%s", path, version ? ` (v${version})` : "");
    if (version && compareAgyVersions(version, "1.1.5") < 0) {
      throw new Error(`agy 版本过低：当前 v${version}，本适配器的新模型 slug 与 --effort 功能需要 v1.1.5 或更高版本。`);
    }

    // 认证检测：agy 需要浏览器 OAuth 登录，headless 模式下无法完成
    if (!isAgyAuthenticated()) {
      log.warn("agy 似乎尚未完成 OAuth 认证（~/.gemini/antigravity-cli/ 下未找到凭据）");
      log.warn("请在终端中手动运行一次 agy（非 headless）完成 Google 账号登录，否则 --print 会卡在认证流程直到超时");
    }
  }
  async shutdown(): Promise<void> {}

  async reply(uid: string, text: string, workspace: string, attachments: string[], opts: ReplyOpts = {}): Promise<ReplyResult> {
    const images = attachments.filter(a => IMG_EXTS.has(extname(a).toLowerCase()));
    const others = attachments.filter(a => !IMG_EXTS.has(extname(a).toLowerCase()));
    const promptText = buildPrompt(text, others, images, workspace);

    const hasHistory = !!opts.sessionId;
    log.info("agy query: cwd=%s model=%s effort=%s agent=%s imgs=%d conv=%s",
      workspace, cfg.AGY_MODEL || "(默认)", cfg.AGY_EFFORT || "(默认)", cfg.AGY_AGENT || "(默认)", images.length, hasHistory ? opts.sessionId!.slice(0, 8) + "…" : "(新)");

    // 首轮：无 --conversation；续轮：带 --conversation <uuid>
    const convId = hasHistory ? opts.sessionId! : null;
    let resultText: string | null = null;
    let lastErr: Error | null = null;

    // --conversation 偶发报错，重试 1 次（仅续轮）
    const maxAttempts = convId ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        resultText = await runAgyPrint(this.agyCliPath, promptText, workspace, convId, opts.abortController);
        break;
      } catch (e) {
        lastErr = e as Error;
        if ((e as Error).name === "AbortError") throw e; // /stop 不重试
        if (attempt < maxAttempts) {
          log.warn("agy 第 %d 次失败: %s（将重试）", attempt, (e as Error).message);
          await sleep(1000);
        }
      }
    }

    if (resultText === null) {
      // 识别认证类错误，给出明确提示
      const errMsg = lastErr?.message ?? "";
      if (/auth|oauth|accounts\.google\.com|credential|login|登录|认证/i.test(errMsg)) {
        throw new Error(
          `agy 认证失败：headless 模式下无法完成浏览器 OAuth 登录。\n` +
          `请在终端中手动运行一次 agy（非 headless）完成 Google 账号登录，然后重试。\n` +
          `原始错误: ${errMsg}`
        );
      }
      throw lastErr ?? new Error("agy 执行失败（未知原因）");
    }

    // 首轮：扫 conversations 目录拿 uuid 存 registry；续轮：uuid 不变
    // 优先读 last_conversations.json 按 workspace 精确查（agy 会话按 cwd 隔离）
    const capturedId = convId ?? latestConversationId(workspace);
    if (!capturedId && !hasHistory) {
      log.warn("首轮 query 后未扫到 conversation db 文件，下次将无法 --conversation 续接");
    }

    const trimmed = resultText.trim() || "(已完成，无文本输出。若需要请查看回传的文件。)";
    return { text: trimmed, sessionId: capturedId ?? undefined };
  }
}

/** spawn agy --print，收集 stdout，支持 abort 中断。 */
function runAgyPrint(
  cliPath: string,
  prompt: string,
  cwd: string,
  convId: string | null,
  abortController?: AbortController,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildAgyArgs(prompt, convId, cfg);

    log.info("spawn: %s %s", cliPath || "agy", args.map(a => a.includes(" ") ? `"${a}"` : a).join(" "));

    // Windows 上 agy 通常是 .cmd 包装；startup() 已解析出完整路径，直接用该路径 spawn，
    // 避免 shell:true 带来的注入风险（文档 6.4 强调不要依赖 shell 行为）。
    const child = spawn(cliPath, args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
    };
    abortController?.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
      const err = new Error(`agy --print 超时（${PRINT_TIMEOUT_MS / 1000}s）`);
      err.name = "TimeoutError";
      finish(err);
    }, PRINT_TIMEOUT_MS);

    function finish(err: Error | null, out?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortController?.signal.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(out ?? "");
    }

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      // spawn 本身失败（找不到 agy 等）
      finish(new Error(`spawn agy 失败: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");

      if (abortController?.signal.aborted) {
        const err = new Error("用户中断（/stop）");
        err.name = "AbortError";
        finish(err);
        return;
      }

      if (code !== 0) {
        const detail = stderr || `退出码 ${code}` + (signal ? ` (signal ${signal})` : "");
        // 认证类错误特别标注
        if (/auth|oauth|accounts\.google\.com|credential|login|token/i.test(detail)) {
          const err = new Error(
            `agy 认证相关错误: ${detail}\n` +
            `（headless 模式下无法完成浏览器 OAuth，请在终端手动运行 agy 登录）`
          );
          finish(err);
          return;
        }
        finish(new Error(`agy 执行失败: ${detail}`));
        return;
      }

      // 成功：返回 stdout（agy --print 的输出就是纯文本回复）
      // 1.1.3+ 在 --print 模式下会 soft-deny 需要权限确认的工具，stderr 打印提示。
      // 如果 stdout 为空但 stderr 有权限提示，把 stderr 拼进回复让用户知道。
      if (stderr) {
        log.debug("agy stderr: %s", stderr.slice(0, 500));
        if (!stdout.trim() && /permission|allow|deny|approve/i.test(stderr)) {
          const hint = `[agy 提示] 部分工具因权限被跳过：\n${stderr.slice(0, 1000)}`;
          finish(null, hint);
          return;
        }
      }
      finish(null, stdout);
    });
  });
}

type AgyArgConfig = Pick<Cfg, "AGY_PERMISSION" | "AGY_MODEL" | "AGY_EFFORT" | "AGY_AGENT" | "AGY_MODE">;

/** 构造 headless 启动参数，单独导出以验证 1.1.5 的 model/effort 透传。 */
export function buildAgyArgs(prompt: string, convId: string | null, options: AgyArgConfig): string[] {
  const args = ["--print", prompt];
  // settings=不传 bypass flag，靠 agy settings.json 的 toolPermission/sandbox 控制。
  if (options.AGY_PERMISSION !== "settings") args.push("--dangerously-skip-permissions");
  if (convId) args.push("--conversation", convId);
  if (options.AGY_MODEL) args.push("--model", options.AGY_MODEL);
  if (options.AGY_EFFORT) args.push("--effort", options.AGY_EFFORT);
  if (options.AGY_AGENT) args.push("--agent", options.AGY_AGENT);
  if (options.AGY_MODE) args.push("--mode", options.AGY_MODE);
  return args;
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
