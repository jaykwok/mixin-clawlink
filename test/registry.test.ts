import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registry } from "../src/session/registry.ts";

// registry 的 ROOT 是相对 cwd 的 data/conversations；chdir 到临时目录隔离，避免污染真实数据
let tmpDir: string;
let origCwd: string;
beforeAll(() => {
  tmpDir = join(tmpdir(), `mixin-reg-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
});
afterAll(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("deleteSessions 删光后自动新开一个会话（保持 ≥1）", async () => {
  const uid = "u-delall";
  await registry.newSession(uid);
  expect((await registry.listSessions(uid)).length).toBe(1);
  const { deleted, remaining, deletedNums } = await registry.deleteSessions(uid, [1]);
  expect(deleted).toBe(1);
  expect(remaining).toBe(1); // 删光后自动建新，仍 ≥1
  expect(deletedNums).toEqual([1]);
  expect((await registry.listSessions(uid)).length).toBe(1);
});

test("listSessions 首次调用保证 ≥1 会话（ensure）", async () => {
  const uid = "u-fresh";
  const list = await registry.listSessions(uid);
  expect(list.length).toBeGreaterThanOrEqual(1);
});

test("deleteSessions 删不存在的编号返回 deleted=0", async () => {
  const uid = "u-nosuch";
  await registry.newSession(uid);
  const { deleted, remaining } = await registry.deleteSessions(uid, [99]);
  expect(deleted).toBe(0);
  expect(remaining).toBe(1);
});

test("deleteSessions 删当前活动会话后新开一个并切到它", async () => {
  const uid = "u-active";
  await registry.newSession(uid); // 1
  await registry.newSession(uid); // 2（active）
  const { deleted, activeDeleted, remaining } = await registry.deleteSessions(uid, [2]);
  expect(deleted).toBe(1);
  expect(activeDeleted).toBe(true);
  expect(remaining).toBe(2); // 剩会话1 + 新开的1个
  const list = await registry.listSessions(uid);
  expect(list.length).toBe(2);
  expect(list.find(s => s.active)).toBeDefined();
});

test("deleteSessions 删非活动会话不影响 active", async () => {
  const uid = "u-keepactive";
  await registry.newSession(uid); // 1
  await registry.newSession(uid); // 2（active）
  const { activeDeleted, remaining } = await registry.deleteSessions(uid, [1]); // 删非active
  expect(activeDeleted).toBe(false);
  expect(remaining).toBe(1); // 只剩会话2
  const list = await registry.listSessions(uid);
  expect(list.length).toBe(1);
  expect(list[0].active).toBe(true); // 会话2仍是active
});
