export const PAGE_SIZE = 9;

const PANEL_VIEWS = ["logs", "sessions", "actions"] as const;
export type PanelViewName = (typeof PANEL_VIEWS)[number];

export function cycleView(current: PanelViewName, direction: 1 | -1): PanelViewName {
  const index = PANEL_VIEWS.indexOf(current);
  return PANEL_VIEWS[(index + direction + PANEL_VIEWS.length) % PANEL_VIEWS.length];
}

export interface PageInfo {
  page: number;
  pages: number;
  start: number;
  end: number;
}

export function pageInfo(total: number, selected: number): PageInfo {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeSelected = Math.max(0, Math.min(selected, Math.max(0, total - 1)));
  const page = Math.min(pages - 1, Math.floor(safeSelected / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  return { page, pages, start, end: Math.min(total, start + PAGE_SIZE) };
}

/** 把当前页的数字 1–9 映射为全列表索引。 */
export function numberedIndex(total: number, selected: number, digit: number): number | null {
  if (digit < 1 || digit > PAGE_SIZE) return null;
  const index = pageInfo(total, selected).start + digit - 1;
  return index < total ? index : null;
}

/** 翻页时尽量保持当前项在页内的相对位置。 */
export function movePageSelection(total: number, selected: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  const info = pageInfo(total, selected);
  const nextPage = Math.max(0, Math.min(info.pages - 1, info.page + direction));
  const offset = Math.max(0, selected - info.start);
  return Math.min(total - 1, nextPage * PAGE_SIZE + offset);
}
