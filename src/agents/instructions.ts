/** 工作区 Agent 规则初始化：为当前 Agent 追加 Mixin ClawLink 的持久能力说明。 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CLAWLINK_INSTRUCTIONS_BEGIN = "<!-- mixin-clawlink:instructions:begin -->";
export const CLAWLINK_INSTRUCTIONS_END = "<!-- mixin-clawlink:instructions:end -->";

function instructionsForAgent(agent: string): string {
  const isAgy = ["antigravity", "agy"].includes(agent.trim().toLowerCase());
  const fileProtocol = isAgy
    ? `- 当当前调用来自 Mixin ClawLink 并提供 \`{ text, files }\` JSON Schema 时：正文写入 \`text\`，待发送文件的绝对路径写入 \`files\`。
- 在这种结构化调用中不要输出 \`[[FILE: ...]]\`；没有文件时返回空数组，只列出用户明确需要且确实存在的文件。`
    : `- 确认文件真实存在后，在回复末尾单独输出：\`[[FILE: 文件的绝对路径]]\`。
- 每个待发送文件使用一行 \`[[FILE: ...]]\`；只发送用户明确需要的文件，不要发送目录或无关文件。
- 标记中的路径必须是当前机器上的绝对路径。正文可以正常说明，Mixin ClawLink 会移除标记并上传文件。`;
  const agySlash = isAgy
    ? "\n- 用户通过 `/agy /skill ...` 调用 agy slash command/skill 时，桥接器会移除 `/agy` 前缀；按原生命令语义执行。"
    : "";
  return `${CLAWLINK_INSTRUCTIONS_BEGIN}
## Mixin ClawLink 交互约定

你正在通过量子密信与用户交互。请遵守以下桥接协议：

- 当用户要求“发送、发给我、回传、交付”某个文件时，不要只在正文中列出文件名或路径。
${fileProtocol}
- 用户发送的非图片附件会由桥接器落盘，并在消息中提供绝对路径；需要时使用文件工具读取。
- \`/new\`、\`/list\`、\`/use\`、\`/reset\`、\`/model\`、\`/effort\`、\`/send\` 等斜杠命令由 Mixin ClawLink 处理，不要把它们当作终端命令执行。${agySlash}
${CLAWLINK_INSTRUCTIONS_END}`;
}

export interface InstructionInitResult {
  path: string;
  changed: boolean;
}

/** 当前 Agent 应使用的规则文件；agy 同时支持二者，优先复用已有 AGENTS.md/GEMINI.md。 */
export async function instructionPathForAgent(agent: string, workspace: string): Promise<string | null> {
  const key = agent.trim().toLowerCase();
  if (key === "claude") return resolve(workspace, "CLAUDE.md");
  if (key === "antigravity" || key === "agy") {
    const agents = resolve(workspace, "AGENTS.md");
    const gemini = resolve(workspace, "GEMINI.md");
    // 两个文件 agy 都会加载：任一文件已有受管区块就直接复用，避免跨文件重复添加。
    for (const candidate of [agents, gemini]) {
      const content = await readTextIfExists(candidate);
      if (content?.includes(CLAWLINK_INSTRUCTIONS_BEGIN)) return candidate;
    }
    if (await fileExists(agents)) return agents;
    if (await fileExists(gemini)) return gemini;
    return agents;
  }
  return null;
}

export async function needsAgentInstructions(agent: string, workspace: string): Promise<boolean> {
  const path = await instructionPathForAgent(agent, workspace);
  if (!path) return false;
  try {
    return !(await readFile(path, "utf8")).includes(instructionsForAgent(agent));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** 幂等写入受管区块；协议升级时只替换标记内内容，保留用户文档其它部分。 */
export async function initAgentInstructions(agent: string, workspace: string): Promise<InstructionInitResult | null> {
  const path = await instructionPathForAgent(agent, workspace);
  if (!path) return null;

  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const desired = instructionsForAgent(agent);
  const begin = current.indexOf(CLAWLINK_INSTRUCTIONS_BEGIN);
  if (begin >= 0) {
    const endStart = current.indexOf(CLAWLINK_INSTRUCTIONS_END, begin);
    if (endStart >= 0) {
      const end = endStart + CLAWLINK_INSTRUCTIONS_END.length;
      const existing = current.slice(begin, end);
      if (existing === desired) return { path, changed: false };
      await writeFile(path, `${current.slice(0, begin)}${desired}${current.slice(end)}`, "utf8");
      return { path, changed: true };
    }
    // 旧文件只残留 begin 标记时视为损坏受管区块，从该位置修复而不是追加第二份。
    await writeFile(path, `${current.slice(0, begin)}${desired}\n`, "utf8");
    return { path, changed: true };
  }

  const prefix = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(path, `${current}${prefix}${desired}\n`, "utf8");
  return { path, changed: true };
}

async function fileExists(path: string): Promise<boolean> {
  return (await readTextIfExists(path)) !== null;
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
