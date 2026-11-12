import { test } from "node:test";
import assert from "node:assert/strict";
import {
  px, pxStr, round, clamp, gridLines, snapMove, snapResize, aspectSize,
  buildSelector, keyToSelector, elementKey, mergeDeep, setPath, getPath,
  findLeafPaths, createHistory, styleToCss, GRID_PRESETS, FONT_WEIGHTS,
} from "../core.mjs";

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
const modNear = (v, step) => {
  const m = ((v % step) + step) % step;
  return Math.min(m, step - m);
};

test("px / pxStr / round / clamp", () => {
  assert.equal(px("12px"), 12);
  assert.equal(px("12"), 12);
  assert.equal(px(12), 12);
  assert.equal(px("auto", 7), 7);
  assert.equal(px("1.5em", null), null);
  assert.equal(pxStr(12.345), "12.35px");
  assert.equal(round(1.23456, 3), 1.235);
  assert.equal(clamp(9, 1, 5), 5);
});

test("gridLines 生成对齐网格线", () => {
  assert.deepEqual(gridLines(0, 16, 8), [0, 8, 16]);
  assert.deepEqual(gridLines(3, 10, 8), [8]);
  assert.deepEqual(gridLines(0, 10, 0), []);
  assert.ok(GRID_PRESETS.includes(8));
  assert.ok(FONT_WEIGHTS.includes(700));
});

test("snapMove：开网格时按 8px 量化左上边", () => {
  const rect = { left: 152.5, top: 420.375, width: 620, height: 56 };
  const r = snapMove({ rect, dx: 43, dy: 27, grid: 8, useGrid: true, useObjects: false, threshold: 6 });
  assert.ok(modNear(rect.left + r.dx, 8) < 1e-6, "left 应落在 8 的倍数上，得到 " + (rect.left + r.dx));
  assert.ok(modNear(rect.top + r.dy, 8) < 1e-6, "top 应落在 8 的倍数上，得到 " + (rect.top + r.dy));
  assert.ok(r.guides.some((g) => g.axis === "x" && g.kind === "grid"));
  assert.equal(r.snappedX, true);
});

test("snapMove：换密度后按新密度量化", () => {
  const rect = { left: 152.5, top: 420.375, width: 620, height: 56 };
  for (const grid of [4, 8, 16, 24, 32]) {
    const r = snapMove({ rect, dx: 39, dy: 19, grid, useGrid: true, useObjects: false, threshold: 6 });
    const x = rect.left + r.dx;
    const y = rect.top + r.dy;
    assert.ok(modNear(x, grid) < 1e-6, "grid=" + grid + " x=" + x);
    assert.ok(modNear(y, grid) < 1e-6, "grid=" + grid + " y=" + y);
  }
});

test("snapMove：关网格时自由拖动（原样返回）", () => {
  const rect = { left: 100, top: 100, width: 50, height: 50 };
  const r = snapMove({ rect, dx: 13.4, dy: 7.9, grid: 8, useGrid: false, useObjects: false });
  assert.equal(r.dx, 13.4);
  assert.equal(r.dy, 7.9);
  assert.equal(r.guides.length, 0);
  assert.equal(r.snappedX, false);
});

test("snapMove：snapMove 返回的是位移本身（含修正量）", () => {
  const rect = { left: 100, top: 100, width: 50, height: 50 };
  const r = snapMove({ rect, dx: 13.4, dy: 7.9, grid: 8, useGrid: true, useObjects: false });
  assert.ok(r.dx > 10, "位移应保留原始拖动量，而不是只返回修正量，得到 " + r.dx);
  assert.ok(modNear(rect.left + r.dx, 8) < 1e-6);
});

test("snapMove：关网格时吸附到父级中线", () => {
  const parent = { left: 0, top: 0, width: 1000, height: 800 };
  const rect = { left: 300, top: 300, width: 100, height: 100 };
  const r = snapMove({ rect, dx: 198.5, dy: 0, grid: 8, useGrid: false, useObjects: true, threshold: 6, parent });
  assert.equal(r.snappedX, true);
  assert.ok(near(rect.left + r.dx, 500), "左边应吸到父级中线 500，实际 " + (rect.left + r.dx));
  assert.ok(r.guides.some((g) => g.axis === "x" && g.kind === "parent"));
});

test("snapMove：axis 限制单轴", () => {
  const rect = { left: 10, top: 10, width: 100, height: 100 };
  const r = snapMove({ rect, dx: 3, dy: 3, grid: 8, useGrid: true, axis: "x" });
  assert.equal(r.dy, 3);
  assert.equal(r.snappedY, false);
});

test("aspectSize 等比换算", () => {
  assert.deepEqual(aspectSize(800, 400, 200, 999, "w"), { width: 200, height: 100 });
  assert.deepEqual(aspectSize(800, 400, 999, 200, "h"), { width: 400, height: 200 });
});

test("snapResize 右侧吸附网格", () => {
  const rect = { left: 100, top: 100, width: 200, height: 100 };
  const r = snapResize({ rect, width: 203, height: 100, dir: { right: true }, grid: 8, useGrid: true });
  assert.equal(round(rect.left + r.width), 304, "右边应贴到 304 = 38×8");
  assert.ok(r.guides.some((g) => g.kind === "grid"));
});

test("snapResize 左边拖拽", () => {
  const rect = { left: 100, top: 100, width: 200, height: 100 };
  const r = snapResize({ rect, width: 203, height: 100, dir: { left: true }, grid: 8, useGrid: true });
  assert.equal(round(rect.left + rect.width - r.width), 96, "左边应贴到 96 = 12×8");
});

test("选择器：key 与 selector 互转", () => {
  assert.equal(keyToSelector("id:src/a.tsx:10:2"), '[data-ve-id="src/a.tsx:10:2"]');
  assert.equal(keyToSelector("sel:.hero > h1"), ".hero > h1");
  assert.equal(keyToSelector("overlay:ov1"), null);
});

test("mergeDeep / setPath / getPath / findLeafPaths", () => {
  const a = { x: { y: 1 }, arr: [1, 2] };
  assert.deepEqual(mergeDeep(a, { x: { z: 2 }, arr: [3] }), { x: { y: 1, z: 2 }, arr: [3] });
  const obj = {};
  setPath(obj, "a.b.0.c", 5);
  assert.equal(getPath(obj, "a.b.0.c"), 5);
  const data = { person: { name: "张三", bio: "文案" }, list: ["文案", "别的"] };
  assert.deepEqual(findLeafPaths(data, (v) => v === "文案").sort(), ["list.0", "person.bio"]);
  assert.deepEqual(findLeafPaths(data, (v) => v === "张三"), ["person.name"]);
});

test("createHistory 撤销重做与上限", () => {
  const h = createHistory(2);
  h.push(1);
  h.push(2);
  h.push(3);
  assert.equal(h.canUndo, true);
  assert.equal(h.undo(), 3);
  assert.equal(h.redo(), 3);
  assert.equal(h.size, 2, "上限 2，最旧的被丢弃");
});

test("styleToCss：样式 / 位移 / 尺寸 / 隐藏", () => {
  const css = styleToCss({
    "id:a.tsx:1:1": { style: { "font-size": "20px" }, box: { x: 8, y: 0, width: 300, height: 200 } },
    "sel:.foot": { hidden: true },
    "overlay:ov1": { __overlay: {} },
  });
  assert.match(css, /\[data-ve-id="a\.tsx:1:1"\]\{font-size:20px!important;transform:translate\(8px,0px\)!important;width:300px!important;height:200px!important\}/);
  assert.match(css, /\.foot\{display:none!important\}/);
  assert.doesNotMatch(css, /overlay/);
});

test("buildSelector 在无 DOM 环境下不炸", () => {
  assert.equal(buildSelector(null), "");
  assert.equal(elementKey(null), null);
});
