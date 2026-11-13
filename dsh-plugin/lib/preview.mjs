/**
 * DSH 插件 · 预览管理器（宿主端，零第三方依赖）
 *
 * 职责：给一个「源代码文件夹」，判断项目类型，起一个注入了视觉编辑器的预览服务。
 *  - Vite 项目：子进程里用项目自己的 Vite + 我们的插件启动（**不改目标项目的任何文件**）
 *  - 静态站点：进程内 node:http 直接托管 + 注入
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "vendor");
const VITE_RUN = path.join(HERE, "vite-run.mjs");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".nuxt", ".output",
  ".cache", ".turbo", ".ve-data", "__pycache__", "vendor",
]);

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function exists(...p) {
  try {
    return fs.existsSync(path.join(...p));
  } catch {
    return false;
  }
}

/** 判断一个目录是什么项目 */
/** 目录里没有 index.html 时，浅层找第一个 HTML 作为入口（depth ≤ maxDepth，跳过重目录） */
export function findFirstHtml(dir, maxDepth = 3) {
  if (!dir || !fs.existsSync(dir)) return "";
  const seen = [];
  const walk = (abs, rel, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(p, rel ? rel + "/" + ent.name : ent.name, depth + 1);
      } else if (/\.html?$/i.test(ent.name)) {
        const relPath = rel ? rel + "/" + ent.name : ent.name;
        seen.push(relPath);
        if (seen.length >= 40) return;
      }
    }
  };
  walk(dir, "", 0);
  if (!seen.length) return "";
  // 浅的优先，其次 index.html 优先，再按名字
  seen.sort((a, b) => {
    const da = a.split("/").length, db = b.split("/").length;
    if (da !== db) return da - db;
    const ia = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
    const ib = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });
  return seen[0];
}

export function detectProject(dir) {
  const info = { dir, mode: null, reasons: [], contentJson: "", publicDir: "", viteConfig: "" };
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ...info, error: "目录不存在" };
  }
  const pkgPath = path.join(dir, "package.json");
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      info.reasons.push("package.json 解析失败");
    }
  }
  const depNames = pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }) : [];
  info.hasPkg = Boolean(pkg);
  info.framework = depNames.includes("next") ? "next" : depNames.includes("react") ? "react" : depNames.includes("vue") ? "vue" : "";
  // 项目是否已自带旧版编辑器插件：只用于提示 + 预览内忽略，绝不改项目文件
  const embeddedSources = [];
  try {
    if (exists(dir, "tools", "visual-editor")) embeddedSources.push("tools/visual-editor 目录");
    const scanCfg = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]
      .map((n) => path.join(dir, n))
      .find((f) => fs.existsSync(f));
    if (scanCfg) {
      const text = fs.readFileSync(scanCfg, "utf8");
      if (/visual-editor|visualEditor/.test(text)) embeddedSources.push(path.basename(scanCfg));
    }
    if (depNames.some((d) => String(d).includes("visual-editor"))) embeddedSources.push("package.json 依赖");
  } catch { /* 检测失败不影响打开 */ }
  info.embeddedEditor = { detected: embeddedSources.length > 0, sources: embeddedSources };

  // Vite：优先项目自己装的 vite（我们要用它来起服务）
  const cfgCandidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs"];
  const cfg = cfgCandidates.find((n) => exists(dir, n));
  const viteInstalled = exists(dir, "node_modules", "vite", "package.json") || exists(dir, "node_modules", "vite", "dist", "node", "index.js");
  if (viteInstalled) {
    info.mode = "vite";
    info.viteConfig = cfg || "";
    info.reasons.push("检测到 node_modules/vite" + (cfg ? ` + ${cfg}` : ""));
  } else if (exists(dir, "index.html") || ["dist", "out", "build", "public", "www"].some((s) => exists(dir, s, "index.html"))) {
    info.mode = "static";
    const entry = detectStaticEntry(dir);
    info.webRoot = entry.webRoot;
    info.entryPath = entry.entryPath;
    info.reasons.push("静态站托管 + 注入" + (entry.webRoot !== dir ? "（入口 " + path.basename(entry.webRoot) + "/）" : "") + (entry.entryPath ? "，跟随跳转到 " + entry.entryPath : ""));
  } else if (findFirstHtml(dir, 3)) {
    // 没有 index.html（比如工具/交付物目录）：只要浅层有 HTML，也按静态站打开，入口用第一个 HTML
    const first = findFirstHtml(dir, 3);
    info.mode = "static";
    info.webRoot = dir;
    info.entryPath = "/" + first;
    info.reasons.push("静态站托管（无 index.html，入口跟随 " + info.entryPath + "）");
  } else if (cfg) {
    info.error = "有 Vite 配置，但项目里没装 vite（先在该目录执行一次 npm install）";
  } else {
    info.error = "没认出项目类型：需要 node_modules/vite 或 index.html";
  }

  // 可回写的内容文件 / 静态资源目录
  for (const rel of ["src/content.json", "content.json", "src/data/content.json", "src/content.ts"]) {
    if (exists(dir, rel)) {
      if (rel.endsWith(".json")) info.contentJson = rel;
      break;
    }
  }
  for (const rel of ["public", "static", "assets"]) {
    if (exists(dir, rel) && fs.statSync(path.join(dir, rel)).isDirectory()) {
      info.publicDir = rel;
      break;
    }
  }
  return info;
}

/** 列目录（给插件里的文件夹选择器用） */
export function browse(dir) {
  const home = process.env.USERPROFILE || process.env.HOME || "C:\\";
  const target = dir && fs.existsSync(dir) ? path.resolve(dir) : home;
  const out = { path: target, parent: path.dirname(target) === target ? null : path.dirname(target), dirs: [], here: detectProject(target) };

  if (!fs.existsSync(target)) return { ...out, error: "目录不存在" };
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    return { ...out, error: "读不了这个目录：" + err.message };
  }
  out.dirs = entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => {
      const full = path.join(target, e.name);
      const child = detectProject(full);
      return { name: e.name, path: full, mode: child.mode || "", framework: child.framework || "", error: child.error || "" };
    })
    .sort((a, b) => (a.mode === b.mode ? a.name.localeCompare(b.name) : a.mode ? -1 : 1));
  return out;
}

/* ─────────────────────────── 预览实例 ─────────────────────────── */

/**
 * 静态站点入口探测：
 *  - 根 index.html 是跳转壳（meta refresh / location.replace）→ 找到真实入口路径
 *  - 根没有 index.html 时，退到 dist / out / build / public / www 子目录
 */
function detectStaticEntry(dir) {
  const out = { webRoot: dir, entryPath: "" };
  try {
    const indexPath = path.join(dir, "index.html");
    if (!fs.existsSync(indexPath)) {
      for (const sub of ["dist", "out", "build", "public", "www"]) {
        const p = path.join(dir, sub, "index.html");
        if (fs.existsSync(p)) { out.webRoot = path.join(dir, sub); return out; }
      }
      return out;
    }
    const html = fs.readFileSync(indexPath, "utf8").slice(0, 6000);
    let m = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^;]*;\s*url=([^"'>]+)/i);
    if (!m) m = html.match(/location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']/i);
    if (!m) m = html.match(/location\.href\s*=\s*["']([^"']+)["']/i);
    if (m) {
      let target = String(m[1]).trim();
      if (!/^https?:/i.test(target) && !target.startsWith("data:")) {
        target = target.replace(/^\.\//, "").replace(/^\.\.\//, "");
        if (!target.startsWith("/")) target = "/" + target;
        target = target.replace(/index\.html?$/i, "");
        if (!target.endsWith("/")) target += "/";
        out.entryPath = target;
      }
    }
  } catch { /* ignore */ }
  return out;
}

/** 生成/更新"项目顶部导航条"：注入到所有 HTML 页面顶部（静态站），带备份 */
export function injectPageNav(dir) {
  const projectDir = path.resolve(String(dir || ""));
  if (!fs.existsSync(projectDir)) return { ok: false, error: "项目目录无效" };
  const info = detectProject(projectDir);
  if (!info.mode) return { ok: false, error: info.error || "无法识别的项目" };
  if (info.mode !== "static") return { ok: false, error: "Vite / SPA 项目暂不支持生成导航条（请用框架路由）" };
  const webRoot = info.webRoot || projectDir;

  const pages = [];
  const htmlFiles = [];
  const skip = new Set(["node_modules", ".git", ".ve-data", "dist", "build", "out"]);
  const walk = (abs, rel, depth) => {
    if (depth > 3 || htmlFiles.length > 80) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".well-known") continue;
      if (skip.has(ent.name)) continue;
      const p = path.join(abs, ent.name);
      const relChild = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(p, relChild, depth + 1);
      else if (/\.html?$/i.test(ent.name)) {
        let title = "";
        try { const h = fs.readFileSync(p, "utf8"); const m = h.match(/<title[^>]*>([^<]*)<\/title>/i); if (m) title = m[1].trim().slice(0, 40); else { const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); if (h1) title = h1[1].replace(/<[^>]+>/g, "").trim().slice(0, 40); } } catch { /* ignore */ }
        pages.push({ path: "/" + relChild.split(path.sep).join("/"), name: relChild, title, entry: /(^|\/)index\.html?$/i.test(relChild) });
        htmlFiles.push(p);
      }
    }
  };
  walk(webRoot, "", 0);
  pages.sort((a, b) => (a.entry === b.entry ? a.path.localeCompare(b.path) : a.entry ? -1 : 1));
  if (!pages.length) return { ok: false, error: "这个项目没有可识别的页面" };

  const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const links = pages.map((p) => {
    let label = String(p.title || p.path).replace(/^\/+/, "").replace(/\.html?$/i, "") || "页面";
    if (p.entry) label = p.title || "首页";
    return '<a href="' + escHtml(p.path) + '">' + escHtml(label) + "</a>";
  }).join("");
  const block = [
    "<!-- ve:pagenav:start -->",
    '<div data-ve-pagenav data-open="0" style="position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:4px;padding:6px;border-radius:999px;background:rgba(255,255,255,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(0,0,0,.12);box-shadow:0 8px 24px rgba(0,0,0,.12);font:600 13px/1.4 system-ui,-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:inherit">',
    '<button type="button" data-ve-pagenav-toggle aria-label="展开/收起页面导航" style="width:34px;height:26px;border-radius:999px;border:0;background:rgba(127,127,127,.16);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;color:inherit;font-size:10px;line-height:1;-webkit-appearance:none;appearance:none">▶</button>',
    '<span data-ve-pagenav-links style="display:none;align-items:center;gap:2px;white-space:nowrap">' + links + "</span>",
    "</div>",
    "<style>html [data-ve-pagenav] a{display:inline-flex;align-items:center;padding:6px 11px;border-radius:999px;text-decoration:none;color:inherit;opacity:.66;border:1px solid transparent;transition:opacity .15s,background .15s}html [data-ve-pagenav] a:hover{opacity:.95;background:rgba(127,127,127,.16)}html [data-ve-pagenav] a[aria-current=\"page\"]{opacity:.95;border-color:rgba(127,127,127,.45);background:rgba(127,127,127,.10)}html [data-ve-pagenav][data-open=\"0\"]{padding:5px!important}html[data-theme=\"ink\"] [data-ve-pagenav]{background:rgba(23,24,27,.88);border-color:rgba(255,255,255,.16)}</style>",
    "<script>(function(){try{var root=document.querySelector('[data-ve-pagenav]');if(!root)return;var btn=root.querySelector('[data-ve-pagenav-toggle]');var links=root.querySelector('[data-ve-pagenav-links]');function set(open){root.setAttribute('data-open',open?'1':'0');if(links)links.style.display=open?'inline-flex':'none';if(btn)btn.textContent=open?'◀':'▶';}if(btn)btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();set(root.getAttribute('data-open')!=='1');});var p=decodeURIComponent(location.pathname||'/');var as=root.querySelectorAll('a');for(var i=0;i<as.length;i++){var n=String(as[i].getAttribute('href')||'').split('?')[0].split('#')[0];if(!n)continue;if((n==='/'||n==='/index.html')&&(p==='/'||p==='/index.html'))as[i].setAttribute('aria-current','page');else if(n===p)as[i].setAttribute('aria-current','page');}set(false);}catch(e){}})()</script>",
    "<!-- ve:pagenav:end -->",
  ].join("");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(projectDir, ".ve-data", "backups", "pagenav-" + stamp);
  const files = [];
  for (const file of htmlFiles) {
    let html = "";
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) continue;
      html = fs.readFileSync(file, "utf8");
    } catch { continue; }
    const rel = path.relative(webRoot, file).split(path.sep).join("/");
    try {
      fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
      fs.copyFileSync(file, path.join(backupDir, rel));
    } catch { /* ignore */ }
    const re = /<!-- ve:pagenav:start -->[\s\S]*?<!-- ve:pagenav:end -->/;
    let next;
    if (re.test(html)) next = html.replace(re, block);
    else if (/<body[^>]*>/i.test(html)) next = html.replace(/(<body[^>]*>)/i, "$1\n" + block + "\n");
    else next = block + "\n" + html;
    try { fs.writeFileSync(file, next, "utf8"); files.push(rel); } catch { /* ignore */ }
  }
  return { ok: true, mode: "static", files, count: files.length, backupDir: fs.existsSync(backupDir) ? backupDir : "", pages: pages.length };
}

/** 清理源码里注入过的导航块（<!-- ve:pagenav:start/end -->），带备份 */
export function removePageNav(dir) {
  const projectDir = path.resolve(String(dir || ""));
  if (!fs.existsSync(projectDir)) return { ok: false, error: "项目目录无效" };
  const info = detectProject(projectDir);
  if (!info.mode) return { ok: false, error: info.error || "无法识别的项目" };
  const webRoot = info.webRoot || projectDir;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(projectDir, ".ve-data", "backups", "pagenav-remove-" + stamp);
  const files = [];
  const walk = (abs, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".") || ["node_modules", ".ve-data"].includes(ent.name)) continue;
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (/\.html?$/i.test(ent.name)) {
        let html = "";
        try { html = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (!/<!-- ve:pagenav:start -->/.test(html)) continue;
        const next = html.replace(/[ \t]*<!-- ve:pagenav:start -->[\s\S]*?<!-- ve:pagenav:end -->\s*/g, "");
        if (next === html) continue;
        try {
          const rel = path.relative(webRoot, p).split(path.sep).join("/");
          fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
          fs.copyFileSync(p, path.join(backupDir, rel));
          fs.writeFileSync(p, next, "utf8");
          files.push(rel);
        } catch { /* ignore */ }
      }
    }
  };
  walk(webRoot, 0);
  return { ok: true, count: files.length, files, backupDir: files.length && fs.existsSync(backupDir) ? backupDir : "" };
}

export function createPreviewManager(options = {}) {
  const log = options.log || ((...a) => console.log("[web-editor]", ...a));
  const instances = new Map();
  let seq = 0;

  async function open({ dir, contentJson, publicDir, cssOut } = {}) {
    const info = detectProject(dir);
    if (!info.mode) {
      const err = new Error(info.error || "无法识别的项目");
      err.code = "VE_BAD_PROJECT";
      throw err;
    }
    // 同一目录复用
    for (const [id, inst] of instances) {
      if (path.resolve(inst.dir) === path.resolve(dir)) return { ...publicInfo(inst), reused: true };
    }
    const id = "ve" + ++seq + "_" + crypto.randomBytes(3).toString("hex");
    const token = crypto.randomBytes(12).toString("hex");
    const port = await freePort();
    const inst = {
      id, dir: path.resolve(dir), token, port, mode: info.mode,
      framework: info.framework, contentJson: contentJson || info.contentJson || "",
      publicDir: publicDir || info.publicDir || "",
      cssOut: cssOut || (exists(dir, "src") ? "src/editor-overrides.css" : ""),
      webRoot: info.webRoot || path.resolve(dir),
      entryPath: info.entryPath || "",
      pagePath: info.entryPath || "/",
      startedAt: Date.now(), child: null, server: null, logs: [],
      conflict: {
        detected: Boolean(info.embeddedEditor && info.embeddedEditor.detected),
        handled: info.embeddedEditor && info.embeddedEditor.detected ? "pending" : "none",
        sources: (info.embeddedEditor && info.embeddedEditor.sources) || [],
      },
    };
    if (info.mode === "vite") await startVite(inst);
    else {
      await startStatic(inst);
      if (inst.conflict && inst.conflict.detected) {
        inst.conflict.handled = "detected-not-applied-static";
        inst.conflict.note = "静态站：项目里的旧编辑器文件没有参与本次预览，预览由插件内置内核注入。";
      }
    }
    instances.set(id, inst);
    log(`打开预览 ${id} ${inst.mode} ${inst.dir} → ${urlOf(inst)}`);
    return publicInfo(inst);
  }

  const urlOf = (inst) => `http://127.0.0.1:${inst.port}${inst.pagePath || inst.entryPath || "/"}`;

  function publicInfo(inst) {
    return {
      id: inst.id, url: urlOf(inst), entryPath: inst.entryPath || "", page: inst.pagePath || "/", mode: inst.mode, framework: inst.framework, webRoot: inst.webRoot || inst.dir,
      dir: inst.dir, port: inst.port, contentJson: inst.contentJson, publicDir: inst.publicDir,
      conflict: inst.conflict || null,
    };
  }

  async function waitReady(inst, timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (inst.child && inst.child.exitCode !== null) throw new Error("预览进程退出了：" + (inst.logs.slice(-8).join("\n") || "无输出"));
      try {
        const res = await fetch(`http://127.0.0.1:${inst.port}/__ve/config`, { signal: AbortSignal.timeout(1200) });
        if (res.ok) {
          const cfg = await res.json();
          cfg.token = inst.token; // 子进程用同一个 token
          return cfg;
        }
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 350));
    }
    throw new Error("预览启动超时。最近的日志：\n" + (inst.logs.slice(-10).join("\n") || "无输出"));
  }

  async function startVite(inst) {
    const args = [
      "--dir", inst.dir,
      "--port", String(inst.port),
      "--token", inst.token,
      "--data", ".ve-data",
      "--content", inst.contentJson || "",
      "--public", inst.publicDir || "",
      "--css-out", inst.cssOut || "",
    ];
    const child = spawn(process.execPath, [VITE_RUN, ...args], {
      cwd: inst.dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VE_TOKEN: inst.token },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    inst.child = child;
    const push = (line) => {
      const s = String(line).trimEnd();
      if (!s) return;
      if (s.startsWith("VE_CONFLICT ")) {
        try { inst.conflict = JSON.parse(s.slice("VE_CONFLICT ".length)); } catch { /* ignore */ }
      }
      inst.logs.push(s);
      if (inst.logs.length > 60) inst.logs.shift();
    };
    child.stdout.on("data", (b) => String(b).split(/\r?\n/).forEach(push));
    child.stderr.on("data", (b) => String(b).split(/\r?\n/).forEach(push));
    child.on("exit", (code) => push(`[vite] 进程退出 code=${code}`));
    await waitReady(inst);
  }

  async function startStatic(inst) {
    const { createStore, mimeOf } = await import(pathToFileURL(path.join(VENDOR, "api.mjs")).href);
    const { createApiHandler, injectRuntime } = await import(pathToFileURL(path.join(VENDOR, "handler.mjs")).href);
    const normalizePage = (p) => {
      let n = String(p || "/").split("?")[0].split("#")[0];
      try { n = decodeURIComponent(n); } catch { /* keep */ }
      if (!n.startsWith("/")) n = "/" + n;
      if (n === "/" || n === (inst.entryPath || "/") || /\/index\.html?$/i.test(n)) return "/";
      return n;
    };
    const pageSlugOf = (p) => {
      const n = normalizePage(p);
      return n === "/" ? "" : n.replace(/^\/+/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "");
    };
    const stores = new Map();
    const storeFor = (p) => {
      const key = normalizePage(p);
      if (!stores.has(key)) {
        stores.set(key, createStore({
          root: inst.webRoot || inst.dir,
          dataDir: ".ve-data",
          contentJson: inst.contentJson,
          publicDir: inst.publicDir,
          cssOut: inst.cssOut,
          token: inst.token,
          page: pageSlugOf(key),
        }));
      }
      return stores.get(key);
    };
    inst.stores = stores;
    const handlers = new Map();
    const handlerFor = (p) => {
      const key = normalizePage(p);
      if (!handlers.has(key)) handlers.set(key, createApiHandler(storeFor(key)));
      return handlers.get(key);
    };
    inst.handlerFor = handlerFor;
    const pageOfRequest = (req) => {
      try {
        const ref = req.headers && req.headers.referer;
        if (ref) {
          let p = new URL(ref).pathname || inst.pagePath || "/";
          try { p = decodeURIComponent(p); } catch { /* keep */ }
          return p;
        }
      } catch { /* ignore */ }
      return inst.pagePath || "/";
    };
    const server = http.createServer(async (req, res) => {
      try {
        const api = handlerFor(pageOfRequest(req));
        if (await api(req, res)) return;
        const u = new URL(req.url || "/", "http://127.0.0.1");
        let rel = decodeURIComponent(u.pathname);
        let file = path.join(inst.webRoot || inst.dir, rel);
        if (!path.resolve(file).startsWith(path.resolve(inst.webRoot || inst.dir))) { res.writeHead(403).end("forbidden"); return; }
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
        if (!fs.existsSync(file) && !path.extname(rel)) file = path.join(inst.webRoot || inst.dir, "index.html");
        if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404"); return; }
        const ext = path.extname(file).toLowerCase();
        if (ext === ".html" || ext === ".htm") {
          if (u.searchParams.get("ve_shot") === "1") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(fs.readFileSync(file));
            return;
          }
          const html = injectRuntime(fs.readFileSync(file, "utf8"), {
            config: { token: inst.token, contentJson: inst.contentJson, mode: "dsh-plugin", page: normalizePage(rel) },
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
          return;
        }
        res.writeHead(200, { "Content-Type": mimeOf(file), "Cache-Control": "no-store" }).end(fs.readFileSync(file));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err?.stack || err));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(inst.port, "127.0.0.1", resolve);
    });
    inst.server = server;
    await waitReady(inst, 8000);
  }

  function lastOpened() {
    let best = null;
    for (const inst of instances.values()) {
      if (!best || (inst.startedAt || 0) > (best.startedAt || 0)) best = inst;
    }
    return best ? publicInfo(best) : null;
  }

  function get(id) {
    return instances.get(id) || null;
  }

  async function close(id) {
    const inst = instances.get(id);
    if (!inst) return { ok: true, already: true };
    instances.delete(id);
    try {
      if (inst.child && inst.child.exitCode === null) {
        if (process.platform === "win32" && inst.child.pid) {
          spawn("taskkill", ["/pid", String(inst.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          inst.child.kill("SIGTERM");
        }
      }
    } catch { /* ignore */ }
    try {
      if (inst.server) await new Promise((r) => inst.server.close(r));
    } catch { /* ignore */ }
    log(`关闭预览 ${id}`);
    return { ok: true };
  }

  async function disposeAll() {
    for (const id of [...instances.keys()]) await close(id);
  }

  /* ---- 代理到预览服务的 __ve 接口（复用编辑器内核的 AI 能力） ---- */
  async function proxy(id, apiPath, payload) {
    const inst = instances.get(id);
    if (!inst) throw new Error("预览不存在或已关闭");
    const res = await fetch(`${urlOf(inst)}__ve/${apiPath}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "x-ve-token": inst.token },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `预览接口 ${apiPath} 返回 ${res.status}`);
    return data;
  }

  /** 列出可编辑页面：静态站扫描 .html；Vite 视为单页应用（入口页 + 手动路径） */
  function listPages(dir) {
    const info = detectProject(dir);
    if (!info.mode) return { ok: false, mode: null, pages: [], error: info.error || "无法识别的项目" };
    if (info.mode === "vite") {
      const inst = [...instances.values()].find((x) => path.resolve(x.dir) === path.resolve(dir));
      const cur = (inst && inst.pagePath) || "/";
      return {
        ok: true, mode: "vite", framework: info.framework || "", spaLikely: true,
        pages: [{ path: "/", name: "入口页", title: "", current: cur === "/" }],
        current: cur,
        hint: "Vite/SPA 项目：路由由框架决定，可手动输入路径切换（如 /about）",
      };
    }
    const root = info.webRoot || path.resolve(dir);
    const pages = [];
    const skip = new Set(["node_modules", ".git", ".ve-data", ".next", ".nuxt", "coverage"]);
    const walk = (abs, rel, depth) => {
      if (depth > 3 || pages.length > 80) return;
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith(".") && ent.name !== ".well-known") continue;
        if (skip.has(ent.name)) continue;
        const absChild = path.join(abs, ent.name);
        const relChild = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) walk(absChild, relChild, depth + 1);
        else if (/\.html?$/i.test(ent.name)) {
          const isIndex = ent.name.toLowerCase() === "index.html";
          pages.push({
            path: "/" + relChild.split(path.sep).join("/"),
            name: relChild.split(path.sep).join("/"),
            isIndex,
            title: (() => { try { const h = fs.readFileSync(absChild, "utf8"); const m = h.match(/<title[^>]*>([^<]*)<\/title>/i); return m ? m[1].trim().slice(0, 60) : ""; } catch { return ""; } })(),
          });
        }
      }
    };
    walk(root, "", 0);
    pages.sort((a, b) => (a.isIndex === b.isIndex ? a.path.localeCompare(b.path) : a.isIndex ? -1 : 1));
    const inst = [...instances.values()].find((x) => path.resolve(x.dir) === path.resolve(dir));
    const cur = (inst && inst.pagePath) || (info.entryPath || "/");
    const entryRel = (info.entryPath || "index.html").replace(/^\/+/, "");
    for (const p of pages) {
      p.current = p.path === cur;
      p.entry = p.path === "/" + entryRel || /(^|\/)index\.html?$/i.test(p.path);
      p.deletable = !p.entry;
    }
    return { ok: true, mode: "static", pages, current: cur, entryPath: info.entryPath || "" };
  }

  /** 页面路径规范化（保留中文；过滤非法字符；自动补 .html） */
  function normalizePageRel(name) {
    let rel = String(name || "").trim();
    if (!rel) throw new Error("缺少页面文件名");
    rel = rel.replace(/\\/g, "/").replace(/[<>:"|?*\u0000-\u001f]/g, "").split("/").map((seg) => seg.trim().replace(/\s+/g, "-").replace(/^\.+$/, "")).filter(Boolean).join("/");
    if (!rel) throw new Error("页面文件名无效");
    if (!/\.html?$/i.test(rel)) rel += ".html";
    if (rel.split("/").some((seg) => seg === "." || seg === "..")) throw new Error("页面路径无效");
    return rel;
  }

  function shotFileOf(webRoot, rel) {
    try {
      const slug = pageSlugOfRel(rel);
      return slug ? path.join(webRoot, ".ve-data", "shots", "pages", slug + ".png") : "";
    } catch { return ""; }
  }

  function pageSlugOfRel(rel) {
    const n = "/" + String(rel || "").replace(/^\/+/, "");
    return n === "/" ? "" : n.replace(/^\/+/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "");
  }

  function staticPageContext(dir, page) {
    const info = detectProject(dir);
    if (!info.mode) throw new Error(info.error || "无法识别的项目");
    if (info.mode !== "static") throw new Error("Vite / SPA 项目不支持页面文件管理（请用框架自己的方式）");
    const webRoot = info.webRoot || path.resolve(dir);
    let rel = String(page || "").replace(/\\/g, "/").trim();
    if (!rel) throw new Error("缺少页面路径");
    rel = rel.replace(/^\/+/, "");
    if (/\.html?$/i.test(rel) === false) rel += ".html";
    const abs = path.join(webRoot, rel);
    if (!path.resolve(abs).startsWith(path.resolve(webRoot))) throw new Error("页面路径越界");
    if (!fs.existsSync(abs)) throw new Error("页面不存在：" + rel);
    const entryRel = (info.entryPath || "index.html").replace(/^\/+/, "");
    const isEntry = rel === entryRel || /(^|\/)index\.html?$/i.test(rel) && rel === entryRel;
    return { info, webRoot, rel, abs, entryRel, isEntry };
  }

  /** 新建静态页面：复制入口 HTML 骨架，改标题/主标题，修正相对路径 */
  function createPage(dir, name, opts = {}) {
    const info = detectProject(dir);
    if (!info.mode) throw new Error(info.error || "无法识别的项目");
    if (info.mode !== "static") throw new Error("Vite / SPA 项目请用框架自己的方式新建页面（这里只支持静态站）");
    const webRoot = info.webRoot || path.resolve(dir);
    const rel = normalizePageRel(name);
    const target = path.join(webRoot, rel);
    if (!path.resolve(target).startsWith(path.resolve(webRoot))) throw new Error("页面路径越界");
    if (fs.existsSync(target)) throw new Error("页面已存在：" + rel);

    // 模板：入口页（优先 detectStaticEntry 的入口，其次 index.html）
    let templateFile = info.entryPath ? path.join(webRoot, info.entryPath) : path.join(webRoot, "index.html");
    if (!fs.existsSync(templateFile)) templateFile = path.join(webRoot, "index.html");
    let html = "";
    try { html = fs.readFileSync(templateFile, "utf8"); } catch { throw new Error("找不到可复制的入口 HTML"); }

    // 去掉固化脚本引用（子页面由固化时统一注入）
    html = html.replace(/\n?<script[^>]*ve-applied[^>]*><\/script>\s*/gi, "\n");

    const baseName = rel.split("/").pop().replace(/\.html?$/i, "");
    const depth = rel.split("/").length - 1;
    const prefix = "../".repeat(depth);
    if (prefix) {
      // 子目录页面：把相对引用改成 ../ 前缀
      html = html.replace(/\b(href|src)=(["'])(?![a-zA-Z]+:|\/|#|data:|\.\.\/)([^"']+)\2/gi, (m, attr, q, val) => attr + "=" + q + prefix + val + q);
    }
    html = html.replace(/<title[^>]*>[^<]*<\/title>/i, "<title>" + baseName + "</title>");

    const backHref = prefix + (info.entryPath || "index.html");
    const backHtml = opts.backLink
      ? '<p style="margin:0 0 24px"><a href="' + backHref + '" style="display:inline-block;padding:8px 14px;border:1px solid currentColor;border-radius:999px;text-decoration:none;color:inherit;font:inherit;opacity:.8">← 返回首页</a></p>'
      : "";
    const template = opts.template === "copy" ? "copy" : "blank";
    if (template === "copy") {
      // 复制当前页：只改标题/H1，并在 body 开头加返回链接
      html = html.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i, (m, a, inner, b) => a + baseName + b);
      if (backHtml) {
        html = html.replace(/(<body[^>]*>)/i, "$1\n" + backHtml);
      }
    } else {
      // 空白页：保留 <head>（站点样式/脚本），正文换成占位内容
      const bodyHtml = '<main class="ve-new-page" style="max-width:960px;margin:0 auto;padding:72px 24px">' +
        backHtml +
        "<h1>" + baseName + "</h1>" +
        '<p style="opacity:.65;line-height:1.8">这是新页面的内容占位：在编辑器里直接改文字、加图片，或者把这里的占位删掉。</p>' +
        "</main>";
      if (/<body[^>]*>[\s\S]*<\/body>/i.test(html)) {
        html = html.replace(/(<body[^>]*>)[\s\S]*?(<\/body>)/i, "$1\n" + bodyHtml + "\n$2");
      } else {
        html = "<!doctype html>\n<html><head><meta charset=\"utf-8\"></head><body>\n" + bodyHtml + "\n</body></html>";
      }
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, html, "utf8");
    return { ok: true, path: "/" + rel.split(path.sep).join("/"), name: rel, title: baseName, template };
  }

  /** 列出页面操作备份（删除/改名/复制前自动备份的） */
  function listPageBackups(dir) {
    const projectDir = path.resolve(String(dir || ""));
    const root = path.join(projectDir, ".ve-data", "backups");
    const backups = [];
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || !/^pages-manage-/.test(ent.name)) continue;
        const dirPath = path.join(root, ent.name);
        const files = [];
        const walk = (abs, rel, depth) => {
          if (depth > 4) return;
          let list = [];
          try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
          for (const e of list) {
            const p = path.join(abs, e.name);
            if (e.isDirectory()) walk(p, rel ? rel + "/" + e.name : e.name, depth + 1);
            else if (rel === "html" || rel.startsWith("html/")) files.push((rel + "/" + e.name).replace(/^html\//, ""));
          }
        };
        walk(dirPath, "", 0);
        let at = 0;
        try { at = fs.statSync(dirPath).mtimeMs; } catch { at = 0; }
        backups.push({ name: ent.name, at, files: [...new Set(files)] });
      }
    } catch { /* ignore */ }
    backups.sort((a, b) => b.at - a.at);
    return { ok: true, dir: projectDir, backups: backups.slice(0, 30) };
  }

  /** 从某个页面备份还原（HTML + 该页数据目录） */
  function restorePageBackup(dir, backupName) {
    const projectDir = path.resolve(String(dir || ""));
    const name = String(backupName || "");
    if (!/^pages-manage-[\w.-]+$/.test(name)) throw new Error("备份名无效");
    const src = path.join(projectDir, ".ve-data", "backups", name);
    if (!fs.existsSync(src)) throw new Error("备份不存在：" + name);
    const restored = [];
    const copyBack = (from, to, labelBase) => copyTree(from, to, (rel) => { restored.push(rel); void labelBase; });
    const htmlDir = path.join(src, "html");
    if (fs.existsSync(htmlDir)) copyBack(htmlDir, projectDir);
    const pagesDir = path.join(src, "pages");
    if (fs.existsSync(pagesDir)) copyBack(pagesDir, path.join(projectDir, ".ve-data", "pages"));
    return { ok: true, restored: [...new Set(restored)].slice(0, 50), count: new Set(restored).size };
  }

  /** 页面管理：备份到 .ve-data/backups/pages-<action>-<ts>/ 后执行 */
  function copyTree(src, dst, onFile, baseRoot) {
    let st = null;
    try { st = fs.statSync(src); } catch { return; }
    const root = baseRoot || src;
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        copyTree(path.join(src, ent.name), path.join(dst, ent.name), onFile, root);
      }
    } else if (st.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      try { if (typeof onFile === "function") onFile(path.relative(root, src).split(path.sep).join("/")); } catch { /* ignore */ }
    }
  }

  function backupPageFiles(webRoot, rel, dataSlug) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(webRoot, ".ve-data", "backups", "pages-manage-" + stamp);
    try {
      const htmlSrc = path.join(webRoot, rel);
      if (fs.existsSync(htmlSrc)) {
        const dst = path.join(dir, "html", rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(htmlSrc, dst);
      }
      const dataSrc = dataSlug ? path.join(webRoot, ".ve-data", "pages", dataSlug) : "";
      if (dataSrc && fs.existsSync(dataSrc)) {
        const dst = path.join(dir, "pages", dataSlug);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        copyTree(dataSrc, dst);
      }
    } catch { /* ignore */ }
    return { backupDir: dir, exists: fs.existsSync(dir) };
  }

  function dropPageData(webRoot, slug) {
    if (!slug) return;
    try { fs.rmSync(path.join(webRoot, ".ve-data", "pages", slug), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  function deletePage(dir, page) {
    const ctx = staticPageContext(dir, page);
    if (ctx.isEntry) throw new Error("入口页不能删除");
    const slug = pageSlugOfRel(ctx.rel);
    const backup = backupPageFiles(ctx.webRoot, ctx.rel, slug);
    fs.rmSync(ctx.abs, { force: true });
    dropPageData(ctx.webRoot, slug);
    try { const shot = shotFileOf(ctx.webRoot, ctx.rel); if (shot) fs.rmSync(shot, { force: true }); } catch { /* ignore */ }
    // 当前正在看这个页面 → 切回入口页
    for (const inst of instances.values()) {
      if (path.resolve(inst.dir) === path.resolve(dir) && inst.pagePath === "/" + ctx.rel) inst.pagePath = "/";
    }
    return { ok: true, action: "delete", page: "/" + ctx.rel, backupDir: backup.exists ? backup.backupDir : "" };
  }

  function renamePage(dir, page, to) {
    const ctx = staticPageContext(dir, page);
    if (ctx.isEntry) throw new Error("入口页不能重命名");
    const rel = normalizePageRel(to);
    if (rel === ctx.rel) throw new Error("新名字和原来一样");
    const target = path.join(ctx.webRoot, rel);
    if (fs.existsSync(target)) throw new Error("目标页面已存在：" + rel);
    const oldSlug = pageSlugOfRel(ctx.rel);
    const newSlug = pageSlugOfRel(rel);
    const backup = backupPageFiles(ctx.webRoot, ctx.rel, oldSlug);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(ctx.abs, target);
    try {
      const from = path.join(ctx.webRoot, ".ve-data", "pages", oldSlug);
      const toDir = path.join(ctx.webRoot, ".ve-data", "pages", newSlug);
      if (oldSlug && fs.existsSync(from)) fs.renameSync(from, toDir);
    } catch { /* ignore */ }
    try {
      const oldShot = shotFileOf(ctx.webRoot, ctx.rel);
      const newShot = shotFileOf(ctx.webRoot, rel);
      if (oldShot && newShot && fs.existsSync(oldShot)) fs.renameSync(oldShot, newShot);
    } catch { /* ignore */ }
    for (const inst of instances.values()) {
      if (path.resolve(inst.dir) === path.resolve(dir) && inst.pagePath === "/" + ctx.rel) inst.pagePath = "/" + rel;
    }
    return { ok: true, action: "rename", from: "/" + ctx.rel, page: "/" + rel, backupDir: backup.exists ? backup.backupDir : "" };
  }

  function copyPage(dir, page, to) {
    const ctx = staticPageContext(dir, page);
    const rel = normalizePageRel(to);
    if (rel === ctx.rel) throw new Error("新名字和原来一样");
    const target = path.join(ctx.webRoot, rel);
    if (fs.existsSync(target)) throw new Error("目标页面已存在：" + rel);
    const oldSlug = pageSlugOfRel(ctx.rel);
    const newSlug = pageSlugOfRel(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(ctx.abs, target);
    try {
      const from = path.join(ctx.webRoot, ".ve-data", "pages", oldSlug);
      const toDir = path.join(ctx.webRoot, ".ve-data", "pages", newSlug);
      if (oldSlug && fs.existsSync(from)) copyTree(from, toDir);
    } catch { /* ignore */ }
    try {
      const oldShot = shotFileOf(ctx.webRoot, ctx.rel);
      const newShot = shotFileOf(ctx.webRoot, rel);
      if (oldShot && newShot && fs.existsSync(oldShot)) fs.copyFileSync(oldShot, newShot);
    } catch { /* ignore */ }
    return { ok: true, action: "copy", from: "/" + ctx.rel, page: "/" + rel };
  }

  /** 切换某个预览实例当前显示的页面 */
  async function setPage(id, page) {
    const inst = instances.get(id);
    if (!inst) throw new Error("预览不存在或已关闭");
    let p = String(page || "/").trim() || "/";
    if (!p.startsWith("/")) p = "/" + p;
    p = p.split("?")[0].split("#")[0];
    if (inst.mode === "static") {
      let file = path.join(inst.webRoot || inst.dir, decodeURIComponent(p));
      if (!path.resolve(file).startsWith(path.resolve(inst.webRoot || inst.dir))) throw new Error("页面路径越界");
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file)) throw new Error("页面不存在：" + p);
    }
    inst.pagePath = p;
    inst.startedAt = inst.startedAt || Date.now();
    return publicInfo(inst);
  }

  return { open, close, get, lastOpened, list: () => [...instances.values()].map(publicInfo), disposeAll, proxy, browse, detectProject, listPages, setPage, createPage, deletePage, renamePage, copyPage, listPageBackups, restorePageBackup, injectPageNav, removePageNav };
}
