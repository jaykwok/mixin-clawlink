import { expect, test } from "bun:test";
import { MessagePipe } from "../src/im/messages.ts";

function makePipe(): MessagePipe {
  return new MessagePipe({} as never);
}

function directCallback(payload: Record<string, unknown>): string {
  return JSON.stringify({ data: JSON.stringify({ eventType: "callback:direct", ...payload }) });
}

test("入站事件规范化正文，并拒绝空用户、未知类型和缺 fileId 的媒体", async () => {
  const pipe = makePipe();
  await expect(pipe.parseInbound(directCallback({ userId: "u-text", type: "text", content: { content: 42 } })))
    .resolves.toEqual({ senderId: "u-text", text: "42" });
  await expect(pipe.parseInbound(directCallback({ userId: "", type: "text", content: { content: "x" } })))
    .resolves.toBeNull();
  await expect(pipe.parseInbound(directCallback({ userId: "u-unknown", type: "reaction", content: {} })))
    .resolves.toBeNull();
  await expect(pipe.parseInbound(directCallback({ userId: "u-file", type: "file", content: {} })))
    .resolves.toBeNull();
});

test("长消息去重使用完整内容，前 200 字相同也不会误判", () => {
  const pipe = makePipe() as any;
  const prefix = "x".repeat(240);
  const first = pipe.fingerprint("user", "text", { content: `${prefix}-a` });
  const second = pipe.fingerprint("user", "text", { content: `${prefix}-b` });
  expect(first).not.toBe(second);
});

test("下载流没有 Content-Length 时仍执行实际大小上限", async () => {
  const pipe = makePipe() as any;
  const response = new Response("123456");
  await expect(pipe.readLimited(response, 5)).resolves.toBeNull();
});

test("下载流读取中断时返回 null 而不是向上抛出", async () => {
  const pipe = makePipe() as any;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("stream interrupted"));
    },
  });
  await expect(pipe.readLimited(new Response(body), 1024)).resolves.toBeNull();
});
