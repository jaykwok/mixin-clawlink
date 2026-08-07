/**
 * 多会话注册表：编号 ↔ {agent sessionId, title, created, turns} 映射。
 *
 * 不再存对话回合内容（JSONL）——记忆交给各 agent 的原生续接机制：
 * 每个槽位存一个 agent 原生 session ID，/use 切换后由当前 agent 用于续接。
 * 布局：data/conversations/<userId>/index.json
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeAgentKind } from "../agents/kind.ts";
import { safeName } from "./workspace.ts";

const ROOT = "data/conversations";
const PLACEHOLDER = "(新会话)";

interface Slot {
  id: string;            // 槽位 id（稳定标识）
  sessionId: string | null; // agent 原生 session ID（首轮 query 后回写；续接用）
  agent?: string;        // sessionId 所属 agent；旧索引首次使用时自动补齐
  workspace?: string;    // sessionId 创建时的 cwd，防止跨工作目录错误续接
  generation?: number;   // agent/cwd 变化时递增，阻止旧任务回写
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
  agent?: string;
}

export interface TurnContext {
  slotId: string;
  generation: number;
  agent: string;
  workspace: string;
  sessionId: string | null;
}

function emptyIndex(): Index {
  return { active: null, sessions: [] };
}

function newSlotId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function newSlot(agent?: string, workspace?: string): Slot {
  return {
    id: newSlotId(),
    sessionId: null,
    agent: agent ? normalizeAgentKind(agent) : undefined,
    workspace: workspace ? resolve(workspace) : undefined,
    generation: 0,
    title: PLACEHOLDER,
    created: Date.now(),
    turns: 0,
  };
}

function sameWorkspace(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resetSlot(slot: Slot, agent?: string, workspace?: string): void {
  slot.sessionId = null;
  slot.agent = agent ? normalizeAgentKind(agent) : undefined;
  slot.workspace = workspace ? resolve(workspace) : undefined;
  slot.generation = (slot.generation ?? 0) + 1;
  slot.title = PLACEHOLDER;
  slot.turns = 0;
}

function parseIndex(value: unknown): Index {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("index.json 根节点必须是对象");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sessions)) throw new Error("index.json 缺少 sessions 数组");
  const sessions = raw.sessions.map((value, index): Slot => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`sessions[${index}] 必须是对象`);
    const slot = value as Record<string, unknown>;
    if (typeof slot.id !== "string" || !slot.id) throw new Error(`sessions[${index}].id 无效`);
    if (slot.sessionId !== null && slot.sessionId !== undefined && typeof slot.sessionId !== "string") {
      throw new Error(`sessions[${index}].sessionId 无效`);
    }
    if (typeof slot.title !== "string") throw new Error(`sessions[${index}].title 无效`);
    if (typeof slot.created !== "number" || !Number.isFinite(slot.created)) throw new Error(`sessions[${index}].created 无效`);
    if (typeof slot.turns !== "number" || !Number.isInteger(slot.turns) || slot.turns < 0) {
      throw new Error(`sessions[${index}].turns 无效`);
    }
    if (slot.agent !== undefined && typeof slot.agent !== "string") throw new Error(`sessions[${index}].agent 无效`);
    if (slot.workspace !== undefined && typeof slot.workspace !== "string") throw new Error(`sessions[${index}].workspace 无效`);
    if (slot.generation !== undefined
      && (typeof slot.generation !== "number" || !Number.isInteger(slot.generation) || slot.generation < 0)) {
      throw new Error(`sessions[${index}].generation 无效`);
    }
    return {
      id: slot.id,
      sessionId: typeof slot.sessionId === "string" ? slot.sessionId : null,
      agent: slot.agent as string | undefined,
      workspace: slot.workspace as string | undefined,
      generation: slot.generation as number | undefined,
      title: slot.title,
      created: slot.created,
      turns: slot.turns,
    };
  });
  const active = typeof raw.active === "string" ? raw.active : null;
  return { active, sessions };
}

class Registry {
  private readonly locks = new Map<string, Promise<void>>();

  /** 同一用户的索引读改写必须串行，避免并发命令互相覆盖。 */
  private withLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(uid) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.then(() => {}, () => {});
    this.locks.set(uid, tail);
    void tail.finally(() => {
      if (this.locks.get(uid) === tail) this.locks.delete(uid);
    });
    return run;
  }

  private dir(uid: string): string {
    return resolve(ROOT, safeName(uid));
  }
  private indexPath(uid: string): string {
    return resolve(this.dir(uid), "index.json");
  }

  private async read(uid: string): Promise<Index> {
    try {
      return parseIndex(JSON.parse(await readFile(this.indexPath(uid), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
      throw new Error(`读取会话索引失败 ${this.indexPath(uid)}: ${(error as Error).message}`, { cause: error });
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
      idx.sessions.push(newSlot());
      idx.active = idx.sessions[0].id;
      changed = true;
    } else if (!idx.active || !idx.sessions.some(s => s.id === idx.active)) {
      idx.active = idx.sessions[idx.sessions.length - 1].id;
      changed = true;
    }
    if (changed) await this.write(uid, idx);
    return idx;
  }

  private activeSlot(idx: Index): Slot | undefined {
    return idx.sessions.find(s => s.id === idx.active);
  }

  /**
   * 为一轮请求锁定槽位和原生 session。agent 或 cwd 改变时自动开启新 session，
   * 避免把 Claude ID 交给 agy，或在另一个工作目录续接历史工具步骤。
   */
  async beginTurn(uid: string, agentName: string, workspace: string, text: string): Promise<TurnContext> {
    return this.withLock(uid, async () => {
      const idx = await this.ensure(uid);
      const s = this.activeSlot(idx);
      if (!s) throw new Error("当前会话槽位不存在");
      const agent = normalizeAgentKind(agentName);
      const cwd = resolve(workspace);
      let changed = false;
      if ((s.agent && normalizeAgentKind(s.agent) !== agent)
        || (s.workspace && !sameWorkspace(s.workspace, cwd))) {
        resetSlot(s, agent, cwd);
        changed = true;
      } else {
        if (!s.agent || s.agent !== agent) { s.agent = agent; changed = true; }
        if (!s.workspace || !sameWorkspace(s.workspace, cwd)) { s.workspace = cwd; changed = true; }
        if (s.generation === undefined) { s.generation = 0; changed = true; }
      }
      // “(已清空)”仅用于兼容旧版清空命令留下的索引标题。
      if (text && (s.title === PLACEHOLDER || s.title === "(已清空)")) {
        s.title = text.slice(0, 30);
        changed = true;
      }
      if (changed) await this.write(uid, idx);
      return {
        slotId: s.id,
        generation: s.generation ?? 0,
        agent,
        workspace: cwd,
        sessionId: s.sessionId,
      };
    });
  }

  /** 只回写发起该请求时的槽位/代次；删除或切换 agent/cwd 后的旧任务不会污染新会话。 */
  async finishTurn(uid: string, turn: TurnContext, agentSessionId: string | null): Promise<boolean> {
    return this.withLock(uid, async () => {
      const idx = await this.read(uid);
      const s = idx.sessions.find(slot => slot.id === turn.slotId);
      if (!s || (s.generation ?? 0) !== turn.generation) return false;
      if (normalizeAgentKind(s.agent ?? turn.agent) !== turn.agent) return false;
      if (s.workspace && !sameWorkspace(s.workspace, turn.workspace)) return false;
      if (agentSessionId) s.sessionId = agentSessionId;
      s.agent = turn.agent;
      s.workspace = turn.workspace;
      s.turns += 1;
      await this.write(uid, idx);
      return true;
    });
  }

  /** 新建槽位并切到它。返回编号。 */
  async newSession(uid: string, agentName?: string, workspace?: string): Promise<number> {
    return this.withLock(uid, async () => {
      const idx = await this.read(uid);
      idx.sessions.push(newSlot(agentName, workspace));
      idx.active = idx.sessions[idx.sessions.length - 1].id;
      await this.write(uid, idx);
      return idx.sessions.length;
    });
  }

  async listSessions(uid: string): Promise<SessionInfo[]> {
    return this.withLock(uid, async () => {
      // ensure：保证 ≥1 会话，/list 永远有内容可显示（避免 0 会话时无回应）
      const idx = await this.ensure(uid);
      return idx.sessions.map((s, i) => ({
        num: i + 1,
        title: s.title,
        turns: s.turns,
        active: s.id === idx.active,
        agent: s.agent ? normalizeAgentKind(s.agent) : undefined,
      }));
    });
  }

  /** 按编号获取会话的原生 agent session ID（供 TUI 拉取对话历史）。 */
  async getSessionIdByNum(uid: string, num: number, agentName?: string): Promise<string | null> {
    return this.withLock(uid, async () => {
      const idx = await this.read(uid);
      if (num >= 1 && num <= idx.sessions.length) {
        const slot = idx.sessions[num - 1];
        if (agentName && slot.agent && normalizeAgentKind(slot.agent) !== normalizeAgentKind(agentName)) return null;
        return slot.sessionId;
      }
      return null;
    });
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
    return this.withLock(uid, async () => {
      const idx = await this.read(uid);
      if (num >= 1 && num <= idx.sessions.length) {
        idx.active = idx.sessions[num - 1].id;
        await this.write(uid, idx);
        return true;
      }
      return false;
    });
  }

  /** 按编号删除（从大到小删，避免索引错位）。删的是当前活动会话时，统一行为：新开一个并切到它。 */
  async deleteSessions(uid: string, nums: number[], agentName?: string, workspace?: string): Promise<{ deleted: number; activeDeleted: boolean; remaining: number; deletedNums: number[] }> {
    return this.withLock(uid, async () => {
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
        idx.sessions.push(newSlot(agentName, workspace));
        idx.active = idx.sessions[idx.sessions.length - 1].id;
      } else if (!sessions.some(s => s.id === idx.active)) {
        // active 未被本次删但失效（异常状态）→ 修到最近一个；空则建新，保持 ≥1 会话
        if (sessions.length) {
          idx.active = sessions[sessions.length - 1].id;
        } else {
          idx.sessions.push(newSlot(agentName, workspace));
          idx.active = idx.sessions[0].id;
        }
      }
      await this.write(uid, idx);
      return { deleted, activeDeleted, remaining: idx.sessions.length, deletedNums: deletedNums.sort((a, b) => a - b) };
    });
  }

  async countTurns(uid: string): Promise<number> {
    return this.withLock(uid, async () => {
      const idx = await this.ensure(uid);
      return this.activeSlot(idx)?.turns ?? 0;
    });
  }
}

export const registry = new Registry();
