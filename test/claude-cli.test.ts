import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

test("npm wrapper claude.cmd 含 %~dp0 变量时解析出 cli.js", () => {
  if (process.platform !== "win32") return; // .cmd 仅 Windows
  const dir = join(tmpdir(), `mixin-clawlink-npm-${process.pid}-${Date.now()}`);
  const binDir = join(dir, "npm");
  const cliDir = join(binDir, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(cliDir, { recursive: true });
  const cliJs = join(cliDir, "cli.js");
  writeFileSync(cliJs, "// fake cli");
  // 模拟 npm 生成的 wrapper：%~dp0 是字面量，读文件时不会展开
  const cmd = join(binDir, "claude.cmd");
  writeFileSync(cmd, `@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
  try {
    const resolved = resolveClaudeCliPath(cmd);
    expect(resolved).toBe(resolve(cliJs));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm wrapper claude.cmd 含 %dp0% 变量时解析出 bin/claude.exe", () => {
  if (process.platform !== "win32") return; // .cmd 仅 Windows
  const dir = join(tmpdir(), `mixin-clawlink-npm-exe-${process.pid}-${Date.now()}`);
  const binDir = join(dir, "npm");
  const pkgBinDir = join(binDir, "node_modules", "@anthropic-ai", "claude-code", "bin");
  mkdirSync(pkgBinDir, { recursive: true });
  const exe = join(pkgBinDir, "claude.exe");
  writeFileSync(exe, "fake exe");
  // 精确复刻真实 npm wrapper：SET dp0=%~dp0 后用 %dp0% 引用，指向 bin/claude.exe
  const cmd = join(binDir, "claude.cmd");
  writeFileSync(cmd, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    `"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*`,
  ].join("\r\n") + "\r\n");
  try {
    const resolved = resolveClaudeCliPath(cmd);
    expect(resolved).toBe(resolve(exe));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
