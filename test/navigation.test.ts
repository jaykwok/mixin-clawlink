import { expect, test } from "bun:test";
import { cycleView, movePageSelection, numberedIndex, pageInfo } from "../src/tui/navigation.ts";

test("Tab 视图循环支持正向与反向", () => {
  expect(cycleView("logs", 1)).toBe("sessions");
  expect(cycleView("logs", -1)).toBe("actions");
});

test("列表每页最多九项，数字映射到当前页", () => {
  expect(pageInfo(0, 0)).toEqual({ page: 0, pages: 1, start: 0, end: 0 });
  expect(pageInfo(23, 0)).toEqual({ page: 0, pages: 3, start: 0, end: 9 });
  expect(numberedIndex(23, 10, 1)).toBe(9);
  expect(numberedIndex(23, 10, 9)).toBe(17);
  expect(numberedIndex(10, 9, 2)).toBeNull();
  expect(numberedIndex(23, 10, 0)).toBeNull();
});

test("翻页保留页内相对位置并在末页收口", () => {
  expect(movePageSelection(23, 4, 1)).toBe(13);
  expect(movePageSelection(23, 13, 1)).toBe(22);
  expect(movePageSelection(23, 22, -1)).toBe(13);
  expect(movePageSelection(0, 0, 1)).toBe(0);
});
