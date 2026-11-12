/**
 * DSH 插件 · 网页修改器（浏览器端 bundle）
 *
 * 形态：DSH 的客户端插件 bundle（window.__ModuleLoader__.load({id, factory}) 协议）。
 * 做两件事：
 *   1. 在侧边栏底部加一个「网页」按钮
 *   2. 点击后在窗口右侧弹出一个抽屉：选源码文件夹 → 起预览 → iframe 里实时编辑 → 框选交给 AI → 保存回写
 *
 * 只用 require("react") / require("react-dom")，其余都是浏览器原生能力。
 */

window.__ModuleLoader__.load({
  id: "dsh-ui-editor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const PLUGIN_ID = "web-page-editor";
/** 插件版本（显示在工具栏，便于确认当前跑的版本） */
const PLUGIN_VERSION = "1.1.13";
const PLUGIN_NOTES = [
  "1.1.13 · 工作台：编辑工具栏新增「✦ AI 调整」弹窗（发送给对话里的 Agent），「↗ 独立窗口」直接打开当前项目且布局与内嵌一致",
  "1.1.12 · 撤销修复：撤销后的改动不再并进旧步骤/旧分支，分支会正确丢弃未走的重做步骤（旧状态不会复活）；小胶囊描边减淡成浅灰",
  "1.1.11 · 找到圆角不圆的原因：DSH 主题全局设置 corner-shape: superellipse(1.5)（squircle），把 999px 圆角画成圆角矩形；插件 UI 全部改回 corner-shape: round",
  "1.1.10 · 样式诊断自动上报：渲染端把按钮真实圆角、命中的 CSS 规则发回宿主（/ve/plugin/client-diag），用于定位圆角被谁覆盖",
  "1.1.9 · 圆角自愈：运行中检测按钮 computed 圆角，不是胶囊就补 inline !important；⋯→版本 增加样式诊断信息",
  "1.1.8 · 修复按钮圆角被旧样式表抢回 7px：样式表内容变化即替换 + 胶囊圆角 !important 兜底 + 工具栏按钮统一 28px 高",
  "1.1.7 · 页面菜单瘦身（导航栏→页面管理；移除显示/隐藏胶囊、清理旧版导航、复制粘贴/固化菜单项），对齐图标逐像素校准",
  "1.1.6 · 侧边「网页修改器」按工作台风格重排（单色纸面 / 细线 / 胶囊按钮 / 黑色选中态）",
  "1.1.5 · 工作台「打开项目」目录可以输入 / 粘贴路径，Enter 进入",
  "1.1.4 · 修复工作台右上角「返回对话」：走 layout.selectPanel(null)，不再乱点按钮 / 不再整页刷新",
  "1.1.3 · 网页工作台页面导航改成工具栏「☰ 页面」按钮 + 下方下拉列表",
  "1.1.2 · 悬浮导航胶囊只在编辑网页时出现（工作台首页 / 退出编辑后不再显示）",
  "1.1.1 · 悬浮导航胶囊进网页工作台 + 编辑器默认常驻（顶部居中固定）",
  "1.1.0 · 网页工作台 + 风格优化 + 固化 + 网格对齐",
  "· 原生右栏 tab + 可视化编辑（文字/图片/样式/尺寸/布局/组件）",
  "· 撤销/重做（整层状态快照，与自动保存兼容）",
  "· 选择：单击元素、Shift+单击选父级、Ctrl+Shift+单击多选、双击进组",
  "· Ctrl+Z 兜底桥：焦点不在预览里也能撤销",
  "· 自动保存 + 历史备份 + 回滚；首次打开项目默认不自动打开",
  "· 外观面板：描边 / 毛玻璃 / 投影 / 透明度（SVG 描边走 stroke）",
  "· 顶部对齐图标、步骤面板、录制排障、图层列表",
];
/** 浮动对话开关：当前搬移方案不稳定，先关闭（保留代码便于后续重做） */
const FLOAT_FEATURE = false;

/** 清理历史版本可能残留的浮动产物：占位块 / data 属性 / 注入样式 / 诊断条 */
function cleanupLegacyFloat() {
  try {
    for (const el of document.querySelectorAll("[data-ue-float-spacer]")) {
      try { el.remove(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try {
    for (const el of document.querySelectorAll("[data-ue-float]")) {
      try { el.removeAttribute("data-ue-float"); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try {
    for (const el of document.querySelectorAll("#__ue_float_style")) {
      try { el.remove(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { const b = document.getElementById("__ue_float_debug"); if (b) b.remove(); } catch { /* ignore */ }
  try {
    for (const el of document.querySelectorAll(".wpe-ai.wpe-float")) {
      el.style.display = el.getAttribute("data-ue-origin-display") || "";
      el.removeAttribute("data-ue-origin-display");
    }
  } catch { /* ignore */ }
}
    /** 每个 DSH 窗口独立的本地存储键（避免多个窗口共享同一个"上次项目"） */
/** 取父目录（用于"新 tab 默认从项目所在文件夹开始"） */
function parentDir(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 2 ? s.slice(0, i) : "";
}

/** DSH 对话服务（若能拿到，「发到对话」就直接发，不用复制粘贴） */
let conversationSvc = null;
let pluginCtx = null;
let sessionsSvc = null;
/** 启动时自动进入工作台的定时器；用户点「返回对话」后要清掉，否则几秒后会被重新拉回工作台 */
let autoWbTimers = [];
let autoWbCancelled = false;
/** DSH 布局服务：新旧版本字段位置不同，尽量都取到（layout.selectPanel 是官方切换主面板的入口） */
function dshLayoutService() {
  try {
    if (!pluginCtx) return null;
    if (typeof pluginCtx.get === "function") {
      const svc = pluginCtx.get("layout");
      if (svc) return svc;
    }
    return pluginCtx.layout || null;
  } catch { return null; }
}
function grabConversation(ctx) {
  try {
    if (conversationSvc) return conversationSvc;
    const svc = typeof ctx.get === "function" ? ctx.get("conversation") : null;
    if (svc && typeof svc.send === "function") conversationSvc = svc;
  } catch { /* ignore */ }
  return conversationSvc;
}

/** 把一段文字填进 DSH 的对话输入框（不自动发送，让用户确认后按 Enter） */
/** 把已经填进对话输入框的内容提交出去（点发送按钮，或补一个 Enter） */
function submitDshComposer() {
  try {
    const el = lastFilledComposer;
    if (!el || !el.isConnected) return "no-composer";
    const textOf = (b) => ((b.getAttribute && (b.getAttribute("aria-label") || b.getAttribute("title"))) || b.textContent || "").trim();
    // ① 找发送按钮：先局部、再全页，匹配「发送/send/submit/回车」等文案
    const scope = el.closest("form, [class*='composer'], [data-composer], [class*='input']") || document.body;
    const pickBtn = (root) => [...root.querySelectorAll("button")]
      .filter((b) => !b.disabled && /发送|send|submit|回车/i.test(textOf(b)))
      .sort((a, b) => (a.getBoundingClientRect().left > b.getBoundingClientRect().left ? -1 : 1))[0];
    let btn = pickBtn(scope) || pickBtn(document);
    if (btn) { btn.click(); return "sent"; }
    // ② 没有按钮：多轮派发 Enter（含 keyCode/which，兼容 React）
    const fire = (target) => {
      for (const type of ["keydown", "keypress", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    };
    fire(el);
    if (el.dispatchEvent) fire(document.activeElement && document.activeElement !== el ? document.activeElement : el);
    return "enter-dispatched";
  } catch (e) {
    console.warn("[dsh-ui-editor] 自动提交失败", e);
    return "error:" + String(e.message || e);
  }
}

/** 从右栏 service 的 mounted（当前屏上会话）读 sessionId */
function mountedSessionId() {
  try {
    const svc = nativeNav;
    const m = svc && svc.mounted;
    const v = m && (typeof m.getSnapshot === "function" ? m.getSnapshot() : (typeof m.get === "function" ? m.get() : m));
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const cand = v.sessionId || v.id || v.current || "";
      if (typeof cand === "string" && cand) return cand;
    }
  } catch { /* ignore */ }
  return "";
}

/** DSH 官方路径：sessions.scope(sessionId).conversation.send(text) —— 直接以用户消息发进对话 */
async function sendViaScopedConversation(text) {
  try {
    const sid = mountedSessionId() || dshSessionId();
    if (!sid) return { ok: false, reason: "no-session-id" };
    const sessions = sessionsSvc || (pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sessions") : null);
    if (!sessions || typeof sessions.scope !== "function") return { ok: false, reason: "no-sessions-scope" };
    const scopeCtx = sessions.scope(sid);
    if (!scopeCtx) return { ok: false, reason: "no-retained-scope:" + sid.slice(0, 8) };
    const conv = scopeCtx.conversation || (typeof scopeCtx.get === "function" ? scopeCtx.get("conversation") : null);
    if (!conv || typeof conv.send !== "function") {
      const keys = scopeCtx && typeof scopeCtx === "object" ? Object.keys(scopeCtx).slice(0, 12).join(",") : "";
      return { ok: false, reason: "no-conversation[" + keys + "]" };
    }
    await conv.send(text);
    return { ok: true, via: "scoped.conversation" };
  } catch (e) {
    return { ok: false, reason: "error:" + String((e && e.message) || e) };
  }
}

/** 读取当前会话 id（DSH 右栏根节点带 data-sidebar-right-session） */
function dshSessionId() {
  try {
    const el = document.querySelector("[data-sidebar-right-session]");
    return (el && el.getAttribute("data-sidebar-right-session")) || "";
  } catch { return ""; }
}

/** 直接把消息送进当前对话（无需粘贴/回车）：conversation.send → sessions.binding(id).prompt */
async function deliverToChat(text) {
  // ⓪ DSH 官方：sessions.scope(sessionId).conversation.send(text)
  try {
    const viaScoped = await sendViaScopedConversation(text);
    if (viaScoped && viaScoped.ok) return viaScoped;
    console.warn("[dsh-ui-editor] scoped conversation 不可用：", viaScoped && viaScoped.reason);
  } catch (e) { console.warn("[dsh-ui-editor] scoped conversation 异常", e); }
  // ① conversation.send（会话作用域内可用）
  try {
    if (conversationSvc && typeof conversationSvc.send === "function") {
      await conversationSvc.send(text);
      return { ok: true, via: "conversation" };
    }
  } catch (e) { console.warn("[dsh-ui-editor] conversation.send 不可用", e); }
  // ② sessions.binding(sessionId).prompt(...)
  let lastReason = "";
  try {
    const id = dshSessionId();
    const svc = sessionsSvc || (pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sessions") : null);
    if (id && svc && typeof svc.binding === "function") {
      const binding = svc.binding(id);
      if (binding && typeof binding.prompt === "function") {
        const result = await binding.prompt([{ type: "text", text }], "queue");
        if (!result || result.ok !== false) return { ok: true, via: "sessions.prompt" };
        lastReason = "prompt-failed";
      } else {
        lastReason = "no-binding-prompt";
      }
    } else if (!id) {
      lastReason = "no-session-id";
    } else {
      lastReason = "no-sessions-service";
    }
  } catch (e) {
    lastReason = "sessions-error";
    console.warn("[dsh-ui-editor] sessions.prompt 失败", e);
  }
  console.warn("[dsh-ui-editor] 会话接口不可用（" + lastReason + "），继续尝试 /handoff 与 DOM 发送");
  // ②b 宿主侧直发（/handoff：宿主用会话服务把消息送进对话）
  try {
    const r = await api("/handoff", { method: "POST", body: JSON.stringify({ text }) });
    if (r && r.ok) return { ok: true, via: "host" };
    console.warn("[dsh-ui-editor] 宿主直发失败", r);
  } catch (e) { console.warn("[dsh-ui-editor] /handoff 请求失败", e); }
  // ③ 填进输入框并自动提交
  if (!fillDshComposer(text)) return { ok: false, reason: (lastReason ? lastReason + "+" : "") + "composer-not-found" };
  const r = submitDshComposer();
  if (r === "sent" || r === "enter-dispatched") return { ok: true, via: "composer", detail: r };
  return { ok: false, reason: (lastReason ? lastReason + "+" : "") + "submit:" + r };
}

let lastFilledComposer = null;

function fillDshComposer(text) {
  try {
    const deep = findDshComposer();
    const boxes = deep ? [deep] : [...document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")]
      .filter((el) => {
        if (el.closest && el.closest("[data-wpe], [data-ve-host], #__ve_host")) return false;
        const r = el.getBoundingClientRect();
        return r.width > 120 && r.height > 12;
      })
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const el = boxes[0];
    if (!el) return false;
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
    lastFilledComposer = el;
    return true;
  } catch (e) {
    console.warn("[dsh-ui-editor] 填充对话输入框失败", e);
    return false;
  }
}

const WIN_SLOTS_KEY = "dsh-ui-editor:winSlots";
const WIN_ID_KEY = "dsh-ui-editor:winId";

/** 读取窗口槽位表：[{ id, lastDir, lastUsed }] */
function readWinSlots() {
  try {
    const raw = localStorage.getItem(WIN_SLOTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeWinSlots(list) {
  try { localStorage.setItem(WIN_SLOTS_KEY, JSON.stringify((list || []).slice(0, 6))); } catch { /* ignore */ }
}

/** 本窗口对应的槽位 id：优先 sessionStorage；没有就从槽位表里挑最久未用的一个（保证多窗口互不抢占） */
function winSlotId() {
  try {
    let id = sessionStorage.getItem(WIN_ID_KEY);
    if (id) return id;
    const slots = readWinSlots();
    const now = Date.now();
    let chosen = null;
    if (slots.length < 3) {
      chosen = { id: "w" + Math.random().toString(36).slice(2, 7), lastDir: "", lastUsed: 0 };
      slots.push(chosen);
    } else {
      chosen = slots.slice().sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))[0];
    }
    chosen.lastUsed = now;
    writeWinSlots(slots);
    sessionStorage.setItem(WIN_ID_KEY, chosen.id);
    return chosen.id;
  } catch { return "default"; }
}

function winScope() {
  return winSlotId();
}

/** 记住"本窗口"上次打开的项目（写入槽位表，不影响其它窗口） */
function rememberWindowDir(dir) {
  try {
    if (!dir) return;
    const id = winSlotId();
    const slots = readWinSlots();
    let slot = slots.find((s) => s.id === id);
    if (!slot) { slot = { id, lastDir: "", lastUsed: 0 }; slots.push(slot); }
    slot.lastDir = dir;
    slot.lastUsed = Date.now();
    writeWinSlots(slots);
  } catch { /* ignore */ }
}

/** 取"本窗口"上次项目（没有就空） */
function recallWindowDir() {
  try {
    const id = winSlotId();
    const slot = readWinSlots().find((s) => s.id === id);
    return (slot && slot.lastDir) || "";
  } catch { return ""; }
}
const lastDirKey = () => "dsh-ui-editor:lastDir:" + winScope();
/** 全局最近项目：窗口作用域在 DSH 重启后会重置，用这个兜底恢复上次项目 */
const lastDirGlobalKey = () => "dsh-ui-editor:lastDirGlobal";

/** 最近一次"真正在用的项目+页面"（重启后按这个恢复，比窗口槽位更准） */
const lastActiveKey = () => "dsh-ui-editor:lastActive";
function saveLastActive(dir, page) {
  try {
    if (!dir) return;
    localStorage.setItem(lastActiveKey(), JSON.stringify({ dir: String(dir), page: String(page || "/"), at: Date.now() }));
  } catch { /* ignore */ }
}
function recallLastActive() {
  try {
    const j = JSON.parse(localStorage.getItem(lastActiveKey()) || "{}");
    return j && typeof j.dir === "string" && j.dir ? j : null;
  } catch { return null; }
}
/** 每个 tab 自己的项目目录（按窗口 + tab id 记忆；tab 切走再回来能恢复） */
const tabDirKey = (tabId) => "dsh-ui-editor:tabDir:" + winScope() + ":" + (tabId || "default");

/** 编辑器上下文桥：供"窗口输入框自动附带选区信息"使用 */
const EDITOR_CTX = { dir: "", selection: [], shotPath: "", enabled: true };
window.__DSH_UE_CTX__ = EDITOR_CTX;
try {
  const v = localStorage.getItem("dsh-ui-editor:attachCtx");
  if (v === "0") EDITOR_CTX.enabled = false;
} catch { /* ignore */ }

function editorCtxText() {
  const c = EDITOR_CTX;
  if (!c.enabled) return "";
  if (!c.dir && !(c.selection && c.selection.length)) return "";
  const items = (c.selection || []).slice(0, 4)
    .map((x) => (x.tag || "") + " " + String(x.text || x.key || "").slice(0, 20))
    .filter(Boolean)
    .join("；");
  let s = "〔网页修改器上下文〕项目：" + (c.dir || "-");
  if (c.selection && c.selection.length) s += "；框选 " + c.selection.length + " 个元素" + (items ? "：" + items : "");
  if (c.shotPath) s += "；截图：" + c.shotPath;
  s += "；如需要请先调用 web_editor_context，再用 web_editor_apply_ops 应用修改。";
  return s;
}

/** 对话输入框悬浮到右侧编辑器上方（真实输入框 + 占位保持布局；不依赖发送 API） */
const COMPOSER_FLOAT = {
  on: false,
  box: null,
  origin: "",
  spacer: null,
  ancestors: [],
  observer: null,
};

/** 浮动基准区域：优先用编辑器自己的根节点（含"选文件夹"和"预览"两种状态），否则用最大的本地预览 iframe */
function previewFrameRect() {
  try {
    const root = document.querySelector(".wpe-tabview");
    if (root) {
      const r = root.getBoundingClientRect();
      if (r.width > 200 && r.height > 120) return r;
    }
  } catch { /* ignore */ }
  try {
    const frames = [...document.querySelectorAll("iframe")].filter((f) => /^https?:\/\/127\.0\.0\.1:/.test(f.src || ""));
    let best = null;
    for (const f of frames) {
      const r = f.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      const area = r.width * r.height;
      if (!best || area > best.area) best = { area, r };
    }
    if (best) return best.r;
  } catch { /* ignore */ }
  return null;
}

/** 抬升"层叠上下文"祖先的 z-index：否则 fixed 只在祖先的小世界里比较，会被右侧边栏/iframe 盖住 */
function raiseStackingAncestors(box) {
  const rootOf = (el) => { try { return el.getRootNode ? el.getRootNode() : document; } catch { return document; } };
  const recs = [];
  try {
    let n = box.parentElement;
    let scope = rootOf(box);
    let steps = 0;
    while (n && n !== document.body && n !== document.documentElement && steps < 14) {
      steps += 1;
      let cs = null;
      try { cs = getComputedStyle(n); } catch { cs = null; }
      if (cs && (cs.position !== "static" || (cs.zIndex && cs.zIndex !== "auto"))) {
        const rec = {
          el: n,
          pos: n.style.getPropertyValue("position"),
          posP: n.style.getPropertyPriority("position"),
          z: n.style.getPropertyValue("z-index"),
          zP: n.style.getPropertyPriority("z-index"),
        };
        try {
          if (cs.position === "static") n.style.setProperty("position", "relative", "important");
          n.style.setProperty("z-index", "2147483000", "important");
          recs.push(rec);
        } catch { /* ignore */ }
      }
      n = n.parentElement;
      if (!n && scope && scope.host) { n = scope.host; scope = rootOf(n); }
    }
  } catch { /* ignore */ }
  return recs;
}

/** 左下角诊断条：常显，成功后也不隐藏（用于我截图排查） */
function updateFloatDebugBadge() {
  try {
    let el = document.getElementById("__ue_float_debug");
    if (!el) {
      el = document.createElement("div");
      el.id = "__ue_float_debug";
      el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:62vw;font:11px/1.4 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.65);padding:6px 8px;border-radius:8px;pointer-events:none;white-space:pre-wrap";
      document.body.appendChild(el);
    }
    const last = COMPOSER_FLOAT.lastLocal || {};
    el.textContent = "[UE 浮动诊断] flag=" + (COMPOSER_FLOAT.flag ? "1" : "0")
      + " on=" + COMPOSER_FLOAT.on
      + " raised=" + ((COMPOSER_FLOAT.zRaised || []).length)
      + (last.rect ? " rect=" + last.rect.x + "," + last.rect.y + " " + last.rect.w + "x" + last.rect.h : "")
      + (last.occluded ? " 被遮挡=" + last.occluded : "")
      + (last.reason ? " reason=" + last.reason : "")
      + (COMPOSER_FLOAT.box ? " box=" + (COMPOSER_FLOAT.box.tagName || "") + "." + String(COMPOSER_FLOAT.box.className || "").split(" ")[0].slice(0, 20) : "");
  } catch { /* ignore */ }
}

/** 找到整个输入区卡片（必须同时包含输入框和按钮栏，否则会出现"输入框和按钮分离"） */
function composerContainer() {
  try {
    const input = findDshComposer();
    if (!input) return null;
    const isSendBtn = (b) => {
      const label = ((b.getAttribute && (b.getAttribute("aria-label") || b.getAttribute("title"))) || b.textContent || "").trim();
      return /发送|send|submit|回车/i.test(label);
    };
    let n = input.parentElement;
    let fallback = input;
    for (let k = 0; k < 12 && n && n !== document.body; k += 1) {
      const btns = n.querySelectorAll ? [...n.querySelectorAll("button")] : [];
      const r = n.getBoundingClientRect();
      if (btns.some(isSendBtn) && r.height >= 60) return n; // 完整卡片：含发送按钮且有两行高度
      const txt = n.textContent || "";
      if (!fallback && /完全权限|DeepSeek/.test(txt)) fallback = n;
      n = n.parentElement;
    }
    return fallback || input;
  } catch { return null; }
}

/** 计算浮动位置：以编辑器 iframe 为基准，水平居中、贴其底部，宽度自适应 */
function floatLayout(box) {
  const fr = previewFrameRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let areaLeft = 0;
  let areaWidth = vw;
  let areaBottom = 16;
  if (fr) {
    areaLeft = fr.left;
    areaWidth = fr.width;
    areaBottom = Math.max(8, vh - fr.bottom + 10);
  }
  const width = Math.max(320, Math.min(720, areaWidth - 32));
  const left = areaLeft + (areaWidth - width) / 2;
  return { left: Math.round(left), width: Math.round(width), bottom: Math.round(areaBottom) };
}

function clearComposerFloat() {
  try {
    if (COMPOSER_FLOAT.spacer && COMPOSER_FLOAT.spacer.parentElement) COMPOSER_FLOAT.spacer.remove();
  } catch { /* ignore */ }
  COMPOSER_FLOAT.spacer = null;
  try {
    for (const st of COMPOSER_FLOAT.styleEls || []) {
      try { st.remove(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  COMPOSER_FLOAT.styleEls = [];
  try {
    if (COMPOSER_FLOAT.box) {
      COMPOSER_FLOAT.box.removeAttribute("data-ue-float");
      COMPOSER_FLOAT.box.style.cssText = COMPOSER_FLOAT.origin || "";
    }
  } catch { /* ignore */ }
  try {
    for (const rec of COMPOSER_FLOAT.ancestors || []) {
      if (!rec || !rec.el) continue;
      for (const p of rec.props || []) {
        if (rec.orig && rec.orig[p]) rec.el.style.setProperty(p, rec.orig[p], rec.origPriority[p] || "");
        else rec.el.style.removeProperty(p);
      }
    }
  } catch { /* ignore */ }
  try {
    for (const rec of COMPOSER_FLOAT.zRaised || []) {
      if (!rec || !rec.el) continue;
      if (rec.z) rec.el.style.setProperty("z-index", rec.z, rec.zP || ""); else rec.el.style.removeProperty("z-index");
      if (rec.pos) rec.el.style.setProperty("position", rec.pos, rec.posP || ""); else rec.el.style.removeProperty("position");
    }
  } catch { /* ignore */ }
  COMPOSER_FLOAT.zRaised = [];
  COMPOSER_FLOAT.ancestors = [];
  try { if (COMPOSER_FLOAT.observer) COMPOSER_FLOAT.observer.disconnect(); } catch { /* ignore */ }
  COMPOSER_FLOAT.observer = null;
  try {
    for (const el of document.querySelectorAll(".wpe-ai.wpe-float")) {
      el.style.display = el.getAttribute("data-ue-origin-display") || "";
      el.removeAttribute("data-ue-origin-display");
    }
  } catch { /* ignore */ }
  COMPOSER_FLOAT.box = null;
  COMPOSER_FLOAT.on = false;
}

/** 解除祖先上会影响 fixed 定位的属性（只解除 transform/filter/contain，绝不动 overflow） */
function relaxAncestors(box) {
  const rootOf = (el) => { try { return el.getRootNode ? el.getRootNode() : document; } catch { return document; } };
  const recs = [];
  try {
    let n = box.parentElement;
    let scope = rootOf(box);
    let steps = 0;
    while (n && n !== document.body && steps < 10) {
      steps += 1;
      let cs = null;
      try { cs = getComputedStyle(n); } catch { cs = null; }
      if (cs) {
        const props = [];
        if (cs.transform && cs.transform !== "none") props.push("transform");
        if (cs.filter && cs.filter !== "none") props.push("filter");
        if (cs.perspective && cs.perspective !== "none") props.push("perspective");
        if (cs.contain && cs.contain !== "none") props.push("contain");
        if (props.length) {
          const rec = { el: n, props, orig: {}, origPriority: {} };
          for (const p of props) {
            rec.orig[p] = n.style.getPropertyValue(p);
            rec.origPriority[p] = n.style.getPropertyPriority(p);
            try { n.style.setProperty(p, "none", "important"); } catch { /* ignore */ }
          }
          recs.push(rec);
        }
      }
      n = n.parentElement;
      if (!n && scope && scope.host) { n = scope.host; scope = rootOf(n); }
    }
  } catch { /* ignore */ }
  return recs;
}

function applyComposerFloatLocal(on) {
  try {
    if (!on) {
      if (COMPOSER_FLOAT.on || COMPOSER_FLOAT.box) clearComposerFloat();
      COMPOSER_FLOAT.lastLocal = { ok: true, off: true };
      return COMPOSER_FLOAT.lastLocal;
    }
    // 已经搬好且元素还在：只更新位置/尺寸（不重建，避免闪烁）
    let box = COMPOSER_FLOAT.box;
    if (!box || !box.isConnected) {
      box = composerContainer();
      if (!box) return { ok: false, reason: "no-container" };
      clearComposerFloat();
      COMPOSER_FLOAT.origin = box.style.cssText;
      COMPOSER_FLOAT.box = box;
      // 占位：保住聊天区高度与滚动
      try {
        const h = box.getBoundingClientRect().height;
        const spacer = document.createElement("div");
        spacer.setAttribute("data-ue-float-spacer", "1");
        spacer.style.cssText = "height:" + Math.round(h) + "px;flex:0 0 auto;pointer-events:none;visibility:hidden";
        if (box.parentElement) box.parentElement.insertBefore(spacer, box);
        COMPOSER_FLOAT.spacer = spacer;
      } catch { /* ignore */ }
      COMPOSER_FLOAT.ancestors = relaxAncestors(box);
      COMPOSER_FLOAT.zRaised = raiseStackingAncestors(box);
      box.setAttribute("data-ue-float", "1");
      // 隐藏编辑器自己的底部 AI 条
      try {
        for (const el of document.querySelectorAll(".wpe-ai.wpe-float")) {
          el.setAttribute("data-ue-origin-display", el.style.display || "");
          el.style.display = "none";
        }
      } catch { /* ignore */ }
      // 跟随编辑器尺寸变化
      try {
        if (!COMPOSER_FLOAT.observer && typeof ResizeObserver === "function") {
          const rootEl = document.querySelector(".wpe-tabview");
          if (rootEl) {
            const ro = new ResizeObserver(() => { try { if (COMPOSER_FLOAT.on) applyComposerFloatLocal(true); } catch { /* ignore */ } });
            ro.observe(rootEl);
            COMPOSER_FLOAT.observer = ro;
          }
        }
      } catch { /* ignore */ }
    }

    // 位置：以编辑器根节点为基准，水平居中、贴其底部
    const pos = floatLayout(box);
    // 样式改用样式表 + !important：React 重渲染覆盖内联样式也不会闪
    try {
      if (!COMPOSER_FLOAT.styleEls || !COMPOSER_FLOAT.styleEls.length || COMPOSER_FLOAT.styleEls.some((s) => !s.isConnected)) {
        const root = (() => { try { return box.getRootNode ? box.getRootNode() : document; } catch { return document; } })();
        const host = root === document ? (document.head || document.body) : root;
        if (host) {
          const st = document.createElement("style");
          st.id = "__ue_float_style";
          host.appendChild(st);
          COMPOSER_FLOAT.styleEls = [st];
        }
      }
      const css = "[data-ue-float]{position:fixed!important;left:" + pos.left + "px!important;right:auto!important;top:auto!important;bottom:" + pos.bottom + "px!important;"
        + "width:" + pos.width + "px!important;max-height:38vh!important;z-index:2147483000!important;background:#fff!important;border:1px solid #e3e6ee!important;"
        + "border-radius:14px!important;box-shadow:0 14px 38px rgba(15,23,42,.24)!important;padding:6px!important;overflow:auto!important;display:block!important;visibility:visible!important}";
      for (const st of COMPOSER_FLOAT.styleEls) st.textContent = css;
    } catch { /* ignore */ }

    // 占位被 React 清掉时补回
    try {
      if (COMPOSER_FLOAT.spacer && !COMPOSER_FLOAT.spacer.isConnected && box.parentElement) {
        box.parentElement.insertBefore(COMPOSER_FLOAT.spacer, box);
      }
    } catch { /* ignore */ }

    COMPOSER_FLOAT.on = true;
    const r = box.getBoundingClientRect();
    let occluded = "";
    try {
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + Math.min(30, r.height / 2));
      const stack = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
      const top = stack.find((el) => !(el.closest && el.closest("#__ve_host")));
      const mine = top && (top === box || box.contains(top) || top.contains(box));
      if (top && !mine) occluded = (top.tagName || "?").toLowerCase() + "." + String(top.className || "").split(" ")[0].slice(0, 24);
    } catch { /* ignore */ }
    COMPOSER_FLOAT.lastLocal = {
      ok: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      occluded,
      raised: (COMPOSER_FLOAT.zRaised || []).length,
    };
    return COMPOSER_FLOAT.lastLocal;
  } catch (e) {
    COMPOSER_FLOAT.lastLocal = { ok: false, reason: "error:" + String((e && e.message) || e) };
    return COMPOSER_FLOAT.lastLocal;
  }
}




/** 浮动对话是否开启（开启时隐藏编辑器自己的悬浮 AI 条，避免两个输入框） */
/** ===== 伪全屏：宽屏/窄屏（只改右侧面板宽度，不动 DSH 原生全屏） ===== */
const SIDEBAR_WIDE_KEY = "dsh-ui-editor:sidebarWide";
/** 页面是否偏暗（预览内核上报，浮窗淡字据此反色） */
let UE_THEME_DARK = false;
const UE_FLOAT_POS_KEY = "dsh-ui-editor:floatPos";
function ueFloatMode() { try { return sidebarWideOn() ? "wide" : "narrow"; } catch { return "narrow"; } }
function ueLoadFloatPos(mode) {
  try { const all = JSON.parse(localStorage.getItem(UE_FLOAT_POS_KEY) || "{}"); return all && all[mode] ? all[mode] : null; } catch { return null; }
}
function ueSaveFloatPos(mode, pos) {
  try {
    const all = JSON.parse(localStorage.getItem(UE_FLOAT_POS_KEY) || "{}");
    all[mode] = { left: Math.round(pos.left), top: Math.round(pos.top) };
    localStorage.setItem(UE_FLOAT_POS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}
const UE_WIDE_PARAMS_KEY = "dsh-ui-editor:wideParams";
const UE_WIDE_DEFAULTS = { wideReserve: 488, narrowRatio: 25, narrowMax: 760 };

function ueWideParams() {
  try {
    const raw = localStorage.getItem(UE_WIDE_PARAMS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        wideReserve: Math.max(240, Math.min(900, Number(o.wideReserve) || UE_WIDE_DEFAULTS.wideReserve)),
        narrowRatio: Math.max(12, Math.min(60, Number(o.narrowRatio) || UE_WIDE_DEFAULTS.narrowRatio)),
        narrowMax: Math.max(320, Math.min(1400, Number(o.narrowMax) || UE_WIDE_DEFAULTS.narrowMax)),
      };
    }
  } catch { /* ignore */ }
  return { ...UE_WIDE_DEFAULTS };
}

function saveUeWideParams(patch) {
  try { localStorage.setItem(UE_WIDE_PARAMS_KEY, JSON.stringify({ ...ueWideParams(), ...patch })); } catch { /* ignore */ }
  try { applySidebarWide(sidebarWideOn()); } catch { /* ignore */ }
}

function sidebarWideOn() {
  try { return localStorage.getItem(SIDEBAR_WIDE_KEY) === "1"; } catch { return false; }
}

/** 宽屏时给左侧对话留出多少像素（保证还能打字） */
function sidebarWideChatRoom() {
  return ueWideParams().wideReserve;
}

/** ===== 拖动记录：对比拖动前后哪些参数变化，上传给宿主供排查 ===== */
const UE_REC = { on: false, snap: null, last: "" };

function ueRecSnapshot() {
  const out = [];
  const push = (label, el) => {
    if (!el) return;
    try {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({
        label,
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 60),
        w: Math.round(r.width),
        padR: cs.paddingRight,
        marR: cs.marginRight,
        right: cs.right,
        transform: cs.transform === "none" ? "" : cs.transform,
        inlineW: (el.style && el.style.width) || "",
        inlinePR: (el.style && el.style.paddingRight) || "",
      });
    } catch { /* ignore */ }
  };
  push("html", document.documentElement);
  push("body", document.body);
  try {
    const start = (CHAT_FLOAT.el && CHAT_FLOAT.el.isConnected) ? CHAT_FLOAT.el : chatColumnContainer();
    let n = start;
    for (let i = 0; i < 10 && n && n !== document.body; i += 1) { push("chat." + i, n); n = n.parentElement; }
  } catch { /* ignore */ }
  push("sidebarPanel", document.querySelector("[data-sidebar-right-session]"));
  const dk = [...document.querySelectorAll("[data-dockkit-divider]")].slice(0, 4);
  dk.forEach((d, i) => push("divider." + i, d));
  const hosts = [...document.querySelectorAll("[data-dockkit-host]")].slice(0, 6);
  hosts.forEach((d, i) => push("dock." + i, d));
  try {
    const cs = getComputedStyle(document.documentElement);
    out.push({ label: "vars", dshW: cs.getPropertyValue("--dsh-sidebar-width").trim(), winW: window.innerWidth });
  } catch { /* ignore */ }
  return out;
}

function ueRecBadge(text) {
  try {
    let el = document.getElementById("__ue_float_debug");
    if (!el) {
      el = document.createElement("div");
      el.id = "__ue_float_debug";
      el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:70vw;max-height:40vh;overflow:auto;font:11px/1.35 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.75);padding:6px 8px;border-radius:8px;white-space:pre-wrap";
      document.body.appendChild(el);
    }
    el.textContent = text;
  } catch { /* ignore */ }
}

function ueRecStart() {
  UE_REC.on = true;
  UE_REC.snap = ueRecSnapshot();
  ueRecBadge("[UE 记录中] 请手动拖动右侧分隔条改变宽度，然后点「结束记录」");
  return true;
}

async function ueRecStop() {
  if (!UE_REC.on) return false;
  UE_REC.on = false;
  const after = ueRecSnapshot();
  const before = UE_REC.snap || [];
  const diffs = [];
  for (let i = 0; i < after.length; i += 1) {
    const a = before[i];
    const b = after[i];
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja !== jb) diffs.push("▸ " + b.label + " | before " + ja + " | after " + jb);
  }
  const text = "UE 拖动记录\n" + (diffs.length ? diffs.join("\n\n") : "（无差异：拖动未改变被监测元素）");
  UE_REC.last = text;
  ueRecBadge(text.slice(0, 3000));
  try {
    await api("/context", {
      method: "POST",
      body: JSON.stringify({ dir: "", selection: [{ key: "ue-drag-record", text: text.slice(0, 12000) }], shot: "" }),
    });
  } catch { /* ignore */ }
  return true;
}

/** 找到侧边栏左侧那条拖拽分隔条 */
function sidebarDivider() {
  try {
    const panel = document.querySelector("[data-sidebar-right-session]");
    const pr = panel ? panel.getBoundingClientRect() : null;
    const cands = [...document.querySelectorAll("[data-dockkit-divider]")];
    let best = null;
    for (const d of cands) {
      const r = d.getBoundingClientRect();
      if (r.height < 200) continue;
      if (!pr) { if (!best) best = d; continue; }
      // 取最贴近侧边栏左缘、且竖直方向覆盖的
      const dx = Math.abs(r.left - pr.left);
      if (dx < 40 && (!best || dx < best.dx)) best = { el: d, dx, r };
    }
    return best ? best.el : null;
  } catch { return null; }
}

/** 模拟一次分隔条拖拽：dx>0 向右（变窄），dx<0 向左（变宽） */
function dragSidebarDivider(dx) {
  try {
    const handle = sidebarDivider();
    if (!handle) return false;
    const r = handle.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const make = (type, cx) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: cx, clientY: y,
    });
    handle.dispatchEvent(make("pointerdown", x));
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      const cx = Math.round(x + (dx * i) / steps);
      const ev = make("pointermove", cx);
      handle.dispatchEvent(ev);
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
    }
    handle.dispatchEvent(make("pointerup", Math.round(x + dx)));
    window.dispatchEvent(make("pointerup", Math.round(x + dx)));
    document.dispatchEvent(make("pointerup", Math.round(x + dx)));
    return true;
  } catch { return false; }
}

function sidebarPanelWidth() {
  try {
    const panel = document.querySelector("[data-sidebar-right-session]");
    if (!panel) return 0;
    return Math.round(panel.getBoundingClientRect().width);
  } catch { return 0; }
}

/** 找主区域容器（对话列所在、接近整窗宽度的祖先），用来给右侧留出空间 */
function mainFrameEl() {
  try {
    const start = (CHAT_FLOAT.el && CHAT_FLOAT.el.isConnected) ? CHAT_FLOAT.el : chatColumnContainer();
    let n = start && start.parentElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    while (n && n !== document.body && n !== document.documentElement) {
      const r = n.getBoundingClientRect();
      if (r.width > vw * 0.9 && r.height > vh * 0.55) return n;
      n = n.parentElement;
    }
  } catch { /* ignore */ }
  return null;
}

/** 通过 DSH 布局服务的内部 panels 动作改右侧面板宽度（等价于手动拖分隔条） */
function layoutPanels() {
  try {
    const layout = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("layout") : null;
    if (!layout) return null;
    return layout.panels || (layout.actions || null);
  } catch { return null; }
}

function applySidebarWide(on) {
  try {
    const vw = window.innerWidth;
    const P = ueWideParams();
    const target = on ? Math.max(300, vw - P.wideReserve) : Math.max(300, Math.min(P.narrowMax, Math.round(vw * (P.narrowRatio / 100))));
    const panels = layoutPanels();
    if (panels && typeof panels.setRightbar === "function") {
      panels.setRightbar(target);
      try { const st = document.getElementById("__ue_sbwide_style"); if (st) st.remove(); } catch { /* ignore */ }
      setTimeout(() => { try { if (CHAT_FLOAT.on) applyChatFloat(true); } catch { /* ignore */ } }, 80);
      return { ok: true, via: "layout.setRightbar", width: target };
    }
    // 兜底：CSS 覆盖（只在拿不到 layout 服务时用）
    let st = document.getElementById("__ue_sbwide_style");
    if (!on) {
      if (st) st.remove();
      setTimeout(() => { try { if (CHAT_FLOAT.on) applyChatFloat(true); } catch { /* ignore */ } }, 60);
      return { ok: true, off: true };
    }
    if (!st) { st = document.createElement("style"); st.id = "__ue_sbwide_style"; document.head.appendChild(st); }
    st.textContent = "[data-sidebar-right-session]{width:" + target + "px!important;max-width:" + target + "px!important;--dsh-sidebar-width:" + target + "px!important}";
    setTimeout(() => { try { if (CHAT_FLOAT.on) applyChatFloat(true); } catch { /* ignore */ } }, 80);
    return { ok: true, via: "css", width: target };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

function toggleSidebarWide() {
  const next = !sidebarWideOn();
  try { localStorage.setItem(SIDEBAR_WIDE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
  applySidebarWide(next);
  setTimeout(() => { try { if (CHAT_FLOAT.on) applyChatFloat(true); } catch { /* ignore */ } }, 60);
  return next;
}

/** ===== 整块对话列浮动（transform 方案：不动布局，只做位移/缩放） ===== */
const CHAT_FLOAT = { on: false, el: null, origin: "", spacer: null, zRaised: [], relaxed: [], observer: null, lastLocal: null, size: null, pos: null, userMoved: false, collapsed: false, lastRect: null, tools: null };

/** 默认不开启；只有用户点过「浮动对话」并打开时才生效（避免启动就把对话搬走） */
function chatFloatOn() {
  try { return localStorage.getItem("dsh-ui-editor:chatFloat") === "1"; } catch { return false; }
}

/** 找到"对话列"：包含消息滚动区 + 输入框的整体容器 */
function chatColumnContainer() {
  try {
    const input = findDshComposer();
    if (!input) return null;
    const editorRoot = document.querySelector(".wpe-tabview");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const unsafe = (node) => {
      try {
        if (!node || node === document.body || node === document.documentElement) return true;
        if (node.contains(document.getElementById("__ve_host"))) return true;
        if (editorRoot && node.contains(editorRoot)) return true; // 绝不能搬含编辑器的容器
        const rr = node.getBoundingClientRect();
        if (rr.width > vw * 0.8 || rr.height > vh * 0.94) return true; // 整窗级容器，危险
        return false;
      } catch { return true; }
    };
    let n = input.parentElement;
    let fallback = null;
    for (let i = 0; i < 16 && n && n !== document.body; i += 1) {
      if (unsafe(n)) break;
      const r = n.getBoundingClientRect();
      if (r.height > 300 && r.width > 300) {
        let hasScroller = false;
        try {
          for (const el of n.querySelectorAll("*")) {
            const cs = getComputedStyle(el);
            if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.clientHeight > 120 && el.scrollHeight > el.clientHeight + 20) { hasScroller = true; break; }
          }
        } catch { /* ignore */ }
        if (hasScroller) return n;
        if (!fallback) fallback = n;
      }
      n = n.parentElement;
    }
    return fallback;
  } catch { return null; }
}

function chatFloatBadge(info) {
  try {
    let el = document.getElementById("__ue_float_debug");
    if (!el) {
      el = document.createElement("div");
      el.id = "__ue_float_debug";
      el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:62vw;font:11px/1.4 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.65);padding:5px 8px;border-radius:8px;pointer-events:none;white-space:pre-wrap";
      document.body.appendChild(el);
    }
    const d = info || CHAT_FLOAT.lastLocal || {};
    el.textContent = "[UE 对话列] on=" + (CHAT_FLOAT.on ? "1" : "0")
      + (d.reason ? " reason=" + d.reason : "")
      + (d.rect ? " rect=" + d.rect.x + "," + d.rect.y + " " + d.rect.w + "x" + d.rect.h : "")
      + (d.raised != null ? " raised=" + d.raised : "")
      + (d.occluded ? " 被遮挡=" + d.occluded : "")
      + " theme=" + (UE_THEME_DARK ? "dark" : "light")
      + " mode=" + ueFloatMode();
  } catch { /* ignore */ }
}

function clearChatFloat() {
  try {
    const st = document.getElementById("__ue_chatfloat_style");
    if (st) st.remove();
  } catch { /* ignore */ }
  try {
    for (const bar of document.querySelectorAll(".wpe-ai.wpe-float")) {
      bar.style.display = bar.getAttribute("data-ue-origin-display") || "";
      bar.removeAttribute("data-ue-origin-display");
    }
  } catch { /* ignore */ }
  try { if (CHAT_FLOAT.spacer && CHAT_FLOAT.spacer.parentElement) CHAT_FLOAT.spacer.remove(); } catch { /* ignore */ }
  CHAT_FLOAT.spacer = null;
  try {
    for (const rec of CHAT_FLOAT.zRaised || []) {
      if (!rec || !rec.el) continue;
      if (rec.z) rec.el.style.setProperty("z-index", rec.z, rec.zP || ""); else rec.el.style.removeProperty("z-index");
      if (rec.pos) rec.el.style.setProperty("position", rec.pos, rec.posP || ""); else rec.el.style.removeProperty("position");
    }
  } catch { /* ignore */ }
  CHAT_FLOAT.zRaised = [];
  try {
    for (const rec of CHAT_FLOAT.relaxed || []) {
      if (!rec || !rec.el) continue;
      for (const p of rec.props || []) {
        if (rec.orig && rec.orig[p]) rec.el.style.setProperty(p, rec.orig[p], rec.origPriority[p] || "");
        else rec.el.style.removeProperty(p);
      }
    }
  } catch { /* ignore */ }
  CHAT_FLOAT.relaxed = [];
  try {
    if (CHAT_FLOAT.handle && CHAT_FLOAT.handle.parentElement) CHAT_FLOAT.handle.remove();
  } catch { /* ignore */ }
  CHAT_FLOAT.handle = null;
  try {
    for (const rec of CHAT_FLOAT.composerRestore || []) {
      try { rec.el.style.cssText = rec.css; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  CHAT_FLOAT.composerRestore = null;
  try {
    if (CHAT_FLOAT.tools && CHAT_FLOAT.tools.box && CHAT_FLOAT.tools.box.parentElement) CHAT_FLOAT.tools.box.remove();
  } catch { /* ignore */ }
  CHAT_FLOAT.tools = null;
  try {
    if (CHAT_FLOAT.el) {
      CHAT_FLOAT.el.removeAttribute("data-ue-chatfloat");
      CHAT_FLOAT.el.style.cssText = CHAT_FLOAT.origin || "";
    }
  } catch { /* ignore */ }
  try { if (CHAT_FLOAT.observer) CHAT_FLOAT.observer.disconnect(); } catch { /* ignore */ }
  CHAT_FLOAT.observer = null;
  CHAT_FLOAT.el = null;
  CHAT_FLOAT.on = false;
  CHAT_FLOAT.collapsed = false;
  CHAT_FLOAT.lastRect = null;
}

/** 折叠时的高度：只保留输入框卡片 */
function chatFloatCollapsedHeight() {
  let h = 140;
  try {
    const box = composerContainer();
    if (box) {
      const r = box.getBoundingClientRect();
      if (r.height > 60) h = Math.round(r.height) + 26;
    }
  } catch { /* ignore */ }
  return Math.max(110, Math.min(240, h));
}

/** 目标位置：默认浮在右侧边栏区域的"底部"（不挡顶部按钮）；用户拖动过则用拖动后的位置 */
/** 当前可见的编辑器面板矩形（多标签时只取可见那个，避免用隐藏标签的坐标导致抖动/残影） */
function visibleTabArea() {
  try {
    const list = [...document.querySelectorAll(".wpe-tabview")];
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      let hidden = false;
      try {
        const cs = getComputedStyle(el);
        hidden = cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05;
      } catch { /* ignore */ }
      if (hidden) continue;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  } catch { /* ignore */ }
  return null;
}

function chatFloatTarget() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const wBase = Math.round(Math.min(560, Math.max(360, vw * 0.36)));
  const hBase = Math.round(Math.min(620, Math.max(280, vh * 0.46)));
  const size = CHAT_FLOAT.size;
  const w = size ? Math.max(320, Math.min(vw - 8, size.w)) : wBase;
  const left = (CHAT_FLOAT.pos && CHAT_FLOAT.userMoved)
    ? Math.max(4, Math.min(vw - w - 4, CHAT_FLOAT.pos.left))
    : Math.max(8, vw - w - 20);
  if (CHAT_FLOAT.collapsed) {
    // 折叠时水平位置沿用当前模式（宽屏居中 / 窄屏右下），不再固定往右下
    let leftC = left;
    try {
      const modeC = ueFloatMode();
      if (CHAT_FLOAT.pos && CHAT_FLOAT.userMoved) {
        leftC = Math.max(4, Math.min(vw - w - 4, CHAT_FLOAT.pos.left));
      } else if (CHAT_FLOAT.defaultPos && CHAT_FLOAT.defaultFor === modeC) {
        leftC = Math.max(4, Math.min(vw - w - 4, CHAT_FLOAT.defaultPos.left));
      } else {
        const areaC = visibleTabArea();
        leftC = modeC === "wide"
          ? (areaC ? Math.max(8, Math.round(areaC.left + (areaC.width - w) / 2)) : Math.max(8, Math.round((vw - w) / 2)))
          : Math.max(8, vw - w - 20);
      }
    } catch { /* ignore */ }
    // 折叠：高度 = 输入卡片高度 + 一点padding，底边贴住视口底部（确定值，不会跳）
    let cardH = 96;
    try {
      const c = composerContainer() || findDshComposer();
      if (c) cardH = Math.round(c.getBoundingClientRect().height);
    } catch { /* ignore */ }
    cardH = Math.ceil(cardH / 2) * 2; // 取偶数，避免每 2 秒重算时 ±1px 抖动
    const sliver = 108;
    const h = Math.max(130, Math.min(460, Math.ceil((cardH + sliver + 4) / 2) * 2));
    let topC;
    if (CHAT_FLOAT.pos && CHAT_FLOAT.userMoved) {
      topC = Math.max(-40, Math.min(vh - 40, CHAT_FLOAT.pos.top));
    } else {
      topC = Math.max(0, vh - h);
      CHAT_FLOAT.pos = { left, top: topC }; // 记住位置，避免反复重算
    }
    return { left: leftC, top: topC, w, h };
  }
  const h = size ? Math.max(240, Math.min(vh - 8, size.h)) : hBase;
  const mode = ueFloatMode();
  if (CHAT_FLOAT.mode !== mode) {
    // 窄屏/宽屏切换：各自恢复自己的位置（没有记录则回各自默认）
    CHAT_FLOAT.mode = mode;
    CHAT_FLOAT.defaultFor = null; // 让默认位置为新模式重算一次
    const saved = ueLoadFloatPos(mode);
    if (saved) { CHAT_FLOAT.pos = { left: saved.left, top: saved.top }; CHAT_FLOAT.userMoved = true; }
    else { CHAT_FLOAT.pos = null; CHAT_FLOAT.userMoved = false; }
  }
  if (CHAT_FLOAT.pos && CHAT_FLOAT.userMoved) {
    const top2 = Math.max(4, Math.min(vh - h - 4, CHAT_FLOAT.pos.top));
    return { left: left, top: top2, w, h };
  }
  // 默认位置：同一模式只算一次并缓存（避免每 2 秒重算造成闪烁/残影）
  if (!CHAT_FLOAT.defaultPos || CHAT_FLOAT.defaultFor !== mode) {
    const area = visibleTabArea();
    const wide = mode === "wide";
    const defLeft = wide
      ? (area ? Math.max(8, Math.round(area.left + (area.width - w) / 2)) : Math.max(8, Math.round((vw - w) / 2)))
      : Math.max(8, vw - w - 20);
    CHAT_FLOAT.defaultFor = mode;
    CHAT_FLOAT.defaultPos = { left: defLeft, top: Math.max(8, vh - h - 24) };
  }
  return { left: CHAT_FLOAT.defaultPos.left, top: CHAT_FLOAT.defaultPos.top, w, h };
}

/** 全局兜底：清除残留的拖拽遮罩（丢在窗口外会导致整屏点不动） */
function cleanupStrayShields() {
  try {
    if (CHAT_FLOAT.dragging) return;
    for (const s of document.querySelectorAll("[data-ue-cf-shield]")) s.remove();
  } catch { /* ignore */ }
}
try {
  if (!window.__ueShieldHooked) {
    window.__ueShieldHooked = true;
    document.addEventListener("pointerup", () => setTimeout(cleanupStrayShields, 0), true);
    document.addEventListener("pointercancel", () => setTimeout(cleanupStrayShields, 0), true);
    window.addEventListener("blur", () => { CHAT_FLOAT.dragging = false; cleanupStrayShields(); });
  }
} catch { /* ignore */ }

/** 浮动面板滚动：滚轮/自定义滚动条都直接驱动记录下来的消息滚动区 */
function floatScrollEl() {
  const el = CHAT_FLOAT.scrollEl;
  if (el && el.isConnected && el.scrollHeight > el.clientHeight + 2) return el;
  try {
    const root = CHAT_FLOAT.el;
    if (!root) return null;
    let best = null;
    for (const d of root.querySelectorAll("*")) {
      if (d.scrollHeight <= d.clientHeight + 2) continue;
      if (d.clientHeight < 80) continue;
      const cs = getComputedStyle(d);
      // 放宽：auto/scroll/overlay 都算；hidden 但内容确实溢出的也尝试
      if (cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowY === "overlay" || cs.overflowY === "hidden") {
        const diff = d.scrollHeight - d.clientHeight;
        if (!best || diff > best.diff) best = { el: d, diff };
      }
    }
    if (best) { CHAT_FLOAT.scrollEl = best.el; return best.el; }
    // 兜底：面板自身可滚（如果内容超出）
    if (root.scrollHeight > root.clientHeight + 2) return root;
  } catch { /* ignore */ }
  return null;
}

function updateFloatScrollbar() {
  try {
    const tools = CHAT_FLOAT.tools;
    if (!tools || !tools.track || !tools.thumb) return;
    const sc = floatScrollEl();
    // 轨道常显；没有可滚区域时隐藏滑块
    tools.track.style.display = "block";
    if (!sc) { tools.thumb.style.display = "none"; return; }
    tools.thumb.style.display = "block";
    const ratio = sc.clientHeight / sc.scrollHeight;
    const trackH = tools.track.clientHeight || 200;
    const thumbH = Math.max(28, Math.min(trackH, Math.round(trackH * ratio)));
    tools.thumb.style.height = thumbH + "px";
    const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
    const top = Math.round((sc.scrollTop / maxScroll) * (trackH - thumbH));
    tools.thumb.style.top = Math.max(0, Math.min(trackH - thumbH, top)) + "px";
  } catch { /* ignore */ }
}

function setFloatScrollRatio(r) {
  try {
    const sc = floatScrollEl();
    const tools = CHAT_FLOAT.tools;
    if (!sc || !tools || !tools.track) return;
    const trackH = tools.track.clientHeight || 200;
    const thumbH = (tools.thumb && tools.thumb.offsetHeight) || 30;
    const maxTop = Math.max(1, trackH - thumbH);
    const p = Math.max(0, Math.min(1, r / maxTop));
    sc.scrollTop = Math.round(p * Math.max(0, sc.scrollHeight - sc.clientHeight));
    updateFloatScrollbar();
  } catch { /* ignore */ }
}

/** 浮动面板的拖拽/缩放工具层（放在 body 顶层，避免被 React 重渲染清掉） */
function ensureFloatTools() {
  if (CHAT_FLOAT.tools && CHAT_FLOAT.tools.box && CHAT_FLOAT.tools.box.isConnected) return CHAT_FLOAT.tools;
  try { if (CHAT_FLOAT.tools && CHAT_FLOAT.tools.box) CHAT_FLOAT.tools.box.remove(); } catch { /* ignore */ }
  const box = document.createElement("div");
  box.setAttribute("data-ue-cf-tools", "1");
  box.style.cssText = "position:fixed;z-index:2147483001;pointer-events:none";
  document.body.appendChild(box);
  const mk = (css, cursor, title, text) => {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;pointer-events:auto;" + css;
    d.style.cursor = cursor;
    if (title) d.title = title;
    if (text) d.textContent = text;
    box.appendChild(d);
    return d;
  };
  const top = mk("left:22px;right:22px;top:0;height:20px;display:flex;align-items:center;justify-content:center;color:#64748b;font:10px/1 system-ui,sans-serif;user-select:none;cursor:move", "move", "按住拖动；双击回默认位置", "⋮⋮ 拖动");
  const left = mk("left:0;top:20px;bottom:5px;width:5px", "move", "按住拖动");
  const right = mk("right:0;top:20px;bottom:5px;width:5px", "move", "按住拖动");
  const bottom = mk("left:0;right:0;bottom:0;height:5px", "move", "按住拖动");
  const corner = mk("right:0;bottom:0;width:18px;height:18px;border-radius:0 0 12px 0;background:linear-gradient(135deg,transparent 42%,rgba(71,85,105,.55) 42%,rgba(71,85,105,.55) 58%,transparent 58%)", "nwse-resize", "按住拖动 = 调整大小（右=变宽，下=变高）");
  const fold = mk("left:4px;top:1px;width:22px;height:19px;display:flex;align-items:center;justify-content:center;border-radius:7px;background:rgba(255,255,255,.7);color:#334155;font:12px/1 system-ui,sans-serif;border:1px solid rgba(15,23,42,.10)", "pointer", "折叠/展开历史消息", "▴");
  fold.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  fold.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleChatFloatCollapse(); });
  // 独立滚动条（右侧细条，可拖动）
  const track = mk("right:2px;top:26px;bottom:8px;width:10px;display:block;border-radius:6px;background:rgba(15,23,42,.10);border:1px solid rgba(15,23,42,.06)", "default", "拖动滚动历史消息");
  const thumb = document.createElement("div");
  thumb.style.cssText = "position:absolute;left:1px;right:1px;top:0;height:40px;border-radius:5px;background:rgba(71,85,105,.45);pointer-events:auto;cursor:grab";
  track.appendChild(thumb);
  thumb.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startY = ev.clientY;
    const startTop = parseFloat(thumb.style.top || "0") || 0;
    const sc = floatScrollEl();
    const tools1 = CHAT_FLOAT.tools;
    if (!sc || !tools1 || !tools1.track) return;
    const shield = document.createElement("div");
    shield.setAttribute("data-ue-cf-shield", "1");
    shield.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483040;cursor:grabbing;background:transparent";
    document.body.appendChild(shield);
    const move = (mv) => { try { setFloatScrollRatio(startTop + (mv.clientY - startY)); } catch { /* ignore */ } };
    const done = () => {
      try { window.removeEventListener("pointermove", move, true); } catch { /* ignore */ }
      try { window.removeEventListener("pointerup", done, true); } catch { /* ignore */ }
      try { if (shield.parentElement) shield.remove(); } catch { /* ignore */ }
    };
    shield.addEventListener("pointermove", move);
    shield.addEventListener("pointerup", done);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", done, true);
  });
  const faint = document.createElement("div");
  faint.setAttribute("data-ue-cf-faintline", "1");
  faint.style.cssText = "position:absolute;left:10px;right:10px;top:0;height:72px;display:none;overflow:hidden;pointer-events:none;"
    + "font:11.5px/18px system-ui,sans-serif;color:#64748b;opacity:.6;white-space:pre-line;text-align:left;"
    + "mask-image:linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 100%);"
    + "-webkit-mask-image:linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 100%)";
  box.appendChild(faint);
  CHAT_FLOAT.tools = { box, top, left, right, bottom, corner, fold, track, thumb };

  /* 拖动/缩放期间铺一层全屏遮罩：鼠标移到 iframe 上方也不会丢 pointerup（解决"粘连"） */
  let activeShield = null;
  const clearShield = () => {
    try { if (activeShield && activeShield.parentElement) activeShield.remove(); } catch { /* ignore */ }
    activeShield = null;
    try { for (const s of document.querySelectorAll("[data-ue-cf-shield]")) s.remove(); } catch { /* ignore */ }
    CHAT_FLOAT.dragging = false;
  };
  const withShield = (cursor, onMove, onDone) => {
    clearShield();
    CHAT_FLOAT.dragging = true;
    const shield = document.createElement("div");
    shield.setAttribute("data-ue-cf-shield", "1");
    shield.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483040;cursor:" + cursor + ";background:transparent";
    document.body.appendChild(shield);
    activeShield = shield;
    const move = (mv) => { try { onMove(mv); } catch { /* ignore */ } };
    const done = () => {
      try { window.removeEventListener("pointermove", move, true); } catch { /* ignore */ }
      try { window.removeEventListener("pointerup", done, true); } catch { /* ignore */ }
      try { window.removeEventListener("pointercancel", done, true); } catch { /* ignore */ }
      clearShield();
      try { if (onDone) onDone(); } catch { /* ignore */ }
    };
    shield.addEventListener("pointermove", move);
    shield.addEventListener("pointerup", done);
    shield.addEventListener("pointercancel", done);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  };

  const beginDrag = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const base = chatFloatTarget();
    withShield("move", (mv) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const leftPx = Math.max(2, Math.min(vw - base.w - 2, base.left + (mv.clientX - startX)));
      const topPx = Math.max(2, Math.min(vh - base.h - 2, base.top + (mv.clientY - startY)));
      CHAT_FLOAT.pos = { left: leftPx, top: topPx };
      CHAT_FLOAT.userMoved = true;
      const el = CHAT_FLOAT.el;
      if (el) {
        el.style.setProperty("--ue-cf-left", leftPx + "px");
        el.style.setProperty("--ue-cf-top", topPx + "px");
        positionFloatTools(el.getBoundingClientRect());
      }
    }, () => { try { ueSaveFloatPos(ueFloatMode(), CHAT_FLOAT.pos || { left: 0, top: 0 }); } catch { /* ignore */ } });
  };
  for (const strip of [top, left, right, bottom]) strip.addEventListener("pointerdown", beginDrag);

  const beginResize = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const base = chatFloatTarget();
    withShield("nwse-resize", (mv) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      const w = Math.max(320, Math.min(vw - base.left - 4, base.w + dx));
      const h = Math.max(120, Math.min(vh - base.top - 4, base.h + dy));
      CHAT_FLOAT.collapsed = false;
      CHAT_FLOAT.size = { w: Math.round(w), h: Math.round(h) };
      CHAT_FLOAT.pos = { left: base.left, top: base.top };
      CHAT_FLOAT.userMoved = true;
      const el = CHAT_FLOAT.el;
      if (el) {
        el.style.setProperty("--ue-cf-w", Math.round(w) + "px");
        el.style.setProperty("--ue-cf-h", Math.round(h) + "px");
        el.style.setProperty("--ue-cf-left", base.left + "px");
        el.style.setProperty("--ue-cf-top", base.top + "px");
        positionFloatTools(el.getBoundingClientRect());
      }
    });
  };
  corner.addEventListener("pointerdown", beginResize);

  top.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    CHAT_FLOAT.userMoved = false;
    CHAT_FLOAT.pos = null;
    CHAT_FLOAT.size = null;
    CHAT_FLOAT.collapsed = false;
    applyChatFloat(true);
  });
  return CHAT_FLOAT.tools;
}

function positionFloatTools(r) {
  try {
    const tools = CHAT_FLOAT.tools;
    if (!tools || !tools.box || !r) return;
    const top = Math.max(0, Math.round(r.top));
    const visibleH = Math.max(80, Math.min(Math.round(r.height), window.innerHeight - top));
    tools.box.style.left = Math.round(r.left) + "px";
    tools.box.style.top = top + "px";
    tools.box.style.width = Math.round(r.width) + "px";
    tools.box.style.height = visibleH + "px";
    tools.box.style.display = "block";
    if (tools.fold) tools.fold.textContent = CHAT_FLOAT.collapsed ? "▾" : "▴";
    // 折叠时工具层隐形（保持可拖），展开恢复
    try {
      if (CHAT_FLOAT.collapsed && tools.faint) {
        tools.faint.style.color = UE_THEME_DARK ? "rgba(255,255,255,.85)" : "rgba(100,116,139,.62)";
        tools.faint.style.textShadow = UE_THEME_DARK ? "0 1px 2px rgba(0,0,0,.45)" : "0 1px 2px rgba(255,255,255,.55)";
        let cardH = 96;
        try { const c = composerContainer() || findDshComposer(); if (c) cardH = Math.round(c.getBoundingClientRect().height); } catch { /* ignore */ }
        const faintH = Math.min(104, Math.max(36, Math.round(r.height - cardH - 6)));
        tools.faint.style.height = faintH + "px";
        tools.faint.style.top = Math.max(0, Math.round(r.height - cardH - faintH - 2)) + "px";
      }
    } catch { /* ignore */ }
    try {
      if (CHAT_FLOAT.collapsed) {
        tools.top.style.background = "transparent";
        tools.top.style.borderColor = "transparent";
        tools.top.textContent = "⋮⋮ 拖动 · 点 ▾ 展开历史";
        tools.top.setAttribute("data-ue-faint", "1");
        if (tools.fold) tools.fold.style.opacity = "0.35";
        if (tools.corner) tools.corner.style.display = "none";
        if (tools.track) tools.track.style.display = "none";
      } else {
        tools.top.style.background = "rgba(15,23,42,.08)";
        tools.top.style.borderColor = "";
        tools.top.textContent = "⋮⋮ 拖动";
        tools.top.removeAttribute("data-ue-faint");
        if (tools.fold) tools.fold.style.opacity = "1";
        if (tools.corner) tools.corner.style.display = "";
        if (tools.track) tools.track.style.display = "block";
      }
    } catch { /* ignore */ }
    updateFloatScrollbar();
  } catch { /* ignore */ }
}

/** 恢复因折叠被隐藏的节点（防止遗留后整个面板变空） */
function restoreHiddenMsg(root) {
  try {
    const scopes = [];
    if (root) scopes.push(root);
    scopes.push(document);
    for (const scope of scopes) {
      for (const n of scope.querySelectorAll("[data-ue-cf-hiddenmsg]")) {
        try { n.style.removeProperty("display"); } catch { /* ignore */ }
        try { n.removeAttribute("data-ue-cf-hiddenmsg"); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** 折叠时的视觉效果：上方留一小段历史（文字向上渐隐），输入卡片周围全透明 */
/** 取最近一条"真正的消息文本"（跳过互动符号/按钮行） */
function ueLastMessageLine() {
  try {
    const sc = floatScrollEl();
    const raw = (sc && sc.innerText) || "";
    const lines = raw.split("\n").map((x) => x.trim()).filter(Boolean);
    const junk = /^(复制|好评|差评|引用|分享|收藏|重试|编辑|删除|重新生成|已复制|复制成功|展开|收起|更多|显示更多|复制代码|[\d\s:：·\-—>…\.]+)$/;
    const picked = [];
    for (let i = lines.length - 1; i >= 0 && picked.length < 4; i -= 1) {
      const s = lines[i];
      if (s.length < 4) continue;
      if (junk.test(s)) continue;
      if (/^[\p{P}\p{S}\s]+$/u.test(s)) continue;
      if (/^\d+[.、)]/.test(s) && s.length < 8) continue;
      picked.unshift(s.slice(0, 80));
    }
    return picked.join("\n");
  } catch { return ""; }
}

/** 刷新折叠淡字（内容变化时也要更新） */
function ueRefreshFaint() {
  try {
    const faint = CHAT_FLOAT.tools && CHAT_FLOAT.tools.faint;
    if (!faint) return;
    if (!CHAT_FLOAT.collapsed) { faint.style.display = "none"; return; }
    faint.style.display = "block";
    faint.textContent = ueLastMessageLine() || "（暂无消息）";
    faint.style.color = UE_THEME_DARK ? "rgba(255,255,255,.86)" : "rgba(100,116,139,.62)";
    faint.style.textShadow = UE_THEME_DARK ? "0 1px 2px rgba(0,0,0,.5)" : "0 1px 2px rgba(255,255,255,.6)";
  } catch { /* ignore */ }
}

function applyCollapsedVisual(on) {
  const el = CHAT_FLOAT.el;
  if (!el) return;
  try {
    // 1) 淡字提示（折叠时）
    const faint = CHAT_FLOAT.tools && CHAT_FLOAT.tools.faint;
    const restore = () => {
      for (const rec of CHAT_FLOAT.collapsedRestore || []) {
        try { rec.el.style.cssText = rec.css; } catch { /* ignore */ }
      }
      CHAT_FLOAT.collapsedRestore = [];
    };
    // 2) 输入框周围外框透明（折叠/展开都做，去掉那圈"实心"底板）
    if (!CHAT_FLOAT.composerRestore) {
      CHAT_FLOAT.composerRestore = [];
      try {
        const composer = composerContainer() || findDshComposer();
        let p = composer && composer.parentElement;
        let guard = 0;
        while (p && p !== el && guard < 8) {
          CHAT_FLOAT.composerRestore.push({ el: p, css: p.style.cssText });
          p.style.setProperty("background", "transparent", "important");
          p.style.setProperty("background-color", "transparent", "important");
          p.style.setProperty("box-shadow", "none", "important");
          p.style.setProperty("border-color", "transparent", "important");
          p = p.parentElement;
          guard += 1;
        }
      } catch { /* ignore */ }
    }
    if (!on) {
      restore();
      if (faint) faint.style.display = "none";
      return;
    }
    restore();
    const sc = floatScrollEl();
    let lastLine = "";
    try {
      const raw = (sc && sc.innerText) || "";
      const lines = raw.split("\n").map((x) => x.trim()).filter(Boolean);
      lastLine = (lines[lines.length - 1] || "").slice(0, 60);
    } catch { /* ignore */ }
    if (faint) {
      faint.textContent = lastLine || ueLastMessageLine() || "（暂无消息）";
      faint.style.display = "block";
    }
    // 隐藏历史区（避免大白块）
    try {
      const composer = composerContainer() || findDshComposer();
      let node = sc;
      while (node && node.parentElement && node.parentElement !== el) node = node.parentElement;
      if (node && node !== el && !(composer && node.contains(composer))) {
        CHAT_FLOAT.collapsedRestore.push({ el: node, css: node.style.cssText });
        node.style.setProperty("display", "none", "important");
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

/** 折叠/展开：折叠后只保留输入框（高度按输入卡片算），并保持底边不动 */
function toggleChatFloatCollapse() {
  const el = CHAT_FLOAT.el;
  let prev = CHAT_FLOAT.lastRect;
  try { if (el && el.isConnected) { const r = el.getBoundingClientRect(); prev = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } } catch { /* ignore */ }
  if (!CHAT_FLOAT.collapsed) {
    CHAT_FLOAT.posBeforeCollapse = (CHAT_FLOAT.pos && CHAT_FLOAT.userMoved)
      ? { left: CHAT_FLOAT.pos.left, top: CHAT_FLOAT.pos.top }
      : (prev ? { left: prev.x, top: prev.y } : null);
    CHAT_FLOAT.collapsed = true;
    try { const c = composerContainer() || findDshComposer(); { const ch = c ? Math.round(c.getBoundingClientRect().height) : 96; CHAT_FLOAT.collapsedH = Math.ceil((ch + 108 + 4) / 2) * 2; } } catch { CHAT_FLOAT.collapsedH = 170; }
    try {
      const hCur = CHAT_FLOAT.collapsedH || 96;
      const prevL = (prev && typeof prev.x === "number") ? prev.x : Math.max(8, window.innerWidth - 560 - 20);
      const prevT = (prev && typeof prev.y === "number") ? prev.y : Math.max(0, window.innerHeight - hCur - 12);
      CHAT_FLOAT.pos = { left: prevL, top: prevT };
      CHAT_FLOAT.userMoved = false;
    } catch { /* ignore */ }
    // 折叠视觉：上方历史残影 + 下方全透明
    try { applyCollapsedVisual(true); } catch { /* ignore */ }
  } else {
    CHAT_FLOAT.collapsed = false;
    try { applyCollapsedVisual(false); } catch { /* ignore */ }
    try { restoreHiddenMsg(el || document); } catch { /* ignore */ }
    if (CHAT_FLOAT.posBeforeCollapse) {
      CHAT_FLOAT.pos = { left: CHAT_FLOAT.posBeforeCollapse.left, top: CHAT_FLOAT.posBeforeCollapse.top };
      CHAT_FLOAT.userMoved = true;
    }
  }
  applyChatFloat(true);
}

function applyChatFloat(on) {
  try {
    cleanupStrayShields();
    if (on && CHAT_FLOAT.blockedUntil && Date.now() < CHAT_FLOAT.blockedUntil) {
      return (CHAT_FLOAT.lastLocal = { ok: false, reason: "cooldown" });
    }
    if (!on) { try { applyCollapsedVisual(false); } catch { /* ignore */ } try { restoreHiddenMsg(document); } catch { /* ignore */ } clearChatFloat(); CHAT_FLOAT.lastLocal = { ok: true, off: true }; chatFloatBadge(); return CHAT_FLOAT.lastLocal; }
    let el = CHAT_FLOAT.el;
    if (!el || !el.isConnected) {
      el = chatColumnContainer();
      if (!el) return (CHAT_FLOAT.lastLocal = { ok: false, reason: "no-column" });
      try {
        const rr = el.getBoundingClientRect();
        if (rr.width < 120 || rr.height < 120) return (CHAT_FLOAT.lastLocal = { ok: false, reason: "column-hidden" });
      } catch { /* ignore */ }
      clearChatFloat();
      const r = el.getBoundingClientRect();
      CHAT_FLOAT.origin = el.style.cssText;
      CHAT_FLOAT.el = el;
      // 占位：保住原布局（聊天列从文档流摘出后不留空洞）
      try {
        const spacer = document.createElement("div");
        spacer.setAttribute("data-ue-chatfloat-spacer", "1");
        spacer.style.cssText = "width:0px;height:0px;flex:0 0 auto;pointer-events:none;visibility:hidden";
        if (el.parentElement) el.parentElement.insertBefore(spacer, el);
        CHAT_FLOAT.spacer = spacer;
      } catch { /* ignore */ }
      // 安全检查：绝不能把包含编辑器/整窗的容器当对话列搬走
      try {
        const editorRoot2 = document.querySelector(".wpe-tabview");
        const rr0 = el.getBoundingClientRect();
        const bad = (editorRoot2 && el.contains(editorRoot2)) || rr0.width > window.innerWidth * 0.85 || rr0.height > window.innerHeight * 0.95;
        if (bad) {
          clearChatFloat();
          CHAT_FLOAT.blockedUntil = Date.now() + 10000;
          CHAT_FLOAT.lastLocal = { ok: false, reason: "unsafe-column" };
          chatFloatBadge();
          return CHAT_FLOAT.lastLocal;
        }
      } catch { /* ignore */ }
      try {
        let best = null;
        for (const d of el.querySelectorAll("*")) {
          const cs = getComputedStyle(d);
          if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && d.scrollHeight > d.clientHeight + 4) {
            const diff = d.scrollHeight - d.clientHeight;
            if (!best || diff > best.diff) best = { el: d, diff };
          }
        }
        CHAT_FLOAT.scrollEl = best ? best.el : null;
      } catch { /* ignore */ }
      CHAT_FLOAT.relaxed = relaxAncestors(el);
      CHAT_FLOAT.zRaised = raiseStackingAncestors(el);
      try { el.style.setProperty("visibility", "hidden", "important"); } catch { /* ignore */ }
      el.setAttribute("data-ue-chatfloat", "1");
      // 滚轮：直接驱动记录下来的消息滚动区（避免滚错对象）
      try {
        if (!el.__ueWheel2) {
          el.__ueWheel2 = true;
          el.addEventListener("wheel", (ev) => {
            try {
              const sc = floatScrollEl();
              if (!sc) return;
              const before = sc.scrollTop;
              sc.scrollTop = before + ev.deltaY;
              if (sc.scrollTop !== before) { ev.preventDefault(); ev.stopPropagation(); }
              updateFloatScrollbar();
            } catch { /* ignore */ }
          }, { passive: false, capture: true });
        }
        const sc = floatScrollEl();
        if (sc && !sc.__ueScrollHooked) {
          sc.__ueScrollHooked = true;
          sc.addEventListener("scroll", () => updateFloatScrollbar(), { passive: true });
        }
      } catch { /* ignore */ }
      // 滚轮翻历史：捕获级处理，不依赖内部布局
      try {
        if (!el.__ueWheel) {
          el.__ueWheel = true;
          /* 原生滚轮：不再拦截，避免卡顿/滚错对象 */
        }
      } catch { /* ignore */ }
      // 拖拽/缩放工具层（body 顶层）
      try { ensureFloatTools(); } catch { /* ignore */ }
    }
    if (!CHAT_FLOAT.collapsed) restoreHiddenMsg(el);
    const pos = chatFloatTarget();
    let st = document.getElementById("__ue_chatfloat_style");
    if (!st) { st = document.createElement("style"); st.id = "__ue_chatfloat_style"; document.head.appendChild(st); }
    st.textContent = "[data-ue-chatfloat]{position:fixed!important;left:var(--ue-cf-left," + pos.left + "px)!important;top:var(--ue-cf-top," + pos.top + "px)!important;right:auto!important;bottom:auto!important;"
      + "width:var(--ue-cf-w," + pos.w + "px)!important;height:var(--ue-cf-h," + pos.h + "px)!important;max-height:none!important;background:linear-gradient(180deg,rgba(255,255,255,.10) 0%,rgba(255,255,255,.40) 55%,rgba(255,255,255,.56) 100%)!important;backdrop-filter:blur(12px) saturate(1.05)!important;"
      + "border:1px solid rgba(15,23,42,.12)!important;border-radius:14px!important;box-shadow:0 18px 48px rgba(15,23,42,.28)!important;overflow-x:hidden!important;overflow-y:auto!important;"
      + "opacity:.9!important;transition:opacity .18s ease!important;z-index:2147483000!important;display:flex!important;visibility:visible!important}"
      + "[data-ue-chatfloat]:hover{opacity:1!important}"
      + "[data-ue-chatfloat]:not([data-ue-collapsed]) > div{background-color:transparent!important}"
      + "[data-ue-chatfloat]:not([data-ue-collapsed]) > div > div{background-color:transparent!important}"
      + "[data-ue-chatfloat][data-ue-collapsed]{background:transparent!important;border:none!important;box-shadow:none!important;backdrop-filter:none!important;padding:0!important;border-radius:0!important;opacity:1!important}"
      + "[data-ue-chatfloat][data-ue-collapsed] > *{background-color:transparent!important;box-shadow:none!important;border-color:transparent!important}"
      + "@keyframes ueFaintText{0%,100%{opacity:.16}50%{opacity:.55}}"
      + "[data-ue-cf-tools] [data-ue-faint='1']{animation:ueFaintText 3.6s ease-in-out infinite!important;color:#64748b!important;font:10px/1 system-ui,sans-serif!important;letter-spacing:.5px!important}"
      + "[data-ue-chatfloat] > div{background-color:transparent!important}"
      + "[data-ue-chatfloat] > div > div{background-color:transparent!important}"
      + "[data-ue-chatfloat] > div > div > div{background-color:transparent!important}";
    try {
      el.style.setProperty("--ue-cf-left", pos.left + "px");
      el.style.setProperty("--ue-cf-top", pos.top + "px");
      el.style.setProperty("--ue-cf-w", pos.w + "px");
      el.style.setProperty("--ue-cf-h", pos.h + "px");
    } catch { /* ignore */ }
    try { el.style.setProperty("visibility", "visible", "important"); } catch { /* ignore */ }
    CHAT_FLOAT.on = true;
    // 隐藏编辑器自己的底部 AI 条，避免和浮动对话叠在一起
    try {
      for (const bar of document.querySelectorAll(".wpe-ai.wpe-float")) {
        if (!bar.getAttribute("data-ue-origin-display")) bar.setAttribute("data-ue-origin-display", bar.style.display || "");
        bar.style.display = "none";
      }
    } catch { /* ignore */ }
    // 全屏状态：隐藏占位块，让侧边栏拉伸（否则左侧会被原对话容器截断）
    try {
      let isFs = false;
      if (nativeNav) {
        try { if (typeof nativeNav.isExpanded === "function" && nativeNav.isExpanded()) isFs = true; } catch { /* ignore */ }
        try { if (typeof nativeNav.isFullscreen === "function" && nativeNav.isFullscreen()) isFs = true; } catch { /* ignore */ }
      }
      if (!isFs) {
        const tv = document.querySelector(".wpe-tabview");
        if (tv) { const tr = tv.getBoundingClientRect(); if (tr.width > window.innerWidth * 0.8) isFs = true; }
      }
      if (CHAT_FLOAT.spacer) CHAT_FLOAT.spacer.style.display = isFs ? "none" : "";
      CHAT_FLOAT.fullscreen = isFs;
    } catch { /* ignore */ }
    try {
      if (CHAT_FLOAT.collapsed) el.setAttribute("data-ue-collapsed", "1");
      else {
        el.removeAttribute("data-ue-collapsed");
        try { applyCollapsedVisual(false); } catch { /* ignore */ }
      }
      ueRefreshFaint();
    } catch { /* ignore */ }
    const r2 = el.getBoundingClientRect();
    CHAT_FLOAT.lastRect = { x: Math.round(r2.left), y: Math.round(r2.top), w: Math.round(r2.width), h: Math.round(r2.height) };
    // 拖拽/缩放工具层贴住面板
    positionFloatTools(r2);
    const inView = CHAT_FLOAT.collapsed
      ? (r2.left >= -2 && r2.top >= -2 && r2.left < window.innerWidth - 50 && r2.width > 200)
      : (r2.left >= -2 && r2.top >= -2 && r2.right <= window.innerWidth + 2 && r2.bottom <= window.innerHeight + 2 && r2.width > 200 && r2.height > 160);
    if (!inView) {
      clearChatFloat();
      CHAT_FLOAT.lastLocal = { ok: false, reason: "out-of-view:" + Math.round(r2.left) + "," + Math.round(r2.top) + " " + Math.round(r2.width) + "x" + Math.round(r2.height) };
      chatFloatBadge();
      return CHAT_FLOAT.lastLocal;
    }
    let occluded = "";
    try {
      const stack = document.elementsFromPoint ? document.elementsFromPoint(Math.round(r2.left + r2.width / 2), Math.round(r2.top + 30)) : [];
      const top = stack.find((x) => !(x.closest && x.closest("#__ve_host")));
      const mine = top && (top === el || el.contains(top) || top.contains(el));
      if (top && !mine) occluded = (top.tagName || "?").toLowerCase() + "." + String(top.className || "").split(" ")[0].slice(0, 22);
    } catch { /* ignore */ }
    CHAT_FLOAT.lastLocal = { ok: true, rect: { x: Math.round(r2.x), y: Math.round(r2.y), w: Math.round(r2.width), h: Math.round(r2.height) }, raised: (CHAT_FLOAT.zRaised || []).length, occluded };
    chatFloatBadge();
    return CHAT_FLOAT.lastLocal;
  } catch (e) {
    CHAT_FLOAT.lastLocal = { ok: false, reason: "error:" + String((e && e.message) || e) };
    chatFloatBadge();
    return CHAT_FLOAT.lastLocal;
  }
}

function keepChatFloat() {
  try { localStorage.removeItem("dsh-ui-editor:chatFloat"); } catch { /* ignore */ }
  if (chatFloatOn()) applyChatFloat(true);
  else if (CHAT_FLOAT.on) applyChatFloat(false);
  return chatFloatOn();
}

function toggleChatFloat() {
  const next = !chatFloatOn();
  try { localStorage.setItem("dsh-ui-editor:chatFloat", next ? "1" : "0"); } catch { /* ignore */ }
  return applyChatFloat(next);
}

function floatChatOn() {
  return chatFloatOn();
}

/** 兼容旧接口：宿主驱动已不可用（宿主是 Node 模式），直接走本地实现 */
async function applyComposerFloat(on) {
  return applyComposerFloatLocal(on);
}

function composerBox() {
  return composerContainer();
}
function keepComposerFloat() {
  if (!FLOAT_FEATURE) {
    cleanupLegacyFloat();
    return false;
  }
  let enabled = true;
  try { localStorage.setItem("dsh-ui-editor:floatChat", "1"); } catch { /* ignore */ }
  applyComposerFloat(enabled);
  return enabled;
}

/** 找到 DSH 对话输入框（排除插件自己的输入控件） */
/** 深度收集所有输入框（含 Shadow DOM），并记录来源信息 */
function collectComposerCandidates() {
  const roots = [document];
  const seen = new Set();
  const walk = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
      }
    } catch { /* ignore */ }
  };
  try { walk(document); } catch { /* ignore */ }
  const inputs = [];
  const placeholders = [];
  for (const root of roots) {
    try {
      for (const el of root.querySelectorAll("textarea, [contenteditable='true'], [contenteditable=''], [role='textbox']")) inputs.push(el);
      for (const el of root.querySelectorAll("[placeholder]")) placeholders.push(el);
    } catch { /* ignore */ }
  }
  return { roots, inputs, placeholders };
}

function findDshComposer() {
  try {
    const { inputs, placeholders } = collectComposerCandidates();
    const visible = inputs.filter((el) => {
      if (el.closest && el.closest("[data-wpe], [data-ve-host], #__ve_host")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 80 && r.height > 10;
    });
    if (visible.length) return visible.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    for (const el of placeholders) {
      const ph = el.getAttribute("placeholder") || "";
      if (/消息|输入|message|ask|prompt/i.test(ph)) {
        const r = el.getBoundingClientRect();
        if (r.width > 80 && r.height > 8) return el;
      }
    }
    return null;
  } catch { return null; }
}

/** 把编辑器上下文接到要发送的消息后面（在 Enter / 点发送之前调用） */
function appendEditorContextBeforeSend() {
  try {
    const extra = editorCtxText();
    if (!extra) return false;
    const el = findDshComposer();
    if (!el) return false;
    const current = el.tagName === "TEXTAREA" ? el.value : el.innerText || "";
    if (!current.trim()) return false; // 空消息不附带
    if (current.includes("〔网页修改器上下文〕")) return false; // 已经带过
    const text = current.replace(/s+$/, "") + "\n\n" + extra;
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  } catch (e) {
    console.warn("[dsh-ui-editor] 附带选区失败", e);
    return false;
  }
}

const API_PATH = "/ve/plugin";
    /** 桌面窗口（dsh-app://）够不到同源接口；宿主会额外监听 19390 起的固定端口 */
    const AUX_PORTS = [19390, 19391, 19392, 19393, 19394, 19395, 19396, 19397, 19398, 19399];
    let apiBase = null;
    let apiBaseTask = null;

    function isHttpPage() {
      return typeof location !== "undefined" && /^https?:$/.test(location.protocol);
    }

    /** 找一个能连上宿主的 base：Web GUI 用同源；桌面窗口用本机固定端口 */
    async function detectApiBase() {
      if (apiBase !== null) return apiBase;
      if (apiBaseTask) return apiBaseTask;
      apiBaseTask = (async () => {
        const candidates = [];
        if (isHttpPage()) candidates.push("");
        for (const port of AUX_PORTS) candidates.push("http://127.0.0.1:" + port);
        for (const base of candidates) {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 500);
            const res = await fetch(base + API_PATH + "/ping", { signal: ctrl.signal, cache: "no-store" });
            clearTimeout(timer);
            if (!res.ok) continue;
            const data = await res.json().catch(() => null);
            if (data && data.ok) {
              apiBase = base;
              console.info("[dsh-ui-editor] 宿主接口已连接：" + (base || "同源"));
              return base;
            }
          } catch { /* 试下一个 */ }
        }
        apiBase = isHttpPage() ? "" : null;
        console.warn("[dsh-ui-editor] 没连上宿主接口；桌面窗口请确认插件宿主已加载（DSH 设置→插件里能看到它）");
        return apiBase;
      })();
      return apiBaseTask;
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    const CSS = `
      .wpe-drawer,.wpe-drawer *{box-sizing:border-box}
      .wpe-drawer{position:fixed;top:0;right:0;bottom:0;width:min(820px,54vw);min-width:460px;background:#fff;color:#111;
        border-left:1px solid #d7dbe3;box-shadow:-12px 0 40px rgba(15,23,42,.16);z-index:2147483000;display:flex;flex-direction:column;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5}
      .wpe-h{display:flex;align-items:center;gap:8px;padding:0 12px;min-height:46px;border-bottom:1px solid #e5e7eb;flex:0 0 auto}
      .wpe-h b{font-size:13px;letter-spacing:.02em}
      .wpe-badge{font-size:11px;padding:1px 7px;border-radius:999px;background:#eef2ff;color:#3b4fd8;font-weight:600}
      .wpe-h .wpe-sp{flex:1}
      .wpe-x{border:0;background:transparent;cursor:pointer;font-size:16px;color:#888;padding:2px 6px;border-radius:6px;line-height:1}
      .wpe-x:hover{background:#f3f4f6;color:#111}
      .wpe-body{flex:1;display:flex;flex-direction:column;min-height:0}
      .wpe-pathrow{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #f0f2f5;flex:0 0 auto}
      .wpe-pathrow input{flex:1;min-width:0;height:32px;border:2px solid #cdd4e0;border-radius:3px;padding:0 9px;font-size:12.5px;font-family:ui-monospace,Menlo,Consolas,monospace;outline:none}
      .wpe-pathrow input:focus{border-color:#3b4fd8}
      .wpe-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;border:1px solid #dfe3ea;background:#fff;border-radius:7px;padding:0 11px;font-size:12.5px;cursor:pointer;white-space:nowrap;color:#111;line-height:1}
      .wpe-btn:hover{background:#f7f8fa;border-color:#c9cfe0}
      .wpe-btn.pri{background:#111;color:#fff;border-color:#111}
      .wpe-btn.pri:hover{background:#000}
      .wpe-btn:disabled{opacity:.45;cursor:not-allowed}
      .wpe-btn.on{background:#eef2ff;border-color:#3b4fd8;color:#26318f}
      .wpe-list{flex:1;overflow:auto;padding:6px 8px;min-height:0}
      .wpe-dir{display:flex;align-items:center;gap:8px;min-height:34px;padding:5px 9px;border-radius:8px;cursor:pointer}
      .wpe-dir:hover{background:#f5f7fb}
      .wpe-dir.proj{cursor:pointer}
      .wpe-dir.proj:hover{background:#eef4ff}
    .wpe-dir{transition:background .15s ease}
    .wpe-dir.proj:active{background:#e0eaff}
    .wpe-dir.wpe-file:hover{background:#e8f0ff;box-shadow:inset 3px 0 0 #4d6bfe}
    .wpe-dir.sel{background:#e8f0ff;box-shadow:inset 3px 0 0 #2f5cff}
    .wpe-dir.sel .nm{color:#2f5cff;font-weight:600}
    .wpe-dir.wpe-file:active{background:#dbe7ff;box-shadow:inset 3px 0 0 #4d6bfe}
      .wpe-dir .wpe-go{flex:0 0 auto;width:20px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:3px;color:#94a3b8;font-size:15px;transform:translateX(2px)}
      .wpe-dir .wpe-go:hover{background:#e2e8f0;color:#334155}
      .wpe-dir .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.8px}
      .wpe-dir .tag{font-size:10.5px;padding:1px 6px;border-radius:999px;background:#eef2ff;color:#3b4fd8;font-weight:600}
      .wpe-dir .tag.s{background:#e9f7ef;color:#0a7a4e}
      .wpe-dir .tag.n{background:#fef3e2;color:#a35f00}
      .wpe-foot{padding:9px 12px;border-top:1px solid #f0f2f5;display:flex;align-items:center;gap:8px;flex:0 0 auto;font-size:12px;color:#5b6478}
      .wpe-preview{flex:1;display:flex;flex-direction:column;min-height:0;position:relative}
      .wpe-preview .wpe-fc{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);width:min(720px,calc(100% - 28px));
        display:flex;align-items:flex-end;gap:6px;z-index:6;background:rgba(255,255,255,.97);border:1px solid #e3e6ee;
        border-radius:14px;padding:8px;box-shadow:0 14px 38px rgba(15,23,42,.22)}
      .wpe-preview .wpe-fc-input{flex:1;min-width:0;height:36px;max-height:120px;resize:vertical;border:1px solid #dfe3ea;border-radius:9px;
        padding:7px 10px;font:12.5px/1.4 Inter,system-ui,sans-serif;outline:none;background:#fff}
      .wpe-preview .wpe-fc-input:focus{border-color:#3b4fd8;box-shadow:0 0 0 3px rgba(59,79,216,.12)}
      /* 浮动对话开启时，隐藏编辑器自己的悬浮 AI 条（没开浮动对话时正常显示） */
      .wpe-preview.float-chat .wpe-ai.wpe-float{display:none!important}
      .wpe-preview .wpe-ai.wpe-float.hidden{display:none!important}
      .wpe-tools{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid #f0f2f5;flex:0 0 auto;flex-wrap:wrap}
      .wpe-frame{flex:1;border:0;width:100%;background:#f7f6f3;min-height:0}
      /* 悬浮 AI 输入条：压在网页上，不聚焦时半透明 */
      .wpe-canvas{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
      .wpe-canvas .wpe-frame{flex:1;min-height:0;width:100%}
      .wpe-float{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:min(780px,94%);
        display:flex;flex-direction:column;gap:6px;background:rgba(255,255,255,.92);border:1px solid rgba(15,23,42,.1);
        border-radius:12px;padding:8px 10px;box-shadow:0 12px 34px rgba(15,23,42,.22);backdrop-filter:blur(8px);
        opacity:.5;transition:opacity .18s ease;z-index:6}
      .wpe-float:hover,.wpe-float.active,.wpe-float.expanded{opacity:1}
      .wpe-float-row{display:flex;align-items:center;gap:6px}
      .wpe-float-row .wpe-float-input{flex:1;min-width:0;height:32px;border:1px solid #dfe3ea;border-radius:8px;padding:0 10px;
        font-size:12.5px;outline:none;background:#fff}
      .wpe-float-row .wpe-float-input:focus{border-color:#3b4fd8;box-shadow:0 0 0 3px rgba(59,79,216,.12)}
      .wpe-float-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:#5b6478}
      .wpe-shot{height:46px;max-width:120px;object-fit:cover;border-radius:6px;border:1px solid rgba(15,23,42,.15);cursor:zoom-in;background:#fff}
      .wpe-float .wpe-sel{padding:2px 7px}
      .wpe-float .wpe-ops{max-height:96px}
      .wpe-ai{flex:0 0 auto;border-top:1px solid #e5e7eb;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:#fafbff;max-height:44vh;overflow:auto}
      .wpe-ai .row{display:flex;gap:6px;align-items:center}
      .wpe-ai input[type=text],.wpe-ai input[type=password]{flex:1;min-width:0;border:1px solid #dfe3ea;border-radius:7px;padding:6px 9px;font-size:12.5px;outline:none}
      .wpe-ai input:focus{border-color:#3b4fd8}
      .wpe-sel{font-size:11.5px;color:#3b4fd8;background:#eef2ff;border-radius:6px;padding:3px 8px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wpe-ops{font-size:11.5px;color:#333;background:#fff;border:1px solid #e5e7eb;border-radius:7px;padding:6px 8px;max-height:120px;overflow:auto;white-space:pre-wrap;line-height:1.55}
      .wpe-msg{font-size:11.5px;color:#5b6478;min-height:16px}
.wpe-menu{position:absolute;right:10px;top:44px;z-index:40;width:236px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 14px 36px rgba(15,23,42,.2);padding:6px;font-size:12px}
.wpe-menu .grp{font-size:10.5px;color:#94a3b8;padding:6px 8px 3px;letter-spacing:.04em}
.wpe-menu button{display:flex;align-items:center;gap:6px;width:100%;height:28px;border:0;background:transparent;border-radius:7px;cursor:pointer;font-size:12px;color:#334155;padding:0 8px;text-align:left}
.wpe-menu button:hover{background:#f1f5f9}
.wpe-menu button.on{color:#1d4ed8;font-weight:600}
.wpe-menu button.danger{color:#c0392b}
.wpe-menu button.danger:hover{background:#fef2f2}
.wpe-menu .sep{height:1px;background:#eef1f6;margin:4px 6px}
.wpe-menu .rowline{display:flex;align-items:center;gap:4px;padding:2px 6px}
.wpe-menu .rowline .wpe-btn{height:24px;padding:0 8px;font-size:11.5px}
.wpe-menu-mask{position:fixed;inset:0;z-index:39;background:transparent}
.wpe-menu{max-height:78vh;overflow:auto}
.wpe-menu.wpe-menu-style{width:300px;max-height:72vh}
.wpe-fixchip{display:inline-flex;align-items:center;height:22px;padding:0 7px;border-radius:999px;font-size:11px;border:1px solid #e5e7eb;color:#94a3b8;cursor:default;white-space:nowrap;user-select:none}
.wpe-fixchip.fixed{color:#0a7a4e;border-color:#cdeee0;background:#f0fdf7}
.wpe-fixchip.stale{color:#a35f00;border-color:#fde9c8;background:#fffaf0;cursor:pointer}
.wpe-fixchip.unfixed{color:#64748b;border-color:#e5e7eb;background:#f8fafc;cursor:pointer}
.wpe-fixchip.none{opacity:.7}
.wpe-sgrid{display:flex;flex-direction:column;gap:6px;padding:2px 4px 6px}
.wpe-menu button.wpe-srow{height:auto;min-height:56px;align-items:flex-start;padding:6px;overflow:hidden}
.wpe-menu button.wpe-srow:hover{background:#f1f5f9}
.wpe-srow .wpe-swatch{flex:0 0 40px;width:40px;height:40px;align-self:center}
.wpe-srow .wpe-srow-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;padding-top:1px}
.wpe-srow{display:flex;align-items:center;gap:10px;width:100%;padding:6px;border:0;border-radius:9px;background:transparent;cursor:pointer;text-align:left}
.wpe-srow:hover{background:#f1f5f9}
.wpe-swatch{flex:0 0 auto;width:42px;height:42px;border-radius:8px;border:1px solid rgba(15,23,42,.12);display:block}
.wpe-srow-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.wpe-srow-text b{font-size:14px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.wpe-srow-text i{font-style:normal;font-size:10.5px;line-height:1.35;color:#7c8aa0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* ───── 工作台（iframe 容器，页面本体在独立的 workbench-ui 项目里） ───── */
.wb-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#fbfbfc}
.wb-root.wb-theme-ink{background:#0b0e13}
.wb-frame{flex:1;width:100%;height:100%;border:0;display:block;background:transparent}
.wb-loading{flex:1;display:flex;align-items:center;justify-content:center;color:#8a8f98;font:13px/1.5 Inter,system-ui,sans-serif}
.wpe-help{display:grid;gap:4px;font-size:12px}
.wpe-help .r{display:flex;gap:10px;align-items:center;padding:4px 6px;border-radius:6px}
.wpe-help .r:nth-child(odd){background:#f8fafc}
.wpe-preview.dark .wpe-help .r:nth-child(odd){background:#111827}
.wpe-help kbd{font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;background:#fff;border:1px solid #dbe1ea;border-bottom-width:2px;border-radius:5px;padding:1px 6px;color:#0f172a;white-space:nowrap}
.wpe-help .desc{color:#475569}
.wpe-preview.dark .wpe-help kbd{background:#1e293b;border-color:#334155;color:#e2e8f0}
.wpe-preview.dark .wpe-help .desc{color:#94a3b8}
      .wpe-msg.err{color:#c0392b}
      .wpe-trigger{border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;
        width:100%;height:32px;border-radius:8px;color:inherit;font-size:12.5px;padding:0 8px}
      .wpe-trigger:hover{background:rgba(127,127,127,.12)}
      .wpe-trigger.on{background:rgba(59,79,216,.14);color:#3b4fd8}
      .wpe-hbtns{display:flex;align-items:center;gap:4px}
      .wpe-iconbtn{border:1px solid #e5e7eb;background:#fff;border-radius:6px;cursor:pointer;height:24px;min-width:26px;padding:0 6px;font-size:12px;line-height:1;color:#444}
      .wpe-iconbtn:hover{background:#f3f4f6;color:#111}
      .wpe-resizer{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:ew-resize;z-index:10}
      .wpe-resizer::after{content:"";position:absolute;left:3px;top:50%;width:2px;height:38px;margin-top:-19px;border-radius:2px;background:rgba(100,110,140,.28)}
      .wpe-resizer:hover::after{background:rgba(59,79,216,.6)}
      .wpe-pill{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;background:#111;color:#fff;border:0;border-radius:999px;padding:9px 15px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.28)}
      .wpe-pill:hover{background:#000}
      .wpe-tabview{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;min-width:0;flex:1 1 auto;overflow:hidden;background:transparent}
      .wpe-tabview .wpe-tabbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,.07);flex:0 0 auto;flex-wrap:wrap}
      .wpe-tabview .wpe-tab-picker{display:flex;flex-direction:column;flex:1;min-height:0}
      .wpe-tabview .wpe-tab-picker .wpe-list{flex:1;min-height:0}
      .wpe-tabview .wpe-preview{flex:1;min-height:0}
      .wpe-tabview .wpe-frame{flex:1;min-height:0}
      .wpe-tabview .wpe-ai{max-height:42%}

      /* 停靠：把 DSH 主框架的第三列（原生右栏位置）撑开，对话区自动让位 */
      [data-wpe-dock]{grid-template-columns:var(--wpe-sb-w,280px) minmax(0,1fr) var(--wpe-dock-w,820px)!important}
      .wpe-notice{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fff8e6;border-bottom:1px solid #f3e2bb;font-size:11.5px;color:#7a5b00;line-height:1.45}
      .wpe-notice span{flex:1}
      .wpe-modal{position:absolute;inset:0;background:rgba(15,23,42,.32);display:flex;align-items:center;justify-content:center;z-index:20}
      .wpe-modal-box{width:min(540px,86%);max-height:72%;background:#fff;border-radius:12px;box-shadow:0 18px 50px rgba(15,23,42,.3);display:flex;flex-direction:column;overflow:hidden}
      .wpe-modal-h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef0f4;font-size:13px}
      .wpe-modal-body{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:6px}
      .wpe-histrow{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid #eef0f4;border-radius:8px}
      .wpe-histrow .t{font-size:12px;color:#111;white-space:nowrap}
      .wpe-histrow .f{flex:1;font-size:11px;color:#8a93a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wpe-drawer.fs{width:100vw!important;min-width:0!important;left:0;right:0;top:0;bottom:0;border-left:0}
      .wpe-drawer.fs .wpe-resizer{display:none}
      .wpe-drawer.fs .wpe-h{min-height:40px;background:rgba(255,255,255,.92);backdrop-filter:blur(6px);z-index:6}
      .wpe-drawer.fs .wpe-tools{position:fixed;right:14px;top:54px;z-index:6;background:rgba(255,255,255,.94);border:1px solid rgba(215,219,227,.9);border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.14)}
      .wpe-drawer.fs .wpe-ai{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(820px,88vw);max-height:40vh;border:1px solid #d7dbe3;border-radius:14px;box-shadow:0 14px 44px rgba(15,23,42,.24);background:#fff;z-index:7}
      .wpe-drawer.fs .wpe-frame{height:100%}
      .wpe-ai .wpe-airow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
      .wpe-ai .wpe-airow .hint{font-size:11px;color:#8a93a6}

      .wpe-src{display:flex;gap:6px;align-items:center;font-size:11.5px;color:#5b6478}
      .wpe-src .chip{border:1px solid #dfe3ea;background:#fff;border-radius:999px;padding:2px 9px;cursor:pointer;font-size:11.5px;color:#333}
      .wpe-src .chip[data-on="1"]{background:#111;border-color:#111;color:#fff}
      .wpe-empty{padding:20px;color:#7a8397;font-size:12.5px;line-height:1.8}

      /* ════════════════════════════════════════════════════════════════
         按「网页工作台」的当前风格重排编辑器 UI（1.1.6）
         单色纸面 · 细线描边 · 胶囊按钮 · 无蓝色强调（选中态一律黑底白字）
         ════════════════════════════════════════════════════════════════ */
      /* 变量挂到 :root 一份：编辑器有时被渲染在容器外（如预览宿主）也不会掉色 */
      :root{
        --wpe-paper:#fbfbfb; --wpe-raised:#fff; --wpe-ink:#111; --wpe-ink80:#141414;
        --wpe-line:rgba(0,0,0,.62); --wpe-line-soft:rgba(0,0,0,.16);
        --wpe-ink60:rgba(0,0,0,.60); --wpe-ink45:rgba(0,0,0,.45); --wpe-ink40:rgba(0,0,0,.40);
        --wpe-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        --wpe-sans:"Inter Tight",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      }
      .wpe-tabview,.wpe-drawer{
        --wpe-paper:#fbfbfb; --wpe-raised:#fff; --wpe-ink:#111; --wpe-ink80:#141414;
        --wpe-line:rgba(0,0,0,.62); --wpe-line-soft:rgba(0,0,0,.16);
        --wpe-ink60:rgba(0,0,0,.60); --wpe-ink45:rgba(0,0,0,.45); --wpe-ink40:rgba(0,0,0,.40);
        --wpe-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        --wpe-sans:"Inter Tight",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        background:var(--wpe-paper); color:var(--wpe-ink); font-family:var(--wpe-sans);
      }
      .wpe-drawer{background:var(--wpe-paper); border-left:1px solid var(--wpe-line); box-shadow:-18px 0 46px rgba(0,0,0,.14)}
      .wpe-h{min-height:52px; padding:0 16px; gap:10px; border-bottom:1px solid var(--wpe-line); background:var(--wpe-paper)}
      .wpe-h b{font:600 13.5px/1.2 var(--wpe-sans); letter-spacing:.01em}
      .wpe-badge{border:1px solid var(--wpe-line); background:transparent; color:var(--wpe-ink60); border-radius:999px; padding:3px 8px; font:500 10.5px/1 var(--wpe-mono); letter-spacing:.02em}
      .wpe-x{border:1px solid transparent; border-radius:999px; color:var(--wpe-ink45); width:26px; height:26px; padding:0; font-size:15px}
      .wpe-x:hover{border-color:var(--wpe-line); background:var(--wpe-raised); color:var(--wpe-ink)}
      .wpe-body{background:var(--wpe-paper)}
      .wpe-pathrow{padding:10px 12px; gap:8px; border-bottom:1px solid var(--wpe-line-soft); background:var(--wpe-paper)}
      .wpe-pathrow input{height:32px; border:1px solid var(--wpe-line-soft); border-radius:999px; padding:0 12px; background:var(--wpe-raised); font:400 11.5px/1.4 var(--wpe-mono); color:var(--wpe-ink)}
      .wpe-pathrow input:focus{border-color:var(--wpe-ink); box-shadow:none}
      .wpe-btn{height:30px; border:1px solid var(--wpe-line); border-radius:999px; background:transparent; color:var(--wpe-ink); padding:0 12px; font:500 12px/1 var(--wpe-sans); letter-spacing:.01em}
      .wpe-btn:hover{background:var(--wpe-raised); border-color:var(--wpe-ink); color:var(--wpe-ink)}
      .wpe-btn.pri{background:var(--wpe-ink); border-color:var(--wpe-ink); color:#fff}
      .wpe-btn.pri:hover{background:#000; border-color:#000}
      .wpe-btn.on{background:var(--wpe-ink); border-color:var(--wpe-ink); color:#fff}
      .wpe-btn.on:hover{background:#000; border-color:#000}
      .wpe-btn:disabled{opacity:.38; background:transparent; color:var(--wpe-ink)}
      .wpe-iconbtn{height:26px; min-width:28px; border:1px solid var(--wpe-line-soft); border-radius:999px; background:transparent; color:var(--wpe-ink60)}
      .wpe-iconbtn:hover{background:var(--wpe-raised); border-color:var(--wpe-ink); color:var(--wpe-ink)}
      .wpe-trigger{border-radius:999px; font:500 12px/1 var(--wpe-sans); color:var(--wpe-ink)}
      .wpe-trigger:hover{background:rgba(0,0,0,.05)}
      .wpe-trigger.on{background:var(--wpe-ink); color:#fff}
      .wpe-trigger.on:hover{background:#000}
      .wpe-tabview{background:var(--wpe-paper)}
      .wpe-tabview .wpe-tabbar{padding:9px 14px; gap:10px; border-bottom:1px solid var(--wpe-line); background:var(--wpe-paper); min-height:50px}
      .wpe-tabview .wpe-tabbar b{font:600 13.5px/1.2 var(--wpe-sans); letter-spacing:.01em; display:inline-flex; align-items:center}
      .wpe-tabview .wpe-tabbar b::before{content:""; display:inline-block; width:6px; height:6px; margin-right:8px; border-radius:999px; background:var(--wpe-ink)}
      .wpe-tab-picker{background-color:var(--wpe-paper); background-image:radial-gradient(circle,rgba(0,0,0,.055) 1px,transparent 1px); background-size:34px 34px}
      .wpe-tools{padding:8px 12px; gap:6px; border-bottom:1px solid var(--wpe-line-soft); background:var(--wpe-paper)}
      .wpe-list{padding:8px; background:transparent}
      .wpe-dir{min-height:42px; padding:8px 12px; border-radius:0; border-bottom:1px solid var(--wpe-line-soft)}
      .wpe-dir:hover{background:rgba(0,0,0,.04)}
      .wpe-dir.proj:hover{background:rgba(0,0,0,.06)}
    .wpe-dir.wpe-file:hover{background:#e8f0ff;box-shadow:inset 3px 0 0 #4d6bfe}
    .wpe-dir.wpe-file:active{background:#dbe7ff;box-shadow:inset 3px 0 0 #4d6bfe}
      .wpe-dir .nm{font:400 12.5px/1.4 var(--wpe-sans)}
      .wpe-dir .wpe-go{border-radius:999px; color:var(--wpe-ink45)}
      .wpe-dir .wpe-go:hover{background:rgba(0,0,0,.06); color:var(--wpe-ink)}
      .wpe-dir .tag{background:transparent; border:1px solid var(--wpe-line-soft); color:var(--wpe-ink60); border-radius:999px; font:500 10px/1 var(--wpe-mono); letter-spacing:.04em; padding:2px 7px}
      .wpe-dir .tag.s{border-color:rgba(10,122,78,.45); color:#0a7a4e}
      .wpe-dir .tag.n{border-color:rgba(163,95,0,.45); color:#8a5200}
      .wpe-foot{border-top:1px solid var(--wpe-line-soft); color:var(--wpe-ink45); font:400 11px/1.5 var(--wpe-mono); background:var(--wpe-paper)}
      .wpe-preview{background:var(--wpe-paper)}
      .wpe-frame{background:var(--wpe-paper)}
      .wpe-preview .wpe-fc,.wpe-float{background:rgba(255,255,255,.94); border:1px solid var(--wpe-line); border-radius:14px; box-shadow:0 18px 46px rgba(0,0,0,.16); backdrop-filter:blur(10px)}
      .wpe-preview .wpe-fc-input,.wpe-float-row .wpe-float-input{border:1px solid var(--wpe-line-soft); border-radius:10px; font:400 12.5px/1.4 var(--wpe-sans); background:#fff; color:var(--wpe-ink)}
      .wpe-preview .wpe-fc-input:focus,.wpe-float-row .wpe-float-input:focus{border-color:var(--wpe-ink); box-shadow:none}
      .wpe-float-meta{color:var(--wpe-ink45); font-family:var(--wpe-mono)}
      .wpe-float .wpe-sel{padding:3px 9px}
      .wpe-sel{border:1px solid var(--wpe-line); background:transparent; color:var(--wpe-ink); border-radius:999px; padding:3px 9px; font:500 10.5px/1.3 var(--wpe-mono); letter-spacing:.02em}
      .wpe-ops{border:1px solid var(--wpe-line-soft); border-radius:10px; background:#fff; font:400 11px/1.55 var(--wpe-mono); color:var(--wpe-ink80)}
      .wpe-msg{color:var(--wpe-ink45); font:400 11px/1.5 var(--wpe-mono)}
      .wpe-msg.err{color:#b91c1c}
      .wpe-ai{background:var(--wpe-paper); border-top:1px solid var(--wpe-line)}
      .wpe-ai input[type=text],.wpe-ai input[type=password]{border:1px solid var(--wpe-line-soft); border-radius:999px; padding:6px 11px; background:#fff; font-family:var(--wpe-sans); color:var(--wpe-ink)}
      .wpe-ai input:focus{border-color:var(--wpe-ink); box-shadow:none}
      .wpe-ai .wpe-airow .hint{color:var(--wpe-ink45); font-family:var(--wpe-mono)}
      .wpe-menu{background:var(--wpe-raised); border:1px solid var(--wpe-line); border-radius:12px; box-shadow:0 20px 48px rgba(0,0,0,.18); padding:6px}
      .wpe-menu .grp{font:500 10px/1.2 var(--wpe-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--wpe-ink45); padding:8px 10px 3px}
      .wpe-menu button{height:30px; border-radius:999px; color:var(--wpe-ink); font:400 12px/1.3 var(--wpe-sans); padding:0 10px}
      .wpe-menu button:hover{background:rgba(0,0,0,.06)}
      .wpe-menu button.on{background:var(--wpe-ink); color:#fff; font-weight:600}
      .wpe-menu button.danger{color:#b91c1c}
      .wpe-menu button.danger:hover{background:rgba(185,28,28,.08)}
      .wpe-menu .sep{background:var(--wpe-line-soft); margin:6px 8px}
      .wpe-menu .rowline .wpe-btn{height:24px; font-size:11px}
      .wpe-menu button.wpe-srow{height:auto; min-height:56px}
      .wpe-srow{border-radius:999px}
      .wpe-srow:hover{background:rgba(0,0,0,.06)}
      .wpe-swatch{border:1px solid var(--wpe-line-soft); border-radius:10px}
      .wpe-srow-text b{font:600 13px/1.25 var(--wpe-sans); color:var(--wpe-ink)}
      .wpe-srow-text i{color:var(--wpe-ink45); font:400 10.5px/1.35 var(--wpe-mono)}
      .wpe-modal{background:rgba(0,0,0,.3)}
      .wpe-modal-box{background:var(--wpe-raised); border:1px solid var(--wpe-line); border-radius:14px; box-shadow:0 24px 60px rgba(0,0,0,.24)}
      .wpe-modal-h{border-bottom:1px solid var(--wpe-line); font:600 13px/1.4 var(--wpe-sans)}
      .wpe-histrow{border:1px solid var(--wpe-line-soft); border-radius:10px}
      .wpe-histrow .t{font-size:12px; color:var(--wpe-ink)}
      .wpe-histrow .f{color:var(--wpe-ink45); font-family:var(--wpe-mono)}
      .wpe-help kbd{border:1px solid var(--wpe-line); border-bottom-width:2px; border-radius:6px; background:#fff; color:var(--wpe-ink); font-family:var(--wpe-mono)}
      .wpe-help .r:nth-child(odd){background:rgba(0,0,0,.03)}
      .wpe-help .desc{color:var(--wpe-ink60)}
      .wpe-fixchip{border:1px solid var(--wpe-line-soft); border-radius:999px; font:500 10.5px/1 var(--wpe-mono); color:var(--wpe-ink45)}
      .wpe-fixchip.fixed{color:#0a7a4e; border-color:rgba(10,122,78,.4); background:rgba(10,122,78,.06)}
      .wpe-fixchip.stale{color:#8a5200; border-color:rgba(163,95,0,.4); background:rgba(163,95,0,.06)}
      .wpe-fixchip.unfixed{color:var(--wpe-ink60); border-color:var(--wpe-line-soft); background:transparent}
      .wpe-notice{background:#fff8e6; border-bottom:1px solid rgba(163,95,0,.3); color:#7a5b00; font:400 11.5px/1.5 var(--wpe-mono)}
      .wpe-empty{color:var(--wpe-ink45); font:400 12px/1.8 var(--wpe-mono)}
      .wpe-src{color:var(--wpe-ink45); font-family:var(--wpe-mono)}
      .wpe-src .chip{border:1px solid var(--wpe-line-soft); border-radius:999px; background:transparent; color:var(--wpe-ink60); font:500 10.5px/1 var(--wpe-mono)}
      .wpe-src .chip[data-on="1"]{background:var(--wpe-ink); border-color:var(--wpe-ink); color:#fff}
      .wpe-resizer::after{background:rgba(0,0,0,.28)}
      .wpe-resizer:hover::after{background:var(--wpe-ink)}
      .wpe-drawer.fs .wpe-h{background:rgba(251,251,251,.94)}
      .wpe-drawer.fs .wpe-tools{background:var(--wpe-raised); border:1px solid var(--wpe-line); border-radius:12px}
      .wpe-drawer.fs .wpe-ai{background:var(--wpe-raised); border:1px solid var(--wpe-line); border-radius:14px}

      /* ════════════════════════════════════════════════════════════════
         1.1.8 样式兜底：宿主页面可能残留旧样式表 / 更高优先级规则，
         会把按钮圆角抢回旧的 7px（看起来「不够圆」）。这里用 !important
         把胶囊圆角和主工具栏按钮高度钉死，保证视觉一致。
         ════════════════════════════════════════════════════════════════ */
      .wpe-btn, .wpe-iconbtn, .wpe-trigger, .wpe-badge, .wpe-sel,
      .wpe-fixchip, .wpe-pathrow input, .wpe-menu button, .wpe-src .chip,
      .wpe-dir .tag, .wpe-ai input[type=text], .wpe-ai input[type=password] {
        border-radius: 999px !important;
      }
      .wpe-btn.on, .wpe-btn.pri, .wpe-iconbtn, .wpe-trigger.on {
        border-radius: 999px !important;
      }
      /* 主工具栏一排按钮统一 28px 高（之前有的 24、有的 26、有的 30，看着参差） */
      .wpe-tools > .wpe-btn, .wpe-tools > span > .wpe-btn, .wpe-tabbar .wpe-btn { height: 28px !important; }
      .wpe-tools .wpe-align .wpe-btn { height: 26px !important; width: 30px !important; padding: 0 !important; }

      /* ════════════════════════════════════════════════════════════════
         1.1.11 关键修复：DSH 主题在全局注射了
           *, :before, :after { corner-shape: superellipse(1.5) }
         （squircle / 超椭圆圆角），会把我们的 border-radius:999px 画成
         「圆角矩形」而不是真正的胶囊——computed 值明明是 999px，看着却不圆。
         DSH 自己的按钮都会写 corner-shape:round 退出这个效果，我们也要退出。
         ════════════════════════════════════════════════════════════════ */
      .wpe-preview, .wpe-preview *, .wpe-preview *::before, .wpe-preview *::after,
      .wpe-drawer, .wpe-drawer *, .wpe-drawer *::before, .wpe-drawer *::after,
      .wpe-tabview, .wpe-tabview *, .wpe-tabview *::before, .wpe-tabview *::after,
      .wpe-trigger, .wpe-pill,
      .wpe-modal, .wpe-modal *, .wpe-modal *::before, .wpe-modal *::after,
      .wpe-menu, .wpe-menu *, .wpe-menu *::before, .wpe-menu *::after,
      .wpe-pill *, .wpe-pill *::before, .wpe-pill *::after {
        corner-shape: round !important;
      }
      /* 兜底：万一有控件被渲染到上面这些根节点之外（如 tab 标题插槽），
         带圆角的控件本身也单独退出 squircle */
      .wpe-badge, .wpe-badge::before, .wpe-badge::after,
      .wpe-btn, .wpe-btn::before, .wpe-btn::after,
      .wpe-iconbtn, .wpe-iconbtn::before, .wpe-iconbtn::after,
      .wpe-trigger, .wpe-trigger::before, .wpe-trigger::after,
      .wpe-sel, .wpe-sel::before, .wpe-sel::after,
      .wpe-fixchip, .wpe-fixchip::before, .wpe-fixchip::after,
      .wpe-x, .wpe-x::before, .wpe-x::after,
      .wpe-pathrow input, .wpe-menu button, .wpe-menu button::before, .wpe-menu button::after,
      .wpe-src .chip, .wpe-dir .tag, .wpe-dir .wpe-go {
        corner-shape: round !important;
      }

      /* 1.1.12：小胶囊（步骤 N/N、静态预览、静态站、未固化…）的描边减淡成浅灰，
         不再用主描边色，避免一排小胶囊看起来太重 */
      .wpe-badge, .wpe-fixchip, .wpe-src .chip {
        border-color: rgba(0, 0, 0, .16) !important;
        color: var(--wpe-ink45) !important;
      }
      .wpe-badge:hover { border-color: rgba(0, 0, 0, .34) !important; }
      .wpe-fixchip.fixed { border-color: rgba(10, 122, 78, .34) !important; color: #0a7a4e !important; }
      .wpe-fixchip.stale { border-color: rgba(163, 95, 0, .34) !important; color: #8a5200 !important; }
    `;

    function ensureCss() {
      if (typeof document === "undefined") return;
      let tag = document.querySelector('style[data-plugin-css="' + PLUGIN_ID + '"]');
      if (!tag) {
        tag = document.createElement("style");
        tag.setAttribute("data-plugin-css", PLUGIN_ID);
        document.head.appendChild(tag);
      }
      // 关键：样式内容变了就替换。以前存在就直接 return，
      // 插件热更新或残留旧样式表时会导致「新界面 + 旧样式」混在一起。
      if (tag.textContent !== CSS) tag.textContent = CSS;
    }

    /** 1.1.8：胶囊圆角的最后一道保险。
     *  宿主如果还有更高优先级的样式规则（或者按钮在另一棵样式树里），
     *  computed 圆角就不会是 999px；这里直接给元素打 inline !important。
     *  已经是对的就不动；处理过的元素打 data-wpe-pill 标记，避免重复计算。 */
    const PILL_SELECTOR = [
      ".wpe-btn", ".wpe-iconbtn", ".wpe-trigger", ".wpe-badge", ".wpe-sel",
      ".wpe-fixchip", ".wpe-x", ".wpe-pathrow input", ".wpe-menu button",
      ".wpe-src .chip", ".wpe-dir .tag", ".wpe-dir .wpe-go",
    ].join(",");
    function fixPillRadii() {
      if (typeof document === "undefined") return;
      try {
        document.querySelectorAll(PILL_SELECTOR).forEach((el) => {
          if (el.getAttribute("data-wpe-pill") === "1") return;
          const cs = window.getComputedStyle(el);
          if (!cs) return;
          const r = cs.borderRadius || cs.borderTopLeftRadius || "";
          // 已经足够圆（半径接近半高）就不动
          if (/^[0-9.]+px$/.test(r)) {
            const v = parseFloat(r);
            const h = parseFloat(cs.height) || 0;
            if (h > 0 && v >= h / 2 - 0.6) {
              el.setAttribute("data-wpe-pill", "1");
              return;
            }
          }
          try {
            el.style.setProperty("border-radius", "999px", "important");
            el.setAttribute("data-wpe-pill", "1");
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
    }
    function bootPillGuard() {
      if (typeof document === "undefined" || window.__wpePillGuard) return;
      window.__wpePillGuard = true;
      let timer = null;
      const schedule = () => {
        if (timer) return;
        // 防抖：聊天气泡流式刷新会频繁触发 mutation，别每次都全量算样式
        timer = window.setTimeout(() => { timer = null; fixPillRadii(); }, 180);
      };
      fixPillRadii();
      try {
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
      } catch { /* ignore */ }
      window.setTimeout(fixPillRadii, 700);
      window.setTimeout(fixPillRadii, 2200);
      // 上报一次真实样式，方便从宿主侧排查「圆角被谁覆盖」
      window.setTimeout(reportStyleDiag, 2600);
      window.setTimeout(reportStyleDiag, 7000);
    }

    /** 收集渲染端的样式诊断：computed 值 + 命中的 CSS 规则，POST 回宿主。 */
    function collectStyleDiag() {
      const out = {
        version: PLUGIN_VERSION, at: Date.now(), ua: navigator.userAgent,
        dpr: window.devicePixelRatio || 1,
        z: (window.visualViewport && window.visualViewport.scale) || 1,
        tags: [], sheets: 0, btn: null,
      };
      try {
        const tags = document.querySelectorAll('style[data-plugin-css="web-page-editor"]');
        out.tags = Array.prototype.map.call(tags, (t) => {
          const s = t.textContent || "";
          return { len: s.length, guard: s.indexOf("999px !important") >= 0, idx: s.indexOf("border-radius: 999px !important"), tail: s.slice(-120) };
        });
        out.sheets = document.styleSheets.length;
        const btn = document.querySelector(".wpe-tools .wpe-btn.on") || document.querySelector(".wpe-tools .wpe-btn") || document.querySelector(".wpe-btn");
        if (btn) {
          const cs = window.getComputedStyle(btn);
          const rect = btn.getBoundingClientRect();
          out.btn = {
            cls: String(btn.className), w: Math.round(rect.width * 100) / 100, h: Math.round(rect.height * 100) / 100,
            inline: btn.getAttribute("style"), radius: cs.borderTopLeftRadius, height: cs.height,
            box: cs.boxSizing, border: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor,
            bg: cs.backgroundColor, color: cs.color, display: cs.display, rules: [], ruleCount: 0,
          };
          const hits = [];
          const walk = (rules) => {
            for (let i = 0; i < rules.length; i++) {
              const r = rules[i];
              try { if (r.cssRules) { walk(r.cssRules); continue; } } catch { continue; }
              if (!r.selectorText) continue;
              let m = false;
              try { m = btn.matches(r.selectorText); } catch { continue; }
              if (!m) continue;
              const br = r.style.getPropertyValue("border-radius") || r.style.getPropertyValue("border-top-left-radius");
              const hgt = r.style.getPropertyValue("height");
              if (!br && !hgt) continue;
              hits.push({
                sel: r.selectorText.slice(0, 160), br: br || "",
                brImp: r.style.getPropertyPriority("border-radius") || r.style.getPropertyPriority("border-top-left-radius"),
                h: hgt || "", hImp: r.style.getPropertyPriority("height"),
              });
            }
          };
          for (let i = 0; i < document.styleSheets.length; i++) {
            try { walk(document.styleSheets[i].cssRules); } catch { /* cross-origin */ }
          }
          out.btn.rules = hits.slice(0, 50);
          out.btn.ruleCount = hits.length;
        }
      } catch (e) { out.error = String((e && e.message) || e); }
      return out;
    }
    function reportStyleDiag() {
      try {
        const d = collectStyleDiag();
        api("/client-diag", { method: "POST", body: JSON.stringify(d) }).catch(() => {});
      } catch { /* ignore */ }
    }

    /* ────────────────────────── 全局状态 ────────────────────────── */

    function createStore() {
      let state = { open: false, standalone: false };
      const subs = new Set();
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch };
          // 关键：必须把新状态传给订阅者。之前只调 fn()，useStore 拿到 undefined
          // 会把状态覆盖成 {}，导致「点按钮后抽屉状态丢失、什么都不显示」。
          subs.forEach((fn) => {
            try { fn(state); } catch { try { fn(); } catch { /* ignore */ } }
          });
        },
        sub(fn) {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      };
    }

    function useStore(store) {
      const [snap, setSnap] = useState(store.get());
      useEffect(() => {
        const off = store.sub((next) => setSnap(next || store.get()));
        setSnap(store.get());
        return off;
      }, [store]);
      return snap;
    }

    /* ────────────────────────── 小工具 ────────────────────────── */

    async function api(path, options) {
      const base = await detectApiBase();
      if (base === null) {
        throw new Error("连不上宿主接口：桌面窗口受 dsh-app:// 协议限制，且固定端口未响应。请改用浏览器打开 Web GUI，或重启 DSH 让插件宿主重新加载。");
      }
      let res;
      try {
        res = await fetch(base + API_PATH + path, {
          headers: { "Content-Type": "application/json" },
          ...options,
        });
      } catch (e) {
        throw new Error("连不上宿主接口（" + (base || "同源") + "）：" + (e && e.message ? e.message : e));
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
      return data;
    }

    const fmtDir = (p) => (p || "").replace(/\\/g, "/").split("/").filter(Boolean).slice(-3).join("/");

    function describeOp(op) {
      const k = String(op.key || "").replace(/^(id|sel):/, "").slice(0, 36);
      if (op.type === "style") return "样式 · " + k + " · " + Object.entries(op.props || {}).map(([a, b]) => a + ":" + b).join(" ");
      if (op.type === "text") return "文字 · " + k + " → " + String(op.value || "").slice(0, 40);
      if (op.type === "attrs") return "属性 · " + k + " · " + Object.keys(op.props || {}).join(",");
      if (op.type === "box") return "尺寸 · " + k + " · " + (op.box && op.box.width) + "×" + (op.box && op.box.height);
      if (op.type === "hide") return "隐藏 · " + k;
      return String(op.type) + " · " + k;
    }

    /* ────────────────────────── 文件夹选择 ────────────────────────── */

    function FolderPicker({ state, setState, onOpened }) {
      const [path, setPath] = useState(state.lastPath || "");
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const [pagesHere, setPagesHere] = useState([]);
      const [pickedPath, setPickedPath] = useState("");

      const load = useCallback(
        async (target) => {
          setBusy(true);
          setErr("");
          try {
            const res = await api("/browse?path=" + encodeURIComponent(target || ""));
            setData(res);
            setPath(res.path);
            setState({ lastPath: res.path });
            try {
              const pl = await api("/pages?dir=" + encodeURIComponent(res.path || target || ""));
              const list = pl && Array.isArray(pl.pages) ? pl.pages.filter((p) => p && p.path) : [];
              setPagesHere(list);
              let saved = "";
              try { saved = localStorage.getItem("ve:fileSel:" + (res.path || "")) || ""; } catch { /* ignore */ }
              setPickedPath(list.some((p) => p.path === saved) ? saved : "");
            } catch { setPagesHere([]); }
          } catch (e) {
            setErr(String(e.message || e));
          } finally {
            setBusy(false);
          }
        },
        [setState],
      );

      useEffect(() => {
        let alive = true;
        const start = async () => {
          const remembered = state.lastPath || "";
          if (remembered) { load(remembered); return; }
          try {
            const r = await api("/default-dir");
            if (alive && r && r.path) { load(r.path); return; }
          } catch { /* ignore */ }
          if (alive) load("");
        };
        start();
        return () => { alive = false; };
      }, []);

      const here = data && data.here;
      const canOpen = Boolean(here && here.mode);

      const openDir = async (dir, page = "") => {
        setBusy(true);
        setErr("");
        try { window.__ueManualOpenAt = Date.now(); } catch { /* ignore */ }
        try {
          const body = { dir, source: "ui" };
          if (page) body.page = page;
          const res = await api("/open", { method: "POST", body: JSON.stringify(body) });
          let info = res;
          if (page && res && res.id && (!res.page || res.page !== page)) {
            try {
              const switched = await api("/page", { method: "POST", body: JSON.stringify({ id: res.id, page }) });
              if (switched && switched.url) info = { ...res, ...switched };
            } catch { /* 页面切换失败时至少先打开默认页 */ }
          }
          onOpened(info);
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy(false);
        }
      };

      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "wpe-pathrow" },
          h("button", { className: "wpe-btn", onClick: () => data && data.parent && load(data.parent), title: "上一级" }, "↑"),
          h("input", {
            value: path,
            spellCheck: false,
            onChange: (e) => setPath(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") load(path);
            },
            placeholder: "粘贴一个源码文件夹路径，回车进入",
          }),
          h("button", { className: "wpe-btn", onClick: () => load(path), disabled: busy }, busy ? "…" : "进入"),
        ),
        h(
          "div",
          { className: "wpe-list" },
          pagesHere.length ? h(
            "div",
            { style: { marginBottom: 10 } },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px 6px", fontFamily: "Consolas,monospace", fontSize: 10, letterSpacing: 1, color: "#8b95a8" } },
              h("span", null, "HTML 页面 · " + pagesHere.length),
              h("span", null, "点击直接打开")),
            pagesHere.map((p) => h(
              "div",
              {
                key: p.path,
                className: "wpe-dir proj wpe-file" + (pickedPath === p.path ? " sel" : ""),
                onClick: () => {
                  setPickedPath(p.path);
                  try { localStorage.setItem("ve:fileSel:" + (data.path || ""), p.path); } catch { /* ignore */ }
                  if (!busy) openDir(data.path, p.path);
                },
                title: "打开 " + p.path,
              },
              h("span", { className: "nm" }, p.title || p.name || p.path),
              h("span", { className: "tag n" }, p.path),
              pickedPath === p.path ? h("span", { className: "tag n", style: { background: "#2f5cff", color: "#fff", borderColor: "#2f5cff" } }, "已选") : null,
            )),
          ) : null,
          err ? h("div", { className: "wpe-empty" }, "出错了：" + err) : null,
          !err && data && data.dirs.length === 0 ? h("div", { className: "wpe-empty" }, "这个目录下没有子文件夹。") : null,
          data &&
            data.dirs.map((d) =>
              h(
                "div",
                {
                  key: d.path,
                  className: "wpe-dir" + (d.mode ? " proj" : ""),
                  onClick: () => { if (!busy) load(d.path); },
                  title: d.mode ? "点击直接打开：" + d.path : d.error || d.path,
                },
                h("span", { className: "nm" }, d.name),
                d.mode === "vite" ? h("span", { className: "tag" }, "Vite") : null,
                d.mode === "static" ? h("span", { className: "tag s" }, "静态站") : null,
                d.mode ? h("span", { className: "tag n" }, d.framework || d.mode) : h("span", { style: { fontSize: 11, color: "#a0a7b6" } }, "不可预览"),
                h("span", {
                  className: "wpe-go",
                  title: "进入这个文件夹（不打开项目）",
                  onClick: (e) => { e.stopPropagation(); load(d.path); },
                }, "›"),
              ),
            ),
        ),
        h(
          "div",
          { className: "wpe-foot" },
          h("div", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            here
              ? here.mode
                ? "识别为：" + (here.mode === "vite" ? "Vite 项目" : "静态站点") + (here.framework ? "（" + here.framework + "）" : "")
                : "当前目录不可预览：" + (here.error || "未识别")
              : ""),
          h(
            "button",
            {
              className: "wpe-btn pri",
              disabled: !canOpen || busy,
              onClick: () => openDir(data.path),
            },
            "打开并编辑",
          ),
        ),
      );
    }

    /* ────────────────────────── 预览 + 编辑 ────────────────────────── */

    const DEV_TOOLS_DEFAULT = true; /* @dev-tools-default */
    function devToolsOn() {
      try {
        const v = window.localStorage.getItem("dsh-ue:dev-tools");
        return v == null ? DEV_TOOLS_DEFAULT : v !== "0";
      } catch { return DEV_TOOLS_DEFAULT; }
    }

    function PreviewPane({ preview, fullscreen, onClose, onPageChange }) {
      const iframeRef = useRef(null);
      const [ready, setReady] = useState(false);
      const [vpWidth, setVpWidth] = useState(0);
      const [pagesData, setPagesData] = useState(null);
      const [pageMenu, setPageMenu] = useState(false);
      const [pageCustom, setPageCustom] = useState("");
      const [createName, setCreateName] = useState("");
      const [createTemplate, setCreateTemplate] = useState("blank");
      const [pageNavStyle, setPageNavStyle] = useState(() => { try { return localStorage.getItem("dsh-ue:page-nav") === "dot" ? "dot" : "square"; } catch { return "square"; } });
      const pageRestoreRef = useRef(false);
      const pageRestoreDirRef = useRef("");
      const [pageShots, setPageShots] = useState({});
      const [shotsLoading, setShotsLoading] = useState(false);
      const [createOpen, setCreateOpen] = useState(false);
      const [pageAction, setPageAction] = useState(null);
      const [pageActionValue, setPageActionValue] = useState("");
      const [pageLinkInfo, setPageLinkInfo] = useState(null);
      const [trashOpen, setTrashOpen] = useState(false);
      const [trashList, setTrashList] = useState(null);
      const [trashBusy, setTrashBusy] = useState(false);
      const [createBackLink, setCreateBackLink] = useState(true);
      const [pageErr, setPageErr] = useState("");
      const [pagePath, setPagePath] = useState(preview.page || preview.entryPath || "/");
      // 内核每次加载/刷新都要重新拿到页面列表，否则默认常驻的导航胶囊会消失；
      // 用 ref 保存一份，ready 时补发（切换页面会让 iframe 重新加载）。
      const pagesRef = useRef(null);
      const pagePathRef = useRef(preview.page || preview.entryPath || "/");

      React.useEffect(() => {
        let alive = true;
        api("/pages?dir=" + encodeURIComponent(preview.dir || ""))
          .then((r) => { if (alive && r && Array.isArray(r.pages)) setPagesData(r); })
          .catch(() => { if (alive) setPagesData({ pages: [] }); });
        return () => { alive = false; };
      }, [preview.dir]);

      const switchPage = async (p) => {
        const target = String(p || "").trim();
        if (!target) return;
        try {
          const info = await api("/page", { method: "POST", body: JSON.stringify({ id: preview.id, page: target }) });
          if (info && info.ok !== false && info.url) {
            setPagePath(info.page || target);
            try { localStorage.setItem("dsh-ui-editor:page:" + (preview.dir || ""), info.page || target); } catch { /* ignore */ }
            try { saveLastActive(preview.dir, info.page || target); } catch { /* ignore */ }
            setPageMenu(false);
            setPageCustom("");
            if (typeof onPageChange === "function") onPageChange(info);
            setMsg("已切换到页面：" + (info.page || target));
          }
        } catch (e) { setMsg("切换页面失败：" + String((e && e.message) || e)); }
      };
      React.useEffect(() => {
        if (!pagesData || !Array.isArray(pagesData.pages)) return;
        const list = pagesData.pages.map((p) => ({ path: p.path, title: p.title || p.name || p.path }));
        pagesRef.current = list;
        try {
          send("pages", { pages: list, current: pagePathRef.current || pagePath || preview.page || "/" });
        } catch { /* ignore */ }
      }, [pagesData, pagePath]);
      React.useEffect(() => { pagePathRef.current = pagePath || preview.page || "/"; }, [pagePath]);

      const createPage = async () => {
        const name = String(createName || "").trim();
        if (!name) { setPageErr("请输入新页面文件名，如「关于.html」或「about.html」"); return; }
        setPageErr("");
        try {
          const r = await api("/page-create", { method: "POST", body: JSON.stringify({ dir: preview.dir, name, template: createTemplate, backLink: createBackLink }) });
          if (r && r.ok !== false && r.path) {
            setCreateName("");
            setPageErr("");
            setCreateOpen(false);
            try {
              const list = await api("/pages?dir=" + encodeURIComponent(preview.dir || ""));
              if (list && Array.isArray(list.pages)) setPagesData(list);
            } catch { /* ignore */ }
            await switchPage(r.path);
            const baseName = String(r.name || r.path || "").split("/").pop().replace(/.html?$/i, "");
            try {
              setAiBarOn(true);
              setInstruction(
                "请帮我完成「" + baseName + "」页面（文件：" + r.path + "）：\n" +
                "1. 沿用本站首页的 UI 规范（字体层级、色板、圆角、间距、按钮/卡片样式），不要引入新风格\n" +
                "2. 先一次问完 3-5 个问题，确认页面用途、需要哪些板块、内容从哪来，再动手实现\n" +
                "3. 实现后检查页面之间的链接是否可用，并提醒我保存 / 固化"
              );
              setMsg("已新建页面，并把「AI 新建页面」提示填进 AI 条：按 Ctrl+Enter 发送");
            } catch { /* ignore */ }
            setMsg("已新建页面：" + r.path);
          } else {
            const why = String((r && (r.error || r.reason)) || "未知错误");
            setPageErr(why);
            setMsg("新建失败：" + why);
          }
        } catch (e) {
          const why = String((e && e.message) || e);
          setPageErr(/404|not found/i.test(why) ? "宿主还没加载新接口：请完全重启 DSH 后再试" : why);
          setMsg("新建失败：" + why);
        }
      };
      const doCreatePage = async ({ name, template, backLink }) => {
        try {
          const r = await api("/page-create", { method: "POST", body: JSON.stringify({ dir: preview.dir, name, template, backLink }) });
          if (!(r && r.ok !== false && r.path)) return { ok: false, error: String((r && (r.error || r.reason)) || "创建失败") };
          try {
            const list = await api("/pages?dir=" + encodeURIComponent(preview.dir || ""));
            if (list && Array.isArray(list.pages)) setPagesData(list);
          } catch { /* ignore */ }
          await switchPage(r.path);
          try { loadPageShots(true); } catch { /* ignore */ }
          const baseName = String(r.name || r.path || "").split("/").pop().replace(/\.html?$/i, "");
          try {
            setAiBarOn(true);
            setInstruction(
              "请帮我完成「" + baseName + "」页面（文件：" + r.path + "）：\n" +
              "1. 沿用本站首页的 UI 规范（字体层级、色板、圆角、间距、按钮/卡片样式），不要引入新风格\n" +
              "2. 先一次问完 3-5 个问题，确认页面用途、需要哪些板块、内容从哪来，再动手实现\n" +
              "3. 实现后检查页面之间的链接是否可用，并提醒我保存 / 固化"
            );
          } catch { /* ignore */ }
          setMsg("已新建页面：" + r.path + "，AI 条已填好提示词（Ctrl+Enter 发送）");
          return { ok: true, path: r.path };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      };
      const loadPageTrash = async () => {
        setTrashOpen(true);
        setTrashList(null);
        try {
          const r = await api("/page-trash?dir=" + encodeURIComponent(preview.dir || ""));
          setTrashList(r && Array.isArray(r.backups) ? r.backups : []);
        } catch { setTrashList([]); }
      };
      const restoreTrash = async (item) => {
        if (!item || trashBusy) return;
        setTrashBusy(true);
        try {
          const r = await api("/page-restore", { method: "POST", body: JSON.stringify({ dir: preview.dir, backup: item.name }) });
          if (r && r.ok !== false) {
            setMsg("已恢复 " + (r.count || 0) + " 个文件：" + (r.restored || []).slice(0, 2).join("、"));
            try {
              const list = await api("/pages?dir=" + encodeURIComponent(preview.dir || ""));
              if (list && Array.isArray(list.pages)) setPagesData(list);
            } catch { /* ignore */ }
            try { loadPageShots(true); } catch { /* ignore */ }
            setTrashOpen(false);
            setTrashList(null);
          } else setMsg("恢复失败：" + String((r && r.error) || "未知"));
        } catch (e) { setMsg("恢复失败：" + String((e && e.message) || e)); }
        finally { setTrashBusy(false); }
      };
      const loadPageShots = async (force) => {
        if (!preview.dir) return;
        setShotsLoading(true);
        try {
          const r = await api("/page-shots", { method: "POST", body: JSON.stringify({ dir: preview.dir, force: Boolean(force) }) });
          if (r && r.ok && r.shots) setPageShots(r.shots);
          else if (r && r.ok === false && r.error) setMsg("缩略图：" + r.error);
        } catch (e) {
          setMsg("缩略图生成失败：" + String((e && e.message) || e));
        } finally {
          setShotsLoading(false);
        }
      };
      const beginPageAction = (type, page) => {
        setPageErr("");
        setPageLinkInfo(null);
        if (type === "delete") {
          try {
            api("/page-links?dir=" + encodeURIComponent(preview.dir || "") + "&page=" + encodeURIComponent(page.path || ""))
              .then((r) => { if (r && r.ok) setPageLinkInfo(r); })
              .catch(() => { /* ignore */ });
          } catch { /* ignore */ }
        }
        const base = String(page.path || "").split("/").pop() || "";
        setPageAction({ type, page, confirm: false });
        setPageActionValue(type === "rename" ? base.replace(/\.html?$/i, "") : base.replace(/\.html?$/i, "") + "-副本");
      };
      const runPageAction = async () => {
        const act = pageAction;
        if (!act) return;
        if (act.type === "delete" && !act.confirm) { setPageAction({ ...act, confirm: true }); return; }
        setPageErr("");
        const body = { dir: preview.dir, action: act.type, page: act.page.path };
        if (act.type !== "delete") body.to = pageActionValue;
        try {
          const r = await api("/page-manage", { method: "POST", body: JSON.stringify(body) });
          if (r && r.ok !== false) {
            const wasCurrent = pagePath === act.page.path;
            setPageAction(null);
            try {
              const list = await api("/pages?dir=" + encodeURIComponent(preview.dir || ""));
              if (list && Array.isArray(list.pages)) setPagesData(list);
            } catch { /* ignore */ }
            try { loadPageShots(true); } catch { /* ignore */ }
            if (act.type === "delete" && wasCurrent) await switchPage("/");
            else if (act.type === "rename" && wasCurrent && r.page) await switchPage(r.page);
            setMsg(act.type === "delete" ? "已删除页面：" + act.page.path : act.type === "rename" ? "已重命名为：" + r.page : "已复制为：" + r.page);
          } else {
            setPageErr(String((r && (r.error || r.reason)) || "操作失败"));
          }
        } catch (e) {
          setPageErr(String((e && e.message) || e));
        }
      };
      const pageName = (() => {
        const cur = pagePath || "/";
        if (cur === "/" || cur === "") return "入口页";
        const parts = String(cur).split("/").filter(Boolean);
        return parts[parts.length - 1] || cur;
      })();

      React.useEffect(() => {
        if (!preview.dir || !pagesData || !Array.isArray(pagesData.pages) || !pagesData.pages.length) return;
        if (pageRestoreRef.current && pageRestoreDirRef.current === preview.dir) return;
        pageRestoreRef.current = true;
        pageRestoreDirRef.current = preview.dir;
        try {
          let saved = localStorage.getItem("dsh-ui-editor:page:" + preview.dir);
          if (!saved) {
            const la = recallLastActive();
            if (la && la.dir && preview.dir && la.dir.toLowerCase() === preview.dir.toLowerCase()) saved = la.page || "";
          }
          const cur = pagePath || preview.page || "/";
          if (saved && saved !== cur && pagesData.pages.some((p) => p.path === saved)) {
            switchPage(saved);
          }
        } catch { /* ignore */ }
      }, [pagesData, preview.dir, pagePath, preview.page]);
      const [selection, setSelection] = useState([]);
      const selectionRef = useRef(selection);
      selectionRef.current = selection;
      const [instruction, setInstruction] = useState("");
      const [busy, setBusy] = useState(false);
      const [ops, setOps] = useState(null);
      const [note, setNote] = useState("");
      const [msg, setMsg] = useState("");
      const [err, setErr] = useState("");
      const [aiCfg, setAiCfg] = useState(null);
      const [cfgForm, setCfgForm] = useState({ baseURL: "", model: "", apiKey: "" });
      const [showCfg, setShowCfg] = useState(false);
      const [marqueeOn, setMarqueeOn] = useState(false);
      const [showHistory, setShowHistory] = useState(false);
      const [aiBarOn, setAiBarOn] = useState(false);
      const [autoSaveOn, setAutoSaveOn] = useState(true);
      const [showHistorySteps, setShowHistorySteps] = useState(false);
      const [histData, setHistData] = useState(null);
      const [recording, setRecording] = useState(false);
      const [zoom, setZoom] = useState(() => {
        try { return Number(localStorage.getItem("dsh-ui-editor:previewZoom")) || 1; } catch { return 1; }
      });
      const [showLayers, setShowLayers] = useState(false);
      const [menuOpen, setMenuOpen] = useState(false);
      const [styleList, setStyleList] = useState(null);
      const [styleBarOpen, setStyleBarOpen] = useState(false);
      const [confirmAsk, setConfirmAsk] = useState(null);
      const [gridOn, setGridOn] = useState(true);
      const [gridSize, setGridSize] = useState(8);
      const [gridObjects, setGridObjects] = useState(true);
      const [fixState, setFixState] = useState(null);
      const [histState2, setHistState2] = useState(null);
      const [showHelp, setShowHelp] = useState(false);
      const [menuWide, setMenuWide] = useState(false);
      const [menuVer, setMenuVer] = useState(false);
      const [themeDark, setThemeDark] = useState(() => {
        try { return localStorage.getItem("dsh-ui-editor:theme") === "dark"; } catch { return false; }
      });
      const [layerData, setLayerData] = useState(null);
      const [backups, setBackups] = useState(null);
      const [conflictDismissed, setConflictDismissed] = useState(false);
      const [floatFocus, setFloatFocus] = useState(false);
      const [floatInput, setFloatInput] = useState("");
      const [floatBusy, setFloatBusy] = useState(false);
      const [shot, setShot] = useState(null);
      const [showShot, setShowShot] = useState(false);
      useEffect(() => {
        EDITOR_CTX.dir = (preview && preview.dir) || "";
        EDITOR_CTX.selection = selection || [];
        EDITOR_CTX.shotPath = (shot && shot.dataUrl)
          ? ((preview && preview.dir ? preview.dir : "") + "\\.ve-data\\shots\\latest.png")
          : (EDITOR_CTX.shotPath || "");
      }, [preview && preview.dir, selection, shot && shot.dataUrl]);

      const reloadPreview = () => {
        const w = iframeRef.current && iframeRef.current.contentWindow;
        if (w) { try { w.location.reload(); } catch { /* ignore */ } }
      };
      const openHistory = async () => {
        setShowHistory(true);
        setBackups(null);
        try {
          const r = await api("/backups?id=" + encodeURIComponent(preview.id));
          setBackups(Array.isArray(r.backups) ? r.backups : []);
        } catch (e) {
          setBackups([]);
          setErr(String(e.message || e));
        }
      };
      const restoreBackup = async (b) => {
        const when = b.at ? new Date(b.at).toLocaleString() : b.id;
        if (!window.confirm("确定回到这个版本？当前改动会被覆盖（当前状态会先自动备份）。\n" + when)) return;
        setBusy(true);
        setErr("");
        try {
          await api("/restore-backup", { method: "POST", body: JSON.stringify({ id: preview.id, backupId: b.id }) });
          setShowHistory(false);
          setMsg("已恢复到 " + when + "，页面已刷新");
          reloadPreview();
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy(false);
        }
      };
      const [aiSource, setAiSource] = useState("auto"); // auto = 优先用 DSH 当前模型
      const [dshAi, setDshAi] = useState(null); // { available, model }
      const [dshTried, setDshTried] = useState(false);

      // 应用预览缩放：zoom 会让 iframe 内部视口变大（页面重新排版，能看到更多内容）
      useEffect(() => {
        const applyZoom = () => {
          try {
            const frames = [...document.querySelectorAll("iframe")].filter((f) => /^https?:\/\/127\.0\.0\.1:/.test(f.src || "") || f.title === "网页预览");
            for (const f of frames) {
              f.style.zoom = String(zoom);
            }
          } catch { /* ignore */ }
        };
        applyZoom();
        try { localStorage.setItem("dsh-ui-editor:previewZoom", String(zoom)); } catch { /* ignore */ }
        const timer = window.setInterval(applyZoom, 1200);
        return () => window.clearInterval(timer);
      }, [zoom]);

      // 固化状态：进入时查一次，之后每 5 秒刷新
      useEffect(() => {
        loadFixStatus();
        const timer = window.setInterval(loadFixStatus, 5000);
        return () => window.clearInterval(timer);
      }, [preview && preview.dir]);

      // 全局 Ctrl+Enter → 切换 AI 改稿条
      useEffect(() => {
        const toggle = () => setAiBarOn((v) => !v);
        window.addEventListener("dsh-ue-toggle-ai", toggle);
        return () => window.removeEventListener("dsh-ue-toggle-ai", toggle);
      }, []);

      // Agent 说「风格优化」时触发 → 打开风格下拉
      useEffect(() => {
        const open = () => { setStyleBarOpen(true); loadStyles(); };
        window.addEventListener('dsh-ue-open-styles', open);
        try { if (window.__uePendingOpenStyles && Date.now() - window.__uePendingOpenStyles < 8000) { window.__uePendingOpenStyles = 0; open(); } } catch (e) { /* ignore */ }
        return () => window.removeEventListener('dsh-ue-open-styles', open);
      }, []);

      useEffect(() => {
        if (!showLayers) return undefined;
        try { send("layers-list"); } catch { /* ignore */ }
        return undefined;
      }, [showLayers]);

      useEffect(() => {
        if (!showHistorySteps) return undefined;
        try { send("history-list"); } catch { /* ignore */ }
        const timer = window.setInterval(() => { try { send("history-list"); } catch { /* ignore */ } }, 1500);
        return () => window.clearInterval(timer);
      }, [showHistorySteps]);

      useEffect(() => {
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            setAiBarOn((v) => !v);
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, []);

      const send = useCallback((type, payload) => {
        const win = iframeRef.current && iframeRef.current.contentWindow;
        if (!win) return;
        win.postMessage({ __ve: "cmd", type, ...(payload || {}) }, "*");
      }, []);

      useEffect(() => {
        const onMsg = (ev) => {
          const d = ev.data;
          if (!d || d.__ve !== "evt") return;
          if (ev.source !== (iframeRef.current && iframeRef.current.contentWindow)) return;
          if (d.type === "page-nav") {
            try { switchPage(d.path); } catch { /* ignore */ }
            return;
          }
          if (d.type === "viewport") { setVpWidth(Math.max(0, Number(d.width) || 0)); return; }
          if (d.type === "ready") {
            setReady(true);
            // 预览每次加载/切页都会重新注入内核：补发页面列表，让顶部导航胶囊继续常驻
            try {
              if (pagesRef.current && pagesRef.current.length) send("pages", { pages: pagesRef.current, current: pagePathRef.current });
            } catch { /* ignore */ }
            try { send("theme-query"); } catch { /* ignore */ }
          } else if (d.type === "shot") {
            if (d.dataUrl) setShot({ dataUrl: d.dataUrl, rect: d.rect || null });
            try {
              api("/context", {
                method: "POST",
                body: JSON.stringify({ dir: preview.dir || "", selection: selectionRef.current || [], shot: d.dataUrl }),
              }).catch(() => {});
            } catch { /* ignore */ }
          } else if (d.type === "marquee") {
            setMarqueeOn(false);
            if (d.items && d.items.length) {
              setSelection(d.items);
              try {
                api("/context", { method: "POST", body: JSON.stringify({ dir: preview.dir || "", selection: d.items, shot: "" }) }).catch(() => {});
              } catch { /* ignore */ }

              setMsg("已选中 " + d.items.length + " 个元素，写一句要 AI 怎么改。");
            } else {
              setMsg("没选中元素，再框一次（要框住内容）。");
            }
          } else if (d.type === "history-state") {
            setHistState2({ ptr: d.ptr, len: d.len, autoSave: d.autoSave });
          } else if (d.type === "preview-focus") {
            try { window.__ueLastPreviewAt = Date.now(); } catch { /* ignore */ }
          } else if (d.type === "layers") {
            setLayerData(d.items || []);
          } else if (d.type === "record") {
            setRecording(false);
            setMsg("录制已上报（共 " + String((d.text || "").length) + " 字符）");
            try {
              api("/context", { method: "POST", body: JSON.stringify({ dir: preview.dir || "", selection: [{ key: "ue-record", text: d.text || "" }], shot: "" }) }).catch(() => {});
            } catch { /* ignore */ }
          } else if (d.type === "history") {
            setHistData({ ptr: d.ptr, steps: d.steps || [] });
          } else if (d.type === "autosave") {
            setAutoSaveOn(Boolean(d.on));
          } else if (d.type === "theme") {
            UE_THEME_DARK = Boolean(d.dark);
            try { if (CHAT_FLOAT.collapsed && CHAT_FLOAT.el) positionFloatTools(CHAT_FLOAT.el.getBoundingClientRect()); } catch { /* ignore */ }
          } else if (d.type === "grid") {
            if (typeof d.on === "boolean") setGridOn(d.on);
            if (d.size != null) setGridSize(Number(d.size) || 8);
            if (typeof d.objects === "boolean") setGridObjects(d.objects);
          } else if (d.type === "toggle-ai") {
            setAiBarOn((v) => !v);
          } else if (d.type === "applied") {
            setMsg("已应用 " + d.count + " 处修改，点「保存」写回源码。");
          } else if (d.type === "saved") {
            const r = (d.result && d.result.data) || {};
            setMsg(r.backupId ? "已保存，旧版本备份：" + r.backupId : "已保存" + (r.wroteContent ? "（文字已写回内容文件）" : ""));
          }
        };
        window.addEventListener("message", onMsg);
        return () => window.removeEventListener("message", onMsg);
      }, []);

      // 对话里 agent 通过工具下发的修改：轮询取走并实时应用到预览页
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const r = await api("/ops?dir=" + encodeURIComponent((preview && preview.dir) || ""));
            if (!alive) return;
            const ops = (r && r.ops) || [];
            if (!ops.length) return;
            if (iframeRef.current && iframeRef.current.contentWindow) {
              iframeRef.current.contentWindow.postMessage({ __ve: "cmd", type: "apply-ops", ops }, "*");
              setMsg("对话里的修改已应用到页面（" + ops.length + " 项）；点「保存」写回源码");
            }
          } catch { /* ignore */ }
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => { alive = false; window.clearInterval(timer); };
      }, [preview && preview.id]);

      useEffect(() => {
        let alive = true;
        api("/ai-native-status")
          .then((r) => { if (alive) { setDshAi(r); setDshTried(true); } })
          .catch(() => { if (alive) { setDshAi({ available: false }); setDshTried(true); } });
        return () => { alive = false; };
      }, []);

      useEffect(() => {
        let alive = true;
        api("/ai-status?id=" + encodeURIComponent(preview.id))
          .then((r) => {
            if (!alive) return;
            const ai = r.ai || { model: "", configured: false };
            setAiCfg(ai);
            setCfgForm((f) => ({ ...f, model: ai.model || "" }));
            })
          .catch(() => setAiCfg({ configured: false, model: "" }));
        return () => { alive = false; };
      }, [preview.id]);

      /** 把浮动面板里的内容发进真实对话（隐藏输入框里写入 + 触发真实发送） */
      const sendFloatToChat = async () => {
        const text = (floatInput || "").trim();
        if (!text) return;
        const extra = (typeof editorCtxText === "function") ? editorCtxText() : "";
        const full = extra ? text + "\n\n" + extra : text;
        setFloatBusy(true);
        try {
          const r = await deliverToChat(full);
          if (r && r.ok) {
            setFloatInput("");
            setMsg("已发送到对话窗口（" + (r.via || "auto") + "）");
          } else {
            console.warn("[dsh-ui-editor] 浮动发送失败", r);
            try {
              await navigator.clipboard.writeText(full);
              setMsg("发送失败（" + ((r && r.reason) || "unknown") + "），已复制到剪贴板，可手动粘贴发送");
            } catch {
              setMsg("发送失败，请手动复制内容到对话窗口");
            }
          }
        } finally {
          setFloatBusy(false);
        }
      }
      const runAi = async () => {
        if (!instruction.trim()) { setMsg("先写一句要 AI 怎么改。"); return; }
        setBusy(true);
        setErr("");
        setOps(null);
        setNote("");
        try {
          const context = selection
            .map((it, i) => `${i + 1}. key=${it.key} | <${it.tag}> | 文字:${JSON.stringify(it.text)} | 位置:${it.rect.x},${it.rect.y} ${it.rect.w}x${it.rect.h} | 样式:${JSON.stringify(it.style)}`)
            .join("\n");
          const first = selection[0];
          const selectionPayload = first ? { key: first.key, tag: first.tag, text: first.text } : null;
          const wantDsh = aiSource !== "custom" && dshAi && dshAi.available;
          let res = null;
          if (wantDsh) {
            res = await api("/ai-native", {
              method: "POST",
              body: JSON.stringify({ instruction: instruction.trim(), selection: selectionPayload, context, shot: shot && shot.dataUrl ? shot.dataUrl : "" }),
            });
            if (res.ok === false && aiCfg && aiCfg.configured) {
              setMsg("DSH 模型调用失败，改用项目自定义接口…");
              res = await api("/ai", {
                method: "POST",
                body: JSON.stringify({
                  id: preview.id,
                  instruction: instruction.trim(),
                  selection: selectionPayload,
                  context: context ? "用户框选的元素（key 必须用这些）：\n" + context : "",
                }),
              });
            }
          } else {
            res = await api("/ai", {
              method: "POST",
              body: JSON.stringify({
                id: preview.id,
                instruction: instruction.trim(),
                selection: selectionPayload,
                context: context ? "用户框选的元素（key 必须用这些）：\n" + context : "",
              }),
            });
          }
          if (!res.ok) {
            if (res.needsDsh) setErr(res.error || "DSH 模型不可用");
            else if (res.needsConfig) { setShowCfg(true); setErr(res.error || "还没配置 AI 接口"); }
            else throw new Error(res.error || "AI 生成失败");
            return;
          }
          if (!res.ops || !res.ops.length) { setNote(res.note || "AI 认为不需要改动。"); return; }
          setOps({ list: res.ops, note: res.note || "" });
          setMsg((res.model ? "用 " + (res.model.model || "DSH 模型") + " 生成了 " : "AI 生成了 ") + res.ops.length + " 个操作，确认后应用。");
        } catch (e) {
          const msgText = String(e.message || e);
          setErr("AI 调用失败：" + msgText);
          setMsg("AI 调用失败，可点「AI 设置」检查模型来源，或改用「发到对话」交给 Agent");
        } finally {
          setBusy(false);
        }
      };

      const applyOps = () => {
        if (!ops) return;
        send("apply-ops", { ops: ops.list });
        setOps(null);
      };

      const saveCfg = async () => {
        setBusy(true);
        setErr("");
        try {
          await api("/ai-config", {
            method: "POST",
            body: JSON.stringify({ id: preview.id, ...cfgForm }),
          });
          const r = await api("/ai-status?id=" + encodeURIComponent(preview.id));
          setAiCfg(r.ai || { configured: true, model: cfgForm.model });
          setShowCfg(false);
          setMsg("AI 配置已保存。");
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy(false);
        }
      };

      const styleCardEl = (s, onClick) => {
        const swatchBg = s.bgColor || (Array.isArray(s.colors) && s.colors[0]) || "#f5f5f5";
        const titleColor = s.titleColor || "#1f2937";
        const desc = s.description || (s.source ? "提取自 " + String(s.source).split(/[\\/]/).pop() : "");
        return h("button", {
          key: s.id,
          className: "wpe-srow",
          title: (s.source ? "提取自 " + s.source : s.name),
          onClick,
        },
          h("span", { className: "wpe-swatch", style: { background: swatchBg }, "aria-hidden": "true" }),
          h("span", { className: "wpe-srow-text" },
            h("b", null, s.name),
            desc ? h("i", null, desc) : null,
          ),
        );
      };

      const loadFixStatus = async () => {
        try {
          const dir = (preview && preview.dir) || '';
          if (!dir) return;
          const r = await api('/fixate-status?dir=' + encodeURIComponent(dir));
          if (r && r.ok) setFixState(r);
        } catch (e) { /* ignore */ }
      };

      const sendGrid = (patch) => {
        const next = Object.assign({ on: gridOn, size: gridSize, objects: gridObjects }, patch || {});
        setGridOn(Boolean(next.on));
        setGridSize(Number(next.size) || 8);
        setGridObjects(Boolean(next.objects));
        try { send("grid", { on: Boolean(next.on), size: Number(next.size) || 8, objects: Boolean(next.objects) }); } catch (e) { /* ignore */ }
      };

      const askFixate = () => {
        setMenuOpen(false);
        setStyleBarOpen(false);
        setConfirmAsk({
          title: "应用改动到源码（相对样式，不覆盖原 CSS 文件）",
          name: "把保存过的修改写进项目真实文件",
          dir: (preview && preview.dir) || "",
          note: "会生成 ve-applied.js 并在入口 HTML 注入 script（Vite 项目写入 src/ve-applied.js 并加 import）；写入前自动备份到 .ve-data/backups/。固化后不带编辑器的真实页面也会显示这些改动。",
          onOk: async () => {
            setConfirmAsk(null);
            setMsg("正在应用改动到源码…");
            try {
              const r = await api('/fixate', { method: 'POST', body: JSON.stringify({ dir: (preview && preview.dir) || '', vw: (typeof window !== "undefined" ? window.innerWidth : 0) }) });
              if (!r || !r.ok) { setMsg("固化失败：" + String((r && r.error) || "未知")); return; }
              setMsg("固化成功：" + String(r.message || (r.files || []).join(" / ")));
              try { loadFixStatus(); } catch (e) { /* ignore */ }
            } catch (e) { setMsg("固化失败：" + String((e && e.message) || e)); }
          },
        });
      };

      // 独立页面（window.open 出来的编辑器）→ 宿主按钮桥接：固化 / 风格 / 自动保存
      React.useEffect(() => {
        const onMsg = (e) => {
          const d = e && e.data;
          if (!d || d.source !== "ve-standalone") return;
          if (d.action === "fixate") { try { askFixate(); } catch { /* ignore */ } return; }
          if (d.action === "styles") { try { window.dispatchEvent(new Event("dsh-ue-open-styles")); } catch { /* ignore */ } return; }
          if (d.action === "toggle-autosave") {
            setAutoSaveOn((v) => {
              const next = !v;
              try { send("autosave", { on: next }); } catch { /* ignore */ }
              return next;
            });
          }
        };
        window.addEventListener("message", onMsg);
        return () => window.removeEventListener("message", onMsg);
      }, [preview && preview.dir]);


      // 应用新风格前，先把项目当前风格存成「原风格」保留一版（按目录只存一次）
      const ensureOriginalStyle = async (dir) => {
        if (!dir) return;
        const key = "ve:origStyleSaved:" + dir;
        try { if (localStorage.getItem(key)) return; } catch { /* ignore */ }
        try {
          const name = "原风格 · " + new Date().toLocaleString();
          const r = await api("/styles/add", { method: "POST", body: JSON.stringify({ path: dir, name }) });
          if (r && r.ok !== false) { try { localStorage.setItem(key, "1"); } catch { /* ignore */ } }
        } catch { /* ignore */ }
      };

      // 把当前项目风格另存为新的一版
      const saveCurrentStyleVersion = async () => {
        const dir = (preview && preview.dir) || "";
        if (!dir) { setMsg("还没打开项目"); return; }
        const def = "我的风格 · " + new Date().toLocaleDateString();
        let name = "";
        try { name = window.prompt("给当前风格起个名字（会存进风格库）", def) || ""; } catch { name = ""; }
        if (!name.trim()) return;
        try {
          const r = await api("/styles/add", { method: "POST", body: JSON.stringify({ path: dir, name: name.trim() }) });
          if (r && r.ok !== false) {
            setMsg("已另存风格：" + name.trim());
            try { const l = await api("/styles"); setStyleList((l && Array.isArray(l.styles)) ? l.styles : []); } catch { /* ignore */ }
          } else setMsg("另存失败：" + String((r && r.error) || "未知"));
        } catch (e) { setMsg("另存失败：" + String((e && e.message) || e)); }
      };

      const styleCompareUrl = (pending) => {
        try {
          const u = new URL(preview.url, window.location.href);
          u.pathname = u.pathname.replace(/[^/]*$/, "style-compare.html");
          u.search = pending ? "?pending=1" : "";
          u.hash = "";
          return u.toString();
        } catch { return ""; }
      };
      const openStyleCompare = (pending) => {
        const u = styleCompareUrl(pending);
        if (u) { try { window.open(u, "_blank", "noopener"); } catch { /* ignore */ } }
      };

      const runApplyStyle = async (id, name, openCompare) => {
        const targetDir = (preview && preview.dir) || "";
        if (!targetDir) { setMsg("还没有打开项目，无法应用风格"); return; }
        setMsg("正在准备「" + (name || "") + "」风格…");
        try {
          await ensureOriginalStyle(targetDir);
          const r = await api('/styles/apply', { method: 'POST', body: JSON.stringify({ id: id, dir: targetDir }) });
          if (!r || !r.ok) { setMsg("风格读取失败：" + String((r && r.error) || "未知")); return; }
          if (openCompare) openStyleCompare(true);
          const sent = await deliverToChat(r.text);
          const ok = Boolean(sent && sent.ok !== false);
          if (ok && !openCompare) { try { closeWorkbench(); } catch { /* ignore */ } }
          setMsg(ok ? "已把「" + (name || "") + "」风格发给 Agent" + (openCompare ? "，对比页已打开，等待新风格生成" : "，已回到对话") : "发送失败：" + String((sent && (sent.reason || sent.error)) || "未知"));
        } catch (e) { setMsg("发送失败：" + String((e && e.message) || e)); }
      };
      const applyStyleToChat = (id, name) => {
        setStyleBarOpen(false);
        setMenuOpen(false);
        const targetDir = (preview && preview.dir) || "";
        if (!targetDir) { setMsg("还没有打开项目，无法应用风格"); return; }
        setConfirmAsk({
          title: "应用风格到项目",
          name: name || "",
          dir: targetDir,
          note: "应用前会自动备份当前版本。可以选择只应用，或应用后立刻打开原版/新版对比。",
          onOk: () => { setConfirmAsk(null); runApplyStyle(id, name, false); },
          onCompare: () => { setConfirmAsk(null); runApplyStyle(id, name, true); },
        });
      };
      const loadStyles = () => {
        if (styleList) return;
        try { api('/styles').then((r) => setStyleList((r && Array.isArray(r.styles)) ? r.styles : [])).catch(() => setStyleList([])); } catch (e) { setStyleList([]); }
      };

      const url = preview.url + (preview.url.indexOf("?") >= 0 ? "&" : "?") + "ve=1&ve_embed=1";
      // 切页后强制 iframe 跟随新页面 URL（防止 React 复用旧 iframe 仍停在首页）
      React.useEffect(() => {
        const f = iframeRef.current;
        if (!f) return;
        try { if (f.getAttribute("src") !== url) f.src = url; } catch { /* ignore */ }
      }, [url]);

      return h(
        "div",
        { className: "wpe-preview" + (floatChatOn() ? " float-chat" : "") + (themeDark ? " dark" : "") },
        h(
          "div",
          { className: "wpe-tools" },
          h(
            "span",
            {
              className: "wpe-status",
              title: ready ? "预览已连接：点击可重新 ping" : "正在连接预览…",
              onClick: () => { send("ping"); setMsg(ready ? "预览已就绪" : "预览还没就绪…"); },
              style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: ready ? "#16a34a" : "#b45309", cursor: "pointer", marginRight: 6 },
            },
            h("span", { style: { width: 7, height: 7, borderRadius: 99, background: ready ? "#16a34a" : "#f59e0b", display: "inline-block", boxShadow: ready ? "0 0 0 2px rgba(22,163,74,.15)" : "0 0 0 2px rgba(245,158,11,.15)" } }),
            ready ? "已连接" : "连接中…",
          ),
          h(
            "span",
            { className: "wpe-align", style: { display: "inline-flex", gap: 3, marginRight: 6 } },
            ...["align-left", "align-centerX", "align-right", "align-top", "align-centerY", "align-bottom"].map((kind) => {
              const it = {"align-left":{"x0":0,"y0":0,"w":243.83,"h":274.94,"paths":["M33.86 50.6l209.97 0 0 81.28 -216.74 0 0 -81.28 6.77 0zm196.42 13.55l-189.64 0 0 54.18 189.64 0 0 -54.18z","M33.86 152.2l142.24 0 0 81.28 -149.01 0 0 -81.28 6.77 0zm128.69 13.55l-121.92 0 0 54.18 121.92 0 0 -54.18z","M13.55 274.94l0 -27.08 -13.55 0 0 27.08 13.55 0zm0 -40.62l-13.55 0 0 -67.73 13.55 0 0 67.73zm0 -81.28l-13.55 0 0 -67.73 13.55 0 0 67.73zm0 -81.28l-13.55 0 0 -67.73 13.55 0 0 67.73z"]},"align-centerX":{"x0":334.33,"y0":0,"w":216.74,"h":274.94,"paths":["M341.1 50.6l209.97 0 0 81.28 -216.74 0 0 -81.28 6.77 0zm196.42 13.55l-189.64 0 0 54.18 189.64 0 0 -54.18z","M374.96 152.2l142.24 0 0 81.28 -149.01 0 0 -81.28 6.77 0zm128.69 13.55l-121.92 0 0 54.18 121.92 0 0 -54.18z","M449.47 274.94l0 -27.08 -13.55 0 0 27.08 13.55 0zm0 -40.62l-13.55 0 0 -67.73 13.55 0 0 67.73zm0 -81.28l-13.55 0 0 -67.73 13.55 0 0 67.73zm0 -81.28l-13.55 0 0 -67.73 13.55 0 0 67.73z"]},"align-right":{"x0":641.56,"y0":0,"w":243.83,"h":274.94,"paths":["M648.33 50.6l209.97 0 0 81.28 -216.74 0 0 -81.28 6.77 0zm196.42 13.55l-189.64 0 0 54.18 189.64 0 0 -54.18z","M716.06 152.2l142.24 0 0 81.28 -149.01 0 0 -81.28 6.77 0zm128.69 13.55l-121.92 0 0 54.18 121.92 0 0 -54.18z","M885.39 274.94l0 -27.08 -13.55 0 0 27.08 13.55 0zm0 -40.62l-13.55 0 0 -67.73 13.55 0 0 67.73zm0 -81.28l-13.55 0 0 -67.73 13.55 0 0 67.73zm0 -81.28l-13.55 0 0 -67.73 13.55 0 0 67.73z"]},"align-top":{"x0":962.39,"y0":0,"w":325.62,"h":237.06,"paths":["M1063.67 237.06l0 -209.97 81.28 0 0 216.74 -81.28 0 0 -6.77zm13.55 -196.42l0 189.64 54.18 0 0 -189.64 -54.18 0z","M1165.27 169.33l0 -142.24 81.28 0 0 149.01 -81.28 0 0 -6.77zm13.55 -128.69l0 121.92 54.18 0 0 -121.92 -54.18 0z","M1288.01 0.01l-27.08 0 0 13.55 27.08 0 0 -13.55zm-40.62 0l0 13.55 -67.73 0 0 -13.55 67.73 0zm-81.28 0l0 13.55 -67.73 0 0 -13.55 67.73 0zm-81.28 0l0 13.55 -67.73 0 0 -13.55 67.73 0z"]},"align-centerY":{"x0":1302.29,"y0":13.54,"w":306.5,"h":216.74,"paths":["M1384.45 223.51l0 -209.97 81.28 0 0 216.74 -81.28 0 0 -6.77zm13.55 -196.42l0 189.64 54.18 0 0 -189.64 -54.18 0z","M1486.05 189.65l0 -142.24 81.28 0 0 149.01 -81.28 0 0 -6.77zm13.55 -128.69l0 121.92 54.18 0 0 -121.92 -54.18 0z","M1608.79 115.15l-27.08 0 0 13.55 27.08 0 0 -13.55zm-40.62 0l0 13.55 -67.73 0 0 -13.55 67.73 0zm-81.28 0l0 13.55 -67.73 0 0 -13.55 67.73 0zm-81.28 0l0 13.55 -67.73 0 0 -13.55 67.73 0z"]},"align-bottom":{"x0":1531.51,"y0":0,"w":398.06,"h":243.84,"paths":["M1705.23 209.97l0 -209.97 81.28 0 0 216.74 -81.28 0 0 -6.77zm13.55 -196.42l0 189.64 54.18 0 0 -189.64 -54.18 0z","M1806.83 209.97l0 -142.24 81.28 0 0 149.01 -81.28 0 0 -6.77zm13.55 -128.69l0 121.92 54.18 0 0 -121.92 -54.18 0z","M1929.57 230.29l-27.08 0 0 13.55 27.08 0 0 -13.55zm-40.62 0l0 13.55 -67.73 0 0 -13.55 67.73 0zm-81.28 0l0 13.55 -67.73 0 0 -13.55 67.73 0zm-81.28 0l0 13.55 -67.73 0 0 -13.55 67.73 0z"]}}[kind];
              /* 图标居中：用 SVG 实际 bbox 计算 transform（不要用写死的 x0/w 估算——
                 align-top / centerY / bottom 的元数据与实际路径 bbox 有偏差，会偏 1~3px） */
              const icon = it
                ? h(
                    "svg",
                    { width: 22, height: 15.4, viewBox: "0 0 300 210", preserveAspectRatio: "xMidYMid meet", style: { display: "block" } },
                    h(
                      "g",
                      {
                        ref: (g) => {
                          if (!g) return;
                          try {
                            g.removeAttribute("transform");
                            const b = g.getBBox();
                            const svg = g.ownerSVGElement;
                            const vb = svg && svg.viewBox && svg.viewBox.baseVal;
                            if (!b || !(b.width > 0) || !vb || !vb.width) return;
                            const s = 0.7;
                            const tx = (vb.width - b.width * s) / 2 - b.x * s;
                            const ty = (vb.height - b.height * s) / 2 - b.y * s;
                            g.setAttribute("transform", "translate(" + tx.toFixed(2) + "," + ty.toFixed(2) + ") scale(" + s + ")");
                          } catch (e) { /* ignore */ }
                        },
                      },
                      it.paths.map((d, i) => h("path", { key: i, d, fill: i === 2 ? "#38bdf8" : "#111" })),
                    ),
                  )
                : null;
              return h("button", {
                key: kind,
                className: "wpe-btn",
                title: "对齐：" + kind + "（Ctrl+Shift+点击可多选元素）",
                // 六个按钮统一尺寸，图标用 flex 居中，保证「图标中心 = 按钮外框中心」
                style: { width: 30, height: 26, flex: "0 0 auto", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 0 },
                onClick: () => { send("align", { kind }); setMsg("已对齐所选元素"); },
              }, icon);
            }),
          ),
          h("span", { className: "wpe-badge" }, preview.mode === "vite" ? "Vite" : "静态站"),
          h("span", { style: { fontSize: 11.5, color: "#5b6478", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: preview.dir }, fmtDir(preview.dir)),
          h(
            "span",
            { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 4 } },
            h("button", {
              className: "wpe-btn",
              title: "页面管理：切换 / 新建 / 重命名 / 复制 / 删除（含缩略图）",
              onClick: () => { const next = !pageMenu; setPageMenu(next); if (next) loadPageShots(false); },
              style: { height: 24, padding: "0 10px", fontSize: 12.5 },
            }, "页面管理 ▾"),
            pageMenu
              ? h("div", {
                  className: "wpe-menu",
                  style: { position: "absolute", top: 30, left: 0, zIndex: 80, width: 360, maxWidth: "min(94vw, 360px)", maxHeight: 380, overflow: "auto", textAlign: "left", padding: 8 },
                },
                  pagesData && pagesData.pages && pagesData.pages.length
                    ? pagesData.pages.map((p) => h("div", { key: p.path, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderRadius: 8, background: p.current ? "#f8fafc" : "transparent" } },
                        h("div", {
                          onClick: () => switchPage(p.path),
                          title: "点击切换到：" + p.path,
                          style: {
                            width: 92, height: 58, flex: "0 0 auto", borderRadius: 6,
                            border: "1px solid " + (p.current ? "#c7d2fe" : "#e5e7eb"),
                            backgroundImage: pageShots[p.path] ? "url(" + pageShots[p.path] + ")" : "none",
                            backgroundSize: "cover", backgroundPosition: "top center",
                            backgroundColor: "#f1f5f9",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 16, color: "#cbd5e1", overflow: "hidden", cursor: "pointer",
                          },
                        }, pageShots[p.path] ? null : (shotsLoading ? "…" : "▦")),
                        h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } },
                          h("button", {
                            onClick: () => switchPage(p.path),
                            title: p.path,
                            style: { textAlign: "left", border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: 12, color: "#334155", fontWeight: p.current ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                          }, (p.current ? "✓ " : "") + (p.path === "/" ? "入口页 /" : p.path)),
                          h("span", { style: { fontSize: 10.5, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.title || (p.entry ? "站点入口" : ""))),
                        h("button", { title: "重命名", onClick: () => beginPageAction("rename", p), style: { flex: "0 0 auto", width: 24, height: 24, border: 0, background: "transparent", borderRadius: 5, cursor: "pointer", color: "#64748b", fontSize: 12 }, onMouseEnter: (ev) => (ev.currentTarget.style.background = "#f1f5f9"), onMouseLeave: (ev) => (ev.currentTarget.style.background = "transparent") }, "✎"),
                        h("button", { title: "复制页面", onClick: () => beginPageAction("copy", p), style: { flex: "0 0 auto", width: 24, height: 24, border: 0, background: "transparent", borderRadius: 5, cursor: "pointer", color: "#64748b", fontSize: 12 }, onMouseEnter: (ev) => (ev.currentTarget.style.background = "#f1f5f9"), onMouseLeave: (ev) => (ev.currentTarget.style.background = "transparent") }, "⧉"),
                        p.deletable
                          ? h("button", { title: "删除页面（会先备份）", onClick: () => beginPageAction("delete", p), style: { flex: "0 0 auto", width: 24, height: 24, border: 0, background: "transparent", borderRadius: 5, cursor: "pointer", color: "#c0392b", fontSize: 12 }, onMouseEnter: (ev) => (ev.currentTarget.style.background = "#fef2f2"), onMouseLeave: (ev) => (ev.currentTarget.style.background = "transparent") }, "🗑")
                          : null))
                    : h("div", { style: { padding: "8px 10px", fontSize: 11.5, color: "#64748b" } },
                        pagesData ? (pagesData.hint || "这个项目没有其它可切换的页面") : "读取页面中…"),
                  pageAction
                    ? h("div", { style: { padding: "8px", borderTop: "1px solid #eef2f7", background: "#fbfdff" } },
                        h("div", { style: { fontSize: 11.5, color: "#475569", marginBottom: 6, lineHeight: 1.5 } },
                          pageAction.type === "delete"
                            ? "删除「" + pageAction.page.path + "」？" + (pageAction.confirm ? "再点一次确认删除。" : "")
                            : (pageAction.type === "rename" ? "重命名「" + pageAction.page.path + "」为：" : "复制「" + pageAction.page.path + "」到新文件：")),
                        pageAction.type === "delete"
                          ? h("div", null,
                              h("div", { style: { display: "flex", gap: 6 } },
                                h("button", { className: "wpe-btn", style: { height: 28, borderColor: "#f3c0c0", color: "#c0392b", background: "#fff5f5" }, onClick: () => runPageAction() }, pageAction.confirm ? "确认删除" : "删除"),
                                h("button", { className: "wpe-btn", style: { height: 28 }, onClick: () => setPageAction(null) }, "取消"),
                                h("span", { style: { fontSize: 10.5, color: "#94a3b8", alignSelf: "center" } }, "HTML 与该页修改数据会备份到 .ve-data/backups")),
                              pageLinkInfo && pageLinkInfo.count > 0
                                ? h("div", { style: { marginTop: 6, fontSize: 11, color: "#b45309", lineHeight: 1.6 } },
                                    "⚠ 有 " + pageLinkInfo.count + " 处链接指向该页（" + (pageLinkInfo.files || []).join("、").slice(0, 120) + "），删除后这些链接会 404")
                                : pageLinkInfo && pageLinkInfo.ok
                                  ? h("div", { style: { marginTop: 6, fontSize: 11, color: "#16a34a" } }, "没有其它页面链接到它")
                                  : null)
                          : h("div", null,
                              h("input", {
                                value: pageActionValue,
                                spellCheck: false,
                                autoFocus: true,
                                onChange: (e) => setPageActionValue(e.target.value),
                                onKeyDown: (e) => { if (e.key === "Enter") runPageAction(); if (e.key === "Escape") setPageAction(null); },
                                style: { width: "100%", height: 32, boxSizing: "border-box", border: "1px solid #dfe3ea", borderRadius: 6, padding: "0 10px", fontSize: 12.5 },
                              }),
                              h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 } },
                                h("button", { className: "wpe-btn", style: { height: 28 }, onClick: () => setPageAction(null) }, "取消"),
                                h("button", { className: "wpe-btn pri", style: { height: 28, whiteSpace: "nowrap" }, onClick: () => runPageAction() }, "确定"))),
                        pageErr ? h("div", { style: { marginTop: 6, fontSize: 11.5, color: "#c0392b" } }, pageErr) : null)
                    : null,

                  trashOpen
                    ? h("div", { style: { padding: "10px", borderTop: "1px solid #e2e8f0", background: "#fff", borderRadius: 8, marginTop: 4 } },
                        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
                          h("span", { style: { fontSize: 12.5, fontWeight: 600, color: "#1e293b", flex: 1 } }, "🗂 删除恢复"),
                          h("button", { className: "wpe-btn", style: { height: 26, fontSize: 11.5 }, onClick: () => { setTrashOpen(false); } }, "收起")),
                        h("div", { style: { fontSize: 11.5, color: "#475569", lineHeight: 1.6, marginBottom: 8 } }, "删除 / 改名 / 复制页面前的自动备份，点「恢复」可还原 HTML 与该页修改数据。"),
                        trashList === null
                          ? h("div", { style: { fontSize: 12, color: "#64748b", padding: "6px 0" } }, "读取中…")
                          : trashList.length === 0
                            ? h("div", { style: { fontSize: 12, color: "#64748b", padding: "6px 0" } }, "还没有页面操作备份")
                            : h("div", { style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflow: "auto" } },
                                trashList.slice(0, 8).map((it) => h("div", { key: it.name, style: { display: "flex", alignItems: "center", gap: 8, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 8px" } },
                                  h("span", { style: { flex: "0 0 auto", color: "#334155", fontSize: 11.5, fontFamily: "ui-monospace,Consolas,monospace" } }, new Date(it.at || Date.now()).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })),
                                  h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#1e293b", fontSize: 12 }, title: (it.files || []).join(", ") }, (it.files || []).slice(0, 3).join("、") || "(无 HTML)"),
                                  h("button", { className: "wpe-btn pri", style: { height: 26, fontSize: 11.5, flex: "0 0 auto", padding: "0 10px" }, disabled: trashBusy, onClick: () => restoreTrash(it) }, trashBusy ? "恢复中…" : "恢复")))))
                    : null,
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "6px 8px 0" } },
                    h("button", { className: "wpe-btn", style: { height: 26, fontSize: 11.5, flex: "0 0 auto" }, onClick: () => loadPageShots(true) }, shotsLoading ? "生成缩略图中…" : "⟳ 刷新缩略图"),
                    h("button", { className: "wpe-btn", style: { height: 26, fontSize: 11.5, flex: "0 0 auto" }, onClick: () => loadPageTrash() }, "🗂 删除恢复"),
                    h("button", { className: "wpe-btn", style: { height: 26, fontSize: 11.5, flex: "0 0 auto" }, title: "重新加载预览（跨域 iframe 用重设 src 的方式刷新）", onClick: () => { setPageMenu(false); try { const f = iframeRef.current; if (f && f.src) { f.src = f.src; setMsg("已重新加载预览"); } } catch (e) { setMsg("重载失败：" + String((e && e.message) || e)); } } }, "⟳ 重载预览")),
                  h("div", { style: { padding: "8px" } },
                    h("button", {
                      className: "wpe-btn",
                      style: { width: "100%", height: 32, fontSize: 12.5, justifyContent: "center" },
                      onClick: () => { setPageErr(""); setPageMenu(false); setCreateOpen(true); },
                    }, "＋ 新建页面")),
                  h("div", { style: { padding: "6px 10px", fontSize: 10.5, color: "#94a3b8", borderTop: "1px solid #eef2f7" } },
                    "每个页面独立保存修改（入口页沿用旧数据）"),
                )
              : null,
          ),
          histState2 && histState2.len
            ? h("span", {
                className: "wpe-badge",
                style: { cursor: "pointer" },
                title: "当前在第 " + (histState2.ptr + 1) + " / " + histState2.len + " 步（点击查看步骤历史）",
                onClick: () => { setShowHistorySteps(true); setHistData(null); },
              }, "步骤 " + (histState2.ptr + 1) + "/" + histState2.len)
            : null,
          h("span", { className: "wpe-msg", style: { maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: msg || "" }, msg || ""),
          h("span", { style: { flex: 1 } }),

          h("button", {
            className: "wpe-btn" + (aiBarOn ? " on" : ""),
            title: "显示/隐藏 AI 改稿条（Ctrl+Enter）",
            onClick: () => setAiBarOn((v) => !v),
          }, "AI 调整"),
          h("button", { className: "wpe-btn" + (gridOn ? " on" : ""), title: "网格对齐 开/关", onClick: () => sendGrid({ on: !gridOn }) }, "网格"),
          h("button", { className: "wpe-btn" + (gridObjects ? " on" : ""), title: "吸附物体边缘 开/关", onClick: () => sendGrid({ objects: !gridObjects }) }, "吸附"),
          h("button", { className: "wpe-btn" + (autoSaveOn ? " on" : ""), title: "自动保存 开/关", onClick: () => { const next = !autoSaveOn; setAutoSaveOn(next); send("autosave", { on: next }); } }, "自动保存"),
          h("button", { className: "wpe-btn" + (themeDark ? " on" : ""), title: "编辑器外观：浅色 / 深色", onClick: () => { const next = !themeDark; setThemeDark(next); try { localStorage.setItem("dsh-ui-editor:theme", next ? "dark" : "light"); } catch { /* ignore */ } } }, themeDark ? "暗色" : "亮色"),
          h("button", {
            className: "wpe-btn",
            title: "刷新预览：重新加载当前页面，立即看到源码 / 外部改动",
            onClick: () => {
              try {
                const f = iframeRef.current;
                if (!f || !f.src) { setMsg("预览还没准备好"); return; }
                const u = new URL(f.src, location.href);
                u.searchParams.set("_ve_refresh", String(Date.now()));
                f.src = u.toString();
                setMsg("已刷新预览");
              } catch (e) { setMsg("刷新失败：" + String((e && e.message) || e)); }
            },
          }, "⟳ 刷新"),
          h("button", { className: "wpe-btn", title: "保存（Ctrl+S）", onClick: () => { send("save"); setMsg("保存中…"); } }, "保存"),
          h("button", { className: "wpe-btn", title: "应用改动到源码：写相对/响应式样式（不覆盖原 CSS 文件，可删除 ve-applied.js 还原）", onClick: askFixate }, "应用到源码"),
          h("span", {
            className: "wpe-fixchip " + (fixState ? fixState.state : ""),
            title: fixState
              ? (fixState.state === "fixed" ? "已固化：真实页面已包含最新修改（" + new Date(fixState.fixedAt || 0).toLocaleString() + "）"
                : fixState.state === "stale" ? "有未固化修改：保存后点「固化」才会写进真实页面"
                : fixState.state === "unfixed" ? "未固化：真实页面还没有这些修改"
                : "没有可固化的修改")
              : "固化状态检查中…",
            onClick: () => { if (fixState && (fixState.state === "unfixed" || fixState.state === "stale")) askFixate(); },
          }, fixState
            ? (fixState.state === "fixed" ? "● 已固化"
              : fixState.state === "stale" ? "● 待固化"
              : fixState.state === "unfixed" ? "○ 未固化"
              : "○ 无改动")
            : "○ …"),
          h("button", { className: "wpe-btn", title: "撤销（Ctrl+Z）", onClick: () => { send("undo"); setMsg("已撤销上一步"); } }, "↶"),
          h("button", { className: "wpe-btn", title: "重做（Ctrl+Shift+Z）", onClick: () => { send("redo"); setMsg("已重做上一步"); } }, "↷"),
          h("button", {
            className: "wpe-btn" + (styleBarOpen ? " on" : ""),
            title: "风格优化：一键套用已保存的 UI 风格（在网页工作台管理风格）",
            onClick: () => { setStyleBarOpen((v) => !v); loadStyles(); },
          }, "风格"),
          h("button", {
            className: "wpe-btn" + (menuOpen ? " on" : ""),
            title: "更多操作（自动保存 / 清空修改 / 调试工具 / 视图 / 项目）",
            onClick: () => {
              setMenuOpen((v) => !v);
              if (!styleList) {
                try { api('/styles').then((r) => setStyleList((r && Array.isArray(r.styles)) ? r.styles : [])).catch(() => setStyleList([])); } catch (e) { setStyleList([]); }
              }
            },
          }, "⋯"),
        ),
        menuOpen
          ? h("div", { className: "wpe-menu-mask", onClick: () => setMenuOpen(false) })
          : null,
        menuOpen
          ? h(
              "div",
              { className: "wpe-menu" },
              h("div", { className: "grp" }, "网格精度"),
              h("div", { className: "rowline" },
                h("input", { type: "range", min: 2, max: 32, step: 2, value: gridSize, title: "网格对齐精度", style: { flex: 1, minWidth: 90 }, onChange: (ev) => sendGrid({ size: Number(ev.target.value) }) }),
                h("span", { style: { fontSize: 10.5, color: "#94a3b8", minWidth: 34, textAlign: "right" } }, gridSize + "px"),
              ),
              
              h("div", { className: "grp" }, "编辑"),
              h("button", {
                className: "danger",
                onClick: () => {
                  const tip = ["确定要清空全部修改吗？", "", "会删除所有覆写记录和步骤历史，页面回到原始状态，且不可撤销。", "（只想退回一步请用 ↶ 或 Ctrl+Z）"].join(String.fromCharCode(10));
                  if (window.confirm(tip)) { send("reset-all"); setMsg("正在恢复原始页面…"); }
                  setMenuOpen(false);
                },
              }, "清空全部修改"),
              h("div", { className: "sep" }),
              h("div", { className: "grp" }, "调试 / 图层"),
              h("button", {
                className: showHistorySteps ? "on" : "",
                onClick: () => { setShowHistorySteps(true); setHistData(null); setMenuOpen(false); },
              }, "步骤历史" + (histData && histData.steps ? "（" + histData.steps.length + "）" : "")),
              h("button", {
                className: showLayers ? "on" : "",
                onClick: () => { setShowLayers(true); setLayerData(null); try { send("layers-list"); } catch { /* ignore */ } setMenuOpen(false); },
              }, "图层列表"),
              h("div", { className: "sep" }),
              h("div", { className: "grp" }, "风格（点击发给 Agent）"),
              styleList === null
                ? h("button", { disabled: true }, "读取风格库…")
                : styleList.length === 0
                  ? h("button", { onClick: () => { setMenuOpen(false); const tried = openWorkbenchPanel(); setMsg(tried && tried.length ? "已尝试打开网页工作台" : "还没有风格：请点左侧「网页工作台」图标导入"); } }, "还没有风格 · 去工作台添加")
                  : h("div", { className: "wpe-sgrid" }, styleList.slice(0, 8).map((s) => styleCardEl(s, () => applyStyleToChat(s.id, s.name)))),
              h("div", { className: "sep" }),
              h("div", { className: "grp" }, "视图"),
              h("div", { className: "rowline" },
                h("button", { className: "wpe-btn", title: "缩小预览", onClick: () => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10)) }, "−"),
                h("span", { style: { minWidth: 40, textAlign: "center", color: "#475569" } }, Math.round(zoom * 100) + "%"),
                h("button", { className: "wpe-btn", title: "放大预览", onClick: () => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10)) }, "+"),
                h("button", { className: "wpe-btn", title: "恢复 100%", onClick: () => setZoom(1) }, "1:1"),
              ),
              h("div", { className: "sep" }),
              h("div", { className: "grp" }, "项目"),
              h("button", {
                className: (() => { try { return localStorage.getItem("dsh-ue:auto-wb") === "1"; } catch { return true; } })() ? "on" : "",
                onClick: () => {
                  try {
                    const cur = localStorage.getItem("dsh-ue:auto-wb") === "1";
                    localStorage.setItem("dsh-ue:auto-wb", cur ? "0" : "1");
                    setMsg(cur ? "已关闭：启动时不再自动进入工作台" : "已开启：下次启动自动进入工作台");
                  } catch { /* ignore */ }
                  setMenuOpen(false);
                },
              }, "启动时自动进入工作台：" + ((() => { try { return localStorage.getItem("dsh-ue:auto-wb") === "1"; } catch { return true; } })() ? "开" : "关")),
              h("button", { onClick: () => { setShowHelp(true); setMenuOpen(false); } }, "快捷键帮助"),
              h("button", { onClick: () => { setShowCfg(true); setMenuOpen(false); } }, "AI 设置"),
              h("button", { onClick: () => { openHistory(); setMenuOpen(false); } }, "历史备份"),
              h("button", { onClick: () => { setMenuVer(true); setMenuOpen(false); } }, "版本 v1.1.13"),
              /* @dev-start */
              devToolsOn() ? h("div", { className: "grp" }, "测试工具（发布排除）") : null,
              devToolsOn() ? h("button", { onClick: () => { setMenuWide(true); setMenuOpen(false); } }, "宽屏/窄屏参数") : null,
              devToolsOn() ? h("button", { onClick: () => { toggleChatFloat(); setMenuOpen(false); } }, "浮动对话（测试）") : null,
              devToolsOn() ? h("button", { className: recording ? "on" : "", onClick: () => { if (recording) { send("rec-stop"); setMsg("录制结束，正在上报…"); } else { send("rec-start"); setRecording(true); setMsg("开始录制：操作完成后再次点「录制中」结束"); } setMenuOpen(false); } }, recording ? "■ 结束录制" : "● 开始录制") : null,
              devToolsOn() ? h("button", { onClick: () => { setMenuOpen(false); try { console.info("[dsh-ui-editor] 拖动诊断", { gridOn, gridSize, gridObjects, aiBarOn, autoSaveOn, themeDark }); } catch { /* ignore */ } setMsg("拖动诊断已输出到控制台：网格 " + (gridOn ? gridSize + "px" : "关") + " / 吸附 " + (gridObjects ? "开" : "关")); } }, "拖动诊断（控制台）") : null,
              /* @dev-end */
              
              h("button", {
                onClick: async () => { try { await api("/close", { method: "POST", body: JSON.stringify({ id: preview.id }) }); } catch { /* ignore */ } setMenuOpen(false); onClose(); },
              }, "关闭"),
            )
          : null,
        showHelp ? h(HelpBox, { onClose: () => setShowHelp(false) }) : null,
        createOpen ? h(NewPageBox, { dir: preview.dir, onClose: () => setCreateOpen(false), onCreate: doCreatePage }) : null,
        menuWide ? h(WideParamsBox, { onClose: () => setMenuWide(false) }) : null,
        menuVer ? h(VersionBox, { onClose: () => setMenuVer(false) }) : null,
        styleBarOpen
          ? h("div", { className: "wpe-menu-mask", onClick: () => setStyleBarOpen(false) })
          : null,
        styleBarOpen
          ? h(
              "div",
              { className: "wpe-menu wpe-menu-style", style: { top: 46 } },
              h("div", { className: "grp" }, "风格优化（点击即发给 Agent）"),
              styleList === null
                ? h("button", { disabled: true }, "读取风格库…")
                : styleList.length === 0
                  ? h("button", { onClick: () => { setStyleBarOpen(false); setMsg("还没有风格：左侧「网页工作台 → 风格优化 → ＋ 添加风格」导入一份"); } }, "还没有风格 · 去网页工作台添加")
                  : h("div", { className: "wpe-sgrid" }, styleList.map((s) => styleCardEl(s, () => applyStyleToChat(s.id, s.name)))),
              h("div", { className: "sep" }),
              h("button", { onClick: () => { setStyleBarOpen(false); openStyleCompare(false); }, title: "打开原版 / 新版风格对比" }, "打开风格对比"),
              h("button", { onClick: saveCurrentStyleVersion, title: "把当前项目风格存成风格库里新的一版" }, "＋ 另存当前风格为一版"),
              h("button", { onClick: () => {
                setStyleBarOpen(false);
                setMenuOpen(false);
                const tried = openWorkbenchPanel();
                setMsg(tried && tried.length ? "已尝试打开网页工作台（左侧图标）" : "没找到工作台入口：请点左侧「网页工作台」图标");
              } }, "管理风格（去网页工作台）"),
            )
          : null,
        confirmAsk
          ? h("div", { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) setConfirmAsk(null); } },
              h("div", { className: "wpe-modal-box", style: { maxWidth: 420 } },
                h("div", { className: "wpe-modal-h" },
                  h("b", null, "应用风格到项目"),
                  h("span", { style: { flex: 1 } }),
                  h("button", { className: "wpe-iconbtn", onClick: () => setConfirmAsk(null) }, "✕"),
                ),
                h("div", { className: "wpe-modal-body", style: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px 14px" } },
                  h("div", { className: "wpe-msg" }, "风格：" + (confirmAsk.name || "")),
                  h("div", { className: "wpe-msg", style: { wordBreak: "break-all" } }, "项目：" + (confirmAsk.dir || "")),
                  h("div", { className: "wpe-msg" }, confirmAsk.note || ""),
                  h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 } },
                    h("button", { className: "wpe-btn", onClick: () => setConfirmAsk(null) }, "取消"),
                    confirmAsk.onCompare
                      ? h("button", { className: "wpe-btn", onClick: () => { try { confirmAsk.onCompare(); } catch (e) { /* ignore */ } } }, "应用并打开风格对比")
                      : null,
                    h("button", { className: "wpe-btn pri", onClick: () => { try { confirmAsk.onOk(); } catch (e) { /* ignore */ } } }, "应用到该项目"),
                  ),
                ),
              ),
            )
          : null,
        preview.conflict && preview.conflict.detected && !conflictDismissed
          ? h(
              "div",
              { className: "wpe-notice" },
              h("span", null, "检测到项目自带旧版编辑器（" + ((preview.conflict.sources || []).join("、") || "已忽略") + "）：已在本次预览中忽略它，未修改项目任何文件；本次使用插件内置的最新内核。"),
              h("button", { className: "wpe-iconbtn", onClick: () => setConflictDismissed(true) }, "知道了"),
            )
          : null,
        h(
          "div",
          { className: "wpe-canvas" },
          h("iframe", {
            ref: iframeRef,
            className: "wpe-frame",
            style: { width: vpWidth ? vpWidth + "px" : "100%", maxWidth: "100%", flex: vpWidth ? "0 0 auto" : "1 1 auto", margin: vpWidth ? "0 auto" : 0 },
            src: url,
            title: "网页预览",
            onLoad: () => setTimeout(() => send("ping"), 400),
          }),
          h(
            "div",
            {
              className: "wpe-ai wpe-float" + (floatFocus ? " active" : "") + (ops ? " expanded" : "") + (aiBarOn || floatChatOn() ? "" : " hidden"),
            },
            h(
              "div",
              { className: "wpe-float-row" },
              h("button", {
                className: "wpe-btn" + (marqueeOn ? " on" : ""),
                "aria-pressed": marqueeOn ? "true" : "false",
                title: marqueeOn ? "正在框选：在网页里拖一个框（Esc 取消）" : "框选：在页面里拖一个框，截取这片区域",
                onClick: () => { setMarqueeOn(true); setMsg("在预览里拖一个框截取区域…"); send("enter-marquee"); },
              }, marqueeOn ? "▣ 框选中…" : "▣ 框选"),
              h("button", {
                className: "wpe-btn" + (styleBarOpen ? " on" : ""),
                title: "风格优化：选一个已保存的 UI 风格交给 Agent",
                onClick: () => { setStyleBarOpen(true); loadStyles(); },
              }, "✦ 风格"),
              h("input", {
                type: "text",
                className: "wpe-float-input",
                placeholder: "想让 AI 怎么改？例如：把选中的标题字号加大、字重加粗，副标题改成两行",
                value: instruction,
                onChange: (e) => setInstruction(e.target.value),
                onFocus: () => setFloatFocus(true),
                onBlur: () => setTimeout(() => setFloatFocus(false), 120),
                onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) runAi(); },
              }),
              h("button", {
                className: "wpe-btn",
                title: "把项目/选区/截图/需求发给对话里的 Agent，由它继续改（会出现在聊天窗口）",
                onClick: async () => {
                  const dir = (preview && preview.dir) || "";
                  const lines = [];
                  const items = selection || [];
                  lines.push("请帮我改一下「" + (dir || "当前项目") + "」这个网页：");
                  lines.push(instruction || "（在输入框里写你想怎么改）");
                  lines.push("");
                  lines.push("—— 来自网页修改器 ——");
                  if (items.length) {
                    lines.push("我框选了 " + items.length + " 个元素：" + items.slice(0, 4).map((x) => (x.tag || "") + " " + String(x.text || x.key || "").slice(0, 24)).filter(Boolean).join("；"));
                  } else {
                    lines.push("（暂时没有框选）");
                  }
                  if (shot && shot.dataUrl) lines.push("框选截图已保存到项目 .ve-data/shots/latest.png，可以用 web_editor_context 查看。");
                  lines.push("请先调用 web_editor_context，再用 web_editor_apply_ops 把修改实时应用到编辑器预览。");
                  const text = lines.join("\n");
                  setInstruction("");
                  const result = await deliverToChat(text);
                  if (result && result.ok) {
                    setMsg("已直接发送到对话窗口（" + (result.via || "auto") + "）：Agent 接着改，改完实时回到页面");
                  } else {
                    console.warn("[dsh-ui-editor] 发送失败原因", result);
                    setErr("发送到对话失败：" + ((result && result.reason) || "unknown") + "（已复制到剪贴板）");
                    try {
                      await navigator.clipboard.writeText(text);
                      setMsg("已复制到剪贴板：切到对话窗口 Ctrl+V 发送即可");
                    } catch {
                      setMsg("请手动复制到对话窗口：" + text.slice(0, 60) + "…");
                    }
                  }
                  setFloatFocus(false);
                },
              }, "发到对话"),
              h("button", { className: "wpe-btn pri", onClick: runAi, disabled: busy }, busy ? "生成中…" : "AI 改"),
            ),
            h(
              "div",
              { className: "wpe-float-meta" },
              h(
                "span",
                { className: "chip", "data-on": aiSource === "auto" ? "1" : "0", onClick: () => setAiSource("auto"), title: "直接用你在 DSH 里选的模型，不需要填 key（不可用时请检查 DSH 设置里的模型）" },
                "DSH 模型" + (dshAi && dshAi.model && dshAi.model.model ? "（" + dshAi.model.model + "）" : dshTried && dshAi && dshAi.available === false ? "（不可用）" : ""),
              ),
              dshTried && dshAi && dshAi.available === false
                ? h("span", { className: "wpe-msg err" }, "DSH 模型不可用")
                : null,
              h("span", { className: "chip", "data-on": aiSource === "custom" ? "1" : "0", onClick: () => setAiSource("custom") }, "自定义接口"),
              aiSource === "custom" ? h("button", { className: "wpe-btn", style: { height: 22, padding: "0 8px", fontSize: 11 }, onClick: () => setShowCfg((v) => !v) }, "设置") : null,
              selection.length
                ? h("span", { className: "wpe-sel", title: selection.map((s) => s.key).join("\n") }, "已选 " + selection.length + " 个元素：" + (selection[0].text || selection[0].tag || "").slice(0, 18))
                : null,
              h("span", { style: { flex: 1 } }),
              h("span", {
                className: "chip",
                "data-on": EDITOR_CTX.enabled ? "1" : "0",
                title: "开启后：你在左侧对话框正常打字发送，会自动带上当前项目和框选信息（不用点「发到对话」）",
                onClick: () => {
                  EDITOR_CTX.enabled = !EDITOR_CTX.enabled;
                  try { localStorage.setItem("dsh-ui-editor:attachCtx", EDITOR_CTX.enabled ? "1" : "0"); } catch { /* ignore */ }
                  setMsg(EDITOR_CTX.enabled ? "已开启：窗口里发的消息会自动附带编辑器选区" : "已关闭：窗口消息不再附带编辑器选区");
                  setShot((s) => (s ? { ...s } : s));
                },
              }, "附带选区"),
              h("span", { style: { flex: 1 } }),
              h("span", { className: "wpe-msg" + (err ? " err" : "") }, err || msg || note || ""),
            ),
            showCfg
              ? h(
                  "div",
                  { style: { display: "grid", gap: 6 } },
                  h("div", { className: "row" },
                    h("input", { type: "text", placeholder: "baseURL，例如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1", value: cfgForm.baseURL, onChange: (e) => setCfgForm({ ...cfgForm, baseURL: e.target.value }) })),
                  h("div", { className: "row" },
                    h("input", { type: "text", placeholder: "模型，例如 gpt-4o-mini / qwen2.5:7b", value: cfgForm.model, onChange: (e) => setCfgForm({ ...cfgForm, model: e.target.value }) }),
                    h("input", { type: "password", placeholder: "apiKey（本地 ollama 可留空）", value: cfgForm.apiKey, onChange: (e) => setCfgForm({ ...cfgForm, apiKey: e.target.value }) })),
                  h("div", { className: "row" },
                    h("button", { className: "wpe-btn pri", onClick: saveCfg, disabled: busy }, "保存 AI 配置"),
                    aiCfg && aiCfg.configured ? h("span", { className: "wpe-msg" }, "当前模型：" + (aiCfg.model || "—")) : h("span", { className: "wpe-msg err" }, "还没配置 AI")),
                )
              : null,
            ops
              ? h(
                  "div",
                  { style: { display: "grid", gap: 6 } },
                  ops.note ? h("div", { className: "wpe-msg" }, ops.note) : null,
                  h("div", { className: "wpe-ops" }, ops.list.map((op) => h("div", { key: Math.random() }, "• " + describeOp(op)))),
                  h("div", { className: "row" },
                    h("button", { className: "wpe-btn pri", onClick: applyOps }, "应用到页面"),
                    h("button", { className: "wpe-btn", onClick: () => { setOps(null); setMsg(""); } }, "取消")),
                )
              : null,
          ),
        ),
        showShot && shot && shot.dataUrl
          ? h(
              "div",
              { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) setShowShot(false); } },
              h(
                "div",
                { className: "wpe-modal-box", style: { width: "min(880px,92%)", maxWidth: "92%", maxHeight: "86%" } },
                h(
                  "div",
                  { className: "wpe-modal-h" },
                  h("b", null, "框选截图"),
                  shot.rect ? h("span", { className: "wpe-msg" }, shot.rect.w + "×" + shot.rect.h) : null,
                  h("span", { style: { flex: 1 } }),
                  h("button", { className: "wpe-iconbtn", onClick: () => setShowShot(false) }, "✕"),
                ),
                h(
                  "div",
                  { style: { padding: 10, overflow: "auto" } },
                  h("img", { src: shot.dataUrl, style: { maxWidth: "100%", display: "block", margin: "0 auto", borderRadius: 8 } }),
                ),
              ),
            )
          : null,
        showLayers
          ? h(
              "div",
              { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) setShowLayers(false); } },
              h(
                "div",
                { className: "wpe-modal-box", style: { maxWidth: 560 } },
                h(
                  "div",
                  { className: "wpe-modal-h" },
                  h("b", null, "图层（卡片/面板级元素）"),
                  h("span", { style: { flex: 1 } }),
                  h("button", { className: "wpe-iconbtn", onClick: () => setShowLayers(false) }, "✕"),
                ),
                h(
                  "div",
                  { className: "wpe-modal-body", style: { padding: "8px 12px 14px", maxHeight: "58vh", overflow: "auto" } },
                  !layerData
                    ? h("div", { className: "wpe-msg" }, "扫描中…")
                    : layerData.length === 0
                      ? h("div", { className: "wpe-msg" }, "没找到卡片级元素")
                      : layerData.map((it) =>
                          h(
                            "div",
                            {
                              key: it.i,
                              onClick: () => { send("layer-select", { index: it.i }); },
                              style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12 },
                              onMouseEnter: (ev) => { ev.currentTarget.style.background = "#f1f5f9"; },
                              onMouseLeave: (ev) => { ev.currentTarget.style.background = "transparent"; },
                            },
                            h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.label),
                            h("span", { style: { color: "#94a3b8", fontSize: 11 } }, it.w + "×" + it.h + " @(" + it.x + "," + it.y + ")"),
                          ),
                        ),
                ),
              ),
            )
          : null,
        showHistorySteps
          ? h(
              "div",
              { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) setShowHistorySteps(false); } },
              h(
                "div",
                { className: "wpe-modal-box", style: { maxWidth: 520 } },
                h(
                  "div",
                  { className: "wpe-modal-h" },
                  h("b", null, "步骤历史" + (histData ? "（" + histData.ptr + 1 + "/" + histData.steps.length + "）" : "")),
                  h("span", { style: { flex: 1 } }),
                  h("button", { className: "wpe-iconbtn", onClick: () => setShowHistorySteps(false) }, "✕"),
                ),
                h(
                  "div",
                  { className: "wpe-modal-body", style: { padding: "8px 12px 14px", maxHeight: "60vh", overflow: "auto" } },
                  !histData
                    ? h("div", { className: "wpe-msg" }, "读取中…")
                    : histData.steps.length === 0
                      ? h("div", { className: "wpe-msg" }, "还没有步骤（改一笔就会记录）")
                      : histData.steps.slice().reverse().map((s) =>
                          h(
                            "div",
                            {
                              key: s.i,
                              onClick: () => send("history-jump", { index: s.i }),
                              style: {
                                display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, cursor: "pointer",
                                background: s.i === histData.ptr ? "#eef2ff" : "transparent",
                                border: s.i === histData.ptr ? "1px solid #c7d2fe" : "1px solid transparent",
                                fontSize: 12,
                              },
                            },
                            h("span", { style: { width: 46, color: "#64748b" } }, "#" + (s.i + 1)),
                            h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, s.label || "（无标签）"),
                            h("span", { style: { color: "#94a3b8", fontSize: 11 } }, s.keys + " 项"),
                            s.i === histData.ptr ? h("span", { style: { color: "#2f5cff", fontSize: 11 } }, "当前") : null,
                          ),
                        ),
                ),
              ),
            )
          : null,
        showHistory
          ? h(
              "div",
              { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) setShowHistory(false); } },
              h(
                "div",
                { className: "wpe-modal-box" },
                h(
                  "div",
                  { className: "wpe-modal-h" },
                  h("b", null, "历史版本（每次保存自动备份）"),
                  h("span", { style: { flex: 1 } }),
                  h("button", { className: "wpe-iconbtn", onClick: () => setShowHistory(false) }, "✕"),
                ),
                h(
                  "div",
                  { className: "wpe-modal-body" },
                  backups === null
                    ? h("div", { className: "wpe-msg" }, "读取中…")
                    : backups.length === 0
                      ? h("div", { className: "wpe-msg" }, "还没有备份（保存一次后就会出现）")
                      : backups.map((b) =>
                          h(
                            "div",
                            { className: "wpe-histrow", key: b.id },
                            h("span", { className: "t" }, b.at ? new Date(b.at).toLocaleString() : b.id),
                            h("span", { className: "f" }, (b.files || []).map((f) => f.file).join(", ")),
                            h("button", { className: "wpe-btn", onClick: () => restoreBackup(b) }, "恢复"),
                          ),
                        ),
                ),
              ),
            )
          : null,
      );
    }

    /* ────────────────────────── 停靠：占用 DSH 原生右栏（grid 第三列） ────────────────────────── */

    let dockFrame = null;
    let dockTimer = 0;
    let dockInterval = 0;

    /** 找 DSH 主框架：display:grid、三列、含 centerCol/rightbarCol 的那层 */
    function findFrame() {
      const nodes = document.querySelectorAll('[class*="_frame"], [class*="frame"]');
      for (const el of nodes) {
        if (el === document.body || el === document.documentElement) continue;
        const cs = getComputedStyle(el);
        if (!cs.display.includes("grid")) continue;
        const tracks = String(cs.gridTemplateColumns || "").trim().split(/\s+/);
        if (tracks.length < 3) continue;
        const cls = String(el.className || "");
        if (!/centerCol|rightbarCol|sidebarCol/i.test(cls) && el.children.length < 3) continue;
        return el;
      }
      return null;
    }

    function hasDockSheet() {
      return Boolean(document.getElementById("dsh-ui-editor-dock-css"));
    }

    function applyDock(reservePx) {
      window.clearTimeout(dockTimer);
      if (!(reservePx > 0)) { clearDock(); return; }
      if (!hasDockSheet()) {
        // CSS 已内置在插件样式里；这里只保证样式表存在（老版本升级兼容）
        const st = document.createElement("style");
        st.id = "dsh-ui-editor-dock-css";
        st.textContent = "[data-wpe-dock]{grid-template-columns:var(--wpe-sb-w,280px) minmax(0,1fr) var(--wpe-dock-w,820px)!important}";
        document.head.appendChild(st);
      }
      let frame = dockFrame && document.contains(dockFrame) ? dockFrame : findFrame();
      if (!frame) {
        dockTimer = window.setTimeout(() => applyDock(reservePx), 300);
        return;
      }
      dockFrame = frame;
      try {
        const cs = getComputedStyle(frame);
        const first = String(cs.gridTemplateColumns || "").trim().split(/\s+/)[0] || "280px";
        document.documentElement.style.setProperty("--wpe-sb-w", first);
      } catch { /* ignore */ }
      document.documentElement.style.setProperty("--wpe-dock-w", Math.round(reservePx) + "px");
      if (!frame.hasAttribute("data-wpe-dock")) frame.setAttribute("data-wpe-dock", "");
      // React 重渲染可能把 inline style 写回来，定时保住我们的列宽（很轻）
      if (!dockInterval) {
        dockInterval = window.setInterval(() => {
          if (!dockFrame || !document.contains(dockFrame)) { dockFrame = findFrame(); }
          if (dockFrame && !dockFrame.hasAttribute("data-wpe-dock")) dockFrame.setAttribute("data-wpe-dock", "");
        }, 1200);
      }
    }

    function clearDock() {
      window.clearTimeout(dockTimer);
      if (dockInterval) { window.clearInterval(dockInterval); dockInterval = 0; }
      if (dockFrame) {
        try { dockFrame.removeAttribute("data-wpe-dock"); } catch { /* ignore */ }
      }
      document.documentElement.style.removeProperty("--wpe-dock-w");
    }

    /* ────────────────────────── 抽屉 ────────────────────────── */    /* ────────────────────────── 抽屉 ────────────────────────── */

    function Drawer({ store }) {
      const snap = useStore(store);
      const [preview, setPreview] = useState(null);
      const [state, setState] = useState({ lastPath: "" });
      const [width, setWidth] = useState(() => {
        try {
          const v = Number(localStorage.getItem("dsh-ui-editor:width"));
          return v > 320 ? Math.min(v, Math.round(window.innerWidth * 0.92)) : 0;
        } catch { return 0; }
      });
      const [minimized, setMinimized] = useState(false);
      const [fullscreen, setFullscreen] = useState(false);

      // 停靠：编辑器占用 DSH 原生右栏（grid 第三列），对话区自动让位
      const vwNow = typeof window !== "undefined" ? window.innerWidth : 1400;
      const dockWidth = width ? Math.min(width, Math.round(vwNow * 0.92)) : Math.min(820, Math.round(vwNow * 0.54));
      useEffect(() => {
        const wantDock = !nativeMode && snap.open && !minimized && !fullscreen && window.innerWidth > 1000;
        if (!wantDock) { clearDock(); return undefined; }
        applyDock(dockWidth);
        return () => { clearDock(); };
      }, [snap.open, minimized, fullscreen, dockWidth]);

      // Agent 通过 web_editor_open 打开项目后：自动连上（5 分钟内的新会话才自动弹）
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await api("/session");
            const s = res && res.session;
            if (!alive || !s || !s.id || !s.url) return;
            if (!s.openedAt || Date.now() - s.openedAt > 5 * 60 * 1000) return;
            if (preview && preview.id === s.id) return;
            try {
              if (localStorage.getItem("dsh-ui-editor:dismissed") === s.id + ":" + s.openedAt) return;
            } catch { /* ignore */ }
            setPreview(s);
            store.set({ open: true });
          } catch { /* ignore */ }
        };
        tick();
        const timer = window.setInterval(tick, 2500);
        return () => { alive = false; window.clearInterval(timer); };
      }, [preview && preview.id]);

      if (nativeMode) return null;
      if (!snap.open) return null;

      const clampW = (w) => Math.max(360, Math.min(Math.round(w), Math.round(window.innerWidth * 0.92)));
      const applyWidth = (w) => {
        const c = clampW(w);
        setWidth(c);
        try { localStorage.setItem("dsh-ui-editor:width", String(c)); } catch { /* ignore */ }
      };
      const cycleWidth = () => {
        const vw = window.innerWidth;
        const options = [460, Math.round(vw * 0.55), Math.round(vw * 0.88)];
        const cur = width || (vw > 900 ? Math.min(820, vw * 0.54) : vw * 0.88);
        const next = options.find((o) => o > cur + 30) || options[0];
        applyWidth(next);
      };
      const onResizeDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const panel = e.currentTarget.parentElement;
        const startW = panel ? panel.getBoundingClientRect().width : 600;
        const move = (ev) => applyWidth(startW + (startX - ev.clientX));
        const up = () => {
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", up, true);
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
      };

      // 最小化：收成右下角一颗胶囊，不挡对话
      if (minimized) {
        return h(
          "button",
          { className: "wpe-pill", title: "恢复网页修改器", onClick: () => setMinimized(false) },
          h("span", { style: { fontSize: 13 } }, "✎"),
          h("span", null, "网页修改器"),
        );
      }

      return h(
        "div",
        { className: "wpe-drawer" + (fullscreen ? " fs" : ""), "data-wpe": "", style: fullscreen ? undefined : { width: dockWidth + "px" } },
        h("div", { className: "wpe-resizer", title: "拖动调整宽度", onPointerDown: onResizeDown }),

        h(
          "div",
          { className: "wpe-h" },
          h("b", null, "网页修改器"),
          h("span", { className: "wpe-badge" }, preview ? (preview.mode === "vite" ? "实时预览" : "静态预览") : "选文件夹"),
          h("span", { className: "wpe-sp" }),
          h(
            "div",
            { className: "wpe-hbtns" },
            h("button", { className: "wpe-iconbtn", title: "切换宽度（窄 / 半屏 / 全屏）", onClick: cycleWidth }, "⇔"),
            h("button", { className: "wpe-iconbtn", title: fullscreen ? "退出全屏" : "全屏编辑（只留底部悬浮条）", onClick: () => setFullscreen((v) => !v) }, fullscreen ? "⤡" : "⛶"),
            h("button", { className: "wpe-iconbtn", title: "最小化到底部悬浮条", onClick: () => setMinimized(true) }, "—"),
            h("button", { className: "wpe-iconbtn", title: "关闭（Esc）", onClick: () => store.set({ open: false }) }, "✕"),
          ),
        ),
        h(
          "div",
          { className: "wpe-body" },
          preview
            ? h(UeErrorBoundary, null, h(PreviewPane, { key: preview.id + "|" + String(preview.page || preview.entryPath || ""), preview, fullscreen, onPageChange: (info) => setPreview(info), onClose: () => setPreview(null) }))
            : h(FolderPicker, { state, setState, onOpened: (info) => { try { saveLastActive(info.dir, info.page); } catch (e) { /* ignore */ } setPreview(info); } }),
        ),
      );
    }

    function Trigger(props) {
      const snap = useStore(props.store);
      const wide = props.wide !== false;
      // standalone = 抽屉已经由 react-dom 独立挂到 body（首选）；
      // 否则退回「渲染在按钮组件树里」，这样即使 react-dom 不可用也能弹出。
      const inlineDrawer = snap.open && !snap.standalone ? h(Drawer, { store: props.store }) : null;
      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            type: "button",
            className: "wpe-trigger" + (snap.open ? " on" : ""),
            title: "网页修改器：选一个源码文件夹，在右侧实时改网页",
            onClick: () => {
              try {
                if (nativeMode && nativeNav && typeof nativeNav.openTab === "function") {
                  try { nativeNav.openTab("web-editor", { revealIfOpened: false }); return; } catch (e) { console.warn("[dsh-ui-editor] 打开右栏 tab 失败", e); }
                }
                props.store.set({ open: !snap.open });
              } catch (e) {
                console.error("[dsh-ui-editor] 点击处理失败", e);
              }
            },
          },
          h("span", { style: { fontSize: 14, lineHeight: 1 } }, "✎"),
          wide ? h("span", null, "网页") : null,
        ),
        inlineDrawer,
      );
    }

    /* ────────────────────────── 插件入口 ────────────────────────── */

    /** 尽力拿到 createRoot：正式版和检出目录的 react/react-dom 版本可能不同 */
    function resolveCreateRoot() {
      const pick = (mod) => (mod && (mod.createRoot || (mod.default && mod.default.createRoot))) || null;
      const tries = [];
      try { tries.push(["react-dom/client", require("react-dom/client")]); } catch (e) { tries.push(["react-dom/client", null]); }
      try { tries.push(["react-dom", require("react-dom")]); } catch (e) { tries.push(["react-dom", null]); }
      for (const [spec, mod] of tries) {
        const fn = pick(mod);
        if (typeof fn === "function") return { createRoot: fn, spec };
      }
      return null;
    }

    /* ────────────── 原生右栏 tab（新版 DSH：和「工作区文件 / 终端 / 浏览器」同一套插槽） ────────────── */

    let nativeMode = false;
    let nativeNav = null;
    let nativeSessionTimer = 0;

    function EditorTabTitle() {
      return "网页修改器";
    }

    /** 关闭工作台：把主面板切回「对话」。
     *  DSH 的布局服务语义是 layout.selectPanel(null) === 回到对话（sidebar/插件管理器也都用它）；
     *  旧实现盲目试了一串不存在的方法，最后靠 DOM 点任意含「对话/返回」的按钮，
     *  容易点到「新建对话」或触发整页刷新，造成「返回对话」跳转异常。 */
    function closeWorkbench() {
      const tried = [];
      // 用户明确要离开：取消「启动自动进工作台」还没执行的延时，否则 1.6/3.6/7 秒后可能又被拉回来
      try {
        autoWbCancelled = true;
        for (const t of autoWbTimers) clearTimeout(t);
        autoWbTimers = [];
      } catch { /* ignore */ }
      try {
        const lay = dshLayoutService();
        if (lay && typeof lay.selectPanel === "function") {
          lay.selectPanel(null);
          tried.push("layout.selectPanel(null)");
        }
      } catch (e) { /* ignore */ }
      // 极老版本 DSH 没有 layout 服务时，用工作区服务退一步（它内部也会关主面板）
      if (!tried.length) {
        try {
          const uw = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("uiWorkspace") : null;
          if (uw && typeof uw.clearMain === "function") {
            uw.clearMain();
            tried.push("uiWorkspace.clearMain");
          }
        } catch { /* ignore */ }
      }
      console.info("[dsh-ui-editor] 关闭工作台（返回对话）尝试：", tried);
      return tried;
    }

    /** 打开网页工作台（main 面板）：优先用布局服务选中面板（和左侧栏点击同一入口），其次模拟点击 */
    function openWorkbenchPanel() {
      const tried = [];
      try {
        const lay = dshLayoutService();
        if (lay && typeof lay.selectPanel === "function") {
          lay.selectPanel("web-editor-workbench");
          tried.push('layout.selectPanel("web-editor-workbench")');
        }
      } catch (e) { /* ignore */ }
      if (!tried.length) {
        try {
          const nodes = [...document.querySelectorAll("button,[role='button'],[title],[aria-label]")];
          const norm = (el) => String((el.getAttribute && (el.getAttribute("title") || el.getAttribute("aria-label"))) || el.textContent || "");
          const hit = nodes.find((el) => /网页工作台/.test(norm(el)) && el.getBoundingClientRect().width > 0);
          if (hit) { hit.click(); tried.push("dom:click"); }
        } catch (e) { /* ignore */ }
      }
      console.info("[dsh-ui-editor] 打开工作台尝试：", tried);
      return tried;
    }

    /** 工作台侧栏图标 */
    function WorkbenchIcon(props) {
      const s = (props && props.size) || 18;
      return h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" },
        h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h("path", { d: "M3 9h18" }),
        h("path", { d: "M8 9v11" }),
        h("path", { d: "M12 13h5M12 16h3" }));
    }

    /** 工作台（主区域整页）：预览 + 右侧 AI 对话 + 项目操作 */
    /** 工作台（主区域）：仪表盘 = 大编辑入口 + 项目管理 + 主题 */
    /** 工作台（主区域）：首页仪表盘 = 大标题 + 打开项目 + 三个能力 + 最近项目缩略图 */
    /** 工作台：iframe 加载独立前端（workbench-ui），并通过 postMessage 桥接宿主能力 */
    function WorkbenchPane() {
      const [theme, setTheme] = React.useState(() => { try { return localStorage.getItem("dsh-ui-editor:wbTheme") || "paper"; } catch { return "paper"; } });
      const [src, setSrc] = React.useState("");
      const [msg, setMsg] = React.useState("加载工作台中…");
      const frameRef = React.useRef(null);

      const postToFrame = (payload) => {
        try { if (frameRef.current && frameRef.current.contentWindow) frameRef.current.contentWindow.postMessage(payload, '*'); } catch (e) { /* ignore */ }
      };
      const snapshot = async () => {
        try {
          const [p, st, stylesRes, base] = await Promise.all([
            api('/projects'),
            api('/state'),
            api('/styles').catch(() => ({ styles: [] })),
            detectApiBase().catch(() => null),
          ]);
          const projects = (p && Array.isArray(p.projects)) ? p.projects : [];
          let info = (st && st.ok) ? st : null;
          if (info && !info.url) {
            const hit = projects.find((x) => x && x.dir === info.dir);
            if (hit && hit.url) info = Object.assign({}, info, { url: hit.url });
          }
          return {
            projects: projects,
            info: info,
            styles: (stylesRes && Array.isArray(stylesRes.styles)) ? stylesRes.styles : [],
            apiBase: base === null ? '' : String(base),
            theme: theme,
          };
        } catch (e) {
          return { projects: [], info: null, styles: [], apiBase: '', theme: theme, error: String((e && e.message) || e) };
        }
      };

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const base = await detectApiBase();
            if (!alive) return;
            if (base === null) { setMsg('连不上宿主接口，工作台无法加载'); return; }
            setSrc(String(base).replace(/\/+$/, '') + '/ve/wb/index.html?embedded=1&v=110');
            setMsg('');
          } catch (e) {
            if (alive) setMsg('工作台加载失败：' + String((e && e.message) || e));
          }
        })();
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        const onMsg = async (e) => {
          const d = e.data;
          if (!d || d.source !== 've-wb') return;
          if (d.type === 'ready') {
            postToFrame({ source: 've-host', type: 'init', data: await snapshot() });
            return;
          }
          if (d.type === 'theme') {
            const th = d.data === 'ink' ? 'ink' : 'paper';
            setTheme(th);
            try { localStorage.setItem('dsh-ui-editor:wbTheme', th); } catch (err) { /* ignore */ }
            return;
          }
          if (d.type === 'call') {
            const id = d.id;
            const method = d.method;
            const args = d.args || {};
            try {
              let data = null;
              if (method === 'projects.list') data = await snapshot();
              else if (method === 'project.open') data = await api('/open', { method: 'POST', body: JSON.stringify({ dir: args.dir, page: args.page || "", source: 'workbench' }) });
              else if (method === 'pages.list') data = await api('/pages?dir=' + encodeURIComponent(args.dir || ''));
              else if (method === 'pages.nav') data = await api('/page-nav', { method: 'POST', body: JSON.stringify({ dir: args.dir }) });
              else if (method === 'project.close') data = await api('/close', { method: 'POST', body: JSON.stringify({ id: args.id }) });
              else if (method === 'browse') { const r = await api('/browse?path=' + encodeURIComponent((args && args.path) || '')); data = Object.assign({ ok: true }, r); }
              else if (method === 'defaultDir') data = await api('/default-dir');
              else if (method === 'workbench.popup') {
                try {
                  const base = await detectApiBase();
                  if (base !== null) {
                    const q = '?api=' + encodeURIComponent(String(base)) + '&standalone=1'
                      + (args && args.dir ? '&dir=' + encodeURIComponent(String(args.dir)) : '')
                      + (args && args.page ? '&page=' + encodeURIComponent(String(args.page)) : '');
                    window.open(String(base).replace(/\/+$/, '') + '/ve/wb/index.html' + q, 've-workbench', 'width=1440,height=920');
                    data = { ok: true };
                  } else data = { ok: false };
                } catch (e) { data = { ok: false, error: String((e && e.message) || e) }; }
              }
              else if (method === 'styles.list') data = await api('/styles');
              else if (method === 'styles.add') data = await api('/styles/add', { method: 'POST', body: JSON.stringify({ path: args.path, name: args.name }) });
              else if (method === 'styles.remove') data = await api('/styles/remove', { method: 'POST', body: JSON.stringify({ id: args.id }) });
              else if (method === 'styles.apply') data = await api('/styles/apply', { method: 'POST', body: JSON.stringify({ id: args.id, dir: args.dir }) });
              else if (method === 'style.extract') data = await api('/style/extract', { method: 'POST', body: JSON.stringify({ path: args.path }) });
              else if (method === 'style.save') data = await api('/style/save', { method: 'POST', body: JSON.stringify({ dir: args.dir, path: args.path }) });
              else if (method === 'agent.prompt') {
                const text = String(args.text || '');
                let sent = null;
                try { sent = await deliverToChat(text); } catch (e) { sent = { ok: false, reason: String((e && e.message) || e) }; }
                if (!sent || sent.ok === false) {
                  try {
                    const r = await api('/handoff', { method: 'POST', body: JSON.stringify({ text: text }) });
                    if (r && r.ok !== false) sent = r;
                    else sent = { ok: false, reason: String((r && (r.reason || r.error)) || 'handoff-failed') };
                  } catch (e) {
                    sent = sent || { ok: false, reason: String((e && e.message) || e) };
                  }
                }
                data = sent;
              }
              else if (method === 'workbench.close') {
                const r = closeWorkbench();
                if (r && r.length) {
                  postToFrame({ source: 've-host', type: 'result', id: id, ok: true, data: { ok: true } });
                } else {
                  // 不再刷新整个渲染进程（会闪一下并丢状态），只提示
                  try { setMsg('没能自动切回对话：请点左侧栏的「对话」入口'); } catch (err) { /* ignore */ }
                  postToFrame({ source: 've-host', type: 'result', id: id, ok: false, error: 'close-failed' });
                }
                return;
              }
              postToFrame({ source: 've-host', type: 'result', id: id, ok: true, data: data });
            } catch (err) {
              postToFrame({ source: 've-host', type: 'result', id: id, ok: false, error: String((err && err.message) || err) });
            }
          }
        };
        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
      }, [theme]);

      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          try { e.preventDefault(); } catch { /* ignore */ }
          const r = closeWorkbench();
          if (!r || !r.length) {
            try { setMsg('没能自动切回对话：请点左侧栏的「对话」入口'); } catch { /* ignore */ }
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, []);

      return h('div', { className: 'wb-root wb-theme-' + theme },
        src
          ? h('iframe', {
              ref: frameRef,
              className: 'wb-frame',
              src: src,
              title: '网页工作台',
              allow: 'fullscreen',
              onLoad: async () => { postToFrame({ source: 've-host', type: 'init', data: await snapshot() }); },
            })
          : h('div', { className: 'wb-loading' }, msg || '加载中…'),
      );
    }

    /** 注册工作台：侧栏图标 + main 面板 */
    function tryRegisterWorkbench(ctx) {
      if (typeof ctx.inject !== "function") return;
      try {
        ctx.inject(["slots"], (scope) => {
          try {
            if (!scope || !scope.slots || typeof scope.slots.inject !== "function") return;
            scope.slots.inject("sidebar.panellist", () =>
              scope.slots.register({ name: "sidebar.panellist", id: "web-editor-workbench", order: 7, label: () => "网页工作台" }, WorkbenchIcon));
            scope.slots.inject("main", () =>
              scope.slots.register({ name: "main", key: "web-editor-workbench" }, WorkbenchPane));
            console.info("[dsh-ui-editor] 工作台已注册（左侧图标：网页工作台）");
          } catch (e) {
            console.warn("[dsh-ui-editor] 工作台侧栏注册失败（不影响右栏编辑器）", e);
          }
        });
      } catch (e) {
        console.warn("[dsh-ui-editor] ctx.inject 不可用，跳过工作台", e);
      }
    }

    /** 快捷键帮助 */
    function HelpBox({ onClose }) {
      const rows = [
        ["单击元素", "选中元素（命中优先，不弹面板）"],
        ["Ctrl + 单击", "选中并打开属性面板"],
        ["Shift + 单击", "选父级容器（可连按往外走）"],
        ["Ctrl + Shift + 单击", "多选 / 移出多选（用于对齐）"],
        ["双击文字", "就地编辑文字"],
        ["双击容器", "进入组（组内单击选内部元素）"],
        ["Esc", "退出组 / 取消框选"],
        ["Ctrl + Z", "撤销（焦点在聊天框时也能用）"],
        ["Ctrl + Shift + Z / Ctrl + Y", "重做"],
        ["Ctrl + S", "保存"],
        ["Ctrl + Enter", "显示/隐藏 AI 改稿条"],
        ["小键盘 + / −", "文字调字号；其它元素调宽高"],
        ["Ctrl + ← / →", "文字字距"],
        ["Ctrl + ↑ / ↓", "文字行距"],
        ["方向键（选中后）", "微移元素（按网格吸附）"],
        ["Ctrl + C / Ctrl + V", "复制元素 / 粘贴副本（偏移 14px，可拖动、可保存）"],
        ["Ctrl + Shift + C / Ctrl + Shift + V", "复制样式 / 粘贴样式（多选时批量应用）"],
        ["Del", "删除选中元素"],
        ["B", "收起 / 展开左侧组件栏"],
      ];
      return h(
        "div",
        { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) onClose(); } },
        h("div", { className: "wpe-modal-box", style: { maxWidth: 560 } },
          h("div", { className: "wpe-modal-h" },
            h("b", null, "快捷键与操作"),
            h("span", { style: { flex: 1 } }),
            h("button", { className: "wpe-iconbtn", onClick: onClose }, "✕"),
          ),
          h("div", { className: "wpe-modal-body", style: { maxHeight: "62vh", overflow: "auto" } },
            h("div", { className: "wpe-help" },
              rows.map((r) => h("div", { className: "r", key: r[0] }, h("kbd", null, r[0]), h("span", { className: "desc" }, r[1]))),
            ),
          ),
        ),
      );
    }

    /** 新建页面弹窗（居中的正经弹窗，不是菜单里的小行） */
    function NewPageBox({ dir, onClose, onCreate }) {
      const [name, setName] = useState("");
      const [template, setTemplate] = useState("blank");
      const [backLink, setBackLink] = useState(true);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const inputRef = useRef(null);
      useEffect(() => { try { if (inputRef.current) inputRef.current.focus(); } catch { /* ignore */ } }, []);
      const submit = async () => {
        const n = String(name || "").trim();
        if (!n) { setErr("请输入页面文件名，如「关于.html」"); return; }
        setBusy(true);
        setErr("");
        try {
          const r = await onCreate({ name: n, template, backLink });
          if (r && r.ok) onClose();
          else setErr(String((r && r.error) || "创建失败"));
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };
      return h("div", { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget && !busy) onClose(); } },
        h("div", { className: "wpe-modal-box", style: { maxWidth: 440 } },
          h("div", { className: "wpe-modal-h" },
            h("b", null, "新建页面"),
            h("span", { style: { flex: 1 } }),
            h("button", { className: "wpe-iconbtn", onClick: onClose, disabled: busy }, "✕")),
          h("div", { className: "wpe-modal-body", style: { padding: "16px 18px 18px" } },
            h("div", { style: { fontSize: 12, color: "#475569", marginBottom: 6 } }, "页面文件名（支持中文，可带子目录）"),
            h("input", {
              ref: inputRef,
              value: name,
              spellCheck: false,
              placeholder: "例如：关于.html 或 blog/post.html",
              onChange: (e) => { setName(e.target.value); if (err) setErr(""); },
              onKeyDown: (e) => { if (e.key === "Enter") submit(); },
              style: { width: "100%", height: 38, border: "1px solid #dfe3ea", borderRadius: 8, padding: "0 12px", fontSize: 13.5, boxSizing: "border-box" },
            }),
            h("div", { style: { display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap", fontSize: 12.5, color: "#334155" } },
              h("select", {
                value: template,
                onChange: (e) => setTemplate(e.target.value),
                style: { height: 32, border: "1px solid #dfe3ea", borderRadius: 8, padding: "0 10px", fontSize: 12.5, background: "#fff" },
              },
                h("option", { value: "blank" }, "空白页（保留站点样式）"),
                h("option", { value: "copy" }, "复制当前页")),
              h("label", { style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", whiteSpace: "nowrap" } },
                h("input", { type: "checkbox", checked: backLink, onChange: (e) => setBackLink(e.target.checked) }),
                "加「返回首页」链接")),
            err ? h("div", { style: { marginTop: 10, fontSize: 12, color: "#c0392b", lineHeight: 1.6, background: "#fff5f5", border: "1px solid #f3c0c0", borderRadius: 8, padding: "8px 10px" } }, err) : null,
            h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 } },
              h("button", { className: "wpe-btn", style: { height: 32, padding: "0 16px" }, onClick: onClose, disabled: busy }, "取消"),
              h("button", { className: "wpe-btn pri", style: { height: 32, padding: "0 18px" }, onClick: submit, disabled: busy }, busy ? "创建中…" : "创建")))));
    }

    /** 版本 / 更新日志弹窗 */
function VersionBox({ onClose }) {
  const [host, setHost] = useState("");
  const [diag, setDiag] = useState("");
  useEffect(() => {
    api("/ping").then((r) => { if (r && r.version) setHost(String(r.version)); }).catch(() => {});
  }, []);
  useEffect(() => {
    // 圆角诊断：把按钮真实 computed 样式打出来，方便排查「版本对了但样式没生效」
    try {
      const btn = document.querySelector(".wpe-tools .wpe-btn") || document.querySelector(".wpe-btn");
      const cs = btn ? window.getComputedStyle(btn) : null;
      const tags = Array.prototype.slice.call(document.querySelectorAll('style[data-plugin-css="web-page-editor"]'));
      const css = tags[0] ? tags[0].textContent || "" : "";
      const r = cs ? cs.borderRadius : "没找到按钮";
      const inline = btn ? btn.getAttribute("style") : null;
      setDiag([
        "按钮圆角：" + r + "　高度：" + (cs ? cs.height : "-"),
        "按钮内联样式：" + (inline || "无"),
        "样式表：" + tags.length + " 张 · 含兜底规则：" + (css.indexOf("999px !important") >= 0 ? "是" : "否") + " · " + (css ? Math.round(css.length / 1024) + "KB" : "空"),
        "样式表总数：" + document.styleSheets.length + " · 屏缩放：" + (window.devicePixelRatio || 1) + "x · 页面缩放：" + ((window.visualViewport && window.visualViewport.scale) || 1),
      ].join(String.fromCharCode(10)));
    } catch (e) { setDiag("诊断失败：" + String((e && e.message) || e)); }
  }, []);
  return h(
    "div",
    { className: "wpe-modal", onClick: (ev) => { if (ev.target === ev.currentTarget) onClose(); } },
    h(
      "div",
      { className: "wpe-modal-box", style: { maxWidth: 560 } },
      h(
        "div",
        { className: "wpe-modal-h" },
        h("b", null, "插件版本 v" + PLUGIN_VERSION),
        h("span", { style: { flex: 1 } }),
        h("button", { className: "wpe-iconbtn", onClick: onClose }, "✕"),
      ),
      h(
        "div",
        { className: "wpe-modal-body", style: { padding: "10px 16px 16px" } },
        h("div", { style: { fontSize: 12.5, color: "#475569", marginBottom: 8 } },
          "宿主版本：" + (host || "读取中…") + "　（改动需重启 DSH 后才生效）"),
        h("div", { style: { fontSize: 12.5, color: "#334155", marginBottom: 8 } },
          "旧进程/旧标签会保留旧版本；如果发现功能回退，请先确认已重启 DSH。"),
        h("div", { style: { fontSize: 11.5, lineHeight: 1.8, color: "#334155", whiteSpace: "pre-wrap", background: "#f8fafc", border: "1px solid #e8ecf3", borderRadius: 10, padding: "8px 12px", marginBottom: 8, fontFamily: "ui-monospace,Consolas,monospace" } },
          diag || "诊断中…"),
        h("div", { style: { fontSize: 12, lineHeight: 1.9, color: "#334155", whiteSpace: "pre-wrap", background: "#f8fafc", border: "1px solid #e8ecf3", borderRadius: 10, padding: "10px 12px" } },
          PLUGIN_NOTES.join(String.fromCharCode(10))),
      ),
    ),
  );
}

/** 宽屏/窄屏默认参数设置 */
function WideParamsBox({ onClose }) {
  const [p, setP] = useState(ueWideParams());
  const [saved, setSaved] = useState(false);
  const field = (label, key, min, max, hint) =>
    h(
      "label",
      { style: { display: "flex", alignItems: "center", gap: 8, margin: "10px 0", fontSize: 12.5 } },
      h("span", { style: { width: 150, color: "#475569" } }, label),
      h("input", {
        type: "number",
        min,
        max,
        value: p[key],
        onChange: (e) => setP({ ...p, [key]: Number(e.target.value) }),
        style: { width: 110, padding: "5px 8px", border: "1px solid #d8dbe6", borderRadius: 8, fontSize: 12.5 },
      }),
      h("span", { style: { color: "#94a3b8", fontSize: 11.5 } }, hint || ""),
    );
  return h(
    "div",
    {
      className: "wpe-modal",
      onClick: (ev) => { if (ev.target === ev.currentTarget) onClose(); },
    },
    h(
      "div",
      { className: "wpe-modal-box", style: { maxWidth: 520 } },
      h(
        "div",
        { className: "wpe-modal-h" },
        h("b", null, "宽屏 / 窄屏默认参数"),
        h("span", { style: { flex: 1 } }),
        h("button", { className: "wpe-iconbtn", onClick: onClose }, "✕"),
      ),
      h(
        "div",
        { className: "wpe-modal-body", style: { padding: "6px 16px 14px" } },
        field("宽屏：左侧预留(px)", "wideReserve", 240, 900, "数值越小，宽屏时编辑器越宽"),
        field("窄屏：宽度比例(%)", "narrowRatio", 12, 60, "占窗口宽度的百分比"),
        field("窄屏：宽度上限(px)", "narrowMax", 320, 1400, "超过则按该值封顶"),
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 14, alignItems: "center" } },
          h("button", {
            className: "wpe-btn pri",
            onClick: () => { saveUeWideParams(p); setSaved(true); },
          }, "保存并应用"),
          h("button", { className: "wpe-btn", onClick: () => { setP(ueWideParams()); setSaved(false); } }, "重置"),
          saved ? h("span", { style: { color: "#16a34a", fontSize: 12 } }, "已保存") : null,
        ),
      ),
    ),
  );
}

function EditorTabView({ tab, initialDir }) {
      const rootRef = useRef(null);
      useEffect(() => {
        // 适配 DSH 右栏：普通/分屏/全屏下都按父容器真实高度铺满，避免"全屏后比例不对"
        const el = rootRef.current;
        if (!el) return undefined;
        const fit = () => {
          try {
            const parent = el.parentElement;
            const h = parent ? parent.clientHeight : 0;
            el.style.height = (h > 0 ? h : window.innerHeight) + "px";
            el.style.width = "100%";
          } catch { /* ignore */ }
        };
        fit();
        let ro = null;
        try { ro = new ResizeObserver(fit); if (el.parentElement) ro.observe(el.parentElement); } catch { /* ignore */ }
        window.addEventListener("resize", fit);
        const timer = setTimeout(fit, 60);
        return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", fit); clearTimeout(timer); };
      }, []); /* __wpeFitDone */
      const [preview, setPreview] = useState(null);
      const [showPicker, setShowPicker] = useState(false);
      const [state, setState] = useState({
        lastPath: (() => {
          try {
            // 新 tab 默认落在「项目所在文件夹」，方便选旁边另一个项目或新建/切换目录
            if (initialDir) return parentDir(initialDir) || initialDir;
            const last = localStorage.getItem(lastDirKey()) || "";
            return last ? (parentDir(last) || last) : "";
          } catch { return ""; }
        })(),
      });
      const [showWideCfg, setShowWideCfg] = useState(false);
      const [showVersion, setShowVersion] = useState(false);
      const picker = showPicker || !preview;
      // 启动时自动恢复"本窗口上次的项目"（只第一个 tab 触发；失败就回选择器）
      useEffect(() => {
        try {
          if (initialDir || window.__ueAutoOpenTried) return;
          window.__ueAutoOpenTried = true;
          if (localStorage.getItem("dsh-ui-editor:autoOpen") !== "1") return; // 默认关闭自动打开
          const dir = recallWindowDir();
          if (!dir) return;
          api("/open", { method: "POST", body: JSON.stringify({ dir, source: "ui" }) })
            .then((info) => {
              if (info && info.ok !== false && info.dir) {
                setPreview(info);
                setShowPicker(false);
              }
            })
            .catch(() => { /* 目录不存在等情况：保持选择器 */ });
        } catch { /* ignore */ }
      }, []);

      const toggleFullscreen = () => {
        // 右栏 service 就是 controller：公开用法 toggleFullscreen(commandTarget())
        try {
          if (nativeNav && typeof nativeNav.toggleFullscreen === "function") {
            const target = typeof nativeNav.commandTarget === "function" ? nativeNav.commandTarget() : null;
            if (target) { nativeNav.toggleFullscreen(target); return; }
            if (typeof nativeNav.isExpanded === "function" && !nativeNav.isExpanded() && typeof nativeNav.toggleExpanded === "function") {
              nativeNav.toggleExpanded();
              return;
            }
            try { nativeNav.toggleFullscreen(); } catch { /* 需要参数时忽略 */ }
            return;
          }
        } catch (e) { console.warn("[dsh-ui-editor] 全屏切换失败", e); }
        try { if (nativeNav && typeof nativeNav.toggleExpanded === "function") nativeNav.toggleExpanded(); } catch { /* ignore */ }
      };

      const openByDir = async (dir) => {
        try {
          const info = await api("/open", { method: "POST", body: JSON.stringify({ dir, source: "ui" }) });
          try { localStorage.setItem(lastDirKey(), dir); localStorage.setItem(lastDirGlobalKey(), dir); } catch { /* ignore */ }
          try { if (tab && tab.id) localStorage.setItem(tabDirKey(tab.id), dir); } catch { /* ignore */ }
          setPreview(info);
          setShowPicker(false);
          try { saveLastActive(info.dir, info.page); } catch { /* ignore */ }
        } catch (e) {
          console.warn("[dsh-ui-editor] 打开目录失败", e);
        }
      };

      // 打开时自动接着上次的项目；同时响应 Agent 新打开的项目
      useEffect(() => {
        let alive = true;
        (async () => {
          // 每个 tab 恢复自己上次打开的项目（互不影响）；只有本窗口第一个 tab 才回退到"上次项目"
          let allowAuto = false;
          try {
            if (!sessionStorage.getItem("dsh-ui-editor:autoOpened")) {
              sessionStorage.setItem("dsh-ui-editor:autoOpened", "1");
              allowAuto = true;
            }
          } catch { allowAuto = true; }
          let last = initialDir || "";
          try {
            if (!last && tab && tab.id) last = localStorage.getItem(tabDirKey(tab.id)) || "";
            if (!last && allowAuto) { const la = recallLastActive(); if (la && la.dir) last = la.dir; }
            if (!last && allowAuto) last = localStorage.getItem(lastDirKey()) || "";
            if (!last && allowAuto) last = localStorage.getItem(lastDirGlobalKey()) || "";
          } catch { /* ignore */ }
          if (last) {
            try {
              const info = await api("/open", { method: "POST", body: JSON.stringify({ dir: last, source: "ui" }) });
              if (alive) {
                setPreview(info);
                try { saveLastActive(info.dir, info.page); } catch { /* ignore */ }
              }
            } catch { /* 上次项目打不开就留在文件夹选择 */ }
          }
        })();
        // 不再跟随全局「最后打开的项目」：否则一个 tab 换项目会把所有 tab 带跑。
        // Agent 打开新项目由 startNativeSessionWatch 负责（会另开新 tab）。
        return () => { alive = false; };
      }, []);

      return h(
        "div",
        { ref: rootRef, className: "wpe-tabview" },
        h(
          "div",
          { className: "wpe-tabbar" },
          h("b", { style: { fontSize: 12.5 } }, "网页修改器"),
          preview ? h("span", { className: "wpe-badge" }, preview.mode === "vite" ? "实时预览" : "静态预览") : h("span", { className: "wpe-badge" }, "选文件夹"),
          h("span", { style: { flex: 1 } }),
          /* @dev-start 测试工具：发布时移除 */
          h("button", {
            className: "wpe-btn" + (CHAT_FLOAT.on ? " on" : ""),
            title: "把对话区（消息+输入框）整块浮到编辑器底部：半透明、hover 变实",
            onClick: () => { toggleChatFloat(); },
          }, "浮动对话（测试）"),
          h("button", {
            className: "wpe-btn",
            title: "宽屏/窄屏默认参数",
            onClick: () => setShowWideCfg(true),
          }, "参数"),
          h("button", {
            className: "wpe-btn" + (UE_REC.on ? " on" : ""),
            title: "记录：点开始后手动拖动分隔条，再点结束，把前后参数变化传回宿主",
            onClick: () => { if (UE_REC.on) ueRecStop(); else ueRecStart(); setState((s) => ({ ...s })); },
          }, UE_REC.on ? "结束记录" : "记录拖动"),
          /* @dev-end */
          h("button", {
            className: "wpe-btn" + (sidebarWideOn() ? " on" : ""),
            title: "宽屏 / 窄屏：把右侧面板拉宽到接近全屏，同时保留左侧对话可以打字（不进原生全屏）",
            onClick: () => { toggleSidebarWide(); setState((s) => ({ ...s })); },
          }, sidebarWideOn() ? "窄屏" : "宽屏"),
          preview ? h("button", {
            className: "wpe-btn",
            title: "独立页面：在新窗口打开当前页面（不带 DSH 侧边栏）",
            onClick: () => {
              try {
                const u = preview.url + (preview.url.indexOf("?") >= 0 ? "&" : "?") + "ve_win=1&ve_tb=top";
                window.open(u, "_blank");
              } catch { /* ignore */ }
            },
          }, "独立页面") : null,
          picker ? null : h("button", {
            className: "wpe-btn",
            title: "换一个项目目录（默认从当前项目所在的文件夹开始）",
            onClick: () => {
              try {
                const cur = preview && preview.dir ? preview.dir : "";
                const last = cur || localStorage.getItem(lastDirKey()) || "";
                setState({ lastPath: last ? (parentDir(last) || last) : "" });
              } catch { /* ignore */ }
              setShowPicker(true);
            },
          }, "目录"),
          /* 原生全屏按钮已移除（宽屏/窄屏已覆盖该需求） */
        ),
        showWideCfg ? h(WideParamsBox, { onClose: () => setShowWideCfg(false) }) : null,
        showVersion ? h(VersionBox, { onClose: () => setShowVersion(false) }) : null,
        picker
          ? h(
              "div",
              { className: "wpe-tab-picker" },
              h(FolderPicker, {
                state,
                setState,
                onOpened: (info) => {
                  try { localStorage.setItem(lastDirKey(), info.dir || ""); } catch { /* ignore */ }
                  try { rememberWindowDir(info.dir || ""); } catch { /* ignore */ }
                  try { saveLastActive(info.dir, info.page); } catch { /* ignore */ }
                  setPreview(info);
                  setShowPicker(false);
                },
              }),
            )
          : h(PreviewPane, {
              key: preview.id,
              preview,
              onPageChange: (info) => setPreview(info),
              fullscreen: false,
              onClose: () => {
            try {
              const last = localStorage.getItem(lastDirKey()) || "";
              setState({ lastPath: last ? (parentDir(last) || last) : "" });
            } catch { /* ignore */ }
            try { if (tab && tab.id) localStorage.removeItem(tabDirKey(tab.id)); } catch { /* ignore */ }
            setPreview(null);
            setShowPicker(true);
          },
            }),
      );
    }

    function EditorTabBody(props) {
      let tab = null;
      try {
        const info = typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
        tab = info && info.tab ? info.tab : null;
      } catch { /* ignore */ }
      let initialDir = "";
      try {
        const params = tab && tab.navigation && tab.navigation.params;
        initialDir = (params && params.dir) || "";
      } catch { /* ignore */ }
      return h(UeErrorBoundary, null, h(EditorTabView, { tab, initialDir }));
    }

    /** 新版 DSH：注册成右栏原生 tab（失败就保持旧悬浮抽屉） */
    function tryRegisterNative(ctx) {
      if (typeof ctx.inject !== "function") return;
      try {
        ctx.inject(["sidebarRightTabs", "sidebarRight"], (scope) => {
          try {
            const tabs = (typeof scope.get === "function" ? scope.get("sidebarRightTabs") : null) || scope.sidebarRightTabs;
            const nav = (typeof scope.get === "function" ? scope.get("sidebarRight") : null) || scope.sidebarRight;
            if (!tabs || typeof tabs.register !== "function" || !scope.slots) {
              console.warn("[dsh-ui-editor] 右栏服务不可用，保持悬浮抽屉模式");
              return;
            }
            nativeNav = nav;
            scope.effect(() => tabs.register({
              id: "web-editor",
              kind: "web-editor",
              multiple: true,
              keepMounted: true,
              title: () => "网页修改器",
              guide: [{
                id: "open",
                order: 40,
                title: () => "网页修改器",
                description: () => "在右栏里微调本地网页项目（文字 / 图片 / 样式 / AI）",
              }],
            }), "dsh-ui-editor: 右栏 tab 类型");
            scope.effect(() => scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({
              name: "sidebar.right.pane.tab",
              key: "web-editor",
              inject: () => ({}),
            }, EditorTabBody)), "dsh-ui-editor: 右栏 tab 内容");
            scope.effect(() => scope.slots.inject("sidebar.right.pane.tab.title", () => scope.slots.register({
              name: "sidebar.right.pane.tab.title",
              key: "web-editor",
            }, EditorTabTitle)), "dsh-ui-editor: 右栏 tab 标题");
            nativeMode = true;
            clearDock();
            console.info("[dsh-ui-editor] 已注册原生右栏 tab（侧栏入口按钮已就绪）");
            startNativeSessionWatch();
          } catch (e) {
            console.warn("[dsh-ui-editor] 注册原生右栏失败，保持悬浮抽屉：", e);
          }
        });
      } catch (e) {
        console.warn("[dsh-ui-editor] ctx.inject 不可用，保持悬浮抽屉：", e);
      }
    }

    /** Agent 用 web_editor_open 打开项目后，自动弹出原生右栏 tab */
    function startNativeSessionWatch() {
      if (nativeSessionTimer) return;
      nativeSessionTimer = window.setInterval(async () => {
        try {
          const res = await api("/session");
          const s = res && res.session;
            if (!s || s.source !== "agent") return;
          if (!s || !s.id || !s.url || !s.openedAt) return;
          if (Date.now() - s.openedAt > 5 * 60 * 1000) return;
          // 多窗口时只有拿到焦点的窗口跟随 Agent 打开的项目，其它窗口保持自己的项目不变
          try { if (!document.hasFocus()) return; } catch { /* ignore */ }
          const key = "dsh-ui-editor:autotab:" + s.id + ":" + s.openedAt;
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, "1");
          // 同一目录 5 分钟内不重复开新 tab（已有 tab 会自己跟上会话）
          try {
            const lastDir = localStorage.getItem("dsh-ui-editor:lastAutoDir") || "";
            const lastAt = Number(localStorage.getItem("dsh-ui-editor:lastAutoAt") || 0);
            if (lastDir === s.dir && Date.now() - lastAt < 5 * 60 * 1000) return;
            localStorage.setItem("dsh-ui-editor:lastAutoDir", s.dir || "");
            localStorage.setItem("dsh-ui-editor:lastAutoAt", String(Date.now()));
          } catch { /* ignore */ }
          try { rememberWindowDir(s.dir || ""); } catch { /* ignore */ }
          if (nativeNav && typeof nativeNav.openTab === "function") {
            nativeNav.openTab("web-editor", { params: { dir: s.dir }, revealIfOpened: false });
            console.info("[dsh-ui-editor] Agent 打开了项目，已新建/切换网页修改器 tab：" + (s.dir || ""));
          }
        } catch { /* ignore */ }
      }, 2500);
      window.addEventListener("beforeunload", () => window.clearInterval(nativeSessionTimer), { once: true });
    }

    /** 错误边界：渲染异常显示成可读信息，避免整页白屏 */
class UeErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err: err };
  }
  componentDidCatch(err, info) {
    try { console.error("[dsh-ui-editor] 渲染异常", err, info); } catch { /* ignore */ }
  }
  render() {
    if (this.state.err) {
      const msg = String((this.state.err && this.state.err.message) || this.state.err);
      return React.createElement(
        "div",
        { style: { padding: 16, font: "12px/1.6 system-ui,sans-serif", color: "#b91c1c" } },
        React.createElement("b", null, "网页修改器渲染出错"),
        React.createElement("div", { style: { marginTop: 6, color: "#334155", whiteSpace: "pre-wrap" } }, msg),
        React.createElement(
          "button",
          { style: { marginTop: 10, padding: "4px 10px", border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff", cursor: "pointer" }, onClick: () => this.setState({ err: null }) },
          "重试",
        ),
      );
    }
    return this.props.children;
  }
}

function apply(ctx) {
      // 窗口输入框 ⇄ 编辑器联动：在用户按 Enter / 点发送前，把当前项目+选区+截图接到消息里
      try {
        if (!window.__DSH_UE_BRIDGE_HOOK__) {
          window.__DSH_UE_BRIDGE_HOOK__ = true;
          document.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
            if (e.target && e.target.closest && e.target.closest("[data-wpe]")) return;
            appendEditorContextBeforeSend();
          }, true);
          document.addEventListener("click", (e) => {
            const btn = e.target && e.target.closest && e.target.closest("button");
            if (!btn) return;
            const label = ((btn.getAttribute("aria-label") || btn.getAttribute("title") || btn.textContent) || "").trim();
            if (!/^(发送|send|submit)$/i.test(label)) return;
            appendEditorContextBeforeSend();
          }, true);
        }
      } catch { /* ignore */ }
      try { pluginCtx = ctx; } catch { /* ignore */ }
      /* 工作台：注册侧栏图标 + 主区域面板（失败不影响右栏编辑器） */
      try { tryRegisterWorkbench(ctx); } catch (e) { console.warn("[dsh-ui-editor] 工作台注册异常", e); }

      /* 启动后自动进入网页工作台：默认开；可在 ⋯ 菜单关闭；每个页面会话只自动开一次 */
      try {
        const autoWb = (() => { try { return localStorage.getItem("dsh-ue:auto-wb") === "1"; } catch { return false; } })();
        const doneKey = "dsh-ue:auto-wb-done";
        if (autoWb && !sessionStorage.getItem(doneKey)) {
          sessionStorage.setItem(doneKey, "1");
          const tryOpen = (delay) => {
            const t = setTimeout(() => {
              if (autoWbCancelled) return; // 用户已经点过「返回对话」，不要再把人拉回工作台
              try {
                if (document.querySelector('iframe[src*="/ve/wb/"]')) return; // 已经打开了
                if (typeof openWorkbenchPanel === "function") openWorkbenchPanel();
              } catch { /* ignore */ }
            }, delay);
            autoWbTimers.push(t);
          };
          tryOpen(1600);
          tryOpen(3600);
          tryOpen(7000);
        }
      } catch { /* ignore */ }
      /* 宽屏（伪全屏）：只改右侧面板宽度 */
      try {
        applySidebarWide(sidebarWideOn());
        window.addEventListener("resize", () => { try { applySidebarWide(sidebarWideOn()); } catch { /* ignore */ } });
      } catch { /* ignore */ }
      /* Ctrl+Z / Ctrl+Shift+Z 兜底：焦点不在预览 iframe 时，把命令转发给内核 */
      try {
        if (!window.__ueUndoBridge) {
          window.__ueUndoBridge = true;
          const editables = (el) => Boolean(el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName || "")));
          window.addEventListener("keydown", (e) => {
            try {
              const meta = e.ctrlKey || e.metaKey;
              if (!meta) return;
              const code = e.code || "";
              const key = String(e.key || "").toLowerCase();
              const isZ = code === "KeyZ" || key === "z";
              const isY = code === "KeyY" || key === "y";
              if (!isZ && !isY) return;
              const target = e.target;
              if (editables(target)) return; // 正在输入框里：交给文本撤销
              // 焦点在左侧对话输入框/编辑器面板输入框里时也不拦截
              try {
                const composer = findDshComposer();
                const recentPreview = Date.now() - (window.__ueLastPreviewAt || 0) < 3000;
                if (composer && target && composer.contains(target) && !recentPreview) return;
              } catch { /* ignore */ }
              let frames = [];
              try {
                frames = [...document.querySelectorAll("iframe")].filter((f) => {
                  if (!(f.title === "网页预览" || /^https?:\/\/127\.0\.0\.1:/.test(f.src || ""))) return false;
                  const r = f.getBoundingClientRect();
                  return r.width > 60 && r.height > 60; // 只发给可见的预览
                });
              } catch { /* ignore */ }
              if (!frames.length) return;
              e.preventDefault();
              const cmd = (isY || e.shiftKey) ? "redo" : "undo";
              for (const f of frames) {
                try { f.contentWindow && f.contentWindow.postMessage({ __ve: "cmd", type: cmd }, "*"); } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }, true);
          console.info("[dsh-ui-editor] Ctrl+Z 兜底桥已启用");
        }
      } catch { /* ignore */ }
      /* Agent 触发的界面指令（如 web_editor_show_styles → 弹出风格面板） */
      try {
        if (!window.__ueUiCommandPoll) {
          window.__ueUiCommandPoll = window.setInterval(async () => {
            try {
              const r = await api('/ui-command');
              const cmd = r && r.command;
              if (cmd && cmd.type === 'styles') {
                window.dispatchEvent(new CustomEvent('dsh-ue-open-styles'));
                try { window.__uePendingOpenStyles = Date.now(); } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }
          }, 1500);
        }
      } catch (e) { /* ignore */ }

      /* Ctrl+Enter 兜底：无论焦点在页面/聊天/工具栏，都尝试切换 AI 改稿条 */
      try {
        if (!window.__ueAiBarKey) {
          window.__ueAiBarKey = true;
          document.addEventListener("keydown", (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.key !== "Enter") return;
            try {
              const tgt = e.target;
              const editable = tgt && tgt.nodeType === 1 && (tgt.isContentEditable || /^(input|textarea|select)$/i.test(tgt.tagName));
              if (editable && tgt.closest && tgt.closest("[data-wpe]")) return; // 编辑器自己的输入框里不抢
            } catch (err) { /* ignore */ }
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("dsh-ue-toggle-ai"));
            try { window.__uePendingToggleAi = Date.now(); } catch (err) { /* ignore */ }
          }, true);
          console.info("[dsh-ui-editor] Ctrl+Enter 兜底已启用");
        }
      } catch (e) { /* ignore */ }

      /* 用户在对话里说「风格优化」→ 发送后自动弹出风格面板（不等 Agent 调工具） */
      try {
        if (!window.__ueStylePhraseHook) {
          window.__ueStylePhraseHook = true;
          const norm = (s) => String(s || "").replace(/\s+/g, "");
          // 关键：发送瞬间先抓文字快照，等界面清空输入框后再判断
          const maybeOpen = () => {
            let text = "";
            try {
              const el = findDshComposer ? findDshComposer() : null;
              text = norm((el && (el.value || el.textContent)) || "");
            } catch (e) { /* ignore */ }
            if (!text || !/风格优化|换个风格|选个风格|套用风格/.test(text)) return;
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("dsh-ue-open-styles"));
              try { window.__uePendingOpenStyles = Date.now(); } catch (e) { /* ignore */ }
            }, 300);
          };
          document.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
            if (e.target && e.target.closest && e.target.closest("[data-wpe]")) return;
            maybeOpen();
          }, true);
          document.addEventListener("click", (e) => {
            const btn = e.target && e.target.closest && e.target.closest("button");
            if (!btn) return;
            const label = ((btn.getAttribute("aria-label") || btn.getAttribute("title") || btn.textContent) || "").trim();
            if (!/^(发送|send|submit)$/i.test(label)) return;
            maybeOpen();
          }, true);
          console.info("[dsh-ui-editor] 风格口令钩子已启用");
        }
      } catch (e) { /* ignore */ }

      /* 整块对话列浮动：默认开启；每 2 秒校准位置（跟随侧栏宽度/全屏） */
      try {
        keepChatFloat();
        window.setInterval(() => {
          try {
            if (chatFloatOn()) applyChatFloat(true);
            else if (CHAT_FLOAT.on) applyChatFloat(false);
          } catch { /* ignore */ }
        }, 2000);
        window.addEventListener("resize", () => {
          try { if (CHAT_FLOAT.on) applyChatFloat(true); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }

      try { sessionsSvc = typeof ctx.get === "function" ? ctx.get("sessions") : null; } catch { /* ignore */ }
      try { grabConversation(ctx); } catch { /* ignore */ }
      ensureCss();
      bootPillGuard();
      const store = createStore();
      lastStore = store;

      // 新版 DSH：优先注册成原生右栏 tab（旧版则保持悬浮抽屉）
      tryRegisterNative(ctx);
      // 启动就探测宿主接口（桌面窗口要等宿主固定端口起来，提前并行开始）
      detectApiBase().catch(() => {});

      // 首选：独立挂到 body（不受侧边栏容器 overflow/transform 影响）
      let container = null;
      let root = null;
      let standalone = false;
      try {
        const resolved = resolveCreateRoot();
        if (resolved) {
          container = document.createElement("div");
          container.setAttribute("data-plugin", PLUGIN_ID);
          document.body.appendChild(container);
          root = resolved.createRoot(container);
          root.render(h(Drawer, { store }));
          standalone = true;
          console.info("[dsh-ui-editor] 抽屉独立挂载成功（" + resolved.spec + "）");
        } else {
          console.warn("[dsh-ui-editor] 取不到 createRoot，抽屉改为渲染在侧边栏按钮内（兼容模式）");
        }
      } catch (e) {
        console.warn("[dsh-ui-editor] 独立挂载失败，改用兼容模式：", e);
        try { if (container && container.remove) container.remove(); } catch { /* ignore */ }
        container = null;
        root = null;
        standalone = false;
      }
      store.set({ standalone });

      // 方便排查：在 Console 里能看到插件到底走到哪一步
      detectApiBase();
      window.__DSH_UI_EDITOR__ = {
        version: "1.10.1",
        get apiBase() { return apiBase; },
        detectApiBase,
        standalone,
        open: () => store.set({ open: true }),
        close: () => store.set({ open: false }),
        state: () => store.get(),
      };
      console.info("[dsh-ui-editor] 已加载；compatibilityMode=" + (!standalone) + "；调试对象 window.__DSH_UI_EDITOR__");

      const esc = (ev) => {
        if (ev.key === "Escape" && store.get().open) store.set({ open: false });
      };
      window.addEventListener("keydown", esc, true);

      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: PLUGIN_ID,
            inject: () => ({ store }),
          },
          Trigger,
        ),
      );

      const cleanup = () => {
        try { delete window.__DSH_UI_EDITOR__; } catch { /* ignore */ }
        try { window.removeEventListener("keydown", esc, true); } catch { /* ignore */ }
        try { if (root) root.unmount(); } catch { /* ignore */ }
        try { if (container) container.remove(); } catch { /* ignore */ }
        try {
          const tag = document.querySelector('style[data-plugin-css="' + PLUGIN_ID + '"]');
          if (tag) tag.remove();
        } catch { /* ignore */ }
      };

      // 交给 cordis 生命周期；没有 effect 时退回页面卸载清理
      if (typeof ctx.effect === "function") ctx.effect(() => cleanup, "dsh-ui-editor: ui");
      else window.addEventListener("beforeunload", cleanup, { once: true });
    }

    const inject = ["slots"];

    // 供自动化测试/二次开发读取（不影响正常使用）
    exports.__test = {
      createStore,
      Drawer,
      Trigger,
      EditorTabView,
      EditorTabBody,
      tryRegisterNative,
      PreviewPane,
      FolderPicker,
      get lastStore() {
        return lastStore;
      },
    };
    let lastStore = null;

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
