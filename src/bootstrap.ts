/**
 * 统一启动根目录。
 * Bun 单文件编译后可能从任意工作目录启动；此时把工作目录固定到 EXE 所在目录，
 * 确保 .env、logs、data 和 workspace 都与 EXE 同级。
 */
import { basename, dirname } from "node:path";

const execName = basename(process.execPath);
const isCompiledBun = !!process.versions.bun && !/^bun(?:\.exe)?$/i.test(execName);
if (isCompiledBun) process.chdir(dirname(process.execPath));

await import("./index.ts");
