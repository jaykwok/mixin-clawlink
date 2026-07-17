/**
 * 密信 IM 消息管道：入站解析(HMAC/去重/anti-loop) + 出站发送(文本/文件上传/下载)。
 * 覆盖消息收发与文件上传下载；当前使用明文模式（不含量子加密）。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { get } from "node:https";
import { cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import { inferMsgType } from "../mime.ts";
import type { TokenManager } from "./auth.ts";

const log = getLogger("im");

const SUCCESS_CODES = [0, 200];
const DEDUP_TTL_S = 30; // 内容指纹去重窗口：平台可能用不同 msgUid 重发同一条

export interface InboundMessage {
  messageId: string;
  chatId: string; // groupId 或 userId（回复时用）
  senderId: string; // 发送者 userId（回复的 receive_id）
  msgType: string; // text/markdown/image/file/voice/video
  text: string;
  fileId?: string | null;
  fileName?: string | null;
}

function mask(s: string): string {
  return s.length > 8 ? s.slice(0, 6) + "***" : "***";
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class MessagePipe {
  private readonly tm: TokenManager;
  private seen = new Map<string, true>(); // msgUid 去重
  private recent = new Map<string, number>(); // 内容指纹去重(带 TTL)

  constructor(tm: TokenManager) {
    this.tm = tm;
  }

  async aclose(): Promise<void> {
    /* 全局 fetch 无需关闭；保留方法与生命周期对称 */
  }

  // ── 入站 ────────────────────────────────────────────────────────
  async parseInbound(raw: string): Promise<InboundMessage | null> {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      log.warn("WS 帧 JSON 解析失败");
      return null;
    }

    // HMAC 验签（仅当三个 X-CTQ-* 字段都在时）
    const ts = frame["X-CTQ-Timestamp"];
    const nonce = frame["X-CTQ-Nonce"];
    const sig = frame["X-CTQ-Signature"];
    if (ts && nonce && sig) {
      const token = await this.tm.get();
      const expected = createHmac("sha256", token)
        .update(`${ts}${nonce}${frame.data ?? ""}`, "utf8")
        .digest("hex");
      if (!safeEqualStr(expected, String(sig))) {
        log.warn("HMAC 验签失败，丢弃该帧");
        return null;
      }
    }

    const dataStr = frame.data;
    if (typeof dataStr !== "string") return null;
    let cb: any;
    try {
      cb = JSON.parse(dataStr);
    } catch {
      log.warn("callback data 解析失败");
      return null;
    }

    if (cb.eventType !== "callback:direct") {
      log.debug("忽略非目标事件: %s", cb.eventType);
      return null;
    }

    const msgUid = cb.msgUid ?? "";
    const senderId = cb.userId ?? "";
    if (cfg.BOT_USER_ID && senderId === cfg.BOT_USER_ID) return null; // anti-loop
    if (msgUid && this.isDuplicate(msgUid)) {
      log.debug("重复消息已跳过: %s", msgUid);
      return null;
    }

    const msgType: string = cb.type ?? "text";
    const content = cb.content ?? {};
    const chatId = cb.groupId || senderId;

    if (this.isRecent(this.fingerprint(senderId, msgType, content))) {
      log.info("内容去重，跳过重复投递: sender=%s type=%s", mask(senderId), msgType);
      return null;
    }

    if (msgType === "text") {
      const text = typeof content === "object" && content ? content.content ?? "" : String(content);
      return { messageId: msgUid, chatId, senderId, msgType: "text", text };
    }
    if (msgType === "markdown") {
      const title = (typeof content === "object" && content ? content.title : "") ?? "";
      const body = typeof content === "object" && content ? content.content ?? "" : String(content);
      const text = title ? `# ${title}\n${body}` : body;
      return { messageId: msgUid, chatId, senderId, msgType: "markdown", text };
    }

    // 媒体消息
    const fileId = typeof content === "object" && content ? content.fileId : null;
    const alt = (typeof content === "object" && content ? content.altText ?? content.fileName : "") ?? "";
    return {
      messageId: msgUid, chatId, senderId, msgType, text: alt,
      fileId: fileId ?? null, fileName: alt || null,
    };
  }

  private isDuplicate(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.set(key, true);
    while (this.seen.size > cfg.DEDUP_MAX) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
    return false;
  }

  private fingerprint(senderId: string, msgType: string, content: any): string {
    if (content && typeof content === "object") {
      if (content.fileId) return `${senderId}:${msgType}:${content.fileId}`;
      return `${senderId}:${msgType}:${String(content.content ?? "").slice(0, 200)}`;
    }
    return `${senderId}:${msgType}:${String(content).slice(0, 200)}`;
  }

  private isRecent(key: string): boolean {
    const now = Date.now() / 1000;
    while (this.recent.size) {
      const [k, t] = this.recent.entries().next().value as [string, number];
      if (now - t > DEDUP_TTL_S) this.recent.delete(k);
      else break;
    }
    if (this.recent.has(key)) return true;
    this.recent.set(key, now);
    while (this.recent.size > cfg.DEDUP_MAX) {
      const first = this.recent.keys().next().value;
      if (first === undefined) break;
      this.recent.delete(first);
    }
    return false;
  }

  // ── 出站：HTTP API（Bearer）─────────────────────────────────────
  private async apiPost(path: string, body: Record<string, unknown>, retryOn401 = true): Promise<any | null> {
    const url = `${cfg.API_BASE}${path}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.tm.get();
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000),
        });
      } catch (e) {
        log.warn("%s 网络错误: %s", path, (e as Error).message);
        if (attempt === 2) return null;
        continue;
      }
      if (resp.status === 401 && retryOn401) {
        log.warn("%s 收到 401，失效 token 重试", path);
        this.tm.invalidate();
        continue;
      }
      if (resp.status >= 500) {
        log.warn("%s 服务端错误 %d", path, resp.status);
        if (attempt === 2) return null;
        continue;
      }
      if (resp.status !== 200) {
        log.error("%s HTTP %d: %s", path, resp.status, (await resp.text().catch(() => "")).slice(0, 300));
        return null;
      }
      const data: any = await resp.json();
      if (!SUCCESS_CODES.includes(data.code) && data.success !== true) {
        log.error("%s 业务错误 code=%s msg=%s", path, data.code, data.msg);
        return null;
      }
      return data;
    }
    return null;
  }

  /** 文件服务响应是 {code,msg/success,data:{...}} 信封；拆出 data。消息 API 无此层则原样。 */
  private static payload(envelope: any): any {
    if (envelope && typeof envelope === "object" && envelope.data && typeof envelope.data === "object") {
      return envelope.data;
    }
    return envelope && typeof envelope === "object" ? envelope : {};
  }

  async sendText(receiveId: string, text: string): Promise<boolean> {
    // 统一发 markdown：agent 回复本质是 markdown（表格/代码块/列表），text 类型不渲染。
    const msgType = "markdown";
    const content = JSON.stringify({ content: text });
    const ok = await this.apiPost("/messages/v1/send", { receive_id: receiveId, msg_type: msgType, content });
    if (ok) log.info("📤 已发送 %s → %s", msgType, mask(receiveId));
    return !!ok;
  }

  async sendTip(receiveId: string, text: string): Promise<void> {
    try {
      await this.sendText(receiveId, text);
    } catch (e) {
      log.error("发送提示失败: %s", (e as Error).message);
    }
  }

  // ── 出站：文件上传/下载 ─────────────────────────────────────────
  async uploadFile(data: Buffer, fileName: string, mimeType: string): Promise<string | null> {
    const maxBytes = cfg.MAX_FILE_MB * 1024 * 1024;
    if (data.length > maxBytes) {
      log.error("文件 %sMB 超过上限 %dMB", (data.length / 1048576).toFixed(1), cfg.MAX_FILE_MB);
      return null;
    }
    const fileHash = createHash("md5").update(data).digest("hex");
    const init = await this.apiPost("/files/upload/init", {
      fileName, fileSize: data.length, mimeType, fileHash,
      chunkSize: cfg.UPLOAD_CHUNK_MB * 1024 * 1024, category: 1,
    });
    if (!init) return null;
    const d = MessagePipe.payload(init);
    if (d.deduplicatedHit && d.fileKey) {
      log.info("upload 秒传命中: %s", fileName);
      return d.fileKey;
    }
    const uploadId = d.uploadId;
    if (!uploadId) {
      log.error("upload init 未返回 uploadId，原始响应: %s", JSON.stringify(init));
      return null;
    }
    const parts = new Map<number, any>((d.parts ?? []).map((p: any) => [p.partNumber, p]));
    // 用 || 而非 ??：d.chunkSize 为空串/0 时也回退（parseInt("")=NaN 会让分片循环卡死）
    const chunkSize = parseInt(d.chunkSize || String(cfg.UPLOAD_CHUNK_MB * 1024 * 1024), 10);
    const completed: any[] = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      const partNo = Math.floor(i / chunkSize) + 1;
      const part = parts.get(partNo);
      if (!part) {
        log.error("分片 %d 的签名 URL 缺失", partNo);
        return null;
      }
      const chunk = data.subarray(i, i + chunkSize);
      const etag = await this.putChunk(part.uploadUrl, chunk);
      if (etag === null) return null;
      completed.push({ partNumber: partNo, etag, size: chunk.length });
    }
    const result = await this.apiPost(`/files/upload/${uploadId}/complete`, { parts: completed, fileHash });
    if (!result) return null;
    const fileKey = MessagePipe.payload(result).fileKey;
    log.info("upload 完成: %s → %s", fileName, fileKey);
    return fileKey;
  }

  private async putChunk(uploadUrl: string, chunk: Buffer): Promise<string | null> {
    // 预签名 URL，无需 Bearer；响应 ETag 头即分片签名
    try {
      const resp = await fetch(uploadUrl, { method: "PUT", body: chunk, signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000) });
      if (resp.status !== 200 && resp.status !== 204) {
        log.error("分片上传 HTTP %d: %s", resp.status, (await resp.text().catch(() => "")).slice(0, 200));
        return null;
      }
      const etag = resp.headers.get("etag") ?? "";
      return etag.replace(/^"|"$/g, "");
    } catch (e) {
      log.error("分片上传网络错误: %s", (e as Error).message);
      return null;
    }
  }

  async sendFile(receiveId: string, data: Buffer, fileName: string, mimeType: string): Promise<boolean> {
    const msgType = inferMsgType(mimeType);
    const fileKey = await this.uploadFile(data, fileName, mimeType);
    if (!fileKey) return false;
    const ext = extname(fileName).replace(/^\./, "");
    let content: Record<string, unknown>;
    if (msgType === "image") content = { fileId: fileKey, width: 0, height: 0, altText: fileName, ext };
    else if (msgType === "file") content = { fileId: fileKey, fileName, size: data.length, ext };
    else content = { fileId: fileKey, ext };
    const ok = await this.apiPost("/messages/v1/send", {
      receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content),
    });
    if (ok) log.info("📎 已发送附件 %s(%s) → %s", fileName, msgType, mask(receiveId));
    return !!ok;
  }

  async downloadFile(fileId: string): Promise<{ data: Buffer; name: string; mime: string } | null> {
    const token = await this.tm.get();
    let resp: Response;
    try {
      resp = await fetch(`${cfg.API_BASE}/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000),
      });
    } catch (e) {
      log.error("下载取址网络错误: %s", (e as Error).message);
      return null;
    }
    // 官方插件允许 302（parseResponse: !response.ok && status !== 302）
    if (!resp.ok && resp.status !== 302) {
      log.error("下载取址 HTTP %d", resp.status);
      return null;
    }
    const info = MessagePipe.payload(await resp.json());
    const fileUrl = info.fileUrl;
    if (!fileUrl) {
      log.error("下载取址未返回 fileUrl: %s", JSON.stringify(info));
      return null;
    }
    log.info("下载取址成功: fileUrl=%s", fileUrl);

    // fileUrl 是 MinIO/S3 预签名 URL（含 X-Amz 参数）
    // Node.js fetch 会自动加 Accept-Encoding 等 header，可能干扰 S3 签名验证
    // 用 https.get 精确控制 header，只发最小请求
    const buf = await downloadPresignedUrl(fileUrl);
    if (!buf) {
      log.error("下载文件最终失败");
      return null;
    }

    const name = info.fileName ?? fileId;
    const mime = info.mimeType ?? "application/octet-stream";
    log.info("📥 已下载附件 %s (%sKB)", name, (buf.length / 1024).toFixed(1));
    return { data: buf, name, mime };
  }
}

/**
 * 用 node:https 精确控制 header 下载 S3/MinIO 预签名 URL。
 * Node.js fetch 会自动加 Accept、Accept-Encoding 等 header，可能干扰 S3 签名验证。
 * https.get 只发最小 header，避免签名失效。
 */
function downloadPresignedUrl(url: string): Promise<Buffer | null> {
  return new Promise(resolve => {
    const req = get(url, {
      timeout: cfg.HTTP_TIMEOUT * 1000,
      headers: { "User-Agent": "Mixin-ClawLink/1.0" },
    }, resp => {
      // 跟随重定向
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        downloadPresignedUrl(resp.headers.location).then(resolve);
        return;
      }
      if (resp.statusCode !== 200) {
        const body: Buffer[] = [];
        resp.on("data", (c: Buffer) => body.push(c));
        resp.on("end", () => {
          const errText = Buffer.concat(body).toString("utf8").slice(0, 500);
          log.error("https.get 下载失败: HTTP %d | body: %s", resp.statusCode, errText);
          resolve(null);
        });
        return;
      }
      const chunks: Buffer[] = [];
      resp.on("data", (c: Buffer) => chunks.push(c));
      resp.on("end", () => resolve(Buffer.concat(chunks)));
      resp.on("error", e => { log.error("https.get 流错误: %s", e.message); resolve(null); });
    });
    req.on("error", e => { log.error("https.get 请求错误: %s", e.message); resolve(null); });
    req.on("timeout", () => { req.destroy(); log.error("https.get 超时"); resolve(null); });
  });
}
