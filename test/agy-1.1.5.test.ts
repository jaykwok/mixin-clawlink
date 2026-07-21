import { expect, test } from "bun:test";
import { buildAgyArgs, buildAgyPrompt } from "../src/agents/agy.ts";
import { parseAgyModelsOutput } from "../src/agents/models.ts";

test("headless 启动参数透传 1.1.5 model slug 与 effort", () => {
  expect(buildAgyArgs("修复测试", "conversation-id", {
    AGY_PERMISSION: "bypass",
    AGY_MODEL: "gemini-3.5-flash",
    AGY_EFFORT: "high",
    AGY_AGENT: "reviewer",
    AGY_MODE: "plan",
  })).toEqual([
    "--print", "修复测试",
    "--dangerously-skip-permissions",
    "--conversation", "conversation-id",
    "--model", "gemini-3.5-flash",
    "--effort", "high",
    "--agent", "reviewer",
    "--mode", "plan",
  ]);
});

test("默认 effort 不传 flag，settings 权限不传 bypass", () => {
  expect(buildAgyArgs("ping", null, {
    AGY_PERMISSION: "settings",
    AGY_MODEL: null,
    AGY_EFFORT: null,
    AGY_AGENT: null,
    AGY_MODE: null,
  })).toEqual(["--print", "ping"]);
});

test("agy prompt 注入系统提示和文件回传协议", () => {
  const prompt = buildAgyPrompt(
    "请把报告发给我",
    [],
    [],
    "D:\\work",
    "请用中文回复。",
    "回复末尾输出 [[FILE: 文件的绝对路径]]。",
  );
  expect(prompt).toContain("【系统指令】\n请用中文回复。");
  expect(prompt).toContain("[[FILE: 文件的绝对路径]]");
  expect(prompt).toContain("请把报告发给我");
});

test("解析 1.1.5 稳定 slug 模型列表并保留显示名", () => {
  const output = [
    "Available models:",
    "SLUG                    DISPLAY NAME",
    "gemini-3.5-flash       Gemini 3.5 Flash",
    "gemini-3.1-pro — Gemini 3.1 Pro",
    "Claude Sonnet 4.6 (slug: claude-sonnet-4.6)",
    "gemini-3.5-flash       重复项",
  ].join("\n");
  expect(parseAgyModelsOutput(output)).toEqual([
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
  ]);
});

test("解析 agy 1.1.5 真实 models 输出并忽略拉取进度", () => {
  const output = [
    "Fetching available models...",
    "gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)",
    "gemini-3.5-flash-high     Gemini 3.5 Flash (High)",
    "gemini-3.5-flash-low      Gemini 3.5 Flash (Low)",
    "gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
    "gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
    "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
    "claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)",
    "gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
  ].join("\r\n");

  expect(parseAgyModelsOutput(output)).toEqual([
    { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
    { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
    { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  ]);
});

test("兼容旧版逐行显示名及 ANSI/bullet 输出", () => {
  expect(parseAgyModelsOutput("\u001b[32m• Gemini 3.5 Flash (Medium)\u001b[0m\n- GPT-OSS 120B (Medium)")).toEqual([
    { id: "Gemini 3.5 Flash (Medium)" },
    { id: "GPT-OSS 120B (Medium)" },
  ]);
});
