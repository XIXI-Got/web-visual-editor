/**
 * 视觉编辑器 · 纯逻辑层（无 DOM、无依赖，可在 Node 里单测）
 *
 * 这一层只做「算」：网格吸附、对齐参考线、元素选择器、覆写合并、撤销栈。
 * 浏览器行为全部在 runtime.js 里，Node 侧落盘在 api.mjs 里。
 */

export const GRID_PRESETS = [2, 4, 8, 10, 12, 16, 20, 24, 32, 48, 64, 100];

const SIDE_ATTR = new Set([
  "src", "href", "alt", "title", "width", "height", "viewBox", "fill", "stroke",
  "d", "class", "id", "role", "aria-label", "checked", "value", "type", "name",
]);

export function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function px(v, fallback = null) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return fallback;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)(px)?$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

export function pxStr(n) {
  return `${round(n, 2)}px`;
}

/** 吸附候选：把一组坐标压成去重、有序的候选线 */
export function uniqSorted(nums) {
  const out = [];
  for (const n of nums) {
    if (!Number.isFinite(n)) continue;
    if (out.some((v) => Math.abs(v - n) < 0.01)) continue;
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

export function gridLines(from, to, step) {
  if (!(step > 0)) return [];
  const out = [];
  const start = Math.ceil(from / step) * step;
  for (let v = start; v <= to + 0.001; v += step) out.push(round(v, 3));
  return out;
}

/**
 * 位置吸附。
 * 传入「未吸附的位移」和元素原始矩形，返回吸附后的位移 + 需要画的参考线。
 *
 * ctx = {
 *   rect:      { left, top, width, height },   // 元素当前（未位移）视口矩形
 *   dx, dy,                                    // 候选位移
 *   grid, useGrid, useObjects, threshold,
 *   parent:    { left, top, width, height } | null,
 *   siblings:  [{ left, top, width, height }],
 *   viewport:  { width, height },
 *   axis:      "both" | "x" | "y",
 * }
 */
export function snapMove(ctx) {
  const {
    rect, dx, dy, grid = 8, useGrid = true, useObjects = true, threshold = 6,
    parent = null, siblings = [], viewport = null, axis = "both", guideX = [], guideY = [],
  } = ctx;

  const next = { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height };

  const xEdges = [
    { v: next.left, off: 0, kind: "left" },
    { v: next.left + next.width / 2, off: next.width / 2, kind: "centerX" },
    { v: next.left + next.width, off: next.width, kind: "right" },
  ];
  const yEdges = [
    { v: next.top, off: 0, kind: "top" },
    { v: next.top + next.height / 2, off: next.height / 2, kind: "centerY" },
    { v: next.top + next.height, off: next.height, kind: "bottom" },
  ];

  const xGridTargets = [];
  const yGridTargets = [];
  const xObjTargets = [];
  const yObjTargets = [];

  if (useGrid && grid > 0) {
    for (const g of gridLines(next.left - grid, next.left + next.width + grid, grid)) xGridTargets.push({ v: g, kind: "grid" });
    for (const g of gridLines(next.top - grid, next.top + next.height + grid, grid)) yGridTargets.push({ v: g, kind: "grid" });
  }

  if (useObjects) {
    const boxes = [];
    if (parent) boxes.push({ box: parent, kind: "parent" });
    for (const s of siblings) boxes.push({ box: s, kind: "sibling" });
    if (viewport) boxes.push({ box: { left: 0, top: 0, width: viewport.width, height: viewport.height }, kind: "viewport" });

    for (const { box, kind } of boxes) {
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      xObjTargets.push({ v: box.left, kind }, { v: cx, kind }, { v: box.left + box.width, kind });
      yObjTargets.push({ v: box.top, kind }, { v: cy, kind }, { v: box.top + box.height, kind });
    }
  }
  // 页边距 / 中心参考线：和元素边缘一样参与吸附
  for (const v of guideX) xObjTargets.push({ v, kind: "guide" });
  for (const v of guideY) yObjTargets.push({ v, kind: "guide" });

  // 网格优先：只用左上边去贴网格（可预期地按密度步进）；够不到再退到「对齐元素」（三边 + 中线都参与）。
  const gridEdgeX = [{ v: next.left, off: 0, kind: "left" }];
  const gridEdgeY = [{ v: next.top, off: 0, kind: "top" }];
  const bestX = axis === "y" ? null
    : pickSnap(gridEdgeX, xGridTargets, Number.POSITIVE_INFINITY) || pickSnap(xEdges, xObjTargets, threshold);
  const bestY = axis === "x" ? null
    : pickSnap(gridEdgeY, yGridTargets, Number.POSITIVE_INFINITY) || pickSnap(yEdges, yObjTargets, threshold);

  const outDx = round(bestX ? dx + bestX.delta : dx, 3);
  const outDy = round(bestY ? dy + bestY.delta : dy, 3);

  const guides = [];
  if (bestX) guides.push({ axis: "x", pos: bestX.target, kind: bestX.kind });
  if (bestY) guides.push({ axis: "y", pos: bestY.target, kind: bestY.kind });

  return { dx: outDx, dy: outDy, guides, snappedX: Boolean(bestX), snappedY: Boolean(bestY) };
}

function pickSnap(edges, targets, threshold) {
  let best = null;
  for (const edge of edges) {
    for (const t of targets) {
      const d = t.v - edge.v;
      const abs = Math.abs(d);
      if (abs > threshold) continue;
      if (!best || abs < best.abs - 0.001) {
        best = { abs, delta: d, target: t.v, kind: t.kind, edge: edge.kind };
      }
    }
  }
  return best;
}

/**
 * 尺寸吸附（拖手柄时用）。
 * dir: { right?: boolean, bottom?: boolean, left?: boolean, top?: boolean }
 */
export function snapResize(ctx) {
  const { rect, width, height, dir = {}, grid = 8, useGrid = true } = ctx;
  const out = { width, height, guides: [] };
  if (!useGrid || !(grid > 0)) return out;

  const snapEdge = (movingEdge, axis, guideItems) => {
    const d = gridLines(movingEdge - grid * 2, movingEdge + grid * 2, grid);
    let best = null;
    for (const v of d) {
      const dist = Math.abs(v - movingEdge);
      if (dist <= grid / 2 + 0.0001 && (!best || dist < best.dist)) best = { dist, v };
    }
    if (best) guideItems.push({ axis, pos: best.v, kind: "grid" });
    return best ? best.v : movingEdge;
  };

  if (dir.right) {
    const fixed = rect.left;
    const moving = snapEdge(fixed + out.width, "x", out.guides);
    out.width = round(Math.max(1, moving - fixed), 3);
  }
  if (dir.left) {
    const fixed = rect.left + rect.width;
    const moving = snapEdge(fixed - out.width, "x", out.guides);
    out.width = round(Math.max(1, fixed - moving), 3);
  }
  if (dir.bottom) {
    const fixed = rect.top;
    const moving = snapEdge(fixed + out.height, "y", out.guides);
    out.height = round(Math.max(1, moving - fixed), 3);
  }
  if (dir.top) {
    const fixed = rect.top + rect.height;
    const moving = snapEdge(fixed - out.height, "y", out.guides);
    out.height = round(Math.max(1, fixed - moving), 3);
  }
  return out;
}

/** 等比缩放：给定一边，算另一边 */
export function aspectSize(naturalW, naturalH, nextW, nextH, which) {
  if (!naturalW || !naturalH) return { width: nextW, height: nextH };
  const ratio = naturalW / naturalH;
  if (which === "w") return { width: round(nextW, 2), height: round(nextW / ratio, 2) };
  if (which === "h") return { width: round(nextH * ratio, 2), height: round(nextH, 2) };
  return { width: round(nextW, 2), height: round(nextH, 2) };
}

/**
 * 稳定 CSS 选择器：优先 id，其次 data 属性，最后 nth-of-type 链。
 * 与 data-ve-id（编译期注入的源位置）配合使用。
 */
export function buildSelector(el, maxDepth = 10) {
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < maxDepth) {
    if (node === el && node.id) return `#${cssEscape(node.id)}`;
    if (node === el) {
      for (const attr of ["data-ve-id", "data-testid", "data-id"]) {
        const v = node.getAttribute?.(attr);
        if (v) return `[${attr}="${cssEscape(v)}"]`;
      }
    }
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length) {
      part += "." + [...node.classList].slice(0, 2).map(cssEscape).join(".");
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.id) {
      parts[0] = `#${cssEscape(node.id)}`;
      break;
    }
    node = parent;
    depth += 1;
  }
  return parts.join(" > ");
}

export function cssEscape(v) {
  if (typeof CSS !== "undefined" && CSS?.escape) return CSS.escape(String(v));
  return String(v).replace(/([^\w-])/g, "\\$1");
}

/** 元素稳定 key：编译期 data-ve-id 优先，否则 CSS 选择器 */
export function elementKey(el) {
  if (!el) return null;
  const ve = el.getAttribute?.("data-ve-id");
  if (ve) return `id:${ve}`;
  const sel = buildSelector(el);
  return sel ? `sel:${sel}` : null;
}

export function keyToSelector(key) {
  if (!key) return null;
  if (key.startsWith("id:")) return `[data-ve-id="${key.slice(3).replace(/"/g, '\\"')}"]`;
  if (key.startsWith("sel:")) return key.slice(4);
  return null;
}

/** 深合并覆写（对象合并，数组整体替换） */
export function mergeDeep(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (patch === null || typeof patch !== "object") return patch;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) out[k] = null;
    else if (typeof v === "object" && !Array.isArray(v)) out[k] = mergeDeep(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** 把 "a.b.0.c" 写进对象 */
export function setPath(obj, path, value) {
  const keys = String(path).split(".").filter(Boolean);
  if (!keys.length) return obj;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const nextIsIndex = /^\d+$/.test(keys[i + 1]);
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") {
      cur[k] = nextIsIndex ? [] : {};
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

export function getPath(obj, path) {
  return String(path).split(".").filter(Boolean).reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/** 遍历 JSON 找唯一叶子，用于把改过的文字回写到 content.json */
export function findLeafPaths(obj, match, out = [], path = []) {
  if (obj == null) return out;
  if (typeof obj === "string" || typeof obj === "number") {
    if (match(obj)) out.push(path.join("."));
    return out;
  }
  if (typeof obj !== "object") return out;
  const entries = Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj);
  for (const [k, v] of entries) findLeafPaths(v, match, out, [...path, String(k)]);
  return out;
}

/** 撤销栈（命令式，最多 N 步） */
export function createHistory(limit = 100) {
  const done = [];
  const undone = [];
  return {
    push(entry) {
      done.push(entry);
      if (done.length > limit) done.shift();
      undone.length = 0;
    },
    undo() {
      const e = done.pop();
      if (!e) return null;
      undone.push(e);
      return e;
    },
    redo() {
      const e = undone.pop();
      if (!e) return null;
      done.push(e);
      return e;
    },
    get canUndo() { return done.length > 0; },
    get canRedo() { return undone.length > 0; },
    get size() { return done.length; },
    clear() { done.length = 0; undone.length = 0; },
  };
}

/** pin/数值格式化，面板里显示用 */
export function fmt(n, suffix = "") {
  if (n == null || Number.isNaN(n)) return "—";
  return `${round(n, 1)}${suffix}`;
}

export const FONT_WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

export const TEXT_PROPS = [
  "font-size", "font-weight", "line-height", "letter-spacing",
  "color", "text-align", "text-transform", "font-family", "font-style",
];

export const BOX_PROPS = [
  "width", "height", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-radius", "opacity", "z-index", "display", "transform",
];

/* ───────── 渐变（文字 / SVG 通用描述，多节点） ─────────
 * 覆写层里只存一个自定义属性 `--ve-grad`，值形如：
 *   g2|90|text|0:#ff4d4d:1|0.62:#ffb86b:0.55|1:#ffb86b:0
 *   段 0：格式版本（g2）
 *   段 1：角度（CSS 角度：0=向上，90=从左到右，180=从上到下）
 *   段 2：目标 text=文字（背景裁切）/ fill=SVG 填充 / stroke=SVG 描边 / both=两者
 *   段 3+：<位置 0-1>:<#hex>:<透明度 0-1>
 * 兼容旧格式：linear|90|#c1|#c2|text、fade|90|#c|#c|text、fadein|...
 * styleToCss 负责把它展开成真正的 CSS 声明；SVG 用到的 <linearGradient> 由运行时注入文档。
 */
export function gradHash(key) {
  let h = 5381;
  const s = String(key || "");
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function gradId(key) {
  return "veGrad-" + gradHash(key);
}

const GRAD_TARGETS = ["text", "fill", "stroke", "both"];
const GRAD_MODES = ["linear", "fade", "fadein"];
const GRAD_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function clamp01(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function hexRgb(hex) {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbaOf(hex, alpha) {
  const { r, g, b } = hexRgb(hex);
  const a = Math.round(clamp01(alpha) * 100) / 100;
  return `rgba(${r},${g},${b},${a})`;
}

/** 渐变节点按位置排序后的副本 */
export function gradStops(g) {
  const list = g && Array.isArray(g.stops) ? g.stops.slice() : [];
  return list
    .filter((s) => s && GRAD_HEX.test(s.color || ""))
    .map((s) => ({ offset: clamp01(s.offset), color: s.color, alpha: clamp01(s.alpha == null ? 1 : s.alpha) }))
    .sort((a, b) => a.offset - b.offset);
}

export function parseGradSpec(spec) {
  if (typeof spec !== "string" || !spec) return null;
  const parts = spec.split("|");
  if (parts[0] === "g2") {
    const angle = Number(parts[1]);
    if (!Number.isFinite(angle)) return null;
    const target = GRAD_TARGETS.includes(parts[2]) ? parts[2] : "text";
    const stops = [];
    for (const seg of parts.slice(3)) {
      const cut = seg.split(":");
      const color = cut[1];
      if (!GRAD_HEX.test(color || "")) continue;
      stops.push({ offset: clamp01(Number(cut[0])), color, alpha: cut[2] == null ? 1 : clamp01(Number(cut[2])) });
    }
    if (!stops.length) return null;
    if (stops.length === 1) stops.push({ ...stops[0], offset: 1 });
    return { angle, target, stops: stops.sort((a, b) => a.offset - b.offset) };
  }
  // —— 旧格式（单色→透明 / 双色），读进来自动升级成节点
  const [mode, a1, c1, c2raw, targetRaw] = parts;
  const angle = Number(a1);
  if (!GRAD_MODES.includes(mode) || !GRAD_HEX.test(c1 || "") || !Number.isFinite(angle)) return null;
  const c2 = GRAD_HEX.test(c2raw || "") ? c2raw : c1;
  const target = GRAD_TARGETS.includes(targetRaw) ? targetRaw : "text";
  const stops = mode === "linear"
    ? [{ offset: 0, color: c1, alpha: 1 }, { offset: 1, color: c2, alpha: 1 }]
    : mode === "fade"
      ? [{ offset: 0, color: c1, alpha: 1 }, { offset: 1, color: c1, alpha: 0 }]
      : [{ offset: 0, color: c1, alpha: 0 }, { offset: 1, color: c1, alpha: 1 }];
  return { angle, target, stops };
}

export function gradSpec(g) {
  if (!g) return "";
  const stops = gradStops(g).map((s) => `${round(s.offset, 3)}:${s.color}:${round(s.alpha, 2)}`);
  return ["g2", Math.round(Number(g.angle) || 0), g.target || "text", ...stops].join("|");
}

/** 展开成 CSS 渐变函数（角度的 cos/sin 与 SVG 那边同一套约定） */
export function gradCss(g) {
  const a = Math.round(Number(g.angle) || 0);
  const stops = gradStops(g).map((s) => `${rgbaOf(s.color, s.alpha)} ${round(s.offset * 100, 2)}%`);
  return `linear-gradient(${a}deg, ${stops.join(", ")})`;
}

/** 取某个位置上的颜色/透明度（在拉条中间加点时用） */
export function gradColorAt(g, t) {
  const list = gradStops(g);
  if (!list.length) return { color: "#ffffff", alpha: 1 };
  const p = clamp01(t);
  if (p <= list[0].offset) return { color: list[0].color, alpha: list[0].alpha };
  const last = list[list.length - 1];
  if (p >= last.offset) return { color: last.color, alpha: last.alpha };
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1];
    const b = list[i];
    if (p > b.offset) continue;
    const span = b.offset - a.offset || 1;
    const k = (p - a.offset) / span;
    const ca = hexRgb(a.color);
    const cb = hexRgb(b.color);
    const mix = (x, y) => Math.round(x + (y - x) * k);
    const color = "#" + [mix(ca.r, cb.r), mix(ca.g, cb.g), mix(ca.b, cb.b)]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
    return { color, alpha: Math.round((a.alpha + (b.alpha - a.alpha) * k) * 100) / 100 };
  }
  return { color: list[0].color, alpha: list[0].alpha };
}

/** SVG 渐变方向：CSS 角度 → objectBoundingBox 的 x1/y1/x2/y2 */
export function gradVector(angle) {
  const rad = (Number(angle) || 0) * Math.PI / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return { x1: 0.5 - dx / 2, y1: 0.5 - dy / 2, x2: 0.5 + dx / 2, y2: 0.5 + dy / 2 };
}

export function styleToCss(overrides) {
  const lines = [];
  for (const [key, entry] of Object.entries(overrides || {})) {
    const sel = keyToSelector(key);
    if (!sel) continue;
    const decls = new Map();
    let gradient = null;
    for (const [p, v] of Object.entries(entry.style || {})) {
      if (v === "" || v == null) continue;
      // 渐变描述本身不用输出，下面展开成具体声明
      if (p === "--ve-grad") { gradient = parseGradSpec(v); continue; }
      decls.set(p, v);
    }
    if (entry.box) {
      const { x, y, width, height } = entry.box;
      if (x || y) {
        // 拖拽位移要跟用户自己写的 transform 叠加，不能互相覆盖
        const extra = decls.get("transform");
        decls.set("transform", `translate(${x || 0}px,${y || 0}px)${extra ? ` ${extra}` : ""}`);
      }
      if (width != null && Number.isFinite(Number(width))) decls.set("width", `${Number(width)}px`);
      if (height != null && Number.isFinite(Number(height))) decls.set("height", `${Number(height)}px`);
    }
    if (entry.hidden) decls.set("display", "none");
    let sub = "";
    // SVG 描边：--ve-svg-stroke 是"给 svg 及其所有后代加 stroke"的专用属性
    const svgStroke = decls.get("--ve-svg-stroke");
    const svgStrokeW = decls.get("--ve-svg-stroke-w");
    if (svgStroke) {
      decls.delete("--ve-svg-stroke");
      decls.delete("--ve-svg-stroke-w");
      decls.set("stroke", svgStroke);
      const parts2 = ["stroke:" + svgStroke + "!important"];
      if (svgStrokeW && Number(svgStrokeW) > 0) {
        decls.set("stroke-width", String(svgStrokeW));
        parts2.push("stroke-width:" + svgStrokeW + "!important");
      }
      sub = sub + " " + `${sel} *{${parts2.join(";")}}`;
    }
    if (gradient) {
      if (gradient.target === "text") {
        // 文字渐变：用背景渐变 + 背景裁切到字形
        decls.set("background-image", gradCss(gradient));
        decls.set("background-clip", "text");
        decls.set("-webkit-background-clip", "text");
        decls.set("-webkit-text-fill-color", "transparent");
        decls.set("color", "transparent");
        // 关键：CSS 绘制顺序是「元素背景 → text-shadow → 文字」，背景裁切到字形后
        // 页面的 text-shadow（比如 0 1px 18px rgba(0,0,0,.5)）会盖在渐变上，把白字压成灰；
        // 渐变本身已经替代了字色，这里把阴影关掉，白才是实白。
        decls.set("text-shadow", "none");
      } else {
        // SVG 渐变：fill/stroke 指向运行时注入的 <linearGradient>；子元素写死过颜色属性的再补一条后代规则
        const url = `url("#${gradId(key)}")`;
        const parts = [];
        if (gradient.target === "fill" || gradient.target === "both") { decls.set("fill", url); parts.push(`fill:${url}!important`); }
        if (gradient.target === "stroke" || gradient.target === "both") { decls.set("stroke", url); parts.push(`stroke:${url}!important`); }
        if (parts.length) sub = `${sel} *{${parts.join(";")}}`;
      }
    }
    if (!decls.size && !sub) continue;
    if (decls.size) lines.push(`${sel}{${[...decls.entries()].map(([p, v]) => `${p}:${v}!important`).join(";")}}`);
    if (sub) lines.push(sub);
  }
  return lines.join("\n");
}
