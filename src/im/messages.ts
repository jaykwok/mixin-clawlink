/**
 * 密信 IM 消息管道：入站解析(HMAC/去重/anti-loop) + 出站发送(文本/文件上传/下载)。
 * 覆盖消息收发与文件上传下载；当前使用明文模式（不含量子加密）。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { cfg } from "../config.ts";
import { getLogger } from "../logger.ts";
import { inferMsgType } from "../mime.ts";
import type { TokenManager } from "./auth.ts";

const log = getLogger("im");

const SUCCESS_CODES = [0, 200];
const DEDUP_TTL_S = 30; // 内容指纹去重窗口：平台可能用不同 msgUid 重发同一条

export interface InboundMessage {
  senderId: string; // 私聊回复的 receive_id，也是会话隔离键
  text: string;
  fileId?: string | null;
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

  // ── 入站 ────────────────────────────────────────────────────────
  async parseInbound(raw: string): Promise<InboundMessage | null> {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      log.warn("WS 帧 JSON 解析失败");
      return null;
    }

    const dataStr = frame.data;
    if (typeof dataStr !== "string") return null;

    // HMAC 验签（仅当三个 X-CTQ-* 字段都在时）
    const ts = frame["X-CTQ-Timestamp"];
    const nonce = frame["X-CTQ-Nonce"];
    const sig = frame["X-CTQ-Signature"];
    if (ts && nonce && sig) {
      const token = await this.tm.get();
      const expected = createHmac("sha256", token)
        .update(`${ts}${nonce}${dataStr}`, "utf8")
        .digest("hex");
      if (!safeEqualStr(expected, String(sig))) {
        log.warn("HMAC 验签失败，丢弃该帧");
        return null;
      }
    }

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

    const msgUid = typeof cb.msgUid === "string" ? cb.msgUid : "";
    const senderId = typeof cb.userId === "string" ? cb.userId.trim() : "";
    if (!senderId) {
      log.warn("direct callback 缺少 userId，已丢弃");
      return null;
    }
    if (cfg.BOT_USER_ID && senderId === cfg.BOT_USER_ID) return null; // anti-loop
    if (msgUid && this.isDuplicate(msgUid)) {
      log.debug("重复消息已跳过: %s", msgUid);
      return null;
    }

    const msgType = typeof cb.type === "string" ? cb.type.toLowerCase() : "text";
    const content = cb.content ?? {};
    // 斜杠命令不走内容去重：用户可能连续点 /list /status 等，靠 msgUid 防 WS 重投即可
    const rawText = typeof content === "object" && content ? String(content.content ?? "") : String(content);
    const isCommand = msgType === "text" && rawText.trim().startsWith("/");
    if (!isCommand && this.isRecent(this.fingerprint(senderId, msgType, content))) {
      log.info("内容去重，跳过重复投递: sender=%s type=%s", mask(senderId), msgType);
      return null;
    }

    if (msgType === "text") {
      const text = typeof content === "object" && content ? String(content.content ?? "") : String(content);
      return { senderId, text };
    }
    if (msgType === "markdown") {
      const title = String((typeof content === "object" && content ? content.title : "") ?? "");
      const body = typeof content === "object" && content ? String(content.content ?? "") : String(content);
      const text = title ? `# ${title}\n${body}` : body;
      return { senderId, text };
    }

    // 媒体消息
    if (!["image", "file", "voice", "video"].includes(msgType)) {
      log.debug("忽略不支持的消息类型: %s", msgType);
      return null;
    }
    const fileId = typeof content === "object" && content ? content.fileId : null;
    if (typeof fileId !== "string" || !fileId.trim()) {
      log.warn("%s 消息缺少 fileId，已丢弃", msgType);
      return null;
    }
    const alt = (typeof content === "object" && content ? content.altText ?? content.fileName : "") ?? "";
    return {
      senderId, text: String(alt), fileId: fileId.trim(),
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
    const payload = content && typeof content === "object"
      ? content.fileId ? `file:${content.fileId}` : JSON.stringify(content)
      : String(content);
    const digest = createHash("sha256").update(payload).digest("hex");
    return `${senderId}:${msgType}:${digest}`;
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
  private async apiPost(path: string, body: Record<string, unknown>): Promise<any | null> {
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
      if (resp.status === 401) {
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
      let data: any;
      try {
        data = await resp.json();
      } catch (error) {
        log.error("%s 响应不是有效 JSON: %s", path, (error as Error).message);
        return null;
      }
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
    if (d.deduplicatedHit && typeof d.fileKey === "string" && d.fileKey) {
      log.info("upload 秒传命中: %s", fileName);
      return d.fileKey;
    }
    const uploadId = typeof d.uploadId === "string" ? d.uploadId : "";
    if (!uploadId) {
      log.error("upload init 未返回 uploadId，原始响应: %s", JSON.stringify(init));
      return null;
    }
    if (!Array.isArray(d.parts)) {
      log.error("upload init 未返回 parts 数组");
      return null;
    }
    const parts = new Map<number, any>(d.parts.map((p: any) => [p.partNumber, p]));
    const configuredChunkSize = cfg.UPLOAD_CHUNK_MB * 1024 * 1024;
    const advertisedChunkSize = Number.parseInt(String(d.chunkSize ?? ""), 10);
    // 无效、0 或负数都会让分片循环失效；统一回退到本地配置。
    const chunkSize = Number.isFinite(advertisedChunkSize) && advertisedChunkSize > 0
      ? advertisedChunkSize
      : configuredChunkSize;
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
    const result = await this.apiPost(`/files/upload/${encodeURIComponent(uploadId)}/complete`, { parts: completed, fileHash });
    if (!result) return null;
    const fileKey = MessagePipe.payload(result).fileKey;
    if (typeof fileKey !== "string" || !fileKey) {
      log.error("upload complete 未返回 fileKey");
      return null;
    }
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
      const normalized = etag.replace(/^"|"$/g, "");
      if (!normalized) {
        log.error("分片上传成功但响应缺少 ETag");
        return null;
      }
      return normalized;
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
    const endpoint = `${cfg.API_BASE}/files/${encodeURIComponent(fileId)}/download`;
    let info: any = {};
    let fileUrl = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.tm.get();
      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000),
        });
      } catch (e) {
        log.error("下载取址网络错误: %s", (e as Error).message);
        return null;
      }
      if (resp.status === 401 && attempt === 1) {
        this.tm.invalidate();
        continue;
      }
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (location) {
          try {
            fileUrl = new URL(location, endpoint).toString();
          } catch (error) {
            log.error("下载取址返回无效跳转地址: %s", (error as Error).message);
            return null;
          }
        }
      } else if (resp.ok) {
        try {
          info = MessagePipe.payload(await resp.json());
          fileUrl = typeof info.fileUrl === "string" ? info.fileUrl : "";
        } catch (error) {
          log.error("下载取址响应不是有效 JSON: %s", (error as Error).message);
          return null;
        }
      } else {
        log.error("下载取址 HTTP %d", resp.status);
        return null;
      }
      break;
    }
    if (!fileUrl) {
      log.error("下载取址未返回 fileUrl");
      return null;
    }
    // 不记录预签名 URL 或完整响应，避免把签名参数写入日志。
    log.info("下载取址成功");

    // 预签名 URL 无需鉴权；原样请求，路径签名不允许客户端重写。
    let fresp: Response;
    try {
      fresp = await fetch(fileUrl, {
        signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000),
      });
      if (!fresp.ok) throw new Error(`HTTP ${fresp.status}`);
    } catch (e) {
      log.error("下载文件失败: %s", (e as Error).message);
      return null;
    }

    const maxBytes = cfg.MAX_FILE_MB * 1024 * 1024;
    const buf = await this.readLimited(fresp, maxBytes);
    if (!buf) return null;
    const name = typeof info.fileName === "string" && info.fileName.trim() ? info.fileName : fileId;
    const mime = typeof info.mimeType === "string" && info.mimeType.trim()
      ? info.mimeType
      : fresp.headers.get("content-type") ?? "application/octet-stream";
    log.info("📥 已下载附件 %s (%sKB)", name, (buf.length / 1024).toFixed(1));
    return { data: buf, name, mime };
  }

  private async readLimited(resp: Response, maxBytes: number): Promise<Buffer | null> {
    const declared = Number.parseInt(resp.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      log.error("下载文件 %sMB 超过上限 %dMB", (declared / 1048576).toFixed(1), cfg.MAX_FILE_MB);
      return null;
    }
    if (!resp.body) return Buffer.alloc(0);
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          log.error("下载文件超过 %dMB 上限，已中止", cfg.MAX_FILE_MB);
          return null;
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      log.error("读取下载内容失败: %s", (error as Error).message);
      return null;
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
  }
}
