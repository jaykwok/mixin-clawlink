/**
 * 多会话注册表：编号 ↔ {claude sessionId, title, created, turns} 映射。
 *
 * 不再存对话回合内容（JSONL）——记忆交给 SDK 原生 resume：
 * 每个槽位存一个 claude session_id，/use 切换后 agents/claude.ts 把它作为
 * options.resume 传进去即可恢复全量上下文。布局：data/conversations/<userId>/index.json
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { safeName } from "./workspace.ts";

const ROOT = "data/conversations";
const PLACEHOLDER = "(新会话)";

interface Slot {
  id: string;            // 槽位 id（稳定标识）
  sessionId: string | null; // claude 的 session_id（首轮 query 后回写；resume 用）
  title: string;
  created: number;       // ms epoch
  turns: number;
}
interface Index { active: string | null; sessions: Slot[]; }

export interface SessionInfo {
  num: number;
  title: string;
  turns: number;
  active: boolean;
}

function emptyIndex(): Index {
  return { active: null, sessions: [] };
}

function newSlotId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

class Registry {
  private dir(uid: string): string {
    return resolve(ROOT, safeName(uid));
  }
  private indexPath(uid: string): string {
    return resolve(this.dir(uid), "index.json");
  }

  private async read(uid: string): Promise<Index> {
    try {
      const idx = JSON.parse(await readFile(this.indexPath(uid), "utf8")) as Index;
      if (!Array.isArray(idx.sessions)) idx.sessions = [];
      return idx;
    } catch {
      return emptyIndex();
    }
  }

  private async write(uid: string, idx: Index): Promise<void> {
    await mkdir(this.dir(uid), { recursive: true });
    await writeFile(this.indexPath(uid), JSON.stringify(idx), "utf8");
  }

  /** 确保有 active 槽位（没有就建一个）；active 失效则指向最近一个。 */
  private async ensure(uid: string): Promise<Index> {
    const idx = await this.read(uid);
    let changed = false;
    if (idx.sessions.length === 0) {
      idx.sessions.push({ id: newSlotId(), sessionId: null, title: PLACEHOLDER, created: Date.now(), turns: 0 });
      idx.active = idx.sessions[0].id;
      changed = true;
    } else if (!idx.active || !idx.sessions.some(s => s.id === idx.active)) {
      idx.active = idx.sessions[idx.sessions.length - 1].id;
      changed = true;
    }
    if (changed) await this.write(uid, idx);
    return idx;
  }

  private activeSlot(uid: string, idx: Index): Slot | undefined {
    return idx.sessions.find(s => s.id === idx.active);
  }

  /** 当前槽位的 claude session_id（供 claude.ts 做 resume）。 */
  async getActiveSessionId(uid: string): Promise<string | null> {
    const idx = await this.ensure(uid);
    return this.activeSlot(uid, idx)?.sessionId ?? null;
  }

  /** 收到用户消息：若是首条则把标题设为消息内容。 */
  async noteUser(uid: string, text: string): Promise<void> {
    if (!text) return;
    const idx = await this.ensure(uid);
    const s = this.activeSlot(uid, idx);
    if (s && (s.title === PLACEHOLDER || s.title === "(已清空)")) {
      s.title = text.slice(0, 30);
      await this.write(uid, idx);
    }
  }

  /** agent 回复完成：回写 claude session_id，轮数 +1。 */
  async finishTurn(uid: string, claudeSessionId: string): Promise<void> {
    const idx = await this.ensure(uid);
    const s = this.activeSlot(uid, idx);
    if (s) {
      s.sessionId = claudeSessionId;
      s.turns += 1;
      await this.write(uid, idx);
    }
  }

  /** 新建槽位并切到它。返回编号。 */
  async newSession(uid: string): Promise<number> {
    const idx = await this.read(uid);
    idx.sessions.push({ id: newSlotId(), sessionId: null, title: PLACEHOLDER, created: Date.now(), turns: 0 });
    idx.active = idx.sessions[idx.sessions.length - 1].id;
    await this.write(uid, idx);
    return idx.sessions.length;
  }

  async listSessions(uid: string): Promise<SessionInfo[]> {
    // ensure：保证 ≥1 会话，/list 永远有内容可显示（避免 0 会话时无回应）
    const idx = await this.ensure(uid);
    return idx.sessions.map((s, i) => ({ num: i + 1, title: s.title, turns: s.turns, active: s.id === idx.active }));
  }

  /** 按编号获取会话的 claude sessionId（供 TUI 拉取对话历史）。 */
  async getSessionIdByNum(uid: string, num: number): Promise<string | null> {
    const idx = await this.read(uid);
    if (num >= 1 && num <= idx.sessions.length) {
      return idx.sessions[num - 1].sessionId;
    }
    return null;
  }

  /** 枚举所有已知用户（扫 data/conversations/ 子目录名；供 TUI 用户面板）。 */
  async listUsers(): Promise<string[]> {
    try {
      const entries = await readdir(ROOT, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch {
      return [];
    }
  }

  /** 切到编号 num 的槽位。返回是否成功。 */
  async switchSession(uid: string, num: number): Promise<boolean> {
    const idx = await this.read(uid);
    if (num >= 1 && num <= idx.sessions.length) {
      idx.active = idx.sessions[num - 1].id;
      await this.write(uid, idx);
      return true;
    }
    return false;
  }

  /** 清空当前槽位（换一个新 claude session = 重开）。 */
  async resetSession(uid: string): Promise<void> {
    const idx = await this.ensure(uid);
    const s = this.activeSlot(uid, idx);
    if (s) {
      s.sessionId = null;
      s.title = "(已清空)";
      s.turns = 0;
      await this.write(uid, idx);
    }
  }

  /** 按编号删除（从大到小删，避免索引错位）。删的是当前活动会话时，统一行为：新开一个并切到它。 */
  async deleteSessions(uid: string, nums: number[]): Promise<{ deleted: number; activeDeleted: boolean; remaining: number; deletedNums: number[] }> {
    const idx = await this.read(uid);
    const sessions = idx.sessions;
    let deleted = 0;
    let activeDeleted = false;
    const deletedNums: number[] = [];
    for (const n of [...new Set(nums)].sort((a, b) => b - a)) {
      if (n >= 1 && n <= sessions.length) {
        const s = sessions.splice(n - 1, 1)[0];
        if (s.id === idx.active) activeDeleted = true;
        deleted++;
        deletedNums.push(n);
      }
    }
    if (activeDeleted) {
      // 删的是当前活动会话 → 新开一个并切到它（统一行为，而非切到剩余的某个）
      idx.sessions.push({ id: newSlotId(), sessionId: null, title: PLACEHOLDER, created: Date.now(), turns: 0 });
      idx.active = idx.sessions[idx.sessions.length - 1].id;
    } else if (!sessions.some(s => s.id === idx.active)) {
      // active 未被本次删但失效（异常状态）→ 修到最近一个；空则建新，保持 ≥1 会话
      if (sessions.length) {
        idx.active = sessions[sessions.length - 1].id;
      } else {
        idx.sessions.push({ id: newSlotId(), sessionId: null, title: PLACEHOLDER, created: Date.now(), turns: 0 });
        idx.active = idx.sessions[0].id;
      }
    }
    await this.write(uid, idx);
    return { deleted, activeDeleted, remaining: idx.sessions.length, deletedNums: deletedNums.sort((a, b) => a - b) };
  }

  async countTurns(uid: string): Promise<number> {
    const idx = await this.ensure(uid);
    return this.activeSlot(uid, idx)?.turns ?? 0;
  }
}

export const registry = new Registry();
