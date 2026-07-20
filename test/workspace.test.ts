import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { safeName, formatTimestamp, uniqueInboxPath, sanitizeFileName } from "../src/session/workspace.ts";

test("safeName 净化危险字符", () => {
  expect(safeName("../../../etc/passwd")).toBe(".._.._.._etc_passwd");
  expect(safeName("正常 文件 (1).png")).toBe("_______1_.png");
  expect(safeName("")).toBe("file");
  expect(safeName("中文name")).toBe("__name");
});

test("formatTimestamp 输出 YYYYMMDDHHmmss", () => {
  // 用固定时间避免依赖系统时钟
  const d = new Date(2026, 6, 20, 14, 8, 32); // 2026-07-20 14:08:32 (local)
  expect(formatTimestamp(d)).toMatch(/^\d{14}$/);
  expect(formatTimestamp(d)).toHaveLength(14);
  // 单位数补零
  const d2 = new Date(2026, 0, 1, 1, 2, 3); // 2026-01-01 01:02:03
  expect(formatTimestamp(d2)).toBe("20260101010203");
});

test("uniqueInboxPath 时间戳命名 + 扩展名", () => {
  const d = new Date(2026, 6, 20, 14, 8, 32);
  const inboxDir = resolve(tmpdir(), `mixin-inbox-${process.pid}-${Date.now()}`);
  const p = uniqueInboxPath(inboxDir, "photo.JPG", d);
  expect(p).toBe(resolve(inboxDir, "20260720140832.JPG"));
});

test("uniqueInboxPath 同秒冲突自动加序号", () => {
  const d = new Date(2026, 6, 20, 14, 8, 32);
  const inboxDir = join(tmpdir(), `mixin-inbox-conflict-${process.pid}-${Date.now()}`);
  mkdirSync(inboxDir, { recursive: true });
  try {
    // 预先创建同秒文件
    writeFileSync(join(inboxDir, "20260720140832.png"), "x");
    // 第一次冲突 → _2
    const p2 = uniqueInboxPath(inboxDir, "a.png", d);
    expect(p2).toBe(resolve(inboxDir, "20260720140832_2.png"));
    writeFileSync(p2, "x");
    // 第二次冲突 → _3
    const p3 = uniqueInboxPath(inboxDir, "b.png", d);
    expect(p3).toBe(resolve(inboxDir, "20260720140832_3.png"));
    // 无扩展名文件也能处理
    const p4 = uniqueInboxPath(inboxDir, "noext", d);
    expect(existsSync(p4)).toBe(false);
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test("uniqueInboxPath 无扩展名时不补点", () => {
  const d = new Date(2026, 6, 20, 14, 8, 32);
  const inboxDir = resolve(tmpdir(), `mixin-inbox-noext-${process.pid}-${Date.now()}`);
  const p = uniqueInboxPath(inboxDir, "README", d);
  expect(p).toBe(resolve(inboxDir, "20260720140832"));
});

test("sanitizeFileName 保留中文/空格，只去掉禁用字符", () => {
  expect(sanitizeFileName("销售报表 Q3")).toBe("销售报表 Q3");
  expect(sanitizeFileName('a/b\\c:d*e?f"g|h<i>j')).toBe("abcdefghij");
  expect(sanitizeFileName("  trim  ")).toBe("trim");
  expect(sanitizeFileName("///")).toBe("file");
});

test("uniqueInboxPath 文档保留原名+时间戳(keepOriginalName)", () => {
  const d = new Date(2026, 6, 20, 14, 8, 32);
  const inboxDir = resolve(tmpdir(), `mixin-inbox-doc-${process.pid}-${Date.now()}`);
  // 中文文件名保留
  const p1 = uniqueInboxPath(inboxDir, "销售报表.xlsx", d, true);
  expect(p1).toBe(resolve(inboxDir, "销售报表_20260720140832.xlsx"));
  // 英文文件名
  const p2 = uniqueInboxPath(inboxDir, "report.pdf", d, true);
  expect(p2).toBe(resolve(inboxDir, "report_20260720140832.pdf"));
  // 含路径穿越字符的净化后仍保留可读名
  const p3 = uniqueInboxPath(inboxDir, "../evil/name.docx", d, true);
  expect(p3).toBe(resolve(inboxDir, "evilname_20260720140832.docx"));
});

test("uniqueInboxPath 文档同名同秒冲突加序号", () => {
  const d = new Date(2026, 6, 20, 14, 8, 32);
  const inboxDir = join(tmpdir(), `mixin-inbox-doc-conflict-${process.pid}-${Date.now()}`);
  mkdirSync(inboxDir, { recursive: true });
  try {
    writeFileSync(join(inboxDir, "report_20260720140832.xlsx"), "x");
    const p = uniqueInboxPath(inboxDir, "report.xlsx", d, true);
    expect(p).toBe(resolve(inboxDir, "report_20260720140832_2.xlsx"));
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});
