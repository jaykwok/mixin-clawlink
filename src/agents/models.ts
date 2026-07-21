/**
 * 从用户自己的 Claude Code 网关拉可用模型列表（供 /model 命令与 TUI 模型选择用）。
 *
 * 只依赖 claude agent sdk，不引入 @anthropic-ai/sdk——这里用原生 fetch 直接打网关。
 * 我们不配置 CC 的 key/base-url（那是用户自己的事），按“进程 env 优先、
 * ~/.claude/settings.json 的 env 兜底”读取 ANTHROPIC_BASE_URL(+key/token)。
 * 同时兼容 Anthropic 风格 /v1/models 与 OpenAI 风格 /models；后者用于 DeepSeek
 * 这类“消息走 /anthropic、模型列表走根路径 /models”的后端。
 *
 * 响应形态支持 {data:[{id,display_name}],has_more,last_id}、数组、或字符串数组。
 * 若后端没有模型列表端点，上层仍允许用 /model <名字> 手填。
 */
import { spawnSync } from "node:child_process";
import { cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import { readClaudeEnv } from "./claude-settings.ts";
import { resolveAgyCliPath } from "./agy-cli.ts";

const log = getLogger("models");

export interface ModelInfo {
  id: string;
  name?: string;
}

interface ModelEndpoint {
  url: string;
  openAiAuth: boolean;
}

function modelEndpoints(base: string): ModelEndpoint[] {
  const clean = base.replace(/\/+$/, "");
  const out: ModelEndpoint[] = [];
  const add = (url: string, openAiAuth: boolean) => {
    if (!out.some((item) => item.url === url)) out.push({ url, openAiAuth });
  };

  // DeepSeek 的 Anthropic base 是 .../anthropic，但模型列表是根路径 /models。
  if (/\/anthropic$/i.test(clean)) add(`${clean.replace(/\/anthropic$/i, "")}/models`, true);
  if (/\/v1$/i.test(clean)) add(`${clean}/models`, false);
  else add(`${clean}/v1/models`, false);
  add(`${clean}/models`, true);
  return out;
}

function requestHeaders(apiKey: string, authToken: string, openAiAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  else if (openAiAuth && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchEndpoint(endpoint: ModelEndpoint, apiKey: string, authToken: string): Promise<ModelInfo[]> {
  const list: ModelInfo[] = [];
  let after = "";
  for (let guard = 0; guard < 20; guard++) {
    const join = endpoint.url.includes("?") ? "&" : "?";
    const url = endpoint.openAiAuth
      ? endpoint.url
      : `${endpoint.url}${join}limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
    const resp = await fetch(url, {
      headers: requestHeaders(apiKey, authToken, endpoint.openAiAuth),
      signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 160);
      throw new Error(`HTTP ${resp.status}${body ? `: ${body}` : ""}`);
    }
    const json = (await resp.json()) as any;
    const arr: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    for (const m of arr) {
      if (typeof m === "string") list.push({ id: m });
      else if (m && typeof m.id === "string") list.push({ id: m.id, name: m.display_name ?? m.name });
    }
    if (endpoint.openAiAuth || !json?.has_more || !json?.last_id) break;
    after = String(json.last_id);
  }
  if (!list.length) throw new Error("返回空列表");
  return list;
}

/** 返回网关上的模型列表；无 base-url/凭据或请求失败 → 抛错（上层兜底）。 */
export async function fetchModels(): Promise<ModelInfo[]> {
  const baseValue = readClaudeEnv("ANTHROPIC_BASE_URL");
  const apiKeyValue = readClaudeEnv("ANTHROPIC_API_KEY");
  const authTokenValue = readClaudeEnv("ANTHROPIC_AUTH_TOKEN");
  const base = (baseValue?.value ?? "").replace(/\/+$/, "");
  const apiKey = apiKeyValue?.value ?? "";
  const authToken = authTokenValue?.value ?? "";
  if (!base) throw new Error("未配置 ANTHROPIC_BASE_URL（可放在进程环境或 ~/.claude/settings.json 的 env 中）");
  if (!apiKey && !authToken) throw new Error("未配置 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN");

  const errors: string[] = [];
  for (const endpoint of modelEndpoints(base)) {
    try {
      const list = await fetchEndpoint(endpoint, apiKey, authToken);
      log.info(
        "从 %s 拉到 %d 个模型（Claude 配置来源: %s）: %s",
        endpoint.url,
        list.length,
        baseValue?.source ?? "unknown",
        list.map((m) => m.id).join(", "),
      );
      return list;
    } catch (error) {
      errors.push(`${endpoint.url}: ${(error as Error).message}`);
    }
  }
  throw new Error(`模型列表拉取失败：${errors.join("；")}（仍可用 /model <名字> 手填）`);
}

/**
 * 从 agy CLI 获取模型列表（spawn `agy models`，解析纯文本输出）。
 * 兼容旧版“每行一个显示名”和 1.1.5+“稳定 slug + 显示名”输出。
 */
export function fetchAgyModels(): ModelInfo[] {
  const cliPath = resolveAgyCliPath(cfg.AGY_CLI_PATH);
  if (!cliPath) {
    throw new Error("未找到 agy CLI（可设置 AGY_CLI_PATH 或确保 agy 在 PATH 中）");
  }
  const r = spawnSync(cliPath, ["models"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  if (r.error) throw new Error(`agy models 执行失败: ${(r.error as Error).message}`);
  if (r.status !== 0 && !r.stdout) {
    const detail = (r.stderr || "").trim().slice(0, 200);
    throw new Error(`agy models 退出码 ${r.status}${detail ? `: ${detail}` : ""}`);
  }
  const out = (r.stdout || "").trim();
  if (!out) throw new Error("agy models 返回空输出");
  const list = parseAgyModelsOutput(out);
  log.info("agy models 返回 %d 个模型: %s", list.length, list.map(model => model.id).join(", "));
  if (!list.length) throw new Error("agy models 未返回任何模型");
  return list;
}

/**
 * 解析 agy models 文本。1.1.5 的稳定 slug 是持久配置值；显示名只用于 UI。
 * 同时保留旧版逐行显示名作为 id，便于尚未升级的输出被友好识别。
 */
export function parseAgyModelsOutput(output: string): ModelInfo[] {
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  const list: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of output.replace(ansi, "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line
      || /^(?:available\s+models?|models?)\s*:?$/i.test(line)
      || /^fetching\s+available\s+models(?:\.{3}|…)?$/i.test(line)
      || /^(?:model\s+)?slug\s+(?:display\s+)?name$/i.test(line)
      || /^[─━=-]{3,}$/.test(line)) continue;
    line = line.replace(/^(?:[*•-]|\d+[.)])\s+/, "").trim();

    let id = line;
    let name = line;
    // 常见新版形态："Gemini 3.5 Flash (slug: gemini-3.5-flash)"。
    const suffix = /^(.*?)\s+\((?:slug|model(?:\s+slug)?)\s*:\s*([a-z0-9][a-z0-9._-]*)\)$/i.exec(line);
    if (suffix) {
      name = suffix[1].trim();
      id = suffix[2];
    } else {
      // 表格/分隔形态："gemini-3.5-flash  Gemini 3.5 Flash" 或 "slug — name"。
      const columns = /^([a-z0-9][a-z0-9._-]*[._-][a-z0-9._-]*)\s+(?:(?:[-–—|])\s+|\s+)(.+)$/i.exec(line);
      if (columns && !/^display[-_ ]?name$/i.test(columns[2].trim())) {
        id = columns[1];
        name = columns[2].trim();
      }
    }
    if (!seen.has(id)) {
      seen.add(id);
      list.push(name && name !== id ? { id, name } : { id });
    }
  }
  return list;
}

/**
 * 统一入口：根据当前 agent 类型分发到对应的模型获取方法。
 * - claude → fetchModels()（Anthropic/OpenAI 网关）
 * - antigravity/agy → fetchAgyModels()（agy models 子进程）
 */
export async function fetchAgentModels(): Promise<ModelInfo[]> {
  const agent = cfg.AGENT.toLowerCase();
  if (agent === "antigravity" || agent === "agy") {
    return fetchAgyModels();
  }
  return fetchModels();
}
