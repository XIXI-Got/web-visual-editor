/**
 * 视觉编辑器 · 落盘层
 *
 * 职责：读/写覆写文件、备份旧版本、接收上传、调用 AI、把文字回写进站点自己的数据文件。
 * 只依赖 Node 内置模块，零第三方依赖。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mergeDeep, setPath, findLeafPaths, styleToCss } from "./core.mjs";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function insidePath(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* 插入组件的节点字段白名单：保留预设类型/参数/样式/定位等，
 * 否则保存一次就会把「分割线的颜色/粗细/方向」等设置丢掉（刷新后又变回默认）。 */
function sanitizeOverlayParams(p) {
  const out = {};
  if (!p || typeof p !== "object") return out;
  if (Array.isArray(p.items)) out.items = p.items.slice(0, 12).map((x) => String(x).slice(0, 40));
  for (const k of ["text", "title", "desc"]) if (typeof p[k] === "string") out[k] = p[k].slice(0, 500);
  for (const k of ["gap", "thick"]) if (Number.isFinite(Number(p[k]))) out[k] = Number(p[k]);
  if (p.dir === "v" || p.dir === "h") out.dir = p.dir;
  if (p.fill === "solid" || p.fill === "grad") out.fill = p.fill;
  if (typeof p.grad === "string" && p.grad) out.grad = p.grad.slice(0, 600);
  return out;
}

function sanitizeOverlayStyle(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  for (const k of ["pad", "radius", "bg", "color", "opacity"]) {
    if (s[k] == null || s[k] === "") continue;
    if (k === "opacity") {
      const v = Number(s[k]);
      if (Number.isFinite(v)) out[k] = Math.max(0, Math.min(1, v));
    } else if (k === "pad" || k === "radius") {
      const v = Number(s[k]);
      if (Number.isFinite(v)) out[k] = v;
    } else {
      out[k] = String(s[k]).slice(0, 120);
    }
  }
  return out;
}

export function createStore(opts) {
  const root = path.resolve(opts.root);
  const dataDir = path.resolve(root, opts.dataDir || ".ve-data");
  // 按页面隔离：page 为空 = 入口页（沿用旧路径，兼容历史数据）；其它页面存到 .ve-data/pages/<slug>/
  const pageSlug = String(opts.page || "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "");
  const pageDir = pageSlug ? path.join(dataDir, "pages", pageSlug) : dataDir;
  // 兼容旧版本：中文页面曾被 percent-encode 后清洗成 _E6_B5_8B_… 的目录名，自动迁移到可读目录
  if (pageSlug) {
    try {
      const legacySlug = encodeURIComponent(pageSlug).replace(/[^A-Za-z0-9._-]/g, "_");
      const legacyDir = path.join(dataDir, "pages", legacySlug);
      if (legacySlug && legacySlug !== pageSlug && fs.existsSync(legacyDir) && !fs.existsSync(path.join(pageDir, "overrides.json"))) {
        fs.mkdirSync(path.dirname(pageDir), { recursive: true });
        fs.renameSync(legacyDir, pageDir);
      }
    } catch { /* ignore */ }
  }
  const backupsRoot = path.join(dataDir, "backups");
  const backupsDir = pageSlug ? path.join(backupsRoot, "pages", pageSlug) : backupsRoot;
  const uploadsDir = path.join(dataDir, "uploads");
  const overridesFile = path.join(pageDir, "overrides.json");
  const stepsFile = path.join(pageDir, "steps.json");
  const historyFile = path.join(pageDir, "history.jsonl");
  const configFile = path.join(dataDir, "config.json");
  const maxBackups = opts.maxBackups ?? 40;

  for (const dir of [dataDir, backupsRoot, uploadsDir, pageDir, backupsDir]) fs.mkdirSync(dir, { recursive: true });

  // ---------- 配置 ----------
  const defaultConfig = {
    root,
    /** 站点自己的内容 JSON（如 src/content.json），文字/图片可回写到这里 */
    contentJson: opts.contentJson || "",
    /** 静态文件目录（上传的图片放这里，才能被站点直接引用） */
    publicDir: opts.publicDir || "",
    /** 上传后返回的 URL 前缀 */
    uploadUrlBase: opts.uploadUrlBase || "/__ve/files/",
    /** 每次保存后同步生成一份纯 CSS 覆写（方便生产环境直接引用） */
    cssOut: opts.cssOut || "",
    /** 备份保留数量 */
    maxBackups,
    /** AI：OpenAI 兼容接口；可用环境变量 VE_AI_BASE_URL / VE_AI_KEY / VE_AI_MODEL 覆盖 */
    ai: {
      baseURL: process.env.VE_AI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.VE_AI_KEY || "",
      model: process.env.VE_AI_MODEL || "gpt-4o-mini",
    },
    token: opts.token || process.env.VE_TOKEN || crypto.randomBytes(12).toString("hex"),
  };

  let config = defaultConfig;
  try {
    if (fs.existsSync(configFile)) {
      const disk = JSON.parse(fs.readFileSync(configFile, "utf8"));
      config = {
        ...defaultConfig,
        ...disk,
        ai: { ...defaultConfig.ai, ...(disk.ai || {}) },
        token: defaultConfig.token, // token 每次启动重新生成，不落盘
      };
    } else {
      writeJson(configFile, { ...defaultConfig, token: undefined });
    }
  } catch {
    config = defaultConfig;
  }
  const saveConfig = () => writeJson(configFile, { ...config, token: undefined });

  // ---------- 步骤历史（整体状态快照，跨保存/跨重启可撤销） ----------
  const MAX_STEPS = 200;
  const STEPS_SCHEMA = 2;
  function readSteps() {
    const d = readJson(stepsFile, { steps: [] });
    if (!d || !Array.isArray(d.steps)) return { schema: STEPS_SCHEMA, steps: [] };
    if (d.schema !== STEPS_SCHEMA) return { schema: STEPS_SCHEMA, steps: [] };
    return d;
  }
  function listSteps(limit = MAX_STEPS) {
    return readSteps().steps.slice(-limit);
  }
  function appendStep(entry) {
    const d = readSteps();
    const id = String(entry.id || ("s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)));
    d.steps.push({ id, at: Date.now(), label: String(entry.label || ""), state: entry.state || {} });
    if (d.steps.length > MAX_STEPS) d.steps = d.steps.slice(-MAX_STEPS);
    d.schema = STEPS_SCHEMA;
    writeJson(stepsFile, d);
    return { ok: true, id, schema: STEPS_SCHEMA, total: d.steps.length };
  }
  function replaceSteps(steps, ptr) {
    const list = Array.isArray(steps) ? steps.slice(-MAX_STEPS) : [];
    const p = Number.isFinite(Number(ptr)) && Number(ptr) >= 0 ? Math.min(list.length - 1, Math.round(Number(ptr))) : list.length - 1;
    writeJson(stepsFile, { schema: STEPS_SCHEMA, steps: list, ptr: Math.max(0, p) });
    return { ok: true, schema: STEPS_SCHEMA, total: list.length, ptr: Math.max(0, p) };
  }
  function stepsPtr() {
    const d = readSteps();
    const p = Number(d.ptr);
    return Number.isFinite(p) ? Math.max(0, Math.min(d.steps.length - 1, Math.round(p))) : Math.max(0, d.steps.length - 1);
  }

  // ---------- 基础 IO ----------
  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return fallback;
    }
  }

  /** 备份一组文件，返回备份批次 id */
  function backup(files, label = "save") {
    try {
      const existing = files.filter((f) => {
        try { return fs.existsSync(f); } catch { return false; }
      });
      if (!existing.length) return null;
      const id = `${stamp()}_${Math.random().toString(36).slice(2, 6)}`;
      const dir = path.join(backupsDir, id);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
        console.warn("[ve] 备份目录不可写，跳过本次备份：", e && e.message);
        return null;
      }
      const manifest = [];
      for (const file of existing) {
        try {
          const rel = path.relative(root, file) || path.basename(file);
          const dest = path.join(dir, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(file, dest);
          manifest.push({ file: rel, size: fs.statSync(file).size });
        } catch (e) {
          console.warn("[ve] 备份单个文件失败，跳过：", file, e && e.message);
        }
      }
      try { writeJson(path.join(dir, "manifest.json"), { id, label, at: new Date().toISOString(), files: manifest }); } catch { return null; }
      try { pruneBackups(); } catch { /* ignore */ }
      return id;
    } catch (e) {
      console.warn("[ve] 备份失败（已忽略，不影响保存）：", e && e.message);
      return null;
    }
  }

  function pruneBackups() {
    let dirs = [];
    try {
      dirs = fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch { return; }
    while (dirs.length > maxBackups) {
      const gone = dirs.shift();
      try { fs.rmSync(path.join(backupsDir, gone), { recursive: true, force: true }); } catch { /* 被占用/ACL 损坏：跳过 */ }
    }
  }

  function listBackups() {
    try {
      if (!fs.existsSync(backupsDir)) return [];
    } catch { return []; }
    let entries = [];
    try { entries = fs.readdirSync(backupsDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      try {
        const m = readJson(path.join(backupsDir, d.name, "manifest.json"), null);
        if (!m) continue;
        out.push({ id: d.name, at: m.at || null, label: m.label || "", files: m.files || [] });
      } catch { /* 跳过损坏目录 */ }
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  function restoreBackup(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error("备份 id 不合法");
    const dir = path.join(backupsDir, id);
    if (!fs.existsSync(dir)) throw new Error("找不到这个备份");
    const manifest = readJson(path.join(dir, "manifest.json"), null);
    if (!manifest) throw new Error("备份缺少 manifest");
    const restored = [];
    for (const item of manifest.files) {
      const src = path.join(dir, item.file);
      const dest = path.join(root, item.file);
      if (!insidePath(root, dest) || !fs.existsSync(src)) continue;
      fs.copyFileSync(src, dest);
      restored.push(item.file);
    }
    return restored;
  }

  // ---------- 覆写数据 ----------
  function readOverrides() {
    const data = readJson(overridesFile, {});
    return data && typeof data === "object" ? data : {};
  }

  const sourceFile = path.join(root, pageSlug || "index.html");
  const sourceMetaFile = path.join(pageDir, "source-meta.json");

  function sourceHash() {
    try {
      if (!fs.existsSync(sourceFile)) return "";
      return crypto.createHash("sha1").update(fs.readFileSync(sourceFile)).digest("hex");
    } catch (e) { return ""; }
  }

  function markSource() {
    try { writeJson(sourceMetaFile, { hash: sourceHash(), at: Date.now() }); } catch (e) { /* ignore */ }
  }

  /** 源文件被编辑器外部改过：旧覆写先备份，再停用，避免旧像素盖住新源码 */
  function checkSource() {
    const hash = sourceHash();
    if (!hash) return { stale: false, hash };
    let meta = null;
    try { meta = readJson(sourceMetaFile, null); } catch (e) { meta = null; }
    if (meta && meta.hash && meta.hash !== hash) {
      const backupId = backup([overridesFile], "source-conflict");
      // 同时把当前最新源码留一份快照，方便对照旧覆写
      try {
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.copyFileSync(sourceFile, path.join(backupsDir, "source-" + hash.slice(0, 8) + ".html"));
      } catch (e) { /* ignore */ }
      writeJson(overridesFile, {});
      writeJson(sourceMetaFile, { hash, at: Date.now(), archivedFrom: meta.hash });
      return { stale: true, hash, backupId };
    }
    if (!meta || meta.hash !== hash) writeJson(sourceMetaFile, { hash, at: Date.now() });
    return { stale: false, hash };
  }

  function contentFile() {
    if (!config.contentJson) return null;
    const file = path.resolve(root, config.contentJson);
    return insidePath(root, file) ? file : null;
  }

  /**
   * 应用一批操作。
   * ops: [{ type, key, ... }]，来源只可能是编辑器自身或 AI 校验后的白名单操作。
   */
  function applyOps(ops) {
    const prev = readOverrides();
    const next = structuredClone(prev);
    const touched = [overridesFile];
    const contentTargets = contentFile();
    let contentData = contentTargets ? readJson(contentTargets, null) : null;
    let contentChanged = false;
    const applied = [];
    const relPx = (v) => { const m = String(v == null ? "" : v).match(/^(-?\d+(?:\.\d+)?)px$/i); return m ? Number(m[1]) : null; };
    const relPct = (n, base, unit) => base > 0 ? (n / base * 100).toFixed(3).replace(/\.?0+$/, "") + (unit || "%") : null;
    const relRef = (op) => {
      const r = op && op.ref && typeof op.ref === "object" ? op.ref : {};
      const vw = Number(r.vw) || 0, vh = Number(r.vh) || 0, pw = Number(r.pw) || vw, ph = Number(r.ph) || 0;
      return { vw, vh, pw, ph };
    };
    const relativizeStyle = (style, op) => {
      const { vw, pw, ph } = relRef(op);
      const units = (op && op.ref && op.ref.units) || {};
      for (const p of Object.keys(style)) {
        const lp = String(p).toLowerCase();
        const v = style[p];
        const n = relPx(v);
        if (n == null) continue;
        if (units[lp] === "px") continue;
        if (lp === "font-size" && vw > 0 && n > 0) {
          style[p] = "clamp(" + Math.max(10, Math.round(n * 0.7)) + "px, " + (n / vw * 100).toFixed(2) + "vw, " + Math.round(n * 1.12) + "px)";
        } else if (lp === "width" && vw > 0 && n > 0) {
          style[p] = relPct(n, pw, pw ? "%" : "vw"); style["max-width"] = "100%"; style["box-sizing"] = "border-box";
        } else if (lp === "height" && n > 0) {
          style[p] = ph > 0 ? relPct(n, ph, "%") : (vw > 0 ? (n / vw * 100).toFixed(3).replace(/\.?0+$/, "") + "vw" : null);
          if (!style[p]) delete style[p];
        }
      }
      return style;
    };

    for (const op of ops) {
      if (!op || typeof op !== "object" || typeof op.key !== "string") continue;
      const key = op.key;
      if (!/^(id|sel|overlay):/.test(key)) continue;

      if (op.type === "reset") {
        delete next[key];
        applied.push({ key, type: "reset" });
        continue;
      }

      if (op.type === "overlay" && op.node && typeof op.node === "object") {
        const node = op.node;
        const attrs = typeof node.attrs === "object" && node.attrs ? node.attrs : {};
        const overlayNode = {
          id: String(node.id || key.slice(8)),
          tag: ["img", "svg", "text", "div"].includes(node.tag) ? node.tag : "img",
          attrs: {
            src: attrs.src ? String(attrs.src) : undefined,
            html: attrs.html ? String(attrs.html).slice(0, 400000) : undefined,
            text: attrs.text ? String(attrs.text).slice(0, 4000) : undefined,
            color: attrs.color ? String(attrs.color) : undefined,
          },
          x: Number(node.x) || 0,
          y: Number(node.y) || 0,
          width: Number(node.width) || 200,
          height: Number(node.height) || 160,
          z: Number(node.z) || 900,
        };
        if (node.preset && ["nav", "button", "card", "divider"].includes(node.preset)) overlayNode.preset = node.preset;
        if (node.params && typeof node.params === "object") overlayNode.params = sanitizeOverlayParams(node.params);
        if (node.style && typeof node.style === "object") overlayNode.style = sanitizeOverlayStyle(node.style);
        if (["auto", "page", "screen"].includes(node.pin)) overlayNode.pin = node.pin;
        if (typeof node.refKey === "string" && node.refKey) overlayNode.refKey = node.refKey.slice(0, 300);
        if (Number.isFinite(Number(node.rotate)) && Number(node.rotate)) overlayNode.rotate = Number(node.rotate);
        next[key] = { __overlay: overlayNode };
        applied.push({ key, type: "overlay" });
        continue;
      }

      const entry = next[key] || {};
      if (op.type === "style" && op.props && typeof op.props === "object") {
        entry.style = { ...(entry.style || {}) };
        for (const [p, v] of Object.entries(op.props)) {
          if (!/^[a-z-]+$/i.test(p)) continue;
          entry.style[p] = v == null || v === "" ? null : String(v);
        }
        relativizeStyle(entry.style, op);
        for (const [p, v] of Object.entries(entry.style)) if (v == null) delete entry.style[p];
        applied.push({ key, type: "style" });
      } else if (op.type === "text" && typeof op.value === "string") {
        // 优先回写站点自己的内容 JSON（唯一匹配才算数），否则记进覆写层
        let wroteContent = false;
        if (contentData && typeof op.orig === "string" && op.orig !== op.value) {
          const hits = findLeafPaths(contentData, (v) => v === op.orig);
          if (hits.length === 1) {
            setPath(contentData, hits[0], op.value);
            contentChanged = true;
            wroteContent = true;
            applied.push({ key, type: "text", to: config.contentJson + "#" + hits[0] });
          }
        }
        if (!wroteContent) {
          entry.text = op.value;
          applied.push({ key, type: "text", to: "overrides" });
        }
      } else if (op.type === "image" && typeof op.value === "string") {
        entry.image = op.value;
        if (op.box && typeof op.box === "object") entry.imageBox = op.box;
        applied.push({ key, type: "image" });
      } else if (op.type === "blockText" && typeof op.value === "string") {
        entry.blockText = op.value;
        applied.push({ key, type: "blockText" });
      } else if (op.type === "attrs" && op.props && typeof op.props === "object") {
        entry.attrs = { ...(entry.attrs || {}) };
        for (const [a, v] of Object.entries(op.props)) {
          if (!/^[a-z-]+$/i.test(a)) continue;
          if (v == null) delete entry.attrs[a];
          else entry.attrs[a] = String(v);
        }
        applied.push({ key, type: "attrs" });
      } else if (op.type === "box" && op.box && typeof op.box === "object") {
        const rr = relRef(op);
        const { vw, ph } = rr;
        const units = (op.ref && op.ref.units) || {};
        entry.style = { ...(entry.style || {}) };
        const keepW = units.width === "px";
        const keepH = units.height === "px";
        if (op.box.width != null && Number(op.box.width) > 0 && !keepW) {
          entry.style.width = rr.pw > 0 ? relPct(Number(op.box.width), rr.pw, "%") : relPct(Number(op.box.width), rr.vw, "vw");
          entry.style["max-width"] = "100%"; entry.style["box-sizing"] = "border-box";
        }
        if (op.box.height != null && Number(op.box.height) > 0 && !keepH) {
          entry.style.height = ph > 0 ? relPct(Number(op.box.height), ph, "%") : (Number(vw) > 0 ? (Number(op.box.height) / vw * 100).toFixed(3).replace(/\.?0+$/, "") + "vw" : null);
        }
        entry.box = { x: Number(op.box.x) || 0, y: Number(op.box.y) || 0 };
        if (keepW && op.box.width != null) entry.box.width = Number(op.box.width);
        if (keepH && op.box.height != null) entry.box.height = Number(op.box.height);
        applied.push({ key, type: "box" });
      } else if (op.type === "hide") {
        entry.hidden = Boolean(op.hidden);
        applied.push({ key, type: "hide" });
      }
      // 没有实际内容的条目不要留在覆写层（例如文字已经回写进 content.json）
      if (op.ref && Number(op.ref.vw) > 0) {
        entry.ref = {
          vw: Number(op.ref.vw),
          vh: Number(op.ref.vh) || 0,
          pw: Number(op.ref.pw) || 0,
          ph: Number(op.ref.ph) || 0,
        };
      }
      const hasContent = Boolean(
        (entry.style && Object.keys(entry.style).length) ||
        typeof entry.text === "string" ||
        typeof entry.blockText === "string" ||
        typeof entry.image === "string" ||
        (entry.attrs && Object.keys(entry.attrs).length) ||
        entry.box ||
        entry.hidden ||
        entry.__overlay,
      );
      if (hasContent) next[key] = entry;
      else delete next[key];
    }

    const files = [...touched];
    if (contentChanged && contentTargets) files.push(contentTargets);
    const backupId = backup(files, applied.map((a) => a.type).join("+") || "save");

    // 变更历史：每条保存一行，供撤回与后续「AI 学习」使用
    try {
      const record = {
        at: new Date().toISOString(),
        backupId,
        ops: applied,
        root: path.basename(root),
      };
      fs.appendFileSync(historyFile, JSON.stringify(record) + "\n", "utf8");
    } catch { /* 历史失败不影响保存 */ }

    writeJson(overridesFile, next);
    if (config.cssOut) {
      const cssFile = path.resolve(root, config.cssOut);
      if (insidePath(root, cssFile)) {
        fs.mkdirSync(path.dirname(cssFile), { recursive: true });
        fs.writeFileSync(cssFile, `/* 由视觉编辑器生成，最后保存：${new Date().toISOString()} */\n${styleToCss(allOverridesAcrossPages())}\n`, "utf8");
      }
    }
    if (contentChanged && contentTargets) {
      fs.writeFileSync(contentTargets, JSON.stringify(contentData, null, 2) + "\n", "utf8");
    }
    try { markSource(); } catch (e) { /* ignore */ }
    return { ok: true, applied, backupId, overrides: next, wroteContent: contentChanged };
  }

  /** 汇总入口页 + 所有页面覆写：写 cssOut 时合并，避免多页面互相覆盖 */
  function allOverridesAcrossPages() {
    const merged = Object.assign({}, readJson(path.join(dataDir, "overrides.json"), {}) || {});
    try {
      const pagesRoot = path.join(dataDir, "pages");
      for (const d of fs.readdirSync(pagesRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const o = readJson(path.join(pagesRoot, d.name, "overrides.json"), null);
        if (o && typeof o === "object") Object.assign(merged, o);
      }
    } catch { /* ignore */ }
    return merged;
  }

  function replaceOverrides(next, label = "replace") {
    const backupId = backup([overridesFile], label);
    writeJson(overridesFile, next || {});
    return { ok: true, backupId };
  }

  function overridesCss() {
    return styleToCss(readOverrides());
  }

  // ---------- 上传 ----------
  function saveUpload(name, buffer) {
    const ext = path.extname(String(name || "")).toLowerCase() || ".bin";
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
    const hash = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 12);
    const base = String(name || "image").replace(/\.[^.]+$/, "").replace(/[^\w\-.]/g, "").slice(0, 40) || "image";
    const filename = `${base}-${hash}${safeExt}`;
    const destDir = config.publicDir ? path.resolve(root, config.publicDir) : uploadsDir;
    if (config.publicDir && !insidePath(root, destDir)) throw new Error("publicDir 配置不合法");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, filename), buffer);
    const url = config.publicDir
      ? path.posix.join(String(config.publicDir).replace(/\\/g, "/"), filename)
      : `${config.uploadUrlBase}${filename}`;
    return { ok: true, url, filename, size: buffer.length };
  }

  function readUpload(filename) {
    if (!/^[\w.-]+$/.test(filename)) return null;
    const file = path.join(uploadsDir, filename);
    if (!insidePath(uploadsDir, file) || !fs.existsSync(file)) return null;
    return file;
  }

  // ---------- AI ----------
  function readAiConfig() {
    const file = path.join(dataDir, "ai.json");
    const disk = readJson(file, {});
    return {
      baseURL: disk.baseURL || config.ai.baseURL,
      apiKey: disk.apiKey || config.ai.apiKey,
      model: disk.model || config.ai.model,
    };
  }

  function writeAiConfig(patch) {
    const file = path.join(dataDir, "ai.json");
    const next = { ...readAiConfig(), ...patch };
    writeJson(file, next);
    config.ai = next;
    return { ok: true };
  }

  /** 调模型，强制它只输出白名单操作 */
  async function askAI({ instruction, selection, context, history }) {
    const ai = readAiConfig();
    if (!ai.apiKey) {
      return {
        ok: false,
        needsConfig: true,
        error: "还没配置 AI。点面板里的「AI 设置」，填 baseURL / apiKey / model（任何 OpenAI 兼容接口都行）。",
      };
    }
    const sys = [
      "你是一个网页视觉编辑器的操作生成器。",
      "你只能输出 JSON，不能输出任何解释文字、不能输出 Markdown 代码围栏。",
      "输出格式：{\"ops\":[操作...],\"note\":\"一句中文说明\"}",
      "允许的操作（严格只用这些）：",
      '{"type":"style","key":"<元素key>","props":{"font-size":"20px","font-weight":"700","color":"#111","line-height":"1.4","letter-spacing":"0.02em","padding-top":"12px","border-radius":"8px","opacity":"0.9"}}',
      '渐变也走 style 的 --ve-grad：多节点格式 "g2|<角度>|<text|fill|stroke|both>|<位置0-1>:<#hex>:<透明度0-1>|..."，例如 "g2|90|text|0:#ff4d4d:1|0.6:#ffb86b:0.6|1:#ffb86b:0"（角度 90=从左到右、180=从上到下；text=文字渐变，fill/stroke/both=SVG 渐变）',
      '{"type":"text","key":"<元素key>","value":"新文字"}',
      '{"type":"attrs","key":"<元素key>","props":{"src":"/图片地址","alt":"说明","fill":"#333"}}',
      '{"type":"box","key":"<元素key>","box":{"x":0,"y":0,"width":320,"height":180}}',
      '{"type":"hide","key":"<元素key>","hidden":true}',
      "规则：key 必须来自提供的候选元素列表，不许编造；改样式要用合法 CSS 值并带单位；一次最多 12 个操作；不要生成脚本。",
      "如果用户要求的东西（比如增加一个新章节）超出现有元素的能力，就返回空 ops，并在 note 里说明原因。",
    ].join("\n");

    const user = [
      `指令：${instruction}`,
      selection ? `当前选中元素：${JSON.stringify(selection)}` : "当前没有选中元素。",
      context ? `页面结构（节选）：\n${context}` : "",
      history?.length ? `可参考的历史操作类型：${history.slice(-5).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const callOnce = async (extraUser) => {
      const messages = [
        { role: "system", content: sys },
        { role: "user", content: user },
      ];
      if (extraUser) messages.push({ role: "user", content: extraUser });
      const res = await fetch(`${ai.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
        body: JSON.stringify({
          model: ai.model,
          temperature: 0.2,
          messages,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`AI 接口返回 ${res.status}：${text.slice(0, 300)}`);
      }
      const data = await res.json().catch(() => null);
      return data?.choices?.[0]?.message?.content || "";
    };

    let raw = "";
    let parsed = null;
    try {
      raw = await callOnce("");
      parsed = parseJsonLoose(raw);
      if (!parsed || !Array.isArray(parsed.ops)) {
        const repair = "你上一次的输出无法解析为 JSON。上一次输出：\n" + String(raw).slice(0, 1500) +
          "\n\n请重新只输出严格 JSON（{\"ops\":[...],\"note\":\"...\"}），不要任何解释、不要代码围栏；如果无法完成，输出 {\"ops\":[],\"note\":\"原因\"}。";
        raw = await callOnce(repair);
        parsed = parseJsonLoose(raw);
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    if (!parsed || !Array.isArray(parsed.ops)) {
      return { ok: false, error: "AI 没返回合法 JSON（已自动重试一次）", raw: String(raw).slice(0, 500) };
    }
    const ops = sanitizeOps(parsed.ops);
    return { ok: true, ops, note: String(parsed.note || ""), dropped: parsed.ops.length - ops.length };
  }


  /** AI 生成可插入的组件 HTML（不走 ops 白名单，直接返回一段代码） */
  async function askAIHtml({ instruction, reference, context }) {
    const ai = readAiConfig();
    if (!ai.apiKey) return { ok: false, needsConfig: true, error: "还没配置 AI。先点「AI 设置」填 baseURL / apiKey / model。" };
    const sys = [
      "你是一个资深前端，负责生成可直接插入现有网页的组件。",
      "只输出一段 HTML 片段，里面可以带 <style>，不要输出 Markdown 代码围栏，不要输出解释文字。",
      "不要包含 <html> / <body> / <script>；不要依赖外部库。",
      "CSS 必须用组件自己的唯一前缀类名作用域，禁止修改全局标签样式。",
      "尺寸用响应式单位（%、clamp、vw、em），不要写死大宽度；组件要在手机到桌面都正常。",
      "如果用户给了参考代码，只借鉴结构与动效，不要照抄它的品牌和文案。",
    ].join("\n");
    const user = ["需求：" + String(instruction || ""), reference ? "参考代码/风格：\n" + String(reference).slice(0, 12000) : "", context ? "当前页面上下文：\n" + String(context).slice(0, 6000) : ""].filter(Boolean).join("\n\n");
    try {
      const res = await fetch(`${ai.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
        body: JSON.stringify({ model: ai.model, temperature: 0.4, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) { const text = await res.text().catch(() => ""); return { ok: false, error: `AI 接口返回 ${res.status}：${text.slice(0, 300)}` }; }
      const data = await res.json().catch(() => null);
      let html = String(data?.choices?.[0]?.message?.content || "").trim();
      html = html.replace(/^```[a-zA-Z]*\s*/,"").replace(/```$/,"").trim();
      if (!html) return { ok: false, error: "AI 返回空内容" };
      return { ok: true, html };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }

  function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  const fenceStripped = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "").trim();
  const fix = (v) => String(v || "").replace(/^\uFEFF/, "").replace(/[\u201c\u201d]/g, "\"").replace(/,\s*([}\]])/g, "$1").trim();
  const tryParse = (v) => { try { return JSON.parse(fix(v)); } catch (e) { return undefined; } };
  const variants = [raw, fenceStripped];
  for (const v of variants) {
    if (!v) continue;
    const direct = tryParse(v);
    if (direct !== undefined) return direct;
    const fixed = fix(v);
    // 找出所有括号平衡片段，从长到短尝试（模型常在 JSON 前后带解释）
    const cands = [];
    for (let i = 0; i < fixed.length; i++) {
      const ch = fixed[i];
      if (ch !== "{" && ch !== "[") continue;
      const open = ch; const close = ch === "{" ? "}" : "]";
      let d = 0; let str = null; let es = false;
      for (let j = i; j < fixed.length; j++) {
        const c = fixed[j];
        if (es) { es = false; continue; }
        if (c === "\\") { es = true; continue; }
        if (str) { if (c === str) str = null; continue; }
        if (c === '"' || c === "'") { str = c; continue; }
        if (c === open) d++;
        else if (c === close) { d--; if (d === 0) { cands.push(fixed.slice(i, j + 1)); break; } }
      }
      if (cands.length > 40) break;
    }
    cands.sort((a, b) => b.length - a.length);
    for (const cand of cands) { const v2 = tryParse(cand); if (v2 !== undefined) return v2; }
  }
  return null;
}

  return {
    config: () => config,
    saveConfig,
    root,
    dataDir,
    backupsDir,
    uploadsDir,
    overridesFile,
    sourceFile,
    pageSlug,
    checkSource,
    markSource,
    readOverrides,
    readHistory(limit = 200) {
      try {
        const file = historyFile;
        if (!fs.existsSync(file)) return [];
        const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
        return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    },
    applyOps,
    replaceOverrides,
    listSteps,
    stepsPtr,
    appendStep,
    replaceSteps,
    overridesCss,
    listBackups,
    restoreBackup,
    backup,
    saveUpload,
    readUpload,
    readAiConfig,
    writeAiConfig,
    askAI,
    askAIHtml,
    contentFile,
  };
}

const ALLOWED_STYLE = /^(font-size|font-weight|line-height|letter-spacing|color|background-color|text-align|text-transform|font-family|font-style|width|height|max-width|min-height|margin(-[a-z]+)?|padding(-[a-z]+)?|border(-[a-z]+)?|border-radius|outline(-[a-z]+)?|opacity|z-index|display|flex-direction|gap|align-items|justify-content|box-shadow|text-shadow|text-decoration(-[a-z]+)?|filter|clip-path|backdrop-filter|-webkit-backdrop-filter|-webkit-text-stroke|paint-order|transform)$/i;
const ALLOWED_ATTR = /^(src|alt|href|title|fill|stroke|stroke-width|viewBox|width|height|loading|object-fit)$/i;

/** 白名单校验：AI 的输出必须过这一层才能落盘 */
export function sanitizeOps(ops) {
  const out = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== "object") continue;
    const key = String(op.key || "");
    if (!/^(id|sel):/.test(key)) continue;
    const type = String(op.type || "");
    if (type === "style") {
      const props = {};
      for (const [p, v] of Object.entries(op.props || {})) {
        if (!ALLOWED_STYLE.test(p)) continue;
        const s = String(v).trim();
        if (s.length > 120 || /url\(|expression|javascript:|@import|\\|;|\{|\}/i.test(s)) continue;
        props[p] = s;
      }
      if (Object.keys(props).length) out.push({ type, key, props });
    } else if (type === "text") {
      const v = String(op.value ?? "");
      if (v.length <= 4000) out.push({ type, key, value: v });
    } else if (type === "attrs") {
      const props = {};
      for (const [a, v] of Object.entries(op.props || {})) {
        if (!ALLOWED_ATTR.test(a)) continue;
        const s = String(v).trim();
        if (s.length > 2000 || /javascript:/i.test(s)) continue;
        props[a] = s;
      }
      if (Object.keys(props).length) out.push({ type, key, props });
    } else if (type === "box" && op.box && typeof op.box === "object") {
      const num = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : 0);
      out.push({ type, key, box: { x: num(op.box.x), y: num(op.box.y), width: num(op.box.width), height: num(op.box.height) } });
    } else if (type === "hide") {
      out.push({ type, key, hidden: Boolean(op.hidden) });
    }
    if (out.length >= 24) break;
  }
  return out;
}

export function mergeOverrides(base, patch) {
  return mergeDeep(base, patch);
}
