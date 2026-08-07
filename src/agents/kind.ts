/** Agent 名称归一化；`agy` 仅作为历史配置别名，运行时统一为 `antigravity`。 */
export function normalizeAgentKind(value: string): string {
  const key = value.trim().toLowerCase();
  return key === "agy" ? "antigravity" : key;
}

export function isAgyAgentName(value: string): boolean {
  return normalizeAgentKind(value) === "antigravity";
}
