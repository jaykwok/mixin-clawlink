import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveClaudeCliPath } from "../src/agents/claude-cli.ts";

test("显式 Claude Code 路径存在时直接采用", () => {
  const dir = join(tmpdir(), `mixin-clawlink-cli-${process.pid}-${Date.now()}`);
  const executable = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(executable, "test");
  try {
    expect(resolveClaudeCliPath(executable)).toBe(executable);
    expect(resolveClaudeCliPath(join(dir, "missing.exe"))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
