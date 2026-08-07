import { expect, test } from "bun:test";
import { ConnectionManager } from "../src/im/transport.ts";

test("stop 会立即打断重连退避，不等待完整定时器", async () => {
  const manager = new ConnectionManager({} as never, async () => {});
  const sleep = (manager as any).sleep(60_000) as Promise<void>;
  const stopped = manager.stop();
  const interrupted = await Promise.race([
    sleep.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 200)),
  ]);
  await stopped;
  expect(interrupted).toBeTrue();
});
