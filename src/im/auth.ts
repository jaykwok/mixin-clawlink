/**
 * OAuth client_credentials 鉴权 + token 缓存、提前刷新与 401 失效处理。
 * 并发 get() 用 Promise 链序列化，避免重复取 token（等价 Python asyncio.Lock）。
 */
import { cfg } from "../config.ts";
import { getLogger } from "../logger.ts";

const log = getLogger("auth");

export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private invalidated = false;
  private refreshing = false;
  private chain: Promise<void> = Promise.resolve();

  private async fetchToken(): Promise<string> {
    const resp = await fetch(`${cfg.API_BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.APP_ID,
        client_secret: cfg.APP_SECRET,
        scope: "client_credentials refresh_token",
      }),
      signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT * 1000),
    });
    if (!resp.ok) throw new Error(`/auth/token HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error(`/auth/token 未返回 access_token: ${JSON.stringify(data)}`);
    this.token = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000 - cfg.TOKEN_REFRESH_LEAD_S * 1000;
    this.invalidated = false;
    log.info("access_token 已获取 (expires_in=%ss)", data.expires_in ?? 7200);
    return this.token;
  }

  /** 返回有效 token；并发调用共享同一次 fetch。 */
  async get(): Promise<string> {
    const run = this.chain
      .catch(() => {})
      .then(async () => {
        if (this.token && !this.invalidated && Date.now() < this.expiresAt) return this.token;
        this.refreshing = true;
        try {
          return await this.fetchToken();
        } finally {
          this.refreshing = false;
        }
      });
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 收到 401 时调用，强制下次 get() 重新获取。 */
  invalidate(): void {
    this.invalidated = true;
  }

  /** 供 TUI 状态栏：token 是否有效 / 是否刷新中 / 剩余秒数。 */
  getStatus(): { valid: boolean; refreshing: boolean; expiresIn: number } {
    const valid = !!this.token && !this.invalidated && Date.now() < this.expiresAt;
    return { valid, refreshing: this.refreshing, expiresIn: Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000)) };
  }
}
