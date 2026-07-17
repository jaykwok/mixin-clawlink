/**
 * OpenTUI 运维面板 + 首启向导（Bun + @opentui/solid）。
 *
 * 同进程挂在 index.ts 重启循环之外：软重启只重建 Bot，TUI 渲染器不销毁、不闪退。
 * 首次运行（APP_ID/APP_SECRET 缺失）→ 设置向导；否则 → 运维面板（向导可从「操作」里重开）。
 *
 * 设计取舍（OpenTUI on Windows 未经目测，故求稳）：
 * - 全局单一 useKeyboard 派发器：列表/文本输入全手动信号驱动，不依赖组件 focus 语义。
 * - 日志用单个多行 <text>（内容整体替换），避免高频子节点 churn 触发 Windows 段错误(#1185)。
 * - renderer 自建（createCliRenderer），exitSignals:[] + exitOnCtrlC:false，退出由我们自己控。
 */
import { createCliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core";
import { render, useKeyboard, usePaste, useSelectionHandler, useRenderer } from "@opentui/solid";
import { createSignal, onMount } from "solid-js";
import { execFile } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { cfg, reload, setValue, writeEnvRaw } from "../config.ts";
import { setSuppressConsole, subscribeConsole } from "../logger.ts";
import { fetchAgentModels } from "../agents/models.ts";
import { registry } from "../session/registry.ts";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "../bot.ts";
import { cycleView, movePageSelection, numberedIndex, pageInfo, type PanelViewName } from "./navigation.ts";

// ── 配色（午夜深蓝 · 柔和层次）────────────────────────────────────
const C = {
  bg: "#080a14", header: "#0b0e1a", panel: "#0e1120", raised: "#131726",
  selected: "#1c2740",
  input: "#0a0d16",
  border: "#1a1f30", borderSoft: "#131826",
  text: "#dce4f0", dim: "#7a8aa5", subtle: "#4e5d78", faint: "#364258",
  accent: "#5b9bf5",
  violet: "#a08bf5", cyan: "#4dd4c4", green: "#3dd68c",
  yellow: "#e8c44a", red: "#f06b7e",
  ink: "#050810",
} as const;

const VIEW_META: Record<PanelViewName, { label: string; icon: string }> = {
  logs: { label: "日志", icon: "◆" },
  sessions: { label: "会话", icon: "●" },
  actions: { label: "操作", icon: "✦" },
};

// ── 状态信号（单实例，模块级）──────────────────────────────────────
const [mode, setMode] = createSignal<"wizard" | "panel">(!cfg.APP_ID || !cfg.APP_SECRET ? "wizard" : "panel");
const [agentName, setAgentName] = createSignal(cfg.AGENT);
const [wsStatus, setWsStatus] = createSignal<{ status: string; attempt: number }>({ status: "connecting", attempt: 0 });
const [authStatus, setAuthStatus] = createSignal<{ valid: boolean; refreshing: boolean; expiresIn: number }>({ valid: false, refreshing: false, expiresIn: 0 });
const [userCount, setUserCount] = createSignal(0);
const [logs, setLogs] = createSignal<string[]>([]);
const [statusMsg, setStatusMsgRaw] = createSignal("");
let statusTimer: ReturnType<typeof setTimeout> | null = null;
function setStatusMsg(msg: string, autoClear = true): void {
  setStatusMsgRaw(msg);
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (autoClear && msg) {
    statusTimer = setTimeout(() => { setStatusMsgRaw(""); statusTimer = null; }, 3000);
  }
}
const [view, setView] = createSignal<PanelViewName>("logs");
const [terminalSize, setTerminalSize] = createSignal({ width: process.stdout.columns || 120, height: process.stdout.rows || 30 });

// 向导
const [fIdx, setFIdx] = createSignal(0);
const [draft, setDraft] = createSignal("");
const [wizardFocus, setWizardFocus] = createSignal<"fields" | "editor">("fields");
const [workspaceConfirm, setWorkspaceConfirm] = createSignal(false);
// 会话视图
const [users, setUsers] = createSignal<string[]>([]);
const [selUser, setSelUser] = createSignal(0);
const [userSessions, setUserSessions] = createSignal("");
const [sessionList, setSessionList] = createSignal<{ num: number; title: string; turns: number; active: boolean }[]>([]);
const [selSession, setSelSession] = createSignal(0);
const [sessionHistory, setSessionHistory] = createSignal("");
const [sessionFocus, setSessionFocus] = createSignal<"users" | "sessions" | "history">("users");
const [historyScroll, setHistoryScroll] = createSignal(0);
// 操作视图
const [modelPick, setModelPick] = createSignal(false);
const [modelList, setModelList] = createSignal<string[]>([]);
const [actions, setActions] = createSignal<string[]>([]);
const [selAct, setSelAct] = createSignal(0);

let currentBot: Bot | null = null;
let renderer: any = null;
let wizardResolve: (() => void) | null = null;
let wizardDone = false;
let wizardFromPanel = false;
let quitFn: () => void = () => {};
let resizeHandler: (() => void) | null = null;
let replaceOnFirstEdit = false;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
function tailWindow(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `…${chars.slice(-(Math.max(1, maxChars - 1))).join("")}`;
}

// ── 向导字段（不含任何 ANTHROPIC_*——那是用户自己的 Claude Code 配置）────────
interface WField { label: string; get: () => string; set: (v: string) => void; choices?: string[]; }
const WIZARD_FIELDS: WField[] = [
  { label: "APP_ID（密信智能助理 apikey，必填）", get: () => cfg.APP_ID, set: v => writeEnvRaw("MIXIN_APP_ID", v) },
  { label: "APP_SECRET（必填）", get: () => cfg.APP_SECRET, set: v => writeEnvRaw("MIXIN_APP_SECRET", v) },
  { label: "ENV（production/staging/impre/test）", get: () => cfg.ENV, set: v => writeEnvRaw("MIXIN_ENV", v), choices: ["production", "staging", "impre", "test"] },
  { label: "AGENT（echo/claude/antigravity）", get: () => cfg.AGENT, set: v => setValue("AGENT", v), choices: ["echo", "claude", "antigravity"] },
  { label: "WORKSPACE 工作目录（agent 操作文件的根目录，必填）", get: () => cfg.WORKSPACE, set: v => setValue("WORKSPACE", v) },
  { label: "SYSTEM_PROMPT 系统提示词", get: () => cfg.SYSTEM_PROMPT, set: v => setValue("SYSTEM_PROMPT", v) },
  { label: "CLAUDE_MODEL（留空=默认）", get: () => cfg.CLAUDE_MODEL ?? "", set: v => setValue("CLAUDE_MODEL", v) },
  { label: "ALLOWED_TOOLS（逗号分隔）", get: () => cfg.CLAUDE_ALLOWED_TOOLS.join(","), set: v => setValue("CLAUDE_ALLOWED_TOOLS", v) },
  { label: "CLAUDE_CLI_PATH（留空=内置）", get: () => cfg.CLAUDE_CLI_PATH ?? "", set: v => setValue("CLAUDE_CLI_PATH", v) },
  { label: "CLAUDE_PERMISSION 权限模式", get: () => cfg.CLAUDE_PERMISSION, set: v => setValue("CLAUDE_PERMISSION", v), choices: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] },
  { label: "FILE_RETURN_INSTRUCTION 回传文件提示", get: () => cfg.FILE_RETURN_INSTRUCTION, set: v => setValue("FILE_RETURN_INSTRUCTION", v) },
  { label: "MAX_FILE_MB", get: () => String(cfg.MAX_FILE_MB), set: v => setValue("MAX_FILE_MB", v) },
  { label: "DANGER_CONFIRM（1/0）", get: () => (cfg.CLAUDE_DANGER_CONFIRM ? "1" : "0"), set: v => setValue("CLAUDE_DANGER_CONFIRM", v), choices: ["1", "0"] },
  { label: "DANGER_PATTERNS（用 || 分隔）", get: () => cfg.CLAUDE_DANGER_PATTERNS.join("||"), set: v => setValue("CLAUDE_DANGER_PATTERNS", v) },
  { label: "QUANTUM_ACCOUNT（可选）", get: () => cfg.QUANTUM_ACCOUNT ?? "", set: v => writeEnvRaw("MIXIN_QUANTUM_ACCOUNT", v) },
  { label: "BOT_USER_ID（可选，anti-loop）", get: () => cfg.BOT_USER_ID ?? "", set: v => writeEnvRaw("MIXIN_BOT_USER_ID", v) },
];

// ── 动作 ──────────────────────────────────────────────────────────
function selectWizardField(index: number): void {
  const next = clamp(index, 0, WIZARD_FIELDS.length - 1);
  setFIdx(next);
  setDraft(WIZARD_FIELDS[next].get());
}

function enterWizardEditor(): void {
  setDraft(WIZARD_FIELDS[fIdx()].get());
  replaceOnFirstEdit = true;
  setWizardFocus("editor");
  setStatusMsg(WIZARD_FIELDS[fIdx()].choices?.length
    ? "已进入选项模式：用 ↑/↓ 选择，按 Enter 保存并返回字段列表"
    : "已进入编辑模式：原值已选中，直接输入会替换；Ctrl+V 粘贴；按 Enter 保存并返回字段列表");
}

function moveWizardChoice(direction: 1 | -1): void {
  const choices = WIZARD_FIELDS[fIdx()].choices;
  if (!choices?.length) return;
  const current = choices.findIndex(choice => choice.toLowerCase() === draft().toLowerCase());
  const base = current >= 0 ? current : 0;
  setDraft(choices[(base + direction + choices.length) % choices.length]);
  replaceOnFirstEdit = false;
}

function applyEditorInput(value: string): void {
  if (replaceOnFirstEdit) {
    replaceOnFirstEdit = false;
    setDraft(value);
  } else {
    setDraft(current => current + value);
  }
}

function applyPastedText(raw: string): void {
  if (mode() !== "wizard" || wizardFocus() !== "editor") {
    setStatusMsg("请先选中字段并按 Enter 进入编辑框，再执行粘贴");
    return;
  }
  if (WIZARD_FIELDS[fIdx()].choices?.length) {
    setStatusMsg("当前字段是选项，请用 ↑/↓ 选择后按 Enter 保存");
    return;
  }
  const value = raw.replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/\n+$/g, "").replace(/\n/g, " ");
  if (!value) { setStatusMsg("剪贴板中没有可粘贴的文本"); return; }
  applyEditorInput(value);
  setStatusMsg(`已粘贴 ${Array.from(value).length} 个字符；按 Enter 保存并返回列表`);
}

async function pasteFromWindowsClipboard(): Promise<void> {
  if (mode() !== "wizard" || wizardFocus() !== "editor") {
    setStatusMsg("请先选中字段并按 Enter 进入编辑框，再按 Ctrl+V");
    return;
  }
  if (process.platform !== "win32") {
    setStatusMsg("当前终端未发送粘贴内容，请使用终端原生粘贴快捷键");
    return;
  }
  try {
    const text = await new Promise<string>((resolve, reject) => {
      execFile("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    applyPastedText(text);
  } catch (error) {
    setStatusMsg(`读取剪贴板失败：${(error as Error).message}`);
  }
}

function handlePaste(event: PasteEvent): void {
  event.preventDefault();
  applyPastedText(new TextDecoder().decode(event.bytes));
}

function minimizeToTray(): void {
  if (process.platform !== "win32") { setStatusMsg("后台托盘功能仅支持 Windows"); return; }
  const requestFile = process.env.MIXIN_TRAY_HIDE_FILE;
  if (!requestFile) { setStatusMsg("请通过 one-dir 包中的 MixinClawLink.exe 启动，才能使用 Ctrl+B 托盘后台"); return; }
  try {
    writeFileSync(requestFile, String(Date.now()), "utf8");
    setStatusMsg("已转入后台；双击托盘图标恢复，右键菜单可退出");
  } catch (error) {
    setStatusMsg(`转入后台失败：${(error as Error).message}`);
  }
}

function commitField(): boolean {
  const f = WIZARD_FIELDS[fIdx()];
  try { f.set(draft()); setStatusMsg(`✓ 已保存：${f.label.split("（")[0]}`); return true; }
  catch (e) { setStatusMsg(`⚠️ ${(e as Error).message}`); return false; }
}
function finalizeWizard(): void {
  // 工作目录为空时弹确认：是否使用默认 ./workspace
  if (!workspaceConfirm() && !cfg.WORKSPACE.trim()) {
    setWorkspaceConfirm(true);
    setStatusMsg("⚠️ 工作目录为空。按 Enter 使用默认 ./workspace，或 Esc 返回填写");
    return;
  }
  if (workspaceConfirm()) {
    // 用户确认使用默认值
    try { setValue("WORKSPACE", "./workspace"); }
    catch (e) { setStatusMsg(`⚠️ ${(e as Error).message}`); setWorkspaceConfirm(false); return; }
    setWorkspaceConfirm(false);
  }
  if (!commitField()) return;
  if (!cfg.APP_ID || !cfg.APP_SECRET) { setStatusMsg("❌ APP_ID / APP_SECRET 不能为空，无法启动"); return; }
  if (wizardFromPanel) {
    wizardFromPanel = false;
    setMode("panel");
    setView("logs");
    setStatusMsg("✅ 配置已写入 .env；AGENT / WORKSPACE 的变更需执行软重启");
    return;
  }
  wizardDone = true;
  setMode("panel");
  setView("logs");
  setStatusMsg("✅ 配置已保存，正在启动 bot…");
  refreshUsers();
  if (wizardResolve) { const r = wizardResolve; wizardResolve = null; r(); }
}
function openConfigEditor(): void {
  reload();
  wizardFromPanel = true;
  setWizardFocus("fields");
  replaceOnFirstEdit = false;
  selectWizardField(0);
  setMode("wizard");
  setStatusMsg("已读取当前 .env");
}
function cancelWizard(): void {
  if (!wizardFromPanel) {
    setStatusMsg("首次运行尚无可返回的面板；请完成配置，或按 q 退出");
    return;
  }
  wizardFromPanel = false;
  reload();
  setMode("panel");
  setView("logs");
  setStatusMsg("已放弃当前未保存的输入");
}
async function refreshUsers(): Promise<void> {
  try {
    const us = await registry.listUsers();
    setUsers(us); setSelUser(0); setUserCount(us.length);
    setUserSessions(us.length ? "选择左侧用户查看会话详情" : "暂无用户 · 在量子密信中发送一条消息即可创建");
  } catch { /* 忽略 */ }
}
async function actionPickModel(): Promise<void> {
  setStatusMsg("拉取模型列表…");
  try {
    const ms = await fetchAgentModels();
    setModelList(ms.map(m => m.id)); setSelAct(0); setModelPick(true);
    const src = (cfg.AGENT.toLowerCase() === "antigravity" || cfg.AGENT.toLowerCase() === "agy") ? "agy models" : "Claude /models";
    setStatusMsg(`拉到 ${ms.length} 个模型（数字或 Enter 确认 / Esc 返回）· 来源: ${src}`);
  } catch (e) { setStatusMsg(`⚠️ ${(e as Error).message}（可改用 IM 里 /model <名字>）`); }
}
function actionReboot(): void {
  if (!currentBot) { setStatusMsg("⚠️ 尚无运行中的 bot"); return; }
  setStatusMsg("🔄 软重启中（重读 .env、重建 agent/WS）…");
  currentBot.requestReboot();
}
async function sendTestToSelected(): Promise<void> {
  if (!currentBot) { setStatusMsg("⚠️ 尚无运行中的 bot"); return; }
  const uid = users()[selUser()];
  if (!uid) return;
  try {
    const ok = await currentBot.sendTest(uid, "🔧 TUI 测试消息（来自运维面板）");
    setStatusMsg(ok ? `✅ 已向 ${uid} 发送测试消息` : `⚠️ 发送失败`);
  } catch (e) { setStatusMsg(`⚠️ ${(e as Error).message}`); }
}
const ACTION_LIST: { label: string; detail: string; run: () => void | Promise<void> }[] = [
  { label: "编辑配置", detail: "读取并修改现有 .env", run: openConfigEditor },
  { label: "选择模型", detail: "从当前 agent 后端拉取", run: actionPickModel },
  { label: "刷新状态", detail: "刷新用户、会话与连接状态", run: async () => { await refreshUsers(); setStatusMsg("已刷新"); } },
  { label: "软重启", detail: "重读 .env 并重建 Agent / WS", run: actionReboot },
  { label: "退出", detail: "安全停止 Mixin ClawLink", run: () => quitFn() },
];
function refreshActions(): void { setActions(ACTION_LIST.map(a => a.label)); setSelAct(0); setModelPick(false); }

// ── 键盘派发 ──────────────────────────────────────────────────────
function isPrintable(s: string): boolean {
  return Array.from(s).length === 1 && !/[\u0000-\u001f\u007f]/.test(s);
}
function keyDigit(name: string, seq: string): number | null {
  const raw = /^[1-9]$/.test(seq) ? seq : /^[1-9]$/.test(name) ? name : "";
  return raw ? Number(raw) : null;
}
function switchPanelView(direction: 1 | -1): void {
  const next = cycleView(view(), direction);
  setView(next);
  setStatusMsg("");
  if (next === "sessions") { setSessionFocus("users"); setSessionList([]); setSessionHistory(""); setHistoryScroll(0); void refreshUsers(); }
  if (next === "actions" && !modelPick()) refreshActions();
}

function handleKey(key: KeyEvent): void {
  const seq: string = key?.sequence ?? "";
  const name: string = key?.name ?? "";
  if (key?.ctrl && name === "c") { return; } // 不退出，允许用户复制日志
  if (key?.ctrl && name === "b") { minimizeToTray(); return; }
  if (mode() === "wizard" && key?.ctrl && name === "v") { void pasteFromWindowsClipboard(); return; }
  if (mode() === "wizard" && key?.ctrl && (name === "s" || seq === "\x13")) { finalizeWizard(); return; }
  if (mode() === "wizard") return handleWizardKey(name, seq, key.shift);
  // panel
  if (!key?.ctrl && (seq === "q" || name === "q")) { quitFn(); return; }
  if (name === "escape") {
    if (modelPick()) { refreshActions(); setStatusMsg(""); }
    else if (view() === "sessions" && sessionFocus() !== "users") {
      // 逐级返回：history → sessions → users
      setSessionFocus(f => f === "history" ? "sessions" : "users");
      setHistoryScroll(0);
    }
    else if (view() !== "logs") { setView("logs"); setStatusMsg(""); }
    return;
  }
  if (name === "tab") { switchPanelView(key.shift ? -1 : 1); return; }
  if (name === "left" || name === "right") {
    if (modelPick()) return; // 子模式中锁方向键，Esc 退出后才能切
    if (view() === "sessions" && sessionFocus() !== "users") return; // 会话子级中锁方向键
    switchPanelView(name === "right" ? 1 : -1); return;
  }
  const digit = keyDigit(name, seq);
  if (digit !== null && view() !== "logs" && !(view() === "sessions" && sessionFocus() !== "users")) { void activateNumberedPanelItem(digit); return; }
  if (view() === "sessions" && seq === "t" && sessionFocus() === "users") { void sendTestToSelected(); return; }
  if (name === "pageup" || name === "pagedown") {
    if (view() === "sessions" && sessionFocus() === "history") {
      setHistoryScroll(s => Math.max(0, s + (name === "pagedown" ? 5 : -5)));
      return;
    }
    if (view() === "sessions" && sessionFocus() === "users") { pagePanel(name === "pagedown" ? 1 : -1); return; }
    if (view() === "sessions" && sessionFocus() === "sessions") { setSelSession(i => movePageSelection(sessionList().length, i, name === "pagedown" ? 1 : -1)); return; }
    pagePanel(name === "pagedown" ? 1 : -1); return;
  }
  if (name === "up" || seq === "k") {
    if (view() === "sessions" && sessionFocus() === "history") { setHistoryScroll(s => Math.max(0, s - 1)); return; }
    if (view() === "sessions" && sessionFocus() === "sessions") { setSelSession(i => Math.max(0, i - 1)); return; }
    navPanel(-1); return;
  }
  if (name === "down" || seq === "j") {
    if (view() === "sessions" && sessionFocus() === "history") { setHistoryScroll(s => s + 1); return; }
    if (view() === "sessions" && sessionFocus() === "sessions") { setSelSession(i => Math.min(Math.max(0, sessionList().length - 1), i + 1)); return; }
    navPanel(1); return;
  }
  if (name === "return" || name === "enter") { void activatePanel(); return; }
}

function handleWizardKey(name: string, seq: string, shift: boolean): void {
  // 工作目录空值确认模式
  if (workspaceConfirm()) {
    if (name === "return" || name === "enter") {
      // 确认使用默认 ./workspace，继续 finalize
      finalizeWizard();
      return;
    }
    if (name === "escape") {
      setWorkspaceConfirm(false);
      setStatusMsg("已取消；请填写工作目录后再按 Ctrl+S 保存");
      // 跳到 WORKSPACE 字段
      const wsIdx = WIZARD_FIELDS.findIndex(f => f.label.startsWith("WORKSPACE"));
      if (wsIdx >= 0) selectWizardField(wsIdx);
      return;
    }
    return; // 锁定其他按键
  }
  if (name === "escape") {
    if (wizardFocus() === "editor") {
      setDraft(WIZARD_FIELDS[fIdx()].get());
      replaceOnFirstEdit = false;
      setWizardFocus("fields");
      setStatusMsg("已放弃当前字段的编辑，返回字段列表");
    } else cancelWizard();
    return;
  }
  if (name === "tab") {
    if (wizardFocus() === "fields") enterWizardEditor();
    else {
      replaceOnFirstEdit = false;
      setWizardFocus("fields");
      setStatusMsg(shift ? "已反向切回字段列表（当前修改尚未保存）" : "已切回字段列表（当前修改尚未保存）");
    }
    return;
  }
  if (wizardFocus() === "fields") {
    const digit = keyDigit(name, seq);
    if (digit !== null) {
      const index = numberedIndex(WIZARD_FIELDS.length, fIdx(), digit);
      if (index !== null) selectWizardField(index);
      return;
    }
    if (name === "pageup" || name === "pagedown") {
      selectWizardField(movePageSelection(WIZARD_FIELDS.length, fIdx(), name === "pagedown" ? 1 : -1));
      return;
    }
    if (name === "up" || seq === "k") {
      selectWizardField(fIdx() - 1);
      return;
    }
    if (name === "down" || seq === "j") {
      selectWizardField(fIdx() + 1);
      return;
    }
    if (name === "left" || name === "right") return;
  } else {
    if (name === "up" || name === "left" || seq === "k") { moveWizardChoice(-1); return; }
    if (name === "down" || name === "right" || seq === "j") { moveWizardChoice(1); return; }
  }
  if (name === "return" || name === "enter") {
    if (wizardFocus() === "fields") enterWizardEditor();
    else if (commitField()) {
      replaceOnFirstEdit = false;
      setWizardFocus("fields");
      setDraft(WIZARD_FIELDS[fIdx()].get());
    }
    return;
  }
  if (wizardFocus() === "fields") return;
  if (WIZARD_FIELDS[fIdx()].choices?.length) return;
  if (name === "backspace" || name === "delete" || seq === "\x7f" || seq === "\b") {
    if (replaceOnFirstEdit) { replaceOnFirstEdit = false; setDraft(""); }
    else setDraft(d => d.slice(0, -1));
    return;
  }
  if (isPrintable(seq)) applyEditorInput(seq);
}

function navPanel(dir: number): void {
  if (view() === "sessions") {
    setSelUser(i => clamp(i + dir, 0, Math.max(0, users().length - 1)));
    setSessionFocus("users");
    setHistoryScroll(0);
    setSessionList([]);
    setSessionHistory("");
  } else if (view() === "actions") {
    const list = modelPick() ? modelList() : actions();
    setSelAct(i => clamp(i + dir, 0, Math.max(0, list.length - 1)));
  }
}

function pagePanel(direction: 1 | -1): void {
  if (view() === "sessions") setSelUser(i => movePageSelection(users().length, i, direction));
  else if (view() === "actions") {
    const list = modelPick() ? modelList() : actions();
    setSelAct(i => movePageSelection(list.length, i, direction));
  }
}

async function activateNumberedPanelItem(digit: number): Promise<void> {
  if (view() === "sessions") {
    const index = numberedIndex(users().length, selUser(), digit);
    if (index === null) return;
    setSelUser(index);
    await activatePanel(index);
    return;
  }
  if (view() === "actions") {
    const list = modelPick() ? modelList() : actions();
    const index = numberedIndex(list.length, selAct(), digit);
    if (index === null) return;
    setSelAct(index);
    await activatePanel(index);
  }
}

async function loadSessionHistory(uid: string, sessionNum: number): Promise<void> {
  try {
    // agy 无 SDK 拉历史，降级提示
    if (cfg.AGENT === "antigravity") {
      setSessionHistory("（agy CLI 模式不支持拉取对话历史；会话续接靠 --conversation <uuid>，历史存在 ~/.gemini/antigravity-cli/conversations/）");
      return;
    }
    const sid = await registry.getSessionIdByNum(uid, sessionNum);
    if (!sid) { setSessionHistory("（该会话尚无 Claude session_id，发一条消息后才会产生）"); return; }
    const msgs = await getSessionMessages(sid, { limit: 50 });
    if (!msgs.length) { setSessionHistory("（无对话记录）"); return; }
    const lines: string[] = [];
    for (const m of msgs) {
      const msg = m.message as any;
      if (m.type === "user") {
        const text = extractText(msg);
        if (text) lines.push(`👤 ${text.slice(0, 200)}`);
      } else if (m.type === "assistant") {
        const text = extractText(msg);
        if (text) lines.push(`🤖 ${text.slice(0, 300)}`);
      }
    }
    setSessionHistory(lines.join("\n") || "（无文本对话记录）");
  } catch (e) { setSessionHistory(`⚠️ ${(e as Error).message}`); }
}

function extractText(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

async function activatePanel(indexOverride?: number): Promise<void> {
  if (view() === "sessions") {
    const focus = sessionFocus();
    // 第一级：用户列表 → Enter 加载会话列表，进入会话选择
    if (focus === "users") {
      const uid = users()[indexOverride ?? selUser()];
      if (!uid) return;
      try {
        const ss = await registry.listSessions(uid);
        const t = await registry.countTurns(uid);
        setSessionList(ss);
        const lines = ss.map(s => `  ${s.num}. ${s.title}（${s.turns} 轮）${s.active ? " ← 当前" : ""}`);
        setUserSessions(`用户 ${uid}（${ss.length} 会话 / 当前槽 ${t} 轮）\n${lines.join("\n") || "（无会话）"}`);
        if (ss.length > 0) {
          const activeNum = ss.find(s => s.active)?.num ?? 1;
          setSelSession(activeNum - 1); // 0-based index
          setSessionFocus("sessions");
        }
      } catch (e) { setUserSessions(`⚠️ ${(e as Error).message}`); setSessionList([]); }
      return;
    }
    // 第二级：会话列表 → Enter 加载对话历史，进入历史浏览
    if (focus === "sessions") {
      const uid = users()[selUser()];
      if (!uid) return;
      const ss = sessionList();
      const item = ss[selSession()];
      if (!item) return;
      setHistoryScroll(0);
      await loadSessionHistory(uid, item.num);
      setSessionFocus("history");
      return;
    }
    // 第三级：对话历史 → Enter 刷新当前会话历史
    if (focus === "history") {
      const uid = users()[selUser()];
      if (!uid) return;
      const ss = sessionList();
      const item = ss[selSession()];
      if (!item) return;
      setHistoryScroll(0);
      await loadSessionHistory(uid, item.num);
      return;
    }
  }
  if (view() === "actions") {
    const activeIndex = indexOverride ?? selAct();
    if (modelPick()) {
      const id = modelList()[activeIndex];
      if (!id) return;
      const isAgy = cfg.AGENT.toLowerCase() === "antigravity" || cfg.AGENT.toLowerCase() === "agy";
      const modelKey = isAgy ? "AGY_MODEL" : "CLAUDE_MODEL";
      try { setValue(modelKey, id); setStatusMsg(`✅ 模型 → ${id}（下条消息生效）`); }
      catch (e) { setStatusMsg(`⚠️ ${(e as Error).message}`); }
      refreshActions();
    } else {
      await ACTION_LIST[activeIndex]?.run();
    }
  }
}

// ── 视图组件 ──────────────────────────────────────────────────────
function wsLabel(): string { const w = wsStatus(); return w.status === "reconnecting" ? `${w.status} #${w.attempt}` : w.status; }
function authLabel(): string { const a = authStatus(); return a.refreshing ? "刷新中" : a.valid ? `${Math.floor(a.expiresIn / 60)}m` : "无"; }
function pageLabel(total: number, selected: number): string {
  const info = pageInfo(total, selected);
  return `${info.page + 1}/${info.pages} · ${total}`;
}

function BrandHeader() {
  return (
    <box width="100%" height={1} flexShrink={0} backgroundColor={C.header} flexDirection="row" alignItems="center">
      <text fg={C.accent}> ◆ </text>
      <text fg={C.text}>Mixin ClawLink</text>
      <text fg={C.faint}> · </text>
      <text fg={C.violet}>Control Deck</text>
      <text fg={C.faint}>  量子密信智能助理连接器</text>
    </box>
  );
}

function StatusBar() {
  const wsDot = () => {
    const s = wsStatus().status;
    if (s === "connected") return C.green;
    if (s === "connecting") return C.yellow;
    return C.red;
  };
  const authDot = () => authStatus().valid ? C.green : C.yellow;
  return (
    <box width="100%" height={1} flexShrink={0} backgroundColor={C.panel} flexDirection="row" alignItems="center">
      <text fg={C.faint}> </text>
      <text fg={C.cyan}>⬢</text>
      <text fg={C.subtle}> </text>
      <text fg={C.dim}>AGENT</text>
      <text fg={C.faint}> </text>
      <text fg={C.text}>{agentName()}</text>
      <text fg={C.faint}>  │  </text>
      <text fg={wsDot()}>●</text>
      <text fg={C.subtle}> </text>
      <text fg={C.dim}>WS</text>
      <text fg={C.faint}> </text>
      <text fg={C.text}>{wsLabel()}</text>
      <text fg={C.faint}>  │  </text>
      <text fg={authDot()}>●</text>
      <text fg={C.subtle}> </text>
      <text fg={C.dim}>TOKEN</text>
      <text fg={C.faint}> </text>
      <text fg={C.text}>{authLabel()}</text>
      <text fg={C.faint}>  │  </text>
      <text fg={C.violet}>◈</text>
      <text fg={C.subtle}> </text>
      <text fg={C.dim}>USERS</text>
      <text fg={C.faint}> </text>
      <text fg={C.text}>{String(userCount())}</text>
    </box>
  );
}

function PanelTabs() {
  return (
    <box width="100%" height={1} flexShrink={0} flexDirection="row" backgroundColor={C.header}>
      {(["logs", "sessions", "actions"] as PanelViewName[]).map((item, i) => {
        const active = () => view() === item;
        return (
          <>
            {i > 0 && <text fg={C.faint}>│</text>}
            <box flexGrow={1} flexShrink={1} flexBasis={0} backgroundColor={active() ? C.selected : C.header} justifyContent="center" alignItems="center" flexDirection="row">
              <text fg={active() ? C.accent : C.subtle}>{` ${VIEW_META[item].icon} ${VIEW_META[item].label} `}</text>
            </box>
          </>
        );
      })}
    </box>
  );
}

function LogsView() {
  const tail = () => logs().slice(-Math.max(1, terminalSize().height - 12)).join("\n");
  return (
    <box width="100%" height="100%" flexGrow={1} flexBasis={0} border borderColor={C.border} backgroundColor={C.panel} title=" 实时日志 " titleColor={C.accent} bottomTitle=" 自动跟随 " bottomTitleAlignment="right">
      <text fg="#8895b0" wrapMode="none" truncate>{tail() || "（等待 bot 启动…）"}</text>
    </box>
  );
}

function SessionsView() {
  const userPage = () => pageInfo(users().length, selUser());
  const userVisible = () => users().slice(userPage().start, userPage().end);
  const wide = () => terminalSize().width >= 110;
  const focus = () => sessionFocus();
  const sessPage = () => pageInfo(sessionList().length, selSession());
  const sessVisible = () => sessionList().slice(sessPage().start, sessPage().end);
  const historyLines = () => (sessionHistory() || "Enter 加载对话历史").split("\n");
  const historyVisible = () => {
    const lines = historyLines();
    const maxLines = Math.max(1, terminalSize().height - 12);
    const start = Math.min(historyScroll(), Math.max(0, lines.length - maxLines));
    return lines.slice(start, start + maxLines).join("\n");
  };
  const selSessionNum = () => { const s = sessionList()[selSession()]; return s ? s.num : 0; };
  return (
    <box width="100%" height="100%" flexGrow={1} flexBasis={0} flexDirection="row" gap={1}>
      <box flexGrow={1} flexShrink={1} flexBasis={0} border borderColor={focus() === "users" ? C.accent : C.border} backgroundColor={C.panel} title=" 用户 " titleColor={C.cyan} bottomTitle={pageLabel(users().length, selUser())} bottomTitleAlignment="right">
        {userVisible().map((u, offset) => {
          const index = userPage().start + offset;
          const num = offset + 1;
          return (
            <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={index === selUser() ? C.selected : C.panel}>
              <text fg={index === selUser() ? C.accent : C.text} wrapMode="none" truncate>{`${index === selUser() ? "▸" : " "}${num}. ${u}`}</text>
            </box>
          );
        })}
        {users().length === 0 && <text fg={C.subtle}> 暂无用户 — 在量子密信中给 bot 发消息</text>}
      </box>
      <box flexGrow={1} flexShrink={1} flexBasis={0} border borderColor={focus() === "sessions" ? C.accent : C.border} backgroundColor={C.raised} title=" 会话 " titleColor={C.violet} bottomTitle={sessionList().length ? pageLabel(sessionList().length, selSession()) : ""} bottomTitleAlignment="right">
        {sessVisible().map((s, offset) => {
          const index = sessPage().start + offset;
          const num = offset + 1;
          return (
            <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={index === selSession() ? C.selected : C.raised}>
              <text fg={index === selSession() ? C.accent : C.text} wrapMode="none" truncate>{`${index === selSession() ? "▸" : " "}${num}. ${s.title}（${s.turns}轮）${s.active ? " *" : ""}`}</text>
            </box>
          );
        })}
        {sessionList().length === 0 && <text fg={C.subtle}> {userSessions() ? "选择用户后按 Enter" : "← 先选用户"}</text>}
      </box>
      <box flexGrow={2} flexShrink={1} flexBasis={0} border borderColor={focus() === "history" ? C.accent : C.border} backgroundColor={C.raised} title=" 对话历史 " titleColor={C.green} bottomTitle={selSessionNum() ? ` 会话 ${selSessionNum()} ` : ""} bottomTitleAlignment="right">
        <text fg="#8895b0" wrapMode="word" truncate>{historyVisible()}</text>
      </box>
    </box>
  );
}

function ActionsView() {
  const list = () => (modelPick() ? modelList() : actions());
  const page = () => pageInfo(list().length, selAct());
  const visible = () => list().slice(page().start, page().end);
  const title = () => (modelPick() ? " 模型目录 " : " 快捷操作 ");
  const detail = () => modelPick()
    ? `选择后写入 ${(() => { const isAgy = cfg.AGENT.toLowerCase() === "antigravity" || cfg.AGENT.toLowerCase() === "agy"; return isAgy ? "AGY_MODEL" : "CLAUDE_MODEL"; })()}\n下条消息生效\n\n来源：${(() => { const isAgy = cfg.AGENT.toLowerCase() === "antigravity" || cfg.AGENT.toLowerCase() === "agy"; return isAgy ? "agy models" : "Claude /models"; })()}`
    : `${ACTION_LIST[selAct()]?.label ?? "—"}\n\n${ACTION_LIST[selAct()]?.detail ?? "请选择一项操作"}`;
  return (
    <box width="100%" height="100%" flexGrow={1} flexBasis={0} flexDirection="row" gap={1}>
      <box flexGrow={3} flexShrink={1} flexBasis={0} border borderColor={C.border} backgroundColor={C.panel} title={title()} titleColor={C.accent} bottomTitle={pageLabel(list().length, selAct())} bottomTitleAlignment="right">
        {visible().map((label, offset) => {
          const index = page().start + offset;
          const num = offset + 1;
          return (
            <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={index === selAct() ? C.selected : C.panel}>
              <text fg={index === selAct() ? C.accent : C.text} wrapMode="none" truncate>{`${index === selAct() ? "▸" : " "}${num}. ${label}`}</text>
            </box>
          );
        })}
      </box>
      <box flexGrow={2} flexShrink={1} flexBasis={0} border borderColor={C.border} backgroundColor={C.raised} title=" 说明 " titleColor={C.violet}>
        <text fg={C.dim} wrapMode="word" truncate>{detail()}</text>
      </box>
    </box>
  );
}

function hints(): string {
  const compact = terminalSize().width < 100;
  if (compact && mode() === "wizard") return wizardFocus() === "fields"
    ? "Enter 进入编辑 · ↑↓/1-9 选择 · PgUp/Dn 翻页 · Esc 返回"
    : WIZARD_FIELDS[fIdx()].choices?.length ? "↑↓ 选择 · Enter 保存 · Esc 放弃" : "输入/Ctrl+V 编辑 · Enter 保存 · Esc 放弃";
  if (compact && view() === "logs") return "Tab/←→ 切视图 · Ctrl+B 后台 · q 退出";
  if (compact) return "1-9 执行 · ↑↓ 选择 · PgUp/Dn 翻页 · Esc 返回";
  if (mode() === "wizard") return wizardFocus() === "fields"
    ? `选中字段后按 Enter 进入编辑 · ↑↓/1-9 选择字段 · PgUp/Dn 翻页 · Ctrl+S ${wizardFromPanel ? "完成" : "保存启动"} · Esc 返回`
    : WIZARD_FIELDS[fIdx()].choices?.length
      ? "↑↓/←→ 切换选项 · Enter 保存返回字段列表 · Esc 放弃编辑"
      : "直接输入或 Ctrl+V 粘贴 · Enter 保存返回字段列表 · Esc 放弃编辑";
  if (view() === "logs") return "Tab/←→ 切换视图 · 鼠标选中后右键复制 · Ctrl+B 托盘后台 · q 退出";
  if (view() === "sessions") {
    const f = sessionFocus();
    if (f === "users") return "↑↓/jk 选用户 · Enter 查看会话 · 1-9 快选 · t 测试 · Tab 切视图 · Esc 日志";
    if (f === "sessions") return "↑↓/jk 选会话 · Enter 查看对话 · PgUp/Dn 翻页 · Esc 返回用户";
    return "↑↓/jk/PgUp/Dn 滚动 · Enter 刷新 · Esc 返回会话列表";
  }
  return "1-9 执行 · ↑↓/jk 选择 · PgUp/Dn 翻页 · Enter 执行 · Esc 返回";
}

function BottomBar() {
  return (
    <box width="100%" height={2} flexShrink={0} backgroundColor={C.header} flexDirection="column">
      <box width="100%" height={1} flexShrink={0} backgroundColor={statusMsg() ? C.yellow : C.border}>
        <text fg={C.ink} wrapMode="none" truncate>{` ${statusMsg() || ""}`}</text>
      </box>
      <box width="100%" height={1} flexShrink={0} backgroundColor={C.header}>
        <text fg={C.subtle} wrapMode="none" truncate>{` ${hints()}`}</text>
      </box>
    </box>
  );
}

function WizardView() {
  const page = () => pageInfo(WIZARD_FIELDS.length, fIdx());
  const visible = () => WIZARD_FIELDS.slice(page().start, page().end);
  const current = () => WIZARD_FIELDS[fIdx()];
  return (
    <box width="100%" height="100%" flexGrow={1} flexDirection="column" backgroundColor={C.bg}>
      <BrandHeader />
      <box width="100%" height={1} flexShrink={0} backgroundColor={C.panel} flexDirection="row" alignItems="center">
        <text fg={C.accent}> {wizardFromPanel ? "配置工作台 / 编辑 .env" : "首次运行 / 初始化连接器"}</text>
      </box>
      <box width="100%" flexGrow={1} flexShrink={1} flexBasis={0} flexDirection="row" gap={1}>
        <box flexGrow={1} flexShrink={1} flexBasis={0} border borderColor={wizardFocus() === "fields" ? C.accent : C.border} backgroundColor={C.panel} title=" 配置字段 " titleColor={wizardFocus() === "fields" ? C.accent : C.dim} bottomTitle={pageLabel(WIZARD_FIELDS.length, fIdx())} bottomTitleAlignment="right">
          {visible().map((fld, offset) => {
            const index = page().start + offset;
            return (
              <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={index === fIdx() ? C.selected : C.panel}>
                <text fg={index === fIdx() ? C.accent : C.subtle} wrapMode="none" truncate>{` ${index === fIdx() ? "▸" : " "} ${fld.label}`}</text>
              </box>
            );
          })}
        </box>
        <box flexGrow={1} flexShrink={1} flexBasis={0} border borderColor={wizardFocus() === "editor" ? C.accent : C.border} backgroundColor={C.raised} title=" 当前值 " titleColor={wizardFocus() === "editor" ? C.accent : C.dim} flexDirection="column">
          <text fg={wizardFocus() === "editor" ? C.cyan : C.subtle} wrapMode="none" truncate> {wizardFocus() === "editor" ? (current().choices?.length ? "选项模式 · ↑/↓ 选择 · Enter 保存" : "编辑模式 · 输入/Ctrl+V · Enter 保存") : "待编辑 · 按 Enter 进入编辑"}</text>
          <text fg={C.faint}> FIELD</text>
          <box width="100%" height={2} flexShrink={0} overflow="hidden"><text fg={C.text} wrapMode="word" truncate> {current().label}</text></box>
          {wizardFocus() === "editor" && current().choices?.length ? (
            <box width="100%" flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden" border borderColor={C.cyan} backgroundColor={C.input} title=" 请选择 " titleColor={C.cyan} flexDirection="column">
              {current().choices?.map((choice, index) => {
                const selected = () => choice.toLowerCase() === draft().toLowerCase();
                return (
                  <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={selected() ? C.selected : C.input}>
                    <text fg={selected() ? C.accent : C.text} wrapMode="none" truncate>{` ${selected() ? "▸" : " "} ${choice}`}</text>
                  </box>
                );
              })}
            </box>
          ) : (
            <>
              <text fg={C.faint}> VALUE</text>
              <box width="100%" height={3} flexShrink={0} overflow="hidden" border borderColor={wizardFocus() === "editor" ? C.cyan : C.borderSoft} backgroundColor={C.input}>
                <text fg={draft() ? C.green : C.subtle} wrapMode="none" truncate> {draft() ? tailWindow(draft(), Math.max(12, Math.floor(terminalSize().width / 2) - 8)) : "（空值；按 Enter 进入编辑）"}</text>
              </box>
              {current().choices?.length ? <text fg={C.subtle} wrapMode="none" truncate> 候选项：按 Enter 展开选择框</text> : <text fg={C.subtle}> 文本字段 · 按 Enter 后输入或粘贴</text>}
            </>
          )}
        </box>
      </box>
      <BottomBar />
    </box>
  );
}

function PanelView() {
  return (
    <box width="100%" height="100%" flexGrow={1} flexDirection="column" backgroundColor={C.bg}>
      <BrandHeader />
      <StatusBar />
      <PanelTabs />
      <box width="100%" flexGrow={1} flexShrink={1} flexBasis={0} padding={0}>
        {view() === "logs" && <LogsView />}
        {view() === "sessions" && <SessionsView />}
        {view() === "actions" && <ActionsView />}
      </box>
      <BottomBar />
    </box>
  );
}

function App() {
  onMount(() => { setDraft(WIZARD_FIELDS[0].get()); refreshActions(); if (mode() === "panel") void refreshUsers(); });
  useKeyboard(handleKey);
  usePaste(handlePaste);
  // 选区完成时显示"右键复制"提示（不自动复制）
  const r = useRenderer();
  useSelectionHandler((sel) => {
    if (sel.isDragging || !sel.isActive) return;
    const text = sel.getSelectedText();
    if (text) setStatusMsg("右键复制", false);
  });
  // 右键复制选中文本
  const onMouseDown = (event: any) => {
    if (event.button !== 2) return;
    const sel = r.getSelection();
    if (!sel) return;
    const text = sel.getSelectedText();
    if (!text) return;
    try {
      const ok = r.copyToClipboardOSC52(text);
      if (ok) { setStatusMsg(`已复制 ${text.length} 字符`); r.clearSelection(); }
    } catch { /* 忽略 */ }
  };
  return (
    <box width="100%" height="100%" flexGrow={1} flexDirection="column" backgroundColor={C.bg} onMouseDown={onMouseDown}>
      {mode() === "wizard" ? <WizardView /> : <PanelView />}
    </box>
  );
}

// ── 对外句柄 ──────────────────────────────────────────────────────
export interface TuiHandle {
  waitForWizard: () => Promise<void>;
  attachBot: (bot: Bot) => void;
  detachBot: () => void;
  isDestroyed: () => boolean;
  shutdown: () => Promise<void>;
}

export async function startTui(opts: { onQuit: () => void }): Promise<TuiHandle> {
  setSuppressConsole(true);
  const syncTerminalSize = () => setTerminalSize({ width: process.stdout.columns || 120, height: process.stdout.rows || 30 });
  syncTerminalSize();
  resizeHandler = syncTerminalSize;
  process.stdout.on("resize", resizeHandler);
  quitFn = () => {
    if (wizardResolve) { const r = wizardResolve; wizardResolve = null; r(); } // 解除等待向导的 main() 阻塞
    opts.onQuit();
  };

  // 日志环形缓冲 + 批量（120ms）刷新，降频规避 Windows 高频 churn
  const ring: string[] = [];
  let dirty = false;
  const unsub = subscribeConsole(line => {
    ring.push(line.replace(/\n$/, ""));
    if (ring.length > 300) ring.splice(0, ring.length - 300);
    dirty = true;
  });
  const flush = setInterval(() => { if (dirty) { dirty = false; setLogs([...ring]); } }, 120);
  const authTimer = setInterval(() => { if (currentBot) setAuthStatus(currentBot.getAuthStatus()); }, 1000);
  const usersTimer = setInterval(() => { void registry.listUsers().then(us => setUserCount(us.length)).catch(() => {}); }, 5000);
  const trayExitFile = process.env.MIXIN_TRAY_EXIT_FILE;
  const trayTimer = setInterval(() => {
    if (!trayExitFile || !existsSync(trayExitFile)) return;
    try { unlinkSync(trayExitFile); } catch { /* 忽略 */ }
    quitFn();
  }, 250);

  renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useKittyKeyboard: null, useMouse: true });
  render(() => <App />, renderer);

  return {
    waitForWizard: () => new Promise<void>(resolve => {
      if (mode() === "panel" || wizardDone) return resolve();
      wizardResolve = resolve;
    }),
    attachBot: (bot: Bot) => {
      currentBot = bot;
      setAgentName(bot.agent.name);
      const ws = bot.getWsStatus();
      setWsStatus({ status: ws.status, attempt: ws.attempt });
      bot.onWsStatus((s, attempt) => setWsStatus({ status: s, attempt }));
      setAuthStatus(bot.getAuthStatus());
      setStatusMsg("");
      void refreshUsers();
    },
    detachBot: () => { /* 旧 ws 回调随旧 ConnectionManager 一起作废；attachBot 会重接 */ },
    isDestroyed: () => renderer === null,
    shutdown: async () => {
      clearInterval(flush); clearInterval(authTimer); clearInterval(usersTimer); clearInterval(trayTimer);
      if (resizeHandler) { process.stdout.off("resize", resizeHandler); resizeHandler = null; }
      unsub();
      setSuppressConsole(false);
      if (renderer) { try { renderer.destroy(); } catch { /* 忽略 */ } renderer = null; }
    },
  };
}
