import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { compareAgyVersions, resolveAgyCliPath } from "../src/agents/agy-cli.ts";

test("compareAgyVersions 按 semver 三段比较 1.1.10 能力门槛", () => {
  expect(compareAgyVersions("1.1.9", "1.1.10")).toBe(-1);
  expect(compareAgyVersions("1.1.10", "1.1.10")).toBe(0);
  expect(compareAgyVersions("1.2.0", "1.1.10")).toBe(1);
});

test("显式存在的 CLI 路径会被规范化返回", () => {
  const currentFile = fileURLToPath(import.meta.url);
  expect(resolveAgyCliPath(currentFile)).toBe(currentFile);
  expect(resolveAgyCliPath(dirname(currentFile))).toBeNull();
});
