/**
 * DSH 插件 · 网页修改器（宿主端）
 *
 * 形态：Cordis 插件。给客户端插件提供 HTTP 接口：
 *   GET  /ve/plugin/ping
 *   GET  /ve/plugin/browse?path=       列目录 / 识别项目类型
 *   POST /ve/plugin/open   { dir }     起预览（Vite 用项目自己的 vite，静态站进程内托管）
 *   POST /ve/plugin/close  { id }
 *   GET  /ve/plugin/list
 *   POST /ve/plugin/ai     { id, instruction, selection, context }   → 转发给预览服务的编辑器内核
 *   GET  /ve/plugin/ai-status?id=
 *   POST /ve/plugin/ai-config { id, baseURL, apiKey, model }
 *
 * 说明：所有接口都在 DSH 自己的 webServer 上，与前端同源；只监听 127.0.0.1。
 */

import http from "node:http";
import fs from "node:fs";
import { createReadStream, existsSync as fsExists, statSync as fsStat, readFileSync as fsRead } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createPreviewManager, browse, detectProject } from "./preview.mjs";
import { sanitizeOps } from "./vendor/api.mjs";

export const name = "web-page-editor";
export const inject = ["webServer", "llm", "tools"];

const PREFIX = "/ve/plugin";
/** 桌面窗口（dsh-app:// 协议）够不到 DSH 自己的 webServer 端口，这里额外开一个固定端口的兼容接口 */
const AUX_PORT_BASE = Number(process.env.VE_EDITOR_PORT || 19390);

/* ─────────── DSH 原生模型：复用当前实例的 llm 服务，不需要额外 key ─────────── */

let llmHelpersCache = null;
function loadLlmHelpers() {
  if (llmHelpersCache) return llmHelpersCache;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(home, ".dsh");
  const anchors = [];
  for (const profile of ["desktop", "web"]) anchors.push(path.join(dshHome, "profiles", profile, "package.json"));
  anchors.push(path.join(dshHome, "profiles", "package.json"));
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const mod = req("@deepseek-ai/dsh-llm");
      if (mod && typeof mod.createUserMessage === "function" && typeof mod.BlockAssembler === "function") {
        llmHelpersCache = mod;
        return mod;
      }
    } catch { /* 试下一个锚点 */ }
  }
  throw new Error("找不到 @deepseek-ai/dsh-llm 的辅助函数");
}

/** 用 profiles 目录作为锚点解析 DSH 自身包（插件是 link: 安装，直接 import 解析不到） */
function loadDshModule(name) {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(home, ".dsh");
  const anchors = [];
  for (const profile of ["desktop", "web"]) anchors.push(path.join(dshHome, "profiles", profile, "package.json"));
  anchors.push(path.join(dshHome, "profiles", "package.json"));
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      return req(name);
    } catch { /* 试下一个锚点 */ }
  }
  return null;
}

const NATIVE_SYSTEM = [
  "你是网页视觉编辑器的操作生成器，运行在 DeepSeek Harness 里。",
  "只输出 JSON，不要 Markdown 代码围栏，不要解释。",
  '输出格式：{"ops":[...],"note":"一句中文说明"}',
  "允许的操作（严格只用这些）：",
  '{"type":"style","key":"<元素key>","props":{"font-size":"20px","font-weight":"700","color":"#111","line-height":"1.4","letter-spacing":"0.02em","padding-top":"12px","border-radius":"8px","opacity":"0.9"}}',
  '渐变也走 style 的 --ve-grad：多节点格式 "g2|<角度>|<text|fill|stroke|both>|<位置0-1>:<#hex>:<透明度0-1>|..."，例如 "g2|90|text|0:#ff4d4d:1|0.6:#ffb86b:0.6|1:#ffb86b:0"（角度 90=从左到右、180=从上到下；text=文字渐变，fill/stroke/both=SVG 渐变）',
  '{"type":"text","key":"<元素key>","value":"新文字"}',
  '{"type":"attrs","key":"<元素key>","props":{"src":"/图片地址","alt":"说明","fill":"#333"}}',
  '{"type":"box","key":"<元素key>","box":{"x":0,"y":0,"width":320,"height":180}}',
  '{"type":"hide","key":"<元素key>","hidden":true}',
  "规则：key 必须来自用户提供的候选元素列表，不许编造；样式值必须是合法 CSS 且带单位；一次最多 12 个操作；不要生成脚本。",
  "若要求超出现有能力（例如新增章节），返回空 ops，并在 note 里说明。",
].join("\n");

const NATIVE_USER_TEMPLATE = (instruction, context, selection) =>
  [
    "指令：" + instruction,
    selection ? "当前重点元素：" + JSON.stringify(selection) : "",
    context ? "候选元素（key 只能从这里取）：\n" + context : "（没有提供候选元素）",
  ]
    .filter(Boolean)
    .join("\n\n");

function stripFences(text) {
  return String(text || "").replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "").trim();
}

function fixLooseJson(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[\u200b\u200c\u200d]/g, "")
    .trim();
}

/** 从文本里找出所有括号平衡的 {...} / [...] 片段（字符串感知） */
function balancedJsonCandidates(text) {
  const s = String(text || "");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;
    const open = ch;
    const close = ch === "{" ? "}" : "]";
    let d = 0;
    let str = null;
    let es = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (es) { es = false; continue; }
      if (c === "\\") { es = true; continue; }
      if (str) { if (c === str) str = null; continue; }
      if (c === '"' || c === "'") { str = c; continue; }
      if (c === open) d++;
      else if (c === close) {
        d--;
        if (d === 0) { out.push(s.slice(i, j + 1)); break; }
      }
    }
    if (out.length > 40) break;
  }
  return out.sort((a, b) => b.length - a.length);
}

function normalizeAiJson(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return { ops: value, note: "" };
  if (Array.isArray(value.ops)) return value;
  for (const alias of ["actions", "operations", "result", "changes"]) {
    if (Array.isArray(value[alias])) return Object.assign({}, value, { ops: value[alias] });
  }
  const grouped = ["style", "text", "attrs", "box", "hide"].filter((k) => Array.isArray(value[k]));
  if (grouped.length) {
    const ops = [];
    for (const k of grouped) for (const item of value[k]) if (item && typeof item === "object") ops.push(Object.assign({ type: k }, item));
    return Object.assign({}, value, { ops });
  }
  return value;
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  const variants = [raw, stripFences(raw)];
  for (const v of variants) {
    if (!v) continue;
    const fixed = fixLooseJson(v);
    try { return normalizeAiJson(JSON.parse(fixed)); } catch (e) { /* 继续 */ }
    for (const cand of balancedJsonCandidates(fixed)) {
      try { return normalizeAiJson(JSON.parse(fixLooseJson(cand))); } catch (e) { /* 继续 */ }
    }
  }
  return null;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体太大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function apply(ctx) {
  const log = (...args) => {
    try {
      ctx.logger?.info?.(args.map(String).join(" "));
    } catch {
      console.log("[web-page-editor]", ...args);
    }
  };
  const manager = createPreviewManager({ log });
  let auxPort = 0;
  let auxServer = null;
  let lastOpened = null;
  // 渲染端上报的样式诊断（排查「按钮圆角不生效」这类宿主样式覆盖问题）
  let lastClientDiag = null;
  // 编辑器当前上下文：最近一次框选的元素 + 截图文件（供 agent 工具读取）
  let lastContext = { dir: "", selection: [], shotPath: "", at: 0 };
  // agent 通过工具下发的修改操作：客户端轮询取走并转发给预览页实时应用
  // agent 会话 id：从工具执行上下文里捕获，用于把编辑器的请求直接发进对话
  let agentSessionId = "";
  const captureSession = (exec) => {
    try {
      const cand = [
        exec && exec.sessionId,
        exec && exec.session && exec.session.id,
        exec && exec.context && exec.context.sessionId,
        exec && exec.agent && exec.agent.sessionId,
      ].filter((x) => typeof x === "string" && x);
      if (cand.length) agentSessionId = cand[0];
      if (process.env.DSH_UE_DEBUG) log("工具会话上下文键：" + Object.keys(exec || {}).join(",") + " → " + agentSessionId);
    } catch { /* ignore */ }
  };
      // Electron 主进程能力：直接操作 DSH 窗口 DOM + 截窗口图（调试/移动对话输入框用）
  let electronTask = null;
  const getElectron = () => {
    if (!electronTask) {
      electronTask = import("electron").then((m) => m.default || m).catch((e) => {
        log("Electron API 不可用：" + String(e && e.message || e));
        return null;
      });
    }
    return electronTask;
  };
  const appWindow = async () => {
    try {
      const api = await getElectron();
      if (!api || !api.BrowserWindow) return null;
      const list = api.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      const live = list.filter((w) => w.webContents && !w.webContents.isDestroyed());
      if (!live.length) return null;
      const focused = live.find((w) => w.isFocused());
      const big = live.slice().sort((a, b) => (b.getBounds().width * b.getBounds().height) - (a.getBounds().width * a.getBounds().height))[0];
      return focused || big;
    } catch (e) {
      log("appWindow 失败：" + String(e && e.message || e));
      return null;
    }
  };
  const opsQueue = new Map();
  const queueOps = (dir, ops) => {
    const key = String(dir || "").toLowerCase();
    const list = opsQueue.get(key) || [];
    list.push(...ops);
    opsQueue.set(key, list);
    return list.length;
  };

  /* ---- DSH 原生模型 ---- */
  const nativeAvailable = () => {
    try { return typeof ctx.llm?.stream === "function"; } catch { return false; }
  };
  const nativeModel = () => {
    try {
      const svc = typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : null;
      const cur = svc && typeof svc.currentSelection === "function" ? svc.currentSelection() : null;
      return {
        provider: (cur && cur.provider) || process.env.VE_DSH_PROVIDER || "",
        model: (cur && cur.model) || process.env.VE_DSH_MODEL || "",
        reasoningEffort: cur && cur.reasoningEffort,
      };
    } catch {
      return { provider: "", model: "" };
    }
  };

  async function runNativeAi({ instruction, selection, context }) {
    if (!nativeAvailable()) return { ok: false, needsDsh: true, error: "当前实例没有暴露 llm 服务" };
    const route = nativeModel();
    if (!route.provider || !route.model) return { ok: false, needsDsh: true, error: "读不到 DSH 当前选择的模型" };
    let helpers;
    try { helpers = loadLlmHelpers(); } catch (e) { return { ok: false, needsDsh: true, error: String(e?.message || e) }; }
    const baseUser = NATIVE_USER_TEMPLATE(instruction, context, selection);
    const runOnce = async (extraUser) => {
      const texts = extraUser ? [baseUser, extraUser] : [baseUser];
      const messages = texts.map((x) => helpers.createUserMessage({
        content: [{ type: "text", text: x }],
        source: { kind: "user" },
      }));
      const assembler = new helpers.BlockAssembler();
      const opts = {
        provider: route.provider,
        model: route.model,
        messages,
        system: NATIVE_SYSTEM,
        temperature: 0.2,
        maxTokens: 1600,
        purpose: "dsh-ui-editor",
      };
      if (route.reasoningEffort) opts.reasoningEffort = route.reasoningEffort;
      for await (const chunk of ctx.llm.stream(opts)) assembler.push(chunk);
      const finish = assembler.finish;
      if (finish && finish.kind === "error") throw new Error("DSH 模型返回错误：" + String(finish.failure?.message || finish.failure || ""));
      if (finish && finish.kind === "aborted") throw new Error("DSH 模型调用被取消");
      return assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("");
    };

    let text = "";
    let parsed = null;
    try {
      text = await runOnce("");
      parsed = parseJsonLoose(text);
      if (!parsed || !Array.isArray(parsed.ops)) {
        log("原生 AI 首次输出不是合法 JSON，重试一次；片段：" + String(text).slice(0, 300));
        const repair = "你上一次的输出无法解析为 JSON。上一次输出如下：\n" + String(text).slice(0, 1500) +
          "\n\n请重新输出：只输出严格 JSON（{\"ops\":[...],\"note\":\"...\"}），不要任何解释、不要代码围栏。如果确实无法完成，输出 {\"ops\":[],\"note\":\"原因\"}。";
        text = await runOnce(repair);
        parsed = parseJsonLoose(text);
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    if (!parsed || !Array.isArray(parsed.ops)) {
      return { ok: false, error: "模型没返回合法 JSON（已自动重试一次）", raw: String(text).slice(0, 600) };
    }
    const ops = sanitizeOps(parsed.ops);
    return { ok: true, ops, note: String(parsed.note || ""), model: { provider: route.provider, model: route.model }, dropped: parsed.ops.length - ops.length };
  }

  /** 桌面窗口是 dsh-app:// 协议，跨源请求需要 CORS；只放行本机来源 */
  function applyCors(req, res) {
    const origin = req.headers.origin;
    let allow = "";
    if (origin) {
      if (origin === "dsh-app://app" || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) allow = origin;
    } else {
      allow = "*"; // 非浏览器调用（本地脚本/curl）
    }
    if (allow) {
      res.setHeader("Access-Control-Allow-Origin", allow);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-ve-token");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  /* ───────── 风格规范：从 design-tokens.json / CSS / UI-SPEC.md 提取抽象参数 ───────── */
  function readTextSafe(file, max) {
    try { return String(fsRead(file, 'utf8')).slice(0, max || 200000); } catch { return ''; }
  }
  function classifyToken(name, value) {
    const n = String(name || '').toLowerCase();
    const v = String(value || '');
    if (/(color|ink|paper|rust|accent|bg|text|rule|hairline|surface|brand)/.test(n) || /^#|rgba?\(|hsla?\(/.test(v)) return 'color';
    if (/(font|family|typeface|serif|sans|mono)/.test(n) || /serif|sans-serif|monospace/i.test(v)) return 'font';
    if (/shadow/.test(n)) return 'shadow';
    if (/radius|rounded|corner/.test(n)) return 'radius';
    if (/(space|gap|gutter|padding|margin)/.test(n)) return 'space';
    if (/(ease|duration|motion|transition|delay)/.test(n)) return 'motion';
    return 'other';
  }
  function parseTokensCss(text) {
    const out = [];
    const re = /--([\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      const value = String(m[2]).trim();
      if (!value || value.length > 160) continue;
      out.push({ name: '--' + name, value: value, kind: classifyToken(name, value) });
    }
    return out;
  }
  function normalizeTokensJson(j) {
    const list = [];
    const meta = (j && j.meta) || {};
    const addColor = (k, v) => {
      if (!v) return;
      const val = (v && typeof v === 'object') ? (v.value || v.hex || '') : String(v);
      if (!val) return;
      list.push({ name: '--' + k, value: String(val), kind: 'color', role: (v && v.role) || '' });
    };
    try { if (j && j.color) for (const k of Object.keys(j.color)) addColor(k, j.color[k]); } catch (e) { /* ignore */ }
    try {
      if (j && j.typography && j.typography.families) {
        for (const k of Object.keys(j.typography.families)) list.push({ name: '--font-' + k, value: String(j.typography.families[k]), kind: 'font' });
      }
    } catch (e) { /* ignore */ }
    try { if (j && j.spacing) for (const k of Object.keys(j.spacing)) list.push({ name: '--space-' + k, value: String(j.spacing[k]), kind: 'space' }); } catch (e) { /* ignore */ }
    try { if (j && j.radius) for (const k of Object.keys(j.radius)) list.push({ name: '--radius-' + k, value: String((j.radius[k] && j.radius[k].value) || j.radius[k]), kind: 'radius' }); } catch (e) { /* ignore */ }
    try { if (j && j.shadow) for (const k of Object.keys(j.shadow)) list.push({ name: '--shadow-' + k, value: String((j.shadow[k] && j.shadow[k].value) || j.shadow[k]), kind: 'shadow' }); } catch (e) { /* ignore */ }
    try { if (j && j.motion) for (const k of Object.keys(j.motion)) list.push({ name: '--motion-' + k, value: String((j.motion[k] && j.motion[k].value) || j.motion[k]), kind: 'motion' }); } catch (e) { /* ignore */ }
    return { meta: meta, tokens: list };
  }
  /* ───────── 风格库：集中存到 ~/.dsh/plugin-data/dsh-ui-editor/styles ───────── */
  function styleRoot() {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const dir = path.join(dshHome, 'plugin-data', 'dsh-ui-editor', 'styles');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    return dir;
  }
  function styleIdSafe(id) { return String(id || '').replace(/[^\w-]/g, '').slice(0, 80); }
  function coverSvgFor(spec) {
    const colors = (spec.colors || []).map((c) => c.value).filter((v) => /^#|rgb/.test(v)).slice(0, 5);
    while (colors.length < 3) colors.push(colors.length ? colors[0] : '#eceef2');
    const name = String((spec.name || '风格')).slice(0, 18);
    const esc2 = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
      colors.map((c, i) => '<stop offset="' + (i / (colors.length - 1) * 100).toFixed(0) + '%" stop-color="' + esc2(c) + '"/>').join(''),
      '</linearGradient></defs>',
      '<rect width="640" height="360" fill="url(#g)"/>',
      '<rect x="28" y="248" width="584" height="84" rx="14" fill="rgba(255,255,255,.16)"/>',
      '<text x="44" y="300" font-family="Inter,system-ui,sans-serif" font-size="26" fill="#fff" opacity=".95">' + esc2(name) + '</text>',
      colors.map((c, i) => '<circle cx="' + (556 - i * 34) + '" cy="290" r="12" fill="' + esc2(c) + '" stroke="rgba(255,255,255,.5)"/>').join(''),
      '</svg>',
    ].join('');
  }
  function hexLuminance(v) {
    const m = String(v || '').match(/^#([0-9a-f]{6})$/i);
    if (!m) return 0.5;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  /** 风格的展示字体（取第一个 font token 的首选字族） */
  /** 标题特效：规范里如果有 stroke/outline 色，就标记"轮廓底图" */
  function styleTitleEffect(spec) {
    try {
      const colors = (spec && spec.colors) || [];
      const hit = colors.find((c) => /stroke|outline|echo/i.test(String(c.name || '')));
      const stroke = hit && /^#|rgb/i.test(String(hit.value)) ? String(hit.value) : '';
      const notes = String((spec && spec.notes) || '');
      // 收紧：只有明确讲"标题轮廓回声"才启用（普通的 stroke 1.5 图标 / focus outline 不算）
      const mention = /轮廓回声|echo|text-stroke|outline-echo|标题.*轮廓|轮廓.*标题/i.test(notes);
      return { effect: stroke || mention ? 'stroke' : '', strokeColor: stroke || '' };
    } catch (e) { return { effect: '', strokeColor: '' }; }
  }

  /** 规范里的完整字体栈（大标题用 display 第一个，小字用 sans/label 那个） */
  function styleFontStacks(spec) {
    try {
      const list = (spec && spec.fonts) || [];
      const display = list[0] ? String(list[0].value || '') : '';
      const smallHit = list.find((f) => /(sans|label|body|text|ui|mono)/i.test(String(f.name || ''))) || list[1] || list[0];
      const small = smallHit ? String(smallHit.value || '') : '';
      return { display: display.trim(), small: small.trim() };
    } catch (e) { return { display: '', small: '' }; }
  }

  /** 小字字体：取 sans/label/body/text 类字体，其次第二个字体 */
  function styleSmallFontOf(spec) {
    try {
      const list = (spec && spec.fonts) || [];
      const hit = list.find((f) => /(sans|label|body|text|ui|mono)/i.test(String(f.name || '')));
      const pick = hit || list[1] || list[0];
      if (!pick) return '';
      return String(pick.value || '').split(',')[0].replace(/["']/g, '').trim();
    } catch (e) { return ''; }
  }

  /** 单色背景：优先 paper/bg/background/surface token，其次最亮颜色 */
  function styleBgOf(spec) {
    try {
      const list = (spec && spec.colors) || [];
      const hit = list.find((c) => /(paper|bg|background|ground|surface|canvas|base)/i.test(String(c.name || '')));
      if (hit && /^#|rgb/i.test(String(hit.value))) return String(hit.value);
      const cols = list.map((c) => String(c.value || '')).filter((v) => /^#/.test(v));
      if (!cols.length) return '#f5f5f5';
      return cols.reduce((best, c) => (hexLuminance(c) > hexLuminance(best) ? c : best), cols[0]);
    } catch (e) { return '#f5f5f5'; }
  }

  function styleFontOf(spec) {
    try {
      const f = (spec && spec.fonts || [])[0];
      if (!f) return '';
      return String(f.value || '').split(',')[0].replace(/["']/g, '').trim();
    } catch (e) { return ''; }
  }
  /** 从规范摘录里提取一句短简介（去掉 markdown 结构） */
  function styleDescOf(spec, fallback) {
    try {
      let text = String((spec && spec.notes) || '');
      text = text.replace(/^#+.*$/gm, ' ').replace(/\|/g, ' ').replace(/[>*_\x60]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 90) text = text.slice(0, 88).trim() + '…';
      return text || String(fallback || '');
    } catch (e) { return String(fallback || ''); }
  }

  function styleColorsOf(spec) {
    try {
      const list = (spec && spec.colors) || [];
      const colors = list.map((c) => String(c.value || '')).filter((v) => /^#|rgb/i.test(v));
      const ink = list.find((c) => /ink|text|title|fg|foreground/i.test(String(c.name || '')));
      let titleColor = ink ? String(ink.value) : '';
      if (!titleColor || !/^#/.test(titleColor)) {
        const dark = colors.find((c) => /^#/.test(c) && hexLuminance(c) < 0.45);
        titleColor = dark || colors[0] || '#1f2937';
      }
      return { colors: colors.slice(0, 6), titleColor: titleColor };
    } catch (e) { return { colors: [], titleColor: '#1f2937' }; }
  }

  function listStyles() {
    const root = styleRoot();
    const out = [];
    try {
      for (const id of fs.readdirSync(root)) {
        const dir = path.join(root, id);
        try {
          if (!fsStat(dir).isDirectory()) continue;
          const meta = JSON.parse(readTextSafe(path.join(dir, 'meta.json'), 100000) || '{}');
          // 迁移：旧风格库没有 fonts.css 时，从 meta.source 目录补一份（卡片真实字体用）
          try {
            const localFonts = path.join(dir, 'fonts.css');
            if (!fsExists(localFonts) && meta.source) {
              const cand = fsStat(meta.source).isDirectory() ? path.join(meta.source, 'fonts.css') : path.join(path.dirname(meta.source), 'fonts.css');
              if (fsExists(cand)) fs.copyFileSync(cand, localFonts);
            }
          } catch (e) { /* ignore */ }
          let palette = { colors: [], titleColor: '#1f2937' };
          try {
            const spec = JSON.parse(readTextSafe(path.join(dir, 'style-spec.json'), 400000) || 'null');
            if (spec) palette = styleColorsOf(spec);
          } catch (e) { /* ignore */ }
          let font = meta.font || '';
          let smallFont = meta.smallFont || '';
          let fontStack = '';
          let smallFontStack = '';
          let titleEffect = '';
          let strokeColor = '';
          let description = meta.description || '';
          try {
            const spec = JSON.parse(readTextSafe(path.join(dir, 'style-spec.json'), 400000) || 'null');
            if (spec) {
              if (!font) font = styleFontOf(spec);
              if (!smallFont) smallFont = styleSmallFontOf(spec);
              const stacks = styleFontStacks(spec);
              fontStack = stacks.display || font;
              smallFontStack = stacks.small || smallFont;
              const eff = styleTitleEffect(spec);
              titleEffect = (meta.titleEffect === "none") ? "" : eff.effect;
              strokeColor = (meta.titleEffect === "none") ? "" : eff.strokeColor;
              if (!description) description = styleDescOf(spec, meta.source || '');
            }
          } catch (e) { /* ignore */ }
          out.push({
            id: id,
            name: meta.name || id,
            source: meta.source || '',
            createdAt: meta.createdAt || 0,
            colors: palette.colors,
            titleColor: palette.titleColor,
            bgColor: (function () { try { const spec = JSON.parse(readTextSafe(path.join(dir, 'style-spec.json'), 400000) || 'null'); return spec ? styleBgOf(spec) : '#f5f5f5'; } catch (e) { return '#f5f5f5'; } })(),
            font: font,
            fontStack: fontStack || font,
            smallFont: smallFont,
            smallFontStack: smallFontStack || smallFont,
            titleEffect: titleEffect,
            strokeColor: strokeColor,
            description: description,
            preview: meta.preview || '',
          });
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }
  function readStyle(id) {
    const dir = path.join(styleRoot(), styleIdSafe(id));
    const spec = JSON.parse(readTextSafe(path.join(dir, 'style-spec.json'), 400000) || 'null');
    const brief = readTextSafe(path.join(dir, 'style-brief.md'), 100000);
    const meta = JSON.parse(readTextSafe(path.join(dir, 'meta.json'), 100000) || '{}');
    return { dir: dir, spec: spec, brief: brief, meta: meta };
  }

  /** 应用风格前把项目源文件备份到 .ve-data/style-backups，方便回退/对比 */
  function backupProjectForStyle(dir, styleName) {
    const root = path.resolve(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = String(styleName || 'style').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'style';
    const out = path.join(root, '.ve-data', 'style-backups', stamp + '_' + safe);
    const keepExt = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.svg', '.md', '.txt']);
    const skipDir = new Set(['.git', 'node_modules', '.ve-data', 'dist', 'build', '.vite', 'coverage']);
    const files = [];
    try {
      const walk = (d, rel) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const r = rel ? rel + '/' + ent.name : ent.name;
          if (ent.isDirectory()) {
            if (!skipDir.has(ent.name)) walk(path.join(d, ent.name), r);
            continue;
          }
          if (!ent.isFile()) continue;
          const ext = path.extname(ent.name).toLowerCase();
          if (!keepExt.has(ext)) continue;
          const src = path.join(d, ent.name);
          const dst = path.join(out, 'files', r);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
          files.push({ path: r, size: fs.statSync(src).size });
          if (files.length >= 300) return;
        }
      };
      fs.mkdirSync(out, { recursive: true });
      walk(root, '');
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
        createdAt: new Date().toISOString(),
        styleName: String(styleName || ''),
        sourceDir: root,
        note: '应用风格前的项目源文件备份；回退时把 files/ 下的文件覆盖回项目即可。',
        files,
      }, null, 2) + '\n', 'utf8');
      return out;
    } catch (e) {
      return '';
    }
  }

  function addStyleFromPath(srcPath, name) {
    const r = computeStyleSpec(srcPath);
    if (!r.ok) return r;
    const spec = r.spec;
    const metaName = String(name || spec.name || '未命名风格').slice(0, 60);
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const dir = path.join(styleRoot(), id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: '创建风格目录失败' }; }
    const brief = buildStyleBrief(spec, '');
    try {
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        name: metaName,
        source: r.base,
        createdAt: Date.now(),
        font: styleFontOf(spec),
        fontStack: styleFontStacks(spec).display || styleFontOf(spec),
        smallFont: styleSmallFontOf(spec),
        smallFontStack: styleFontStacks(spec).small || styleSmallFontOf(spec),
        description: styleDescOf(spec, metaName),
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'style-spec.json'), JSON.stringify(spec, null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'style-brief.md'), brief, 'utf8');
      fs.writeFileSync(path.join(dir, 'cover.svg'), coverSvgFor(spec), 'utf8');
      // 规范目录里的 @font-face（常是 data URI 内嵌字体）复制进风格库，卡片才能用真实字体渲染
      try {
        const fontsSrc = path.join(r.base, 'fonts.css');
        if (fsExists(fontsSrc)) fs.copyFileSync(fontsSrc, path.join(dir, 'fonts.css'));
      } catch (e) { /* ignore */ }
    } catch (e) { return { ok: false, error: '写入风格文件失败：' + String(e && e.message || e) }; }
    return { ok: true, id: id, name: metaName, styles: listStyles() };
  }
  function removeStyle(id) {
    const dir = path.join(styleRoot(), styleIdSafe(id));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    return { ok: true, styles: listStyles() };
  }
  let pendingUiCommand = null;

  /** 查询某项目当前的固化状态：已固化 / 有未固化修改 / 未固化 */
  function fixateStatusOf(dir) {
    const projectDir = String(dir || '').trim();
    if (!projectDir || !fsExists(projectDir)) return { state: 'none', error: '项目目录无效' };
    const statMtime = (p) => { try { return fsExists(p) ? fsStat(p).mtimeMs : 0; } catch (e) { return 0; } };
    const overridesAt = (() => {
      let m = statMtime(path.join(projectDir, '.ve-data', 'overrides.json'));
      try {
        const pagesRoot = path.join(projectDir, '.ve-data', 'pages');
        for (const d of fs.readdirSync(pagesRoot, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          m = Math.max(m, statMtime(path.join(pagesRoot, d.name, 'overrides.json')));
        }
      } catch (e) { /* ignore */ }
      return m;
    })();
    const scriptCandidates = [
      path.join(projectDir, 've-applied.js'),
      path.join(projectDir, 'src', 've-applied.js'),
    ];
    let scriptPath = '';
    let fixedAt = 0;
    for (const p of scriptCandidates) {
      const m = statMtime(p);
      if (m) { scriptPath = p; fixedAt = Math.max(fixedAt, m); }
    }
    // 入口是否已注入：扫描项目里的所有 HTML（固化常发生在子页面，例如 uneo-neumorphism/preview.html，
    // 之前只看 index.html，导致子页面固化后状态永远显示「未固化」）
    let injected = false;
    const injectedFiles = [];
    const scanInjectedHtml = (abs, depth) => {
      if (depth > 3 || injectedFiles.length >= 120) return;
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (['node_modules', '.ve-data', 'dist', 'build', 'out', '.git'].includes(ent.name)) continue;
        if (ent.name.startsWith('.') && ent.name !== '.well-known') continue;
        const p = path.join(abs, ent.name);
        if (ent.isDirectory()) { scanInjectedHtml(p, depth + 1); continue; }
        if (!/\.html?$/i.test(ent.name)) continue;
        let t = '';
        try {
          if (fsStat(p).size > 8 * 1024 * 1024) continue;
          t = readTextSafe(p, 8 * 1024 * 1024) || '';
        } catch (e) { continue; }
        if (t.includes('ve-applied-style') || t.includes('ve-applied')) {
          injected = true;
          fixedAt = Math.max(fixedAt, statMtime(p));
          injectedFiles.push(path.relative(projectDir, p).split(path.sep).join('/'));
        }
      }
    };
    try { scanInjectedHtml(projectDir, 0); } catch (e) { /* ignore */ }
    if (!injected) {
      try {
        for (const js of ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js']) {
          const p = path.join(projectDir, js);
          if (fsExists(p) && (readTextSafe(p, 800000) || '').includes('ve-applied')) { injected = true; break; }
        }
      } catch (e) { /* ignore */ }
    }
    if (!fixedAt || !injected) return { state: overridesAt ? 'unfixed' : 'none', fixedAt: fixedAt, overridesAt: overridesAt, injected: injected, injectedFiles: injectedFiles, scriptPath: scriptPath };
    if (overridesAt > fixedAt + 300) return { state: 'stale', fixedAt: fixedAt, overridesAt: overridesAt, injected: injected, injectedFiles: injectedFiles, scriptPath: scriptPath };
    return { state: 'fixed', fixedAt: fixedAt, overridesAt: overridesAt, injected: injected, injectedFiles: injectedFiles, scriptPath: scriptPath };
  }

  /** 把覆写层「固化」成项目里真实生效的文件（不需要编辑器内核也能看到改动）
   *  - 纯静态：生成 ve-applied.js（内嵌覆写数据）+ 在入口 HTML 注入 <script>
   *  - Vite：写成 src/ve-applied.js 并在入口 JS 里加一行 import
   *  全程写入前备份到 .ve-data/backups/fixate-<时间>/
   */
/** 固化会注入 script 改变源码：同步各页面 source-meta，避免下次打开被误判为外部修改 */
  function refreshFixateSourceMeta(dir) {
    try {
      const dataDir = path.join(dir, '.ve-data');
      const writeMeta = (file, metaFile) => {
        if (!fsExists(file)) return;
        const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
        fs.mkdirSync(path.dirname(metaFile), { recursive: true });
        fs.writeFileSync(metaFile, JSON.stringify({ hash, at: Date.now(), from: 'fixate' }, null, 2), 'utf8');
      };
      const pagesRoot = path.join(dataDir, 'pages');
      if (fsExists(pagesRoot)) {
        for (const d of fs.readdirSync(pagesRoot, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          writeMeta(path.join(dir, d.name), path.join(pagesRoot, d.name, 'source-meta.json'));
        }
      }
      writeMeta(path.join(dir, 'index.html'), path.join(dataDir, 'source-meta.json'));
    } catch (e) { /* ignore */ }
  }


  /** 把覆写条目生成真实 CSS：不依赖 ve-applied.js，源码直接生效 */
  function appliedCssSelector(key) {
    const k = String(key || "");
    if (k.indexOf("sel:") === 0) return k.slice(4).trim();
    if (k.indexOf("id:") === 0) return "#" + k.slice(3).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
    return "";
  }
  function appliedCssProp(name) {
    return String(name || "").replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }
  function buildAppliedCss(entries) {
    const lines = [];
    for (const key of Object.keys(entries || {})) {
      const e = entries[key];
      if (!e || typeof e !== "object" || e.__overlay) continue;
      const sel = appliedCssSelector(key);
      if (!sel) continue;
      const props = [];
      if (e.hidden) props.push("display:none !important");
      if (e.style && typeof e.style === "object") {
        for (const p of Object.keys(e.style)) {
          const v = e.style[p];
          if (v == null || v === "") continue;
          props.push(appliedCssProp(p) + ":" + String(v) + " !important");
        }
      }
      if (props.length) lines.push(sel + "{" + props.join(";") + ";}");
    }
    return lines.join("\n");
  }
  function htmlSlugOf(rel) {
    let p = "/" + String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    try { p = decodeURIComponent(p); } catch (e) { /* keep */ }
    if (p === "/" || /\/index\.html?$/i.test(p)) return "";
    return p.replace(/^\/+/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "");
  }

  function fixateProject(dir, opts = {}) {
    const projectDir = String(dir || (lastContext && lastContext.dir) || '').trim();
    if (!projectDir || !fsExists(projectDir)) return { ok: false, error: '项目目录无效：' + projectDir };
    const dataDir = path.join(projectDir, '.ve-data');
    const overridesFile = path.join(dataDir, 'overrides.json');
    const readOv = (p) => { try { return JSON.parse(readTextSafe(p, 8000000) || '{}') || {}; } catch (e) { return {}; } };
    const baseOverrides = readOv(overridesFile);
    const pageOverrides = {};
    try {
      const pagesRoot = path.join(dataDir, 'pages');
      for (const d of fs.readdirSync(pagesRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = path.join(pagesRoot, d.name, 'overrides.json');
        if (!fsExists(p)) continue;
        const o = readOv(p);
        if (Object.keys(o).length) pageOverrides[d.name] = o;
      }
    } catch (e) { /* ignore */ }
    const overrides = baseOverrides;
    // 固化 CSS 用原始 px/box（保留拖拽后的真实尺寸）；响应式转换只用于 Vite 的 JS 运行时
    const rawBaseOverrides = JSON.parse(JSON.stringify(baseOverrides || {}));
    const rawPageOverrides = JSON.parse(JSON.stringify(pageOverrides || {}));
    const keys = Object.keys(baseOverrides || {});
    const totalKeys = keys.length + Object.values(pageOverrides).reduce((n, o) => n + Object.keys(o).length, 0);
    if (!totalKeys) return { ok: false, error: '还没有保存过修改（先点一次「保存」再固化）' };

    // 识别项目类型与入口
    const hasPkg = fsExists(path.join(projectDir, 'package.json'));
    let pkg = {};
    try { pkg = hasPkg ? JSON.parse(readTextSafe(path.join(projectDir, 'package.json'), 200000) || '{}') : {}; } catch (e) { pkg = {}; }
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const isVite = Boolean(deps.vite || deps['@vitejs/plugin-react'] || deps.react) || fsExists(path.join(projectDir, 'vite.config.js')) || fsExists(path.join(projectDir, 'vite.config.ts'));
    const findEntryJs = () => {
      const cands = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js', 'main.js', 'main.ts'];
      for (const c of cands) if (fsExists(path.join(projectDir, c))) return c;
      return '';
    };
    const findEntryHtml = () => {
      const cands = ['index.html', 'public/index.html', 'src/index.html'];
      for (const c of cands) if (fsExists(path.join(projectDir, c))) return c;
      try {
        const hits = fs.readdirSync(projectDir).filter((n) => /\.html?$/i.test(n));
        if (hits.length) return hits[0];
      } catch (e) { /* ignore */ }
      return '';
    };

    // 生成自包含运行脚本
    const LAYOUT_PROPS = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height", "left", "right", "top", "bottom", "inset", "transform", "position", "flex", "flex-basis", "align-self", "justify-self", "grid-column", "grid-row", "box-sizing", "font-size", "line-height", "letter-spacing"]);
    const pxNum = (v) => { const m = String(v == null ? "" : v).match(/^(-?[\d.]+)px$/i); return m ? Number(m[1]) : null; };
    const pctOf = (n, base) => (base > 0 ? (n / base * 100).toFixed(3).replace(/\.?0+$/, "") + "%" : null);
    const stripLayoutForFixate = (obj, vwFallback) => {
      for (const [key, entry] of Object.entries(obj || {})) {
        if (!entry || typeof entry !== "object") continue;
        const isTextKey = /(^|\s|>)(p|h[1-6]|span|a|button|label|li|em|strong)$/i.test(String(key).trim());
        const ref = entry.ref && typeof entry.ref === "object" ? entry.ref : {};
        const vw = Number(ref.vw) || Number(vwFallback) || 0;
        const vh = Number(ref.vh) || Math.round(vw * 0.56) || 0;
        const pw = Number(ref.pw) || vw;
        const ph = Number(ref.ph) || vh;
        const box = entry.box && typeof entry.box === "object" ? entry.box : null;
        entry.style = entry.style && typeof entry.style === "object" ? entry.style : {};
        const style = entry.style;
        const hasParent = Number(ref.pw) > 0 && Number(ref.ph) > 0;
        const w = box && Number.isFinite(Number(box.width)) ? Number(box.width) : pxNum(style.width);
        const h = box && Number.isFinite(Number(box.height)) ? Number(box.height) : pxNum(style.height);
        if (!isTextKey && w != null && w > 0 && vw > 0) { style.width = hasParent ? pctOf(w, pw) : (w / vw * 100).toFixed(3).replace(/\.?0+$/, "") + "vw"; style["max-width"] = "100%"; style["box-sizing"] = "border-box"; }
        else if (style.width && pxNum(style.width) != null) delete style.width;
        if (!isTextKey && h != null && h > 0 && vh > 0) style.height = hasParent ? pctOf(h, ph) : (h / vh * 100).toFixed(3).replace(/\.?0+$/, "") + "vh";
        else if (style.height && pxNum(style.height) != null) delete style.height;
        // 位移不做相对固化：静态流里的 left/top 会把页面推出窗口产生横向滚动条
        if (style.position === "relative" && !style.left && !style.top) delete style.position;
        if (isTextKey) {
          delete style.width; delete style.height;
          delete style.left; delete style.right; delete style.top; delete style.bottom;
        }
        for (const k of Object.keys(style)) {
          const lk = String(k).toLowerCase();
          const v = style[k];
          if (lk === "font-size") {
            const px = pxNum(v);
            if (px != null && vw > 0 && px > 0) style[k] = "clamp(" + Math.max(10, Math.round(px * 0.7)) + "px, " + (px / vw * 100).toFixed(2) + "vw, " + Math.round(px * 1.12) + "px)";
            continue;
          }
          if ((lk === "line-height" || lk === "letter-spacing") && pxNum(v) != null) { delete style[k]; continue; }
          if ((lk.startsWith("margin") || lk.startsWith("padding")) && pxNum(v) != null && pw > 0) { style[k] = pctOf(pxNum(v), pw); continue; }
          if (LAYOUT_PROPS.has(lk) && pxNum(v) != null) delete style[k];
        }
        if (entry.attrs && typeof entry.attrs === "object") {
          for (const k of Object.keys(entry.attrs)) if (["width", "height", "style"].includes(String(k).toLowerCase())) delete entry.attrs[k];
        }
        delete entry.box;
      }
    };
    stripLayoutForFixate(baseOverrides, Number(opts.vw) || 0);
    for (const o of Object.values(pageOverrides)) stripLayoutForFixate(o, Number(opts.vw) || 0);
    const script = buildAppliedScript({ base: baseOverrides, pages: pageOverrides });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(dataDir, 'backups', 'fixate-' + stamp);
    const written = [];
    const backupFile = (p) => {
      try {
        if (!fsExists(p)) return;
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(p, path.join(backupDir, path.basename(p)));
      } catch (e) { /* ignore */ }
    };

    if (isVite) {
      const entryJs = findEntryJs();
      const target = path.join(projectDir, 'src', 've-applied.js');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, script, 'utf8');
      written.push('src/ve-applied.js');
      if (!entryJs) return { ok: false, error: '找不到 Vite 入口（src/main.*），已生成 src/ve-applied.js，请手动在入口 import "./ve-applied.js"' };
      const entryPath = path.join(projectDir, entryJs);
      backupFile(entryPath);
      let src = readTextSafe(entryPath, 500000) || '';
      if (!src.includes('ve-applied.js')) {
        src = src.replace(/(^[\s\S]*?)(\r?\n)/, '$1$2/* dsh-ui-editor: 固化覆写 */\nimport "./ve-applied.js";\n');
        fs.writeFileSync(entryPath, src, 'utf8');
        written.push(entryJs + '（已加 import）');
      }
      const synced2 = syncWorkbenchToPlugin(projectDir);
      return {
        ok: true,
        mode: 'vite',
        files: written,
        backupDir: fsExists(backupDir) ? backupDir : '',
        keys: keys.length,
        synced: synced2,
        message: '已固化：' + written.join(' / ') + (synced2.length ? '；并已同步到插件目录' : ''),
      };
    }

    // 静态站：把覆写直接写成 HTML 内的真实 CSS（不再依赖 ve-applied.js）
    const htmlRel = findEntryHtml();
    if (!htmlRel) return { ok: false, error: '找不到入口 HTML（index.html）' };
    const oldScript = path.join(projectDir, 've-applied.js');
    if (fsExists(oldScript)) {
      backupFile(oldScript);
      try { fs.unlinkSync(oldScript); written.push('移除旧 ve-applied.js'); } catch (e) { /* ignore */ }
    }
    const htmlFiles = [];
    const walkHtml = (abs, depth) => {
      if (depth > 3 || htmlFiles.length > 60) return;
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.') && ent.name !== '.well-known') continue;
        if (['node_modules', '.ve-data', 'dist', 'build', 'out'].includes(ent.name)) continue;
        const p = path.join(abs, ent.name);
        if (ent.isDirectory()) walkHtml(p, depth + 1);
        else if (/\.html?$/i.test(ent.name)) htmlFiles.push(p);
      }
    };
    walkHtml(projectDir, 0);
    if (!htmlFiles.includes(path.join(projectDir, htmlRel))) htmlFiles.unshift(path.join(projectDir, htmlRel));
    let injectedCount = 0;
    for (const htmlPath of htmlFiles) {
      const rel = path.relative(projectDir, htmlPath).split(path.sep).join('/');
      const slug = htmlSlugOf(rel);
      const merged = Object.assign({}, rawBaseOverrides, rawPageOverrides[slug] || {});
      const css = buildAppliedCss(merged);
      if (!css) continue;
      let html = readTextSafe(htmlPath, 8000000) || '';
      backupFile(htmlPath);
      // 去掉历史 script 注入
      html = html.replace(/\s*<script[^>]*ve-applied[^>]*><\/script>/gi, '');
      const styleTag = '\n<style id="ve-applied-style" data-ve-applied-style="1">\n/* dsh-ui-editor: 应用改动到源码（真实 CSS） */\n' + css + '\n</style>\n';
      const styleRe = /<style[^>]*id=["']ve-applied-style["'][^>]*>[\s\S]*?<\/style>/i;
      if (styleRe.test(html)) html = html.replace(styleRe, styleTag);
      else if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, styleTag + '</body>');
      else html = html + styleTag;
      fs.writeFileSync(htmlPath, html, 'utf8');
      injectedCount += 1;
    }
    if (injectedCount) written.push(injectedCount + ' 个 HTML 已写入真实 CSS');
    const synced = syncWorkbenchToPlugin(projectDir);
    return {
      ok: true,
      mode: 'static',
      files: written,
      backupDir: fsExists(backupDir) ? backupDir : '',
      keys: keys.length,
      synced: synced,
      message: '已固化：' + written.join(' / ') + (synced.length ? '；并已同步到插件目录（刷新工作台即可看到）' : ''),
    };
  }

  /** 把工作区 workbench-ui 的文件同步到插件目录（DSH 实际从插件副本加载工作台） */
  function syncWorkbenchToPlugin(projectDir) {
    try {
      if (path.basename(String(projectDir || '')).toLowerCase() !== 'workbench-ui') return [];
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const targets = [
        path.join(home, '.dsh', 'plugins', 'dsh-ui-editor', 'lib', 'workbench-ui'),
        path.join(home, '.dsh', 'profiles', 'node_modules', 'dsh-ui-editor', 'lib', 'workbench-ui'),
        path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ui-editor', 'lib', 'workbench-ui'),
        path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-ui-editor', 'lib', 'workbench-ui'),
      ];
      const files = ['index.html', 'styles.css', 'app.js', 've-applied.js'];
      const done = [];
      for (const tdir of targets) {
        if (!fsExists(tdir)) continue;
        for (const f of files) {
          const src = path.join(projectDir, f);
          if (!fsExists(src)) continue;
          try { fs.copyFileSync(src, path.join(tdir, f)); done.push(path.basename(tdir) + '/' + f); } catch (e) { /* ignore */ }
        }
      }
      return done;
    } catch (e) { return []; }
  }

  /* ─────────── 页面缩略图（headless Edge/Chrome） ─────────── */

  function findBrowserExe() {
    const cands = [
      process.env.VE_BROWSER || "",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean);
    for (const p of cands) { try { if (fsExists(p)) return p; } catch { /* ignore */ } }
    return "";
  }

  function shotSlugOf(page) {
    return String(page || "/").replace(/^\/+/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "") || "index";
  }

  function capturePageShot(url, outFile, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const exe = findBrowserExe();
      if (!exe) { resolve({ ok: false, error: "找不到 Edge/Chrome，无法生成缩略图" }); return; }
      try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch { /* ignore */ }
      const profile = path.join(os.tmpdir(), "ve-shot-" + Math.random().toString(36).slice(2, 8));
      const child = spawn(exe, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--disable-extensions",
        "--window-size=480,320", "--virtual-time-budget=2500",
        "--screenshot=" + outFile, "--user-data-dir=" + profile, url,
      ], { stdio: "ignore", windowsHide: true });
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
        resolve(fsExists(outFile) ? { ok: true } : r);
      };
      child.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
      child.on("exit", () => finish({ ok: false, error: "截图进程退出但没生成文件" }));
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, error: "截图超时" }); }, timeoutMs);
    });
  }

  /** 扫描项目里其它 HTML 对某个页面的引用（用于删除前提示） */
  function pageLinksTo(dir, page) {
    const projectDir = String(dir || "").trim();
    const target = String(page || "").replace(/^\/+/, "");
    if (!projectDir || !target) return { ok: false, error: "缺少参数" };
    const info = manager.listPages(projectDir);
    if (!info || info.mode !== "static") return { ok: false, unsupported: true, count: 0, files: [], note: "Vite/SPA 不支持引用检查" };
    const roots = [projectDir];
    const files = [];
    const walk = (abs, depth) => {
      if (depth > 3 || files.length > 80) return;
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith(".") || ["node_modules", ".ve-data"].includes(ent.name)) continue;
        const p = path.join(abs, ent.name);
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (/\.html?$/i.test(ent.name)) files.push(p);
      }
    };
    walk(projectDir, 0);
    const targetBase = path.basename(target);
    const hit = [];
    for (const file of files) {
      const rel = path.relative(projectDir, file).split(path.sep).join("/");
      if (rel === target) continue;
      let html = "";
      try {
        if (fsStat(file).size > 3 * 1024 * 1024) continue;
        html = fsRead(file, "utf8");
      } catch { continue; }
      const re = /(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        const url = String(m[1] || "");
        if (!url || url.startsWith("#") || url.startsWith("http") || url.startsWith("mailto:")) continue;
        const clean = url.split("?")[0].split("#")[0].replace(/^\.\//, "");
        if (clean === target || clean === "/" + target || clean === targetBase || clean === "/" + targetBase) {
          hit.push({ file: rel, href: url });
          break;
        }
      }
    }
    return { ok: true, count: hit.length, files: [...new Set(hit.map((x) => x.file))], links: hit.slice(0, 20), note: hit.length ? "有其它页面链接到它，删除后这些链接会 404" : "没有其它页面链接到它" };
  }

  async function buildPageShots(dir, force) {
    const projectDir = String(dir || "").trim();
    const inst = manager.list().find((x) => path.resolve(x.dir) === path.resolve(projectDir));
    if (!inst) return { ok: false, error: "项目预览还没打开，请先打开项目" };
    if (inst.mode !== "static") return { ok: false, error: "Vite / SPA 项目暂不支持页面缩略图（静态站支持）" };
    const info = manager.listPages(projectDir);
    const pages = (info.pages || []).filter((p) => p && p.path).slice(0, 16);
    const shotsDir = path.join(projectDir, ".ve-data", "shots", "pages");
    const shots = {};
    const made = [];
    for (const p of pages) {
      const rel = p.path.replace(/^\/+/, "");
      const htmlAbs = path.join(inst.webRoot || projectDir, rel);
      const outFile = path.join(shotsDir, shotSlugOf(p.path) + ".png");
      let fresh = false;
      try { fresh = !force && fsExists(outFile) && fsStat(outFile).mtimeMs >= fsStat(htmlAbs).mtimeMs; } catch { fresh = false; }
      if (!fresh) {
        const url = "http://127.0.0.1:" + inst.port + encodeURI(p.path) + (p.path.indexOf("?") >= 0 ? "&" : "?") + "ve_shot=1";
        const r = await capturePageShot(url, outFile);
        if (!r.ok) { made.push(p.path + "：" + r.error); continue; }
        made.push(p.path);
      }
      try {
        const v = fsStat(outFile).mtimeMs;
        shots[p.path] = PREFIX + "/page-shot?dir=" + encodeURIComponent(projectDir) + "&page=" + encodeURIComponent(p.path) + "&v=" + Math.round(v);
      } catch { /* ignore */ }
    }
    return { ok: true, dir: projectDir, shots, generated: made, count: pages.length };
  }

  /** 生成自包含的固化脚本：内嵌覆写数据 + 纯 JS 应用（不依赖编辑器） */
  function buildAppliedScript(payload) {
    const isPaged = payload && typeof payload === "object" && payload.base !== undefined;
    const base = isPaged ? (payload.base || {}) : (payload || {});
    const pages = isPaged ? (payload.pages || {}) : {};
    const data = JSON.stringify({ base, pages }).replace(/<\//g, '<\\/');
    return `/* 由 DSH 网页修改器固化生成：把保存过的修改写进真实页面（不依赖编辑器内核）
 * 重新固化会覆盖本文件；删除本文件并移除入口里的引用即可还原。
 */
(function () {
  var DATA = ${data};
  // 按页面取覆写：入口页用 base，其它页面用 pages[slug] 覆盖
  function pageSlug() {
    try {
      var p = location.pathname || "/";
      try { p = decodeURIComponent(p); } catch (e) { /* keep */ }
      if (p === "/" || /\\/index\\.html?$/i.test(p)) return "";
      return p.replace(/^\\/+/, "").replace(/[^\\p{L}\\p{N}._-]+/gu, "_").replace(/^\\.+|\\.+$/g, "");
    } catch (e) { return ""; }
  }
  var OVERRIDES = {};
  try {
    var _b = DATA.base || {};
    for (var _k in _b) OVERRIDES[_k] = _b[_k];
    var _pg = (DATA.pages || {})[pageSlug()];
    if (_pg) for (var _k2 in _pg) OVERRIDES[_k2] = _pg[_k2];
  } catch (e) { /* ignore */ }
  // 编辑器预览里（URL 带 ve=1）由内核接管样式，这里不重复应用，避免内联样式与内核的 !important 规则冲突
  try {
    if (/[?&]ve=1([&#]|$)/.test(location.search) || document.documentElement.hasAttribute('data-ve-editor')) return;
  } catch (e) { /* ignore */ }
  function resolve(key) {
    try {
      if (key.indexOf('id:') === 0) return document.getElementById(key.slice(3));
      if (key.indexOf('sel:') === 0) return document.querySelector(key.slice(4));
      if (key.indexOf('overlay:') === 0) return null;
    } catch (e) { return null; }
    return null;
  }
  function paintOverlay(key, node) {
    try {
      if (!node) return;
      var el = document.createElement(node.tag === 'text' ? 'div' : node.tag || 'div');
      el.setAttribute('data-ve-applied-overlay', node.id || key.slice(8));
      var a = node.attrs || {};
      if (a.src) el.setAttribute('src', a.src);
      if (a.text) el.textContent = a.text;
      if (a.html) el.innerHTML = a.html;
      if (a.color) el.style.color = a.color;
      var s = node.style || {};
      el.style.cssText = 'position:absolute;left:' + (node.x || 0) + 'px;top:' + (node.y || 0) + 'px;width:' + (node.width || 200) + 'px;height:' + (node.height || 160) + 'px;z-index:' + (node.z || 900) + ';' + (node.rotate ? 'transform:rotate(' + node.rotate + 'deg);' : '');
      for (var k in s) { try { el.style[k] = s[k]; } catch (e) { /* ignore */ } }
      var ref = null;
      if (node.refKey) { try { ref = document.querySelector(node.refKey); } catch (e) { ref = null; } }
      var pin = node.pin || 'page';
      if (pin !== 'page' && node.refKey) ref = ref || document.body;
      var host = (pin === 'screen') ? document.body : (ref && ref.parentElement ? ref.parentElement : document.body);
      host.appendChild(el);
    } catch (e) { /* ignore */ }
  }
  function apply() {
    Object.keys(OVERRIDES).forEach(function (key) {
      var e = OVERRIDES[key];
      if (!e || typeof e !== 'object') return;
      if (e.__overlay) { paintOverlay(key, e.__overlay); return; }
      var node = resolve(key);
      if (!node) return;
      try {
        if (e.hidden) node.style.setProperty('display', 'none', 'important');
        if (e.style) for (var p in e.style) { var v = e.style[p]; if (v != null && v !== '') node.style.setProperty(p, String(v), 'important'); }
        if (typeof e.text === 'string' && node.textContent !== e.text) node.textContent = e.text;
        else if (typeof e.blockText === 'string' && node.innerHTML !== e.blockText) node.innerHTML = e.blockText;
        if (typeof e.image === 'string') {
          if (node.tagName === 'IMG') node.src = e.image;
          else { var img = node.querySelector('img'); if (img) img.src = e.image; }
        }
        if (e.attrs) for (var a in e.attrs) { if (e.attrs[a] == null) node.removeAttribute(a); else node.setAttribute(a, e.attrs[a]); }
        if (e.box) {
          node.style.transform = 'translate(' + (e.box.x || 0) + 'px,' + (e.box.y || 0) + 'px)';
          if (e.box.width) node.style.width = e.box.width + 'px';
          if (e.box.height) node.style.height = e.box.height + 'px';
        }
      } catch (err) { /* ignore */ }
    });
  }
  // 工作台这类页面是 app.js 异步渲染的（等父窗口 init），脚本执行时 #app 可能还是空的：
  // 先尝试，再用定时重试 + MutationObserver 在内容出现后补应用
  var tries = 0;
  function boot() {
    try { apply(); } catch (e) { /* ignore */ }
    var timer = setInterval(function () {
      tries += 1;
      try { apply(); } catch (e) { /* ignore */ }
      if (tries >= 24) clearInterval(timer);
    }, 150);
    try {
      var host = document.getElementById('app') || document.body;
      var mo = new MutationObserver(function () { try { apply(); } catch (e) { /* ignore */ } });
      mo.observe(host, { childList: true, subtree: true });
      setTimeout(function () { try { mo.disconnect(); } catch (e) { /* ignore */ } }, 6000);
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
  }

  /** 压缩成一段短提示：规范全文写进文件，对话里只发引用 */
  function buildShortStylePrompt(styleName, dir, briefFile) {
    const lines = [];
    lines.push('请按保存的 UI 风格「' + (styleName || '未命名') + '」优化项目：' + (dir || ''));
    if (briefFile) {
      lines.push('');
      lines.push('风格规范已写入文件（含完整 token 与执行要求）：');
      lines.push(briefFile);
      lines.push('');
      lines.push('请先读取这个文件（read 工具），把里面的颜色 / 字体 / 圆角 / 间距 / 动效 token 当作硬约束，再逐处修改页面样式：');
    } else {
      lines.push('（未能写入项目目录，规范见风格库 ' + (styleName || '') + '）');
    }
    lines.push('不要引入新的主色或第三种字体，不要重写整页结构；改完保存并说明用了哪些 token。');
    lines.push('中文排版注意：规范里的展示字体多是拉丁字体（如 Bodoni / Inter），中文需用同气质替代（标题可用思源宋体/宋体，正文用系统无衬线），并保证标题字重不低于 600，避免中文衬线在 500 字重下显得过细。');
    return lines.join('\n');
  }

  function composeStylePrompt(style, dir) {
    const brief = String(style.brief || '').slice(0, 6000);
    return [
      '请按这套 UI 风格优化项目：' + (dir || ''),
      '',
      '风格名：' + ((style.meta && style.meta.name) || '未命名') + (style.meta && style.meta.source ? '（提取自 ' + style.meta.source + '）' : ''),
      '',
      brief,
      '',
      '执行方式：先读取上面这份规范的抽象 token（颜色/字体/圆角/间距/动效）作为硬约束，再逐处修改该项目的样式；不要引入新的主色或字体，不要重写整页结构。改完用编辑器保存并说明用了哪些 token。',
    ].join('\n');
  }
  function computeStyleSpec(inputPath) {
    const start = String(inputPath || '').trim();
    if (!start) return { ok: false, error: '缺少规范路径' };
    let base = start;
    try { if (fsExists(base) && fsStat(base).isFile()) base = path.dirname(base); } catch (e) { /* ignore */ }
    if (!fsExists(base)) return { ok: false, error: '路径不存在：' + start };
    const pickFile = (names) => {
      for (const n of names) {
        const p = path.join(base, n);
        try { if (fsExists(p) && fsStat(p).isFile()) return p; } catch (e) { /* ignore */ }
      }
      return '';
    };
    const cand = {
      json: pickFile(['design-tokens.json', 'tokens.json', 'theme.json', 'design.json', 'variables.json']),
      css: pickFile(['design-tokens.css', 'tokens.css', 'theme.css', 'variables.css', 'ui-spec.css', 'styles.css']),
      md: pickFile(['UI-SPEC.md', 'STYLE.md', 'DESIGN.md', 'README.md']),
      html: pickFile(['ui-spec.html', 'style-guide.html', 'index.html']),
      fonts: pickFile(['fonts.css', 'font.css', 'typography.css']),
      cover: pickFile(['cover.png', 'cover.jpg', 'cover.webp', 'preview.png', 'preview.jpg', 'preview.webp', 'thumb.png', 'thumb.jpg', 'screenshot.png']),
    };
    const sources = [];
    let tokens = [];
    let meta = {};
    if (fsExists(cand.json)) {
      const text = readTextSafe(cand.json, 400000);
      if (text) {
        try {
          const n = normalizeTokensJson(JSON.parse(text));
          tokens = n.tokens;
          meta = n.meta || {};
          sources.push(cand.json);
        } catch (e) { /* ignore */ }
      }
    }
    if (!tokens.length && fsExists(cand.css)) {
      const text = readTextSafe(cand.css, 400000);
      if (text) { tokens = parseTokensCss(text); sources.push(cand.css); }
    }
    if (!tokens.length && fsExists(cand.html)) {
      const text = readTextSafe(cand.html, 800000);
      if (text) { tokens = parseTokensCss(text); sources.push(cand.html); }
    }
    let mdText = '';
    if (fsExists(cand.md)) { mdText = readTextSafe(cand.md, 60000); sources.push(cand.md); }
    if (!tokens.length && !mdText) return { ok: false, error: '没找到 token 文件或规范文件（支持 design-tokens.json / tokens.json / theme.json / *.css / UI-SPEC.md / README.md）' };
    const found = [];
    for (const k of ['json', 'css', 'md', 'html', 'fonts', 'cover']) {
      if (cand[k]) found.push({ kind: k, path: cand[k] });
    }
    const pick = (kind, n) => tokens.filter((x) => x.kind === kind).slice(0, n || 12);
    const spec = {
      name: String(meta.name || path.basename(base) || '未命名风格'),
      version: String(meta.version || ''),
      referenceViewport: String(meta.referenceViewport || ''),
      sources: sources,
      colors: pick('color', 24),
      fonts: pick('font', 8),
      radii: pick('radius', 8),
      shadows: pick('shadow', 8),
      spacing: pick('space', 20),
      motion: pick('motion', 8),
      other: pick('other', 20),
      notes: mdText ? mdText.slice(0, 6000) : '',
    };
    spec.found = found;
    return { ok: true, base: base, spec: spec, found: found, summary: { name: spec.name, colors: spec.colors.slice(0, 8), fonts: spec.fonts, radii: spec.radii.slice(0, 4), found: found.map((f) => path.basename(f.path)) } };
  }
  function buildStyleBrief(spec, projectDir) {
    const colorBlock = (spec.colors || []).map((c) => '- `' + c.name + '`: `' + c.value + '`' + (c.role ? ' — ' + c.role : '')).join('\n') || '- （无）';
    const fontBlock = (spec.fonts || []).map((f) => '- `' + f.name + '`: ' + f.value).join('\n') || '- （无）';
    const radiusBlock = (spec.radii || []).map((r) => '- `' + r.name + '`: ' + r.value).join('\n') || '- （无）';
    const spacingBlock = (spec.spacing || []).map((s) => s.name + ': ' + s.value).join('; ') || '- （无）';
    const jsonBlock = JSON.stringify({
      colors: spec.colors,
      fonts: spec.fonts,
      radii: spec.radii,
      shadows: spec.shadows,
      spacing: spec.spacing,
      motion: spec.motion,
    }, null, 2);
    const lines = [];
    lines.push('# UI 风格规范（按此规范优化页面）');
    lines.push('');
    lines.push('- 项目：' + (projectDir || ''));
    lines.push('- 规范名：' + spec.name + (spec.version ? ' v' + spec.version : ''));
    lines.push('- 来源文件：' + ((spec.sources || []).join(', ') || '（未知）'));
    lines.push('');
    lines.push('## 抽象参数（硬约束）');
    lines.push('```json');
    lines.push(jsonBlock);
    lines.push('```');
    lines.push('');
    lines.push('## 颜色');
    lines.push(colorBlock);
    lines.push('');
    lines.push('## 字体');
    lines.push(fontBlock);
    lines.push('');
    lines.push('## 圆角');
    lines.push(radiusBlock);
    lines.push('');
    lines.push('## 间距 token');
    lines.push(spacingBlock);
    lines.push('');
    lines.push('## 原始规范摘录（仅作理解参考，不要照抄 HTML）');
    lines.push(spec.notes ? spec.notes.slice(0, 3000) : '（无）');
    lines.push('');
    lines.push('## 中文排版注意');
    lines.push('- 规范中的展示字体多为拉丁字体（Bodoni Moda / Inter 等），中文没有对应字重时容易显得过细。');
    lines.push('- 中文标题建议使用同气质替代字体（思源宋体 / 宋体 / 思源黑体等），字重要比规范数值更实一档（≥600）。');
    lines.push('- 拉丁字体只用于英文单词、数字与标签，避免整段中文落到细体衬线。');
    lines.push('');
    lines.push('## 执行要求');
    lines.push('1. 只允许使用上面的颜色、字体、圆角、间距体系，不要引入新的主色或第三种字体。');
    lines.push('2. 修改现有页面时优先调整现有元素的样式与排布，不重写整页结构。');
    lines.push('3. 保持可读性与对比度；强调色只用于按钮/高亮/数据等少量位置。');
    lines.push('4. 改完后保存，并在总结里列出使用了哪些 token。');
    return lines.join('\n');
  }
  const route = {
    kind: "prefix",
    path: PREFIX,
    handler: async (req, res) => {
      applyCors(req, res);
      if ((req.method || "").toUpperCase() === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const sub = url.pathname.slice(PREFIX.length) || "/";
      const method = (req.method || "GET").toUpperCase();
      try {
        if (sub === "/ping") {
          sendJson(res, 200, { ok: true, name, version: "1.1.13", pid: process.pid, auxPort });
          return;
        }
        // 前端样式诊断：客户端把 computed 样式 + 命中的 CSS 规则发回来，排查样式覆盖
        if (method === "POST" && sub === "/client-diag") {
          try {
            const body = await readJsonBody(req, 1024 * 1024);
            lastClientDiag = body && typeof body === "object" ? body : null;
            if (lastClientDiag) lastClientDiag.hostAt = Date.now();
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "GET" && sub === "/client-diag") {
          sendJson(res, 200, { ok: true, diag: lastClientDiag });
          return;
        }
        if (method === "GET" && sub === "/browse") {
          sendJson(res, 200, { ok: true, ...browse(url.searchParams.get("path") || "") });
          return;
        }
        if (method === "GET" && sub === "/default-dir") {
          const cands = [];
          try {
            const wr = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : null;
            const list = wr && typeof wr.list === "function" ? wr.list() : [];
            for (const w of list) if (w && w.path) cands.push(String(w.path));
          } catch { /* ignore */ }
          try {
            const ss = typeof ctx.get === "function" ? ctx.get("sessions") : null;
            const list = ss && typeof ss.list === "function" ? ss.list() : [];
            for (const s of list) {
              if (s && s.cwd) cands.push(String(s.cwd));
              if (s && s.workspace && s.workspace.path) cands.push(String(s.workspace.path));
            }
          } catch { /* ignore */ }
          try {
            const lo = manager.lastOpened && manager.lastOpened();
            if (lo && lo.dir) cands.push(path.dirname(String(lo.dir)));
          } catch { /* ignore */ }
          cands.push(process.cwd());
          let picked = "";
          for (const c of cands) {
            try {
              const r = browse(c);
              if (r && r.path) { picked = String(r.path); break; }
            } catch { /* 下一个 */ }
          }
          if (!picked) { try { picked = os.homedir(); } catch { picked = ""; } }
          sendJson(res, 200, { ok: Boolean(picked), path: picked, candidates: cands.slice(0, 8) });
          return;
        }
        if (method === "GET" && sub === "/detect") {
          sendJson(res, 200, { ok: true, ...detectProject(url.searchParams.get("path") || "") });
          return;
        }
        if (method === "GET" && sub === "/list") {
          sendJson(res, 200, { ok: true, instances: manager.list() });
          return;
        }
        if (method === "GET" && sub === "/ui/env") {
          const api = await getElectron().catch(() => null);
          const info = {
            ok: true,
            processType: process.type || "unknown",
            electronVersion: (process.versions && process.versions.electron) || "",
            nodeVersion: (process.versions && process.versions.node) || "",
            hasElectronApi: Boolean(api),
            apiKeys: api ? Object.keys(api).slice(0, 20) : [],
            hasBrowserWindow: Boolean(api && api.BrowserWindow),
            pid: process.pid,
          };
          try {
            const win = await appWindow();
            info.windowFound = Boolean(win);
            if (win) {
              const b = win.getBounds();
              info.windowBounds = { x: b.x, y: b.y, w: b.width, h: b.height };
              info.windowCount = (api && api.BrowserWindow ? api.BrowserWindow.getAllWindows().length : 0);
            }
          } catch (e) { info.windowError = String(e && e.message || e); }
          sendJson(res, 200, info);
          return;
        }
        if (method === "POST" && sub === "/ui/exec") {
          const body = await readJsonBody(req);
          const code = String(body.code || "");
          const win = await appWindow();
          if (!win) { sendJson(res, 503, { ok: false, error: "没有可用的 DSH 窗口" }); return; }
          try {
            const out = await win.webContents.executeJavaScript("(async()=>{ try { return JSON.stringify(await (async()=>{" + code + "})()); } catch(e){ return JSON.stringify({__error:String(e&&e.stack||e)}); } })()", true);
            let parsed = null;
            try { parsed = JSON.parse(out); } catch { parsed = { raw: String(out).slice(0, 4000) }; }
            sendJson(res, 200, { ok: true, result: parsed });
          } catch (e) {
            sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
          }
          return;
        }
        if (method === "GET" && sub === "/ui/screenshot") {
          const win = await appWindow();
          if (!win) { sendJson(res, 503, { ok: false, error: "没有可用的 DSH 窗口" }); return; }
          try {
            const img = await win.webContents.capturePage();
            const outDir = path.join(process.env.TEMP || ".", "dsh-ue-shots");
            fs.mkdirSync(outDir, { recursive: true });
            const file = path.join(outDir, "app-" + Date.now().toString(36) + ".png");
            fs.writeFileSync(file, img.toPNG());
            const size = img.getSize();
            sendJson(res, 200, { ok: true, path: file, size });
          } catch (e) { sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
          return;
        }
        if (method === "POST" && sub === "/ui/float-composer") {
          const body = await readJsonBody(req);
          const on = body.on !== false;
          // 位置可调：右侧边距 / 底部边距 / 宽度(vw) / 最大宽度(px)
          const wantsPosition = {
            right: Number(body.right) || 20,
            bottom: Number(body.bottom) || 18,
            widthVw: Number(body.widthVw) || 46,
            maxWidth: Number(body.maxWidth) || 720,
          };
          const win = await appWindow();
          if (!win) { sendJson(res, 503, { ok: false, error: "没有可用的 DSH 窗口" }); return; }
          const script = "(() => {" +
            "const allRoots = [document];" +
            "const seen = new Set();" +
            "const walkRoots = (root) => { if (!root || seen.has(root)) return; seen.add(root); for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { allRoots.push(el.shadowRoot); walkRoots(el.shadowRoot); } } };" +
            "try { walkRoots(document); } catch(e) {}" +
            "const cands = [];" +
            "for (const root of allRoots) { try { for (const el of root.querySelectorAll('textarea, [contenteditable=\"true\"], [contenteditable=\"\"], [role=\"textbox\"]')) cands.push(el); } catch(e) {} }" +
            "const visible = cands.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 80 && r.height > 10; });" +
            "const info = { rootCount: allRoots.length, candCount: cands.length, visibleCount: visible.length };" +
            "let target = visible.sort((a,b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;" +
            "if (!target) { for (const root of allRoots) { try { for (const el of root.querySelectorAll('[placeholder]')) { const ph = el.getAttribute('placeholder') || ''; if (/消息|message|输入|ask/i.test(ph)) { target = el; break; } } } catch(e) {} if (target) break; } }" +
            "if (!target) return JSON.stringify({ ...info, found: false });" +
            "let box = target;" +
            "for (let i = 0; i < 6 && box.parentElement; i++) { const r = box.getBoundingClientRect(); if (r.width > 260 && r.height > 44) break; box = box.parentElement; }" +
            "const br = box.getBoundingClientRect();" +
            "if (!on) { box.style.cssText = window.__UE_ORIGIN__ || ''; delete window.__UE_ORIGIN__; return JSON.stringify({ ...info, found: true, off: true }); }" +
            "const key = '__UE_ORIGIN__';" +
            "if (!window[key]) window[key] = box.style.cssText;" +
            "const anc = []; let n = box.parentElement; let d = 0;" +
            "while (n && n !== document.body && d < 8) { const cs = getComputedStyle(n); const props = []; if (cs.transform && cs.transform !== 'none') props.push('transform'); if (cs.filter && cs.filter !== 'none') props.push('filter'); if (cs.contain && cs.contain !== 'none') props.push('contain'); if (cs.display === 'none') props.push('display'); if (cs.overflow && cs.overflow !== 'visible') props.push('overflow'); for (const p of props) { try { n.style.setProperty(p, p === 'overflow' ? 'visible' : (p === 'display' ? 'block' : 'none'), 'important'); } catch(e) {} } if (props.length) anc.push(props.join(',')); n = n.parentElement; d += 1; }" +
            "box.setAttribute('data-ue-float','1');" +
            "box.style.cssText = 'position:fixed;right:' + P.right + 'px;bottom:' + P.bottom + 'px;width:min(' + P.maxWidth + 'px,' + P.widthVw + 'vw);max-height:42vh;z-index:2147483000;background:#fff;border:1px solid #e3e6ee;border-radius:14px;box-shadow:0 14px 38px rgba(15,23,42,.24);padding:6px;overflow:auto;display:block;visibility:visible';" +
            "const r2 = box.getBoundingClientRect();" +
            "return JSON.stringify({ ...info, found: true, boxTag: box.tagName, boxClass: String(box.className||'').slice(0,60), rect: { x: Math.round(r2.x), y: Math.round(r2.y), w: Math.round(r2.width), h: Math.round(r2.height) }, before: { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) }, ancestors: anc });" +
            "})()";
          try {
            const scriptWithPos = "const P = " + JSON.stringify(wantsPosition) + ";" + script;
            const raw = await win.webContents.executeJavaScript(scriptWithPos, true);
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch { parsed = { raw: String(raw).slice(0, 2000) }; }
            sendJson(res, 200, { ok: true, ...parsed });
          } catch (e) { sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
          return;
        }
        if (method === "GET" && sub === "/state") {
          const want = String(url.searchParams.get("dir") || "");
          const all = manager.list();
          const pick = all.find((x) => want && String(x.dir || "").toLowerCase() === want.toLowerCase()) || all[all.length - 1];
          let overrides = null;
          if (pick && pick.id) {
            try { overrides = await manager.proxy(pick.id, "overrides"); } catch { overrides = null; }
          }
          const dirKey = String((pick && pick.dir) || want || "").toLowerCase();
          sendJson(res, 200, {
            ok: true,
            dir: (pick && pick.dir) || want || "",
            id: pick ? pick.id : "",
            opened: all.map((x) => ({ id: x.id, dir: x.dir, mode: x.mode })),
            overrides: overrides || {},
            pendingOps: (opsQueue.get(dirKey) || []).length,
            selection: lastContext.selection || [],
            shotPath: lastContext.shotPath || "",
            agentSessionId,
            at: lastContext.at || 0,
          });
          return;
        }
        if (method === "GET" && sub === "/projects") {
          const all = manager.list();
          sendJson(res, 200, {
            ok: true,
            projects: all.map((p) => ({
              id: p.id,
              dir: p.dir,
              mode: p.mode || '',
              url: p.url || '',
              at: p.at || 0,
            })),
          });
          return;
        }
        if (method === "GET" && sub === "/ops") {
          const dir = String(url.searchParams.get("dir") || "").toLowerCase();
          const list = opsQueue.get(dir) || [];
          opsQueue.delete(dir);
          sendJson(res, 200, { ok: true, ops: list });
          return;
        }
        if (method === "POST" && sub === "/handoff") {
          const body = await readJsonBody(req);
          const text = String(body.text || "");
          if (!text) { sendJson(res, 400, { ok: false, error: "缺少 text" }); return; }
          const attempts = [];
          // 找当前会话：工具执行上下文捕获的优先，其次取最近有 prompt 的会话
          let sid = agentSessionId || "";
          if (!sid) {
            try {
              const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : null;
              const list = sessions && typeof sessions.list === "function" ? sessions.list() : [];
              const alive = list.filter((x) => x && x.id);
              alive.sort((a, b) => (Number(b.lastPromptAt) || 0) - (Number(a.lastPromptAt) || 0));
              sid = alive.length ? alive[0].id : "";
              attempts.push("sessions.list:" + list.length + "→" + (sid ? sid.slice(0, 10) : "none"));
            } catch (err) {
              attempts.push("sessions.list:fail(" + String((err && err.message) || err).slice(0, 80) + ")");
            }
          }
          // ① 直接投递到当前 Agent（最接近用户发消息，内部走 followup 队列）
          try {
            const agents = typeof ctx.get === "function" ? ctx.get("agents") : null;
            const agent = agents && typeof agents.get === "function" && sid ? agents.get(sid) : null;
            if (agent) {
              let msg = null;
              try {
                const helpers = loadLlmHelpers();
                msg = helpers.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
              } catch { msg = null; }
              if (agent.followup && msg) {
                try {
                  agent.followup(msg);
                  attempts.push("agents.followup:ok");
                  sendJson(res, 200, { ok: true, via: "agents.followup", sessionId: sid, attempts });
                  return;
                } catch (err) {
                  attempts.push("agents.followup:fail(" + String((err && err.message) || err).slice(0, 120) + ")");
                }
              }
              const sess = agent.session;
              if (sess && typeof sess.prompt === "function") {
                try {
                  const r2 = await sess.prompt([{ type: "text", text }], "queue");
                  if (!r2 || r2.ok !== false) {
                    attempts.push("agent.session.prompt:ok");
                    sendJson(res, 200, { ok: true, via: "agent.session.prompt", sessionId: sid, attempts });
                    return;
                  }
                  attempts.push("agent.session.prompt:reject");
                } catch (err) {
                  attempts.push("agent.session.prompt:fail(" + String((err && err.message) || err).slice(0, 120) + ")");
                }
              }
            } else {
              attempts.push("agents.get:none");
            }
          } catch (err) {
            attempts.push("agents:fail(" + String((err && err.message) || err).slice(0, 100) + ")");
          }
          const controller = typeof ctx.get === "function" ? ctx.get("sessionController") : null;
          if (controller && typeof controller.prompt === "function" && sid) {
            try {
              const ac = new AbortController();
              const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 15000);
              try {
                const out = await controller.prompt({
                  sessionId: sid,
                  content: [{ type: "text", text }],
                  mode: "queue",
                }, ac.signal);
                clearTimeout(timer);
                attempts.push("sessionController.prompt:ok");
                sendJson(res, 200, { ok: true, via: "host.prompt", sessionId: sid, attempts, out: out || null });
                return;
              } catch (err) {
                clearTimeout(timer);
                attempts.push("sessionController.prompt:fail(" + String((err && err.message) || err).slice(0, 120) + ")");
              }
            } catch (err) {
              attempts.push("sessionController:fail(" + String((err && err.message) || err).slice(0, 80) + ")");
            }
          } else {
            attempts.push("sessionController:" + (controller ? "present" : "missing") + ", sid=" + (sid || "none"));
          }
          sendJson(res, 200, { ok: false, sessionId: sid, attempts });
          return;
        }
        if (method === "POST" && sub === "/context") {
          const body = await readJsonBody(req);
          const dir = String(body.dir || (lastOpened && lastOpened.dir) || "");
          let shotPath = lastContext.shotPath || "";
          try {
            if (body.shot && typeof body.shot === "string" && body.shot.startsWith("data:image/") && dir) {
              const m = body.shot.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/i);
              if (m) {
                const shotsDir = path.join(dir, ".ve-data", "shots");
                fs.mkdirSync(shotsDir, { recursive: true });
                const file = path.join(shotsDir, Date.now().toString(36) + "." + m[1].toLowerCase());
                fs.writeFileSync(file, Buffer.from(m[2], "base64"));
                // 同时维护 latest.png，方便 agent / 用户固定路径引用
                try { fs.copyFileSync(file, path.join(shotsDir, "latest.png")); } catch { /* ignore */ }
                shotPath = file;
              }
            }
          } catch (e) { log("保存框选截图失败：" + String(e?.message || e)); }
          lastContext = {
            dir,
            selection: Array.isArray(body.selection) ? body.selection.slice(0, 40) : [],
            shotPath,
            at: Date.now(),
          };
          sendJson(res, 200, { ok: true, dir, shotPath, latest: shotPath ? path.join(dir, ".ve-data", "shots", "latest.png") : "" });
          return;
        }
        if (method === "GET" && sub === "/pages") {
          const dir = String(url.searchParams.get("dir") || "");
          try {
            sendJson(res, 200, { ok: true, ...manager.listPages(dir) });
          } catch (e) {
            sendJson(res, 200, { ok: false, pages: [], error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/page-shots") {
          const body = await readJsonBody(req);
          try {
            const r = await buildPageShots(String(body.dir || (lastContext && lastContext.dir) || ""), Boolean(body.force));
            sendJson(res, 200, r);
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "GET" && sub === "/page-shot") {
          try {
            const dir = String(url.searchParams.get("dir") || "");
            const page = String(url.searchParams.get("page") || "/");
            const file = path.join(dir, ".ve-data", "shots", "pages", shotSlugOf(page) + ".png");
            if (!fsExists(file)) { sendJson(res, 404, { ok: false, error: "还没有生成缩略图" }); return; }
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            createReadStream(file).pipe(res);
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/page-nav-remove") {
          const body = await readJsonBody(req);
          try { sendJson(res, 200, manager.removePageNav(String(body.dir || (lastContext && lastContext.dir) || ""))); }
          catch (e) { sendJson(res, 400, { ok: false, error: String((e && e.message) || e) }); }
          return;
        }
        if (method === "POST" && sub === "/page-nav") {
          const body = await readJsonBody(req);
          try {
            sendJson(res, 200, manager.injectPageNav(String(body.dir || (lastContext && lastContext.dir) || "")));
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "GET" && sub === "/page-trash") {
          try {
            const dir3 = String(url.searchParams.get("dir") || (lastContext && lastContext.dir) || "");
            sendJson(res, 200, manager.listPageBackups(dir3));
          } catch (e) {
            sendJson(res, 200, { ok: false, backups: [], error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/page-restore") {
          const body = await readJsonBody(req);
          try {
            const dir4 = String(body.dir || (lastContext && lastContext.dir) || "");
            const r = manager.restorePageBackup(dir4, String(body.backup || body.name || ""));
            sendJson(res, 200, { ok: true, ...r, pages: manager.listPages(dir4).pages || [] });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "GET" && sub === "/page-links") {
          try {
            sendJson(res, 200, pageLinksTo(String(url.searchParams.get("dir") || ""), String(url.searchParams.get("page") || "")));
          } catch (e) {
            sendJson(res, 200, { ok: false, count: 0, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/page-manage") {
          const body = await readJsonBody(req);
          const dir2 = String(body.dir || (lastContext && lastContext.dir) || "");
          const action = String(body.action || "");
          const page = String(body.page || "");
          const to = String(body.to || "");
          try {
            let made = null;
            if (action === "delete") made = manager.deletePage(dir2, page);
            else if (action === "rename") made = manager.renamePage(dir2, page, to);
            else if (action === "copy") made = manager.copyPage(dir2, page, to);
            else throw new Error("未知操作：" + action);
            sendJson(res, 200, { ok: true, ...made, pages: manager.listPages(dir2).pages || [] });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/page-create") {
          const body = await readJsonBody(req);
          try {
            const made = manager.createPage(String(body.dir || (lastContext && lastContext.dir) || ""), String(body.name || ""), {
              template: body.template === "copy" ? "copy" : "blank",
              backLink: body.backLink !== false,
            });
            sendJson(res, 200, { ok: true, ...made, ...{ pages: manager.listPages(String(body.dir || (lastContext && lastContext.dir) || "")).pages || [] } });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/page") {
          const body = await readJsonBody(req);
          try {
            const info = await manager.setPage(String(body.id || ""), String(body.page || "/"));
            lastOpened = { ...info, openedAt: Date.now(), source: "ui" };
            sendJson(res, 200, { ok: true, ...info });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (method === "POST" && sub === "/open") {
          const body = await readJsonBody(req);
          if (!body.dir) {
            sendJson(res, 400, { ok: false, error: "缺少 dir" });
            return;
          }
          const info = await manager.open({
            dir: String(body.dir),
            contentJson: body.contentJson ? String(body.contentJson) : undefined,
            publicDir: body.publicDir ? String(body.publicDir) : undefined,
            cssOut: body.cssOut ? String(body.cssOut) : undefined,
          });
          let finalInfo = info;
          if (body.page) {
            try { finalInfo = await manager.setPage(info.id, String(body.page)); } catch (e) { /* 页面无效就停在入口页 */ }
          }
          lastOpened = { ...finalInfo, openedAt: Date.now(), source: body.source === "agent" ? "agent" : "ui" };
          sendJson(res, 200, { ok: true, ...finalInfo });
          return;
        }
        if (method === "POST" && sub === "/close") {
          const body = await readJsonBody(req);
          sendJson(res, 200, { ok: true, ...(await manager.close(String(body.id || ""))) });
          return;
        }
        if (method === "GET" && sub === "/ai-native-status") {
          const route = nativeModel();
          sendJson(res, 200, { ok: true, available: nativeAvailable(), model: route.provider ? route : null });
          return;
        }
        if (method === "POST" && sub === "/ai-native") {
          const body = await readJsonBody(req);
          const result = await runNativeAi({
            instruction: String(body.instruction || ""),
            selection: body.selection || null,
            context: String(body.context || "") + (lastContext.shotPath ? "\n【框选截图】" + lastContext.shotPath : ""),
          });
          sendJson(res, 200, result);
          return;
        }        if (method === "GET" && sub === "/session") {
          sendJson(res, 200, { ok: true, session: lastOpened || manager.lastOpened() });
          return;
        }
        if (method === "GET" && sub === "/backups") {
          const data = await manager.proxy(String(url.searchParams.get("id") || ""), "backups");
          sendJson(res, 200, data);
          return;
        }
        if (method === "GET" && sub === "/history") {
          const data = await manager.proxy(String(url.searchParams.get("id") || ""), "history");
          sendJson(res, 200, data);
          return;
        }
        if (method === "POST" && sub === "/restore-backup") {
          const body = await readJsonBody(req);
          const data = await manager.proxy(String(body.id || ""), "restore", { id: String(body.backupId || "") });
          sendJson(res, 200, data);
          return;
        }
        if (method === "POST" && sub === "/ai") {
          const body = await readJsonBody(req);
          const data = await manager.proxy(String(body.id || ""), "ai", {
            instruction: String(body.instruction || ""),
            selection: body.selection || null,
            context: String(body.context || ""),
            history: Array.isArray(body.history) ? body.history : [],
          });
          sendJson(res, 200, data);
          return;
        }
        if (method === "GET" && sub === "/ai-status") {
          const cfg = await manager.proxy(String(url.searchParams.get("id") || ""), "config");
          sendJson(res, 200, { ok: true, ai: cfg?.ai || null, contentJson: cfg?.contentJson || "" });
          return;
        }
        if (method === "POST" && sub === "/ai-config") {
          const body = await readJsonBody(req);
          const data = await manager.proxy(String(body.id || ""), "ai-config", {
            baseURL: body.baseURL || undefined,
            apiKey: body.apiKey || undefined,
            model: body.model || undefined,
          });
          sendJson(res, 200, data);
          return;
        }
        if (method === 'POST' && sub === '/style/extract') {
          const body = await readJsonBody(req);
          sendJson(res, 200, computeStyleSpec(body.path || body.dir || ''));
          return;
        }
        if (method === 'POST' && sub === '/style/save') {
          const body = await readJsonBody(req);
          const dir = String(body.dir || '').trim();
          if (!dir) { sendJson(res, 400, { ok: false, error: '缺少项目目录 dir' }); return; }
          if (!fsExists(dir)) { sendJson(res, 400, { ok: false, error: '项目目录不存在：' + dir }); return; }
          const r = computeStyleSpec(body.path || body.dir || '');
          if (!r.ok) { sendJson(res, 200, r); return; }
          const spec = r.spec;
          const brief = buildStyleBrief(spec, dir);
          const outDir = path.join(dir, '.ve-data');
          try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
          const specFile = path.join(outDir, 'style-spec.json');
          const briefFile = path.join(outDir, 'style-brief.md');
          try {
            fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');
            fs.writeFileSync(briefFile, brief, 'utf8');
          } catch (e) {
            sendJson(res, 500, { ok: false, error: '写入失败：' + String(e && e.message || e) });
            return;
          }
          sendJson(res, 200, { ok: true, specFile: specFile, briefFile: briefFile, summary: r.summary, brief: brief });
          return;
        }
        if (method === 'GET' && sub === '/styles') {
          sendJson(res, 200, { ok: true, styles: listStyles() });
          return;
        }
        if (method === 'GET' && sub === '/styles/font.css') {
          const id = styleIdSafe(url.searchParams.get('id') || '');
          try {
            const dir = path.join(styleRoot(), id);
            let css = '';
            const local = path.join(dir, 'fonts.css');
            if (fsExists(local)) css = readTextSafe(local, 4000000);
            if (!css) {
              try {
                const meta = JSON.parse(readTextSafe(path.join(dir, 'meta.json'), 100000) || '{}');
                const src = String(meta.source || '');
                if (src) {
                  const cand = fsStat(src).isDirectory ? path.join(src, 'fonts.css') : path.join(path.dirname(src), 'fonts.css');
                  if (fsExists(cand)) css = readTextSafe(cand, 4000000);
                }
              } catch (e) { /* ignore */ }
            }
            res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
            res.end(css || '/* no fonts */');
          } catch (e) { res.writeHead(404); res.end('not found'); }
          return;
        }
        if (method === 'GET' && sub === '/styles/cover.svg') {
          const id = styleIdSafe(url.searchParams.get('id') || '');
          try {
            const file = path.join(styleRoot(), id, 'cover.svg');
            const svg = readTextSafe(file, 200000) || coverSvgFor({ name: id, colors: [] });
            res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
            res.end(svg);
          } catch (e) { res.writeHead(404); res.end('not found'); }
          return;
        }
        if (method === 'GET' && sub === '/styles/file') {
          const id = styleIdSafe(url.searchParams.get('id') || '');
          const name = path.basename(String(url.searchParams.get('name') || '').replace(/[^a-zA-Z0-9._-]/g, ''));
          if (!id || !/\.(png|jpe?g|webp|svg|gif)$/i.test(name)) { res.writeHead(404); res.end('not found'); return; }
          const file = path.join(styleRoot(), id, name);
          try {
            if (!fsExists(file) || !fsStat(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
            const ext = path.extname(name).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
            const buf = fs.readFileSync(file);
            res.writeHead(200, { 'content-type': mime + '; charset=utf-8', 'cache-control': 'no-cache', 'content-length': buf.length });
            res.end(buf);
          } catch (e) { res.writeHead(404); res.end('not found'); }
          return;
        }
        if (method === 'POST' && sub === '/styles/add') {
          const body = await readJsonBody(req);
          sendJson(res, 200, addStyleFromPath(body.path || '', body.name || ''));
          return;
        }
        if (method === 'POST' && sub === '/styles/remove') {
          const body = await readJsonBody(req);
          sendJson(res, 200, removeStyle(body.id || ''));
          return;
        }
        if (method === 'POST' && sub === '/styles/apply') {
          const body = await readJsonBody(req);
          const st = readStyle(body.id || '');
          if (!st.spec) { sendJson(res, 200, { ok: false, error: '风格不存在' }); return; }
          const dir = String(body.dir || '').trim();
          const styleName = (st.meta && st.meta.name) || '';
          const backupDir = dir && fsExists(dir) ? backupProjectForStyle(dir, styleName) : '';
          const full = composeStylePrompt(st, dir);
          let briefFile = '';
          if (dir && fsExists(dir)) {
            try {
              const outDir = path.join(dir, '.ve-data');
              fs.mkdirSync(outDir, { recursive: true });
              briefFile = path.join(outDir, 'style-brief.md');
              fs.writeFileSync(briefFile, full, 'utf8');
            } catch (e) { /* ignore */ }
          }
          const shortText = buildShortStylePrompt(styleName, dir, briefFile);
          sendJson(res, 200, { ok: true, text: shortText, briefFile: briefFile, backupDir: backupDir, fullText: full, style: { id: body.id, name: styleName } });
          return;
        }
        if (method === 'GET' && sub === '/fixate-status') {
          const dir = String(url.searchParams.get('dir') || (lastContext && lastContext.dir) || '');
          const st = fixateStatusOf(dir);
          sendJson(res, 200, Object.assign({ ok: true, dir: dir }, st));
          return;
        }

        if (method === 'POST' && sub === '/fixate') {
          let body = {};
          try { body = await readJsonBody(req); } catch (e) { body = {}; }
          const r = fixateProject(body.dir || '', { vw: Number(body.vw) || 0 });
          if (!r.ok) { sendJson(res, 200, r); return; }
          refreshFixateSourceMeta(String(body.dir || ''));
          log('已固化到源码：' + (r.files || []).join(', '));
          sendJson(res, 200, Object.assign({ message: '已固化：' + (r.files || []).join(' / ') }, r, r.message ? { message: r.message } : {}));
          return;
        }

        if (method === 'GET' && sub === '/ui-command') {
          const cmd = pendingUiCommand;
          pendingUiCommand = null;
          sendJson(res, 200, { ok: true, command: cmd });
          return;
        }
        sendJson(res, 404, { ok: false, error: "未知接口 " + sub });
      } catch (err) {
        log("接口出错", String(err?.stack || err));
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  };

  // 前缀路由接管 /ve/plugin/*；返回 disposer 交给 cordis 生命周期
  ctx.effect(() => ctx.webServer.register(route), "dsh-ui-editor: /ve/plugin 路由");

  /* 工作台前端（独立静态项目）：/ve/wb/*  →  lib/workbench-ui/ */
  let wbRoute = null;
  try {
    const WB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "workbench-ui");
    const WB_MIME = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".webp": "image/webp",
      ".woff2": "font/woff2",
    };
    wbRoute = {
      kind: "prefix",
      path: "/ve/wb",
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || "/", "http://127.0.0.1");
          let rel = decodeURIComponent(u.pathname.slice("/ve/wb".length)) || "/";
          if (rel === "/" || rel === "") rel = "/index.html";
          if (rel.split("/").some((p) => p.startsWith(".") || p.includes(".."))) { res.writeHead(404); res.end("not found"); return; }
          const file = path.join(WB_DIR, rel.replace(/^[/\\]+/, ""));
          if (!file.startsWith(WB_DIR) || !fsExists(file) || !fsStat(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
          res.writeHead(200, {
            "content-type": WB_MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
            "content-length": fsStat(file).size,
            "cache-control": "no-cache",
          });
          if ((req.method || "GET").toUpperCase() === "HEAD") { res.end(); return; }
          createReadStream(file).pipe(res);
        } catch (e) {
          try { res.writeHead(500); res.end("server error"); } catch { /* ignore */ }
          log("工作台静态资源出错", String(e?.message || e));
        }
      },
    };
    ctx.effect(() => ctx.webServer.register(wbRoute), "dsh-ui-editor: /ve/wb 工作台静态资源");
    log("工作台静态路由已注册", WB_DIR);
  } catch (e) {
    log("工作台静态路由注册失败", String(e?.message || e));
  }

  

  // 桌面窗口兼容接口：dsh-app:// 页面用绝对地址 http://127.0.0.1:<auxPort> 访问
  ctx.effect(() => {
    let disposed = false;
    const listen = (port, tries, done, fail) => {
      const srv = http.createServer((req, res) => {
        const isWb = (req.url || "").startsWith("/ve/wb") && wbRoute;
        Promise.resolve((isWb ? wbRoute.handler : route.handler)(req, res)).catch((err) => {
          try { res.writeHead(500, { "Content-Type": "text/plain" }); res.end(String(err?.message || err)); } catch { /* ignore */ }
        });
      });
      srv.once("error", (err) => {
        if (err.code === "EADDRINUSE" && tries > 0) listen(port + 1, tries - 1, done, fail);
        else fail(err);
      });
      srv.listen(port, "127.0.0.1", () => done(srv, port));
    };
    listen(AUX_PORT_BASE, 10, (srv, port) => {
      if (disposed) { try { srv.close(); } catch { /* ignore */ } return; }
      auxServer = srv;
      auxPort = port;
      log(`桌面窗口兼容接口已就绪：http://127.0.0.1:${port}${PREFIX}`);
    }, (err) => log("兼容接口端口启动失败（Web GUI 不受影响）：" + String(err?.message || err)));
    return () => {
      disposed = true;
      try { auxServer?.close(); } catch { /* ignore */ }
    };
  }, "dsh-ui-editor: 桌面窗口兼容接口");

  // agent 工具：在对话里直接「打开某个项目进行微调」
  ctx.effect(() => {
    const tools = typeof ctx.get === "function" ? ctx.get("tools") : null;
let defineTool = null;
    try { defineTool = (loadDshModule("@deepseek-ai/dsh-tools") || {}).defineTool || null; } catch { /* ignore */ }
    if (!tools || typeof tools.register !== "function" || typeof defineTool !== "function") {
      log("工具服务不可用，agent 工具未注册（不影响编辑器本身）");
      return;
    }
    const dispose = tools.register(defineTool({
      name: "web_editor_open",
      description: "在 DSH 内置网页编辑器里打开一个本地前端项目（Vite / 静态站），返回预览地址、项目类型，以及项目自带旧版编辑器时的冲突处理结果（冲突只在本次预览里忽略，绝不修改项目文件）。用户要求「打开某个项目/网站进行微调、改文字、改图片、改样式」时调用它。",
      parameters: {
        dir: { type: "string", required: true, description: "项目根目录的绝对路径，例如 D:\\my-project" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            id: { type: "string", required: true },
            url: { type: "string", required: true },
            dir: { type: "string", required: true },
            mode: { type: "string" },
            framework: { type: "string" },
            conflict: { type: "object", additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const info = await manager.open({ dir: String(args.dir || "") });
        lastOpened = { ...info, openedAt: Date.now(), source: "agent" };
        return { ok: true, ...info };
      },
    }));
    const disposeState = tools.register(defineTool({
      name: "web_editor_state",
      description: "查看 DSH 网页编辑器当前状态：已打开的项目、当前框选、框选截图路径，以及页面上已应用但还没保存的修改（overrides）和排队待应用的操作数。用户问「现在编辑器里改了什么/我的修改生效了吗/接着上次继续改」时先调用它。",
      parameters: {
        dir: { type: "string", description: "可选：项目目录；不传则取最近打开的预览" },
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true }, dir: { type: "string" }, opened: { type: "array" }, overrides: { type: "object", additionalProperties: true }, pendingOps: { type: "number" }, selection: { type: "array" }, shotPath: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value).slice(0, 4000) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const want = String((args && args.dir) || "");
        const all = manager.list();
        const pick = all.find((x) => want && String(x.dir || "").toLowerCase() === want.toLowerCase()) || all[all.length - 1];
        let overrides = {};
        if (pick && pick.id) {
          try { overrides = (await manager.proxy(pick.id, "overrides")) || {}; } catch { overrides = {}; }
        }
        const dirKey = String((pick && pick.dir) || want || "").toLowerCase();
        return {
          ok: true,
          dir: (pick && pick.dir) || want || "",
          opened: all.map((x) => ({ id: x.id, dir: x.dir, mode: x.mode })),
          overrides,
          pendingOps: (opsQueue.get(dirKey) || []).length,
          selection: lastContext.selection || [],
          shotPath: lastContext.shotPath || "",
        };
      },
    }));
    log("已注册 agent 工具 web_editor_state");
    const disposeOps = tools.register(defineTool({
      name: "web_editor_apply_ops",
      description: "把修改操作实时应用到用户已打开的 DSH 网页编辑器预览里（页面会立刻变化，用户在右边能看到）。操作类型：style(改样式)、text(改文字)、hide(隐藏/删除)、box(边距/圆角/透明度)、overlay(加元素)。改完让用户点编辑器里的「保存」才会写回源码。用户说「帮我把编辑器里选中的…改成…」时：先 web_editor_context 看选区，再用本工具下发操作。",
      parameters: {
        dir: { type: "string", description: "项目目录；不传则用最近打开的项目" },
        ops: { type: "array", required: true, description: '操作数组，元素形如 {type:"style", key:"sel:.box > h1", props:{"font-size":"96px"}}；key 可用 web_editor_context 返回的 selection[].key' },
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true }, dir: { type: "string" }, queued: { type: "number" }, note: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const dir = String((args && args.dir) || (lastOpened && lastOpened.dir) || "");
        const list = Array.isArray(args && args.ops) ? args.ops : [];
        if (!dir) return { ok: false, queued: 0, note: "还没有打开任何项目，请先 web_editor_open" };
        if (!list.length) return { ok: false, dir, queued: 0, note: "ops 为空" };
        const total = queueOps(dir, list);
        return { ok: true, dir, queued: list.length, note: "已下发 " + list.length + " 条操作，编辑器会在 1~2 秒内应用（用户能看到页面变化），保存后才写回源码（累计队列 " + total + "）" };
      },
    }));
    log("已注册 agent 工具 web_editor_apply_ops");
    const disposeCtx = tools.register(defineTool({
      name: "web_editor_context",
      description: "读取 DSH 网页编辑器当前状态：正在编辑哪个项目目录、最近一次框选了哪些元素、以及框选区域截图的本地文件路径（可用 read_image 直接查看截图像素内容）。用户说「看我刚框选的地方」「继续改这个区域」「按截图帮我改」时先调用它，再决定如何修改。",
      parameters: {
        dir: { type: "string", description: "可选：限定项目目录；不传则返回全局最近一次上下文" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            dir: { type: "string" },
            selection: { type: "array" },
            shotPath: { type: "string" },
            latest: { type: "string" },
            activeDir: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const want = String((args && args.dir) || "");
        const active = lastOpened && lastOpened.dir ? lastOpened.dir : "";
        const ok = !want || want === lastContext.dir || want === active;
        const shotPath = lastContext.shotPath || "";
        return {
          ok,
          dir: lastContext.dir || active || "",
          activeDir: active,
          selection: lastContext.selection || [],
          shotPath,
          latest: shotPath ? path.join(lastContext.dir || active, ".ve-data", "shots", "latest.png") : "",
        };
      },
    }));
    const disposeStyles = tools.register(defineTool({
      name: "web_editor_styles",
      description: "列出用户在【网页工作台 → 风格优化】里保存的全部 UI 风格（中央风格库）。每个风格含 id、名称、提取来源和主色/字体摘要。当用户说「用某某风格优化」「按我保存的那个风格改」但没说明具体参数时，先调用本工具看有哪些风格，再调 web_editor_apply_style 取规范。",
      parameters: {
        keyword: { type: "string", description: "可选：按名称/来源过滤，例如 大象 / 极简" },
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true }, styles: { type: "array" }, note: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const kw = String((args && args.keyword) || "").toLowerCase();
        const list = listStyles().filter((s) => !kw || String(s.name).toLowerCase().includes(kw) || String(s.source).toLowerCase().includes(kw));
        return { ok: true, styles: list.map((s) => {
          let summary = {};
          try {
            const st = readStyle(s.id);
            summary = {
              colors: (st.spec && st.spec.colors || []).slice(0, 6).map((c) => c.value),
              fonts: (st.spec && st.spec.fonts || []).slice(0, 3).map((f) => f.value.split(",")[0]),
            };
          } catch (e) { /* ignore */ }
          return { id: s.id, name: s.name, source: s.source, ...summary };
        }), note: list.length ? "用 web_editor_apply_style 传入 id 或名称即可拿到完整规范" : "还没有保存任何风格；请让用户在网页工作台导入风格" };
      },
    }));
    const disposeApplyStyle = tools.register(defineTool({
      name: "web_editor_apply_style",
      description: "取一份已保存的 UI 风格规范的完整抽象 token 和 Agent 提示词，并把规范摘要写入项目 .ve-data/style-brief.md。拿它返回的 text 作为约束后用 web_editor_apply_ops 逐项改页面样式（颜色/字体/圆角/间距/动效），不要重写整页结构。用户说「按 XX 风格优化这个页面/网站」时调用。",
      parameters: {
        style: { type: "string", required: true, description: "风格 id 或名称（可先用 web_editor_styles 查）" },
        dir: { type: "string", description: "项目目录；不传则用最近打开的项目" },
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true }, dir: { type: "string" }, style: { type: "object", additionalProperties: true }, text: { type: "string" }, note: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const want = String((args && args.style) || "").trim();
        const list = listStyles();
        const hit = list.find((s) => s.id === want) || list.find((s) => String(s.name) === want) || list.find((s) => String(s.name).includes(want)) || list[0];
        if (!hit) return { ok: false, dir: "", style: {}, text: "", note: "风格库为空：先让用户在网页工作台导入一个风格" };
        const st = readStyle(hit.id);
        if (!st.spec) return { ok: false, dir: "", style: {}, text: "", note: "风格文件读取失败：" + hit.id };
        const dir = String((args && args.dir) || (lastOpened && lastOpened.dir) || "");
        const full = composeStylePrompt(st, dir);
        let briefFile = '';
        if (dir && fsExists(dir)) {
          try {
            const outDir = path.join(dir, ".ve-data");
            fs.mkdirSync(outDir, { recursive: true });
            briefFile = path.join(outDir, "style-brief.md");
            fs.writeFileSync(briefFile, full, "utf8");
          } catch (e) { /* ignore */ }
        }
        lastContext = Object.assign({}, lastContext, { dir: dir || lastContext.dir, style: { id: hit.id, name: hit.name } });
        return {
          ok: true,
          dir,
          style: { id: hit.id, name: hit.name, source: hit.source },
          text: buildShortStylePrompt(hit.name, dir, briefFile),
          briefFile,
          note: "规范已写入 " + (briefFile || "（项目目录不可写）") + "；请先读取该文件，再用 web_editor_apply_ops 逐项应用（颜色/字体/圆角/间距），保存前提醒用户",
        };
      },
    }));
    const disposeAddStyle = tools.register(defineTool({
      name: "web_editor_add_style",
      description: "从一个本地目录（某个网站/设计规范文件夹）一键提取 UI 风格并保存到风格库。宿主直接用文件解析完成（毫秒级），不需要读大文件、不需要逐条分析。用户说「提取某个网站的风格规范」「把这个目录做成风格」「添加这份设计规范」「分析这套 UI」时先调用本工具；成功后如需应用风格，再用 web_editor_apply_style。",
      parameters: {
        path: { type: "string", required: true, description: "规范所在目录（含 design-tokens.json / tokens.json / *.css / UI-SPEC.md / fonts.css 之一）" },
        name: { type: "string", description: "风格名（可选，不传则自动取规范里的名字）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            id: { type: "string" },
            name: { type: "string" },
            colors: { type: "array", items: { type: "string" } },
            fonts: { type: "array", items: { type: "string" } },
            description: { type: "string" },
            found: { type: "array", items: { type: "string" } },
            briefHead: { type: "string" },
            error: { type: "string" },
            note: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const srcPath = String((args && args.path) || "").trim();
        if (!srcPath) return { ok: false, error: "缺少 path（规范目录）" };
        const started = Date.now();
        const r = addStyleFromPath(srcPath, args && args.name);
        if (!r.ok) return { ok: false, error: String(r.error || "提取失败") };
        const st = readStyle(r.id);
        const spec = (st && st.spec) || {};
        const meta = (st && st.meta) || {};
        lastContext = Object.assign({}, lastContext, { style: { id: r.id, name: r.name } });
        const brief = String((st && st.styleBrief) || "").slice(0, 700);
        log("已提取风格（" + (Date.now() - started) + "ms）：" + r.name + " @" + srcPath);
        return {
          ok: true,
          id: r.id,
          name: r.name,
          colors: (spec.colors || []).slice(0, 8).map((c) => String(c.name || "") + "=" + String(c.value || "")),
          fonts: (spec.fonts || []).map((f) => String(f.value || "")),
          description: meta.description || "",
          found: (spec.found || []).map((f) => String(f.kind) + ":" + f.path),
          briefHead: brief,
          note: "已保存到风格库（" + (Date.now() - started) + "ms）。要应用就说「按这个风格优化项目」，我会调用 web_editor_apply_style。",
        };
      },
    }));
    const disposeShowStyles = tools.register(defineTool({
      name: "web_editor_show_styles",
      description: "在用户的 DSH 界面里弹出一个【风格优化】面板（列出所有已保存风格，可点选应用）。当用户说「风格优化」「给我选个风格」「按风格改」但没指明具体风格时调用本工具：先弹面板让用户选，再根据用户的选择调用 web_editor_apply_style。",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true }, count: { type: "number" }, note: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const list = listStyles();
        pendingUiCommand = { type: "styles", at: Date.now() };
        return { ok: true, count: list.length, note: list.length ? "已在界面弹出风格面板（" + list.length + " 个风格），等用户点选后调用 web_editor_apply_style" : "界面已弹出风格面板，但风格库是空的：提示用户去网页工作台导入风格" };
      },
    }));
    log("已注册 agent 工具 web_editor_show_styles");
    const disposePages = tools.register(defineTool({
      name: "web_editor_pages",
      description: "网页项目的页面管理：列出页面 / 新建页面 / 删除页面 / 重命名 / 复制 / 切换当前页面。用户说「新建一个页面」「加一个关于页」「删掉某页」「把页面改名」「复制这个页面」时用。新建时 template=blank（默认，保留站点样式）或 copy（复制当前页）；静态站支持，Vite/SPA 请提示用户用框架路由。新建后按规范继续：① 沿用首页 UI 规范（字体层级/色板/圆角/间距/按钮卡片样式，不引入新风格）② 先一次问完 3-5 个问题确认页面用途/板块/内容，再动手 ③ 页面之间用「页面链接」组件连起来 ④ 完成后提醒用户保存并固化。",
      parameters: {
        action: { type: "string", required: true, enum: ["list", "create", "delete", "rename", "copy", "switch"], description: "操作类型" },
        dir: { type: "string", description: "项目目录（不传用最近打开的项目）" },
        name: { type: "string", description: "create 时的页面文件名，如 关于.html 或 blog/post.html" },
        page: { type: "string", description: "delete/rename/copy/switch 时的源页面路径，如 /about.html" },
        to: { type: "string", description: "rename/copy 时的目标页面路径/文件名" },
        template: { type: "string", description: "create 模板：blank（默认）或 copy" },
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true }, dir: { type: "string" }, pages: { type: "array" }, note: { type: "string" }, error: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        captureSession(exec);
        const dir = String(args.dir || (lastOpened && lastOpened.dir) || (lastContext && lastContext.dir) || "");
        if (!dir) return { ok: false, error: "还没有打开任何项目，请先 web_editor_open" };
        const action = String(args.action || "list");
        try {
          if (action === "list") return { ok: true, dir, ...manager.listPages(dir) };
          if (action === "create") {
            const made = manager.createPage(dir, String(args.name || ""), { template: args.template === "copy" ? "copy" : "blank", backLink: true });
            return { ok: true, dir, ...made, pages: manager.listPages(dir).pages || [], note: "页面已创建。接下来请沿用首页 UI 规范实现内容；先问用户 3-5 个问题确认用途/板块/内容。用 web_editor_apply_ops 写内容，完成后提醒保存/固化。" };
          }
          if (action === "delete") { const r = manager.deletePage(dir, String(args.page || "")); return { ok: true, dir, ...r, pages: manager.listPages(dir).pages || [] }; }
          if (action === "rename") { const r = manager.renamePage(dir, String(args.page || ""), String(args.to || "")); return { ok: true, dir, ...r, pages: manager.listPages(dir).pages || [] }; }
          if (action === "copy") { const r = manager.copyPage(dir, String(args.page || ""), String(args.to || "")); return { ok: true, dir, ...r, pages: manager.listPages(dir).pages || [] }; }
          if (action === "switch") {
            const inst = manager.list().find((x) => path.resolve(x.dir) === path.resolve(dir));
            if (!inst) return { ok: false, error: "项目预览没打开，请先 web_editor_open" };
            const r = await manager.setPage(inst.id, String(args.page || "/"));
            return { ok: true, dir, ...r };
          }
          return { ok: false, error: "未知操作：" + action };
        } catch (e) {
          return { ok: false, dir, error: String((e && e.message) || e) };
        }
      },
    }));
    log("已注册 agent 工具 web_editor_pages");
    log("已注册 agent 工具 web_editor_styles / web_editor_apply_style");
    log("已注册 agent 工具 web_editor_context");
    log("已注册 agent 工具 web_editor_open");
    return () => { try { dispose(); } catch { /* ignore */ } try { disposeCtx(); } catch { /* ignore */ } try { disposeOps(); } catch { /* ignore */ } try { disposeState(); } catch { /* ignore */ } try { disposeStyles(); } catch { /* ignore */ } try { disposeApplyStyle(); } catch { /* ignore */ } try { disposeShowStyles(); } catch { /* ignore */ } try { disposeAddStyle(); } catch { /* ignore */ } };
  }, "dsh-ui-editor: agent 工具");

  ctx.effect(() => () => manager.disposeAll(), "dsh-ui-editor: 关闭所有预览");
  log("网页修改器已加载，接口前缀 " + PREFIX);
}
