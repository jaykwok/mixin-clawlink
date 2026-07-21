import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAWLINK_INSTRUCTIONS_BEGIN,
  initAgentInstructions,
  instructionPathForAgent,
  needsAgentInstructions,
} from "../src/agents/instructions.ts";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "mixin-clawlink-init-"));
}

test("/init 为 Claude 幂等追加 CLAUDE.md 且保留原文", async () => {
  const workspace = tempWorkspace();
  try {
    const path = join(workspace, "CLAUDE.md");
    writeFileSync(path, "# 原有项目规则\n", "utf8");
    expect(await needsAgentInstructions("claude", workspace)).toBeTrue();
    expect((await initAgentInstructions("claude", workspace))?.changed).toBeTrue();
    expect((await initAgentInstructions("claude", workspace))?.changed).toBeFalse();
    const text = readFileSync(path, "utf8");
    expect(text).toStartWith("# 原有项目规则");
    expect(text.split(CLAWLINK_INSTRUCTIONS_BEGIN)).toHaveLength(2);
    expect(await needsAgentInstructions("claude", workspace)).toBeFalse();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("并发 /init 也只追加一次", async () => {
  const workspace = tempWorkspace();
  try {
    await Promise.all(Array.from({ length: 5 }, () => initAgentInstructions("claude", workspace)));
    const text = readFileSync(join(workspace, "CLAUDE.md"), "utf8");
    expect(text.split(CLAWLINK_INSTRUCTIONS_BEGIN)).toHaveLength(2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("/init 为 agy 优先复用已有 GEMINI.md，否则创建 AGENTS.md", async () => {
  const withGemini = tempWorkspace();
  const empty = tempWorkspace();
  try {
    writeFileSync(join(withGemini, "GEMINI.md"), "# Gemini rules\n", "utf8");
    expect(await instructionPathForAgent("antigravity", withGemini)).toBe(join(withGemini, "GEMINI.md"));
    expect((await initAgentInstructions("antigravity", withGemini))?.path).toBe(join(withGemini, "GEMINI.md"));
    expect((await initAgentInstructions("agy", empty))?.path).toBe(join(empty, "AGENTS.md"));
  } finally {
    rmSync(withGemini, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("agy 的 AGENTS.md/GEMINI.md 任一已初始化时不会跨文件重复添加", async () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, "AGENTS.md"), "# Agent rules\n", "utf8");
    writeFileSync(join(workspace, "GEMINI.md"), `${CLAWLINK_INSTRUCTIONS_BEGIN}\n已有受管内容\n`, "utf8");
    const result = await initAgentInstructions("antigravity", workspace);
    expect(result).toEqual({ path: join(workspace, "GEMINI.md"), changed: false });
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("# Agent rules\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
