import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compareAgyVersions, latestConversationId } from "../src/agents/agy-cli.ts";

test("compareAgyVersions 按 semver 三段比较 1.1.5 能力门槛", () => {
  expect(compareAgyVersions("1.1.4", "1.1.5")).toBe(-1);
  expect(compareAgyVersions("1.1.5", "1.1.5")).toBe(0);
  expect(compareAgyVersions("1.2.0", "1.1.5")).toBe(1);
});

/**
 * 构造一个临时 HOME，里面放 agy 的 cache 文件，验证 latestConversationId 的孤儿过滤。
 * agy-cli.ts 用 homedir() 读 ~/.gemini/antigravity-cli；测试前临时改 HOME/USERPROFILE 指向临时目录。
 */
function withTempHome(fn: (home: string) => void): void {
  const home = join(tmpdir(), `mixin-agy-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

test("latestConversationId 按 workspace 精确命中缓存", () => {
  withTempHome(home => {
    const cacheDir = resolve(home, ".gemini", "antigravity-cli", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const ws = "D:\\mixin-clawlink\\workspace";
    const uuid = "83dc0480-8177-4a28-b2d4-606cfed50e5b";
    writeFileSync(join(cacheDir, "last_conversations.json"), JSON.stringify({ [ws]: uuid }));
    // metadata 含该 uuid → 存活 → 返回
    writeFileSync(join(cacheDir, "conversation_metadata.json"),
      JSON.stringify({ conversations: { [uuid]: { summary: { ID: uuid } } } }));
    expect(latestConversationId(ws)).toBe(uuid);
  });
});

test("缓存命中但 uuid 在 metadata 中不存在 → 视为孤儿返回 null", () => {
  withTempHome(home => {
    const cacheDir = resolve(home, ".gemini", "antigravity-cli", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const ws = "D:\\mixin-clawlink\\workspace";
    const orphanUuid = "00000000-0000-0000-0000-000000000000";
    writeFileSync(join(cacheDir, "last_conversations.json"), JSON.stringify({ [ws]: orphanUuid }));
    // metadata 只含另一个 uuid，orphanUuid 不在 → 孤儿
    writeFileSync(join(cacheDir, "conversation_metadata.json"),
      JSON.stringify({ conversations: { "11111111-1111-1111-1111-111111111111": {} } }));
    expect(latestConversationId(ws)).toBeNull();
  });
});

test("agy 1.1.5 metadata 滞后但 conversation db 存在时仍可续接", () => {
  withTempHome(home => {
    const dataDir = resolve(home, ".gemini", "antigravity-cli");
    const cacheDir = resolve(dataDir, "cache");
    const conversationsDir = resolve(dataDir, "conversations");
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(conversationsDir, { recursive: true });
    const ws = "D:\\网信安";
    const uuid = "72ada736-4755-4edf-861d-d9dae9d0fdf9";
    writeFileSync(join(cacheDir, "last_conversations.json"), JSON.stringify({ [ws]: uuid }));
    writeFileSync(join(cacheDir, "conversation_metadata.json"), JSON.stringify({ conversations: {} }));
    writeFileSync(join(conversationsDir, `${uuid}.db`), "agy conversation db placeholder");
    expect(latestConversationId(ws)).toBe(uuid);
  });
});

test("metadata 文件缺失时不阻断（宽松放行，兼容旧版 agy）", () => {
  withTempHome(home => {
    const cacheDir = resolve(home, ".gemini", "antigravity-cli", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const ws = "D:\\mixin-clawlink\\workspace";
    const uuid = "83dc0480-8177-4a28-b2d4-606cfed50e5b";
    writeFileSync(join(cacheDir, "last_conversations.json"), JSON.stringify({ [ws]: uuid }));
    // 不写 conversation_metadata.json → 宽松校验仍返回
    expect(latestConversationId(ws)).toBe(uuid);
  });
});
