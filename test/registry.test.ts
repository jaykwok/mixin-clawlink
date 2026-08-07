import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("本轮绑定槽位代次，reset 后旧任务不能把 session 写回来", async () => {
  const uid = "u-generation";
  const workspace = join(tmpDir, "workspace-a");
  const turn = await registry.beginTurn(uid, "antigravity", workspace, "第一轮");
  await registry.resetSession(uid, "antigravity", workspace);
  expect(await registry.finishTurn(uid, turn, "stale-conversation-id")).toBeFalse();

  const next = await registry.beginTurn(uid, "antigravity", workspace, "新一轮");
  expect(next.sessionId).toBeNull();
  expect(await registry.finishTurn(uid, next, "fresh-conversation-id")).toBeTrue();
  expect((await registry.listSessions(uid))[0]).toMatchObject({ agent: "antigravity", turns: 1 });
});

test("切换 agent 或工作目录时不复用不兼容的原生 session", async () => {
  const uid = "u-scope";
  const workspaceA = join(tmpDir, "workspace-a");
  const workspaceB = join(tmpDir, "workspace-b");
  const agyTurn = await registry.beginTurn(uid, "agy", workspaceA, "agy 请求");
  await registry.finishTurn(uid, agyTurn, "agy-conversation-id");

  const claudeTurn = await registry.beginTurn(uid, "claude", workspaceA, "Claude 请求");
  expect(claudeTurn.sessionId).toBeNull();
  await registry.finishTurn(uid, claudeTurn, "claude-session-id");

  const moved = await registry.beginTurn(uid, "claude", workspaceB, "新目录请求");
  expect(moved.sessionId).toBeNull();
  expect(moved.generation).toBeGreaterThan(claudeTurn.generation);
});

test("损坏的会话索引显式报错，不静默覆盖为新索引", async () => {
  const uid = "u-corrupt";
  const dir = join(tmpDir, "data", "conversations", uid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), "{not-json", "utf8");
  await expect(registry.listSessions(uid)).rejects.toThrow("读取会话索引失败");
});

test("结构正确但槽位字段损坏的索引也显式报错", async () => {
  const uid = "u-invalid-slot";
  const dir = join(tmpDir, "data", "conversations", uid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify({ active: null, sessions: [null] }), "utf8");
  await expect(registry.listSessions(uid)).rejects.toThrow("sessions[0] 必须是对象");
});

test("同一用户并发新建会话不会因索引读改写竞态丢失", async () => {
  const uid = "u-concurrent";
  await Promise.all(Array.from({ length: 20 }, () => registry.newSession(uid, "antigravity", tmpDir)));
  expect(await registry.listSessions(uid)).toHaveLength(20);
});
