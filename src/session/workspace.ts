/**
 * 工作目录：默认固定根目录（MIXIN_WORKSPACE），可用 /cwd 按用户切换到任意项目目录。
 * 文件回传改由 agent 用 [[FILE: 路径]] 标记显式声明，不整目录 diff（大目录不卡）。
 */
import { mkdir } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { cfg, expandHome } from "../config.ts";

/** 文件名/目录名净化：替换危险字符，避免路径穿越。 */
export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return s || "file";
}

/** 格式化时间为 YYYYMMDDHHmmss（如 20260720140832）。 */
export function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 生成全局 inbox 内唯一的附件路径：文件名=时间戳+原扩展名（如 20260720140832.png），
 * 同秒冲突自动加序号（_2、_3…）。origName 仅用于取扩展名。
 */
export function uniqueInboxPath(inboxDir: string, origName: string, now: Date = new Date()): string {
  const ext = extname(origName) || "";
  const ts = formatTimestamp(now);
  let name = `${ts}${ext}`;
  let p = resolve(inboxDir, name);
  for (let i = 2; existsSync(p); i++) {
    name = `${ts}_${i}${ext}`;
    p = resolve(inboxDir, name);
  }
  return p;
}

export class Workspace {
  /** 固定根目录（绝对路径）。/reboot 改 MIXIN_WORKSPACE 后，新 Bot 读新值。 */
  readonly root: string;
  private cwd = new Map<string, string>(); // userId -> 当前工作目录

  constructor(root?: string) {
    this.root = resolve(expandHome(root ?? cfg.WORKSPACE));
    mkdirSync(this.root, { recursive: true }); // 必须存在：否则 claude.exe 以此为 cwd 启动会 ENOENT
  }

  /** 该用户当前工作目录（未切换过则为根目录）。 */
  currentDir(uid: string): string {
    return this.cwd.get(uid) ?? this.root;
  }

  /** 切换该用户的工作目录。绝对路径直接用；相对路径基于根目录；不存在则创建。 */
  async setCwd(uid: string, p: string): Promise<string> {
    const expanded = expandHome(p);
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(this.root, expanded);
    await mkdir(abs, { recursive: true });
    this.cwd.set(uid, abs);
    return abs;
  }
}
