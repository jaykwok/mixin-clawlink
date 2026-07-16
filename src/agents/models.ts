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
import { cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import { readClaudeEnv } from "./claude-settings.ts";

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
