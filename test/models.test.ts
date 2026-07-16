import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModels } from "../src/agents/models.ts";

test("从 Claude 用户配置读取 DeepSeek base，并用根路径 /models 拉模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mixin-clawlink-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "test-token",
    },
  }));

  const names = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(fetchModels()).resolves.toEqual([{ id: "deepseek-v4-pro", name: undefined }]);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toBe("https://api.deepseek.com/models");
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
