#!/usr/bin/env node
/**
 * dsh-ui-editor 独立启动器（不依赖 DSH）
 *
 * 用法：
 *   node tools/standalone/launcher.mjs --dir <项目目录> [--port 19391] [--open] [--static] [--styles <风格库目录>]
 *
 * 能力：
 *   - 纯静态站：自己起服务并在 HTML 里注入编辑器内核
 *   - Vite/React 项目：自动用项目自带的 vite 起 dev server 并注入编辑器内核（不改项目文件），
 *     本启动器做反向代理（含 HMR websocket）；/ve/wb 与 /ve/plugin 仍由本进程提供
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const VENDOR = path.join(ROOT, "tools/visual-editor");
const WB_DIR = path.join(ROOT, "workbench-ui");
const VITE_RUN = path.join(ROOT, "dsh-plugin/lib/vite-run.mjs");

/* ── 参数 ── */
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const PROJECT = String(opt("dir", "") || "");
const PORT = Number(opt("port", 19391));
const OPEN = Boolean(opt("open", false));
const OPEN_EDITOR = Boolean(opt("editor", false));
const FORCE_STATIC = Boolean(opt("static", false));
const STYLES_DIR = String(
  opt("styles", "") ||
  path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".dsh", "plugin-data", "dsh-ui-editor", "styles")
);

if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "dsh-ui-editor 独立启动器",
    "",
    "用法：node tools/standalone/launcher.mjs --dir <项目目录> [选项]",
    "",
    "选项：",
    "  --dir <路径>     要编辑的项目目录（必填）",
    "  --port <端口>    监听端口，默认 19391（被占用会自动顺延）",
    "  --open           启动后自动打开浏览器",
    "  --static         强制按静态站处理（Vite 项目也可用，但不会热更新）",
    "  --styles <目录>  风格库目录，默认 ~/.dsh/plugin-data/dsh-ui-editor/styles",
    "  --help            显示本帮助",
  ].join("\n"));
  process.exit(0);
}
if (!PROJECT || !fs.existsSync(PROJECT)) {
  console.error("用法：node tools/standalone/launcher.mjs --dir <项目目录> [--port 19391] [--open] [--static] [--styles <风格库目录>]");
  console.error("（加 --help 查看完整说明；也可以把项目文件夹直接拖到 启动独立编辑器.bat 上）");
  process.exit(1);
}
const PROJECT_ROOT = path.resolve(PROJECT);
const DATA_DIR = path.join(PROJECT_ROOT, ".ve-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const hasVite = !FORCE_STATIC && fs.existsSync(path.join(PROJECT_ROOT, "node_modules/vite/dist/node/index.js"));
const isStatic = !hasVite;
const cssOut = hasVite && fs.existsSync(path.join(PROJECT_ROOT, "src")) ? "src/editor-overrides.css" : "";

/* ── 风格库读取（与 DSH 插件共用） ── */
function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; } }
function styleList() {
  const out = [];
  try {
    for (const id of fs.readdirSync(STYLES_DIR)) {
      const dir = path.join(STYLES_DIR, id);
      const meta = readJson(path.join(dir, "meta.json"), null);
      if (!meta) continue;
      const spec = readJson(path.join(dir, "style-spec.json"), {});
      const colors = (spec.colors || []).map((c) => String(c.value || "")).filter((v) => /^#|rgb/i.test(v)).slice(0, 6);
      const ink = (spec.colors || []).find((c) => /ink|text|title|fg/i.test(String(c.name || "")));
      const bg = (spec.colors || []).find((c) => /paper|bg|background|surface|canvas/i.test(String(c.name || "")));
      const strokeTok = (spec.colors || []).some((c) => /stroke|outline|echo/i.test(String(c.name || "")));
      const mention = /轮廓回声|echo|text-stroke/i.test(String(spec.notes || ""));
      out.push({
        id,
        name: meta.name || id,
        source: meta.source || "",
        createdAt: meta.createdAt || 0,
        colors,
        titleColor: (ink && ink.value) || colors[colors.length - 1] || "#1f2937",
        bgColor: (bg && bg.value) || colors[0] || "#f5f5f5",
        font: meta.font || "",
        fontStack: meta.fontStack || (spec.fonts || [])[0]?.value || "",
        smallFont: meta.smallFont || "",
        smallFontStack: meta.smallFontStack || (spec.fonts || [])[1]?.value || "",
        description: meta.description || "",
        titleEffect: meta.titleEffect === "none" ? "" : (strokeTok || mention ? "stroke" : ""),
        strokeColor: ((spec.colors || []).find((c) => /stroke/i.test(String(c.name || ""))) || {}).value || "",
      });
    }
  } catch { /* ignore */ }
  return out;
}
function readStyle(id) {
  const dir = path.join(STYLES_DIR, String(id || ""));
  return {
    dir,
    meta: readJson(path.join(dir, "meta.json"), null),
    brief: (() => { try { return fs.readFileSync(path.join(dir, "style-brief.md"), "utf8"); } catch { return ""; } })(),
  };
}
function composePrompt(st, dir) {
  const name = (st.meta && st.meta.name) || "";
  const briefFile = path.join(dir || PROJECT_ROOT, ".ve-data", "style-brief.md");
  try { if (st.brief) fs.writeFileSync(briefFile, st.brief, "utf8"); } catch { /* ignore */ }
  return [
    "请按保存的 UI 风格「" + name + "」优化项目：" + (dir || PROJECT_ROOT),
    "",
    "风格规范已写入文件（含完整 token 与执行要求）：",
    briefFile,
    "",
    "请先读取这个文件，把里面的颜色 / 字体 / 圆角 / 间距 / 动效 token 当作硬约束，再逐处修改页面样式。",
  ].join("\n");
}

/* ── 静态站页面列表（给工作台/导航胶囊用） ── */
function listStaticPages(root) {
  const pages = [];
  const skip = new Set(["node_modules", ".git", ".ve-data", "dist", "build", "out", "coverage"]);
  const walk = (abs, rel, depth) => {
    if (depth > 3 || pages.length > 80) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".well-known") continue;
      if (skip.has(ent.name)) continue;
      const p = path.join(abs, ent.name);
      const relChild = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) { walk(p, relChild, depth + 1); continue; }
      if (!/\.html?$/i.test(ent.name)) continue;
      let title = "";
      try {
        const h = fs.readFileSync(p, "utf8");
        const m = h.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (m) title = m[1].trim().slice(0, 40);
        else {
          const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
          if (h1) title = h1[1].replace(/<[^>]+>/g, "").trim().slice(0, 40);
        }
      } catch { /* ignore */ }
      pages.push({
        path: "/" + relChild.split(path.sep).join("/"),
        name: relChild,
        title,
        entry: /(^|\/)index\.html?$/i.test(relChild),
      });
    }
  };
  walk(root, "", 0);
  pages.sort((a, b) => (a.entry === b.entry ? a.path.localeCompare(b.path) : a.entry ? -1 : 1));
  return pages;
}

/* ── 工具 ── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8",
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
function safeJoin(root, urlPath) {
  const p = path.normalize(path.join(root, decodeURIComponent(urlPath)));
  if (!p.startsWith(root)) return null;
  return p;
}
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ "cache-control": "no-store" }, headers || {}));
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8" });
}
async function readBody(req, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function parseJson(buf, def = {}) {
  try { return JSON.parse(buf.toString("utf8")); } catch { return def; }
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* ── 静态模式内核（按需加载） ── */
let apiHandler = null;
let injectRuntime = null;

/* ── Vite 子进程 ── */
let viteChild = null;
let vitePort = 0;
async function startViteServer() {
  vitePort = await getFreePort();
  const token = Math.random().toString(36).slice(2, 12);
  const childArgs = [
    VITE_RUN,
    "--dir", PROJECT_ROOT,
    "--port", String(vitePort),
    "--token", token,
    "--data", ".ve-data",
    "--css-out", cssOut || "",
  ];
  viteChild = spawn(process.execPath, childArgs, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VE_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  const push = (b) => {
    for (const line of String(b).split(/\r?\n/)) {
      const s = line.trimEnd();
      if (!s) continue;
      logs.push(s);
      if (logs.length > 40) logs.shift();
    }
  };
  viteChild.stdout.on("data", push);
  viteChild.stderr.on("data", push);
  viteChild.on("exit", (code) => { if (code) console.error("[vite] 退出 code=" + code + "\n" + logs.slice(-8).join("\n")); });

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch("http://127.0.0.1:" + vitePort + "/", { redirect: "manual" });
      if (r.status >= 200 && r.status < 500) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Vite dev server 启动超时。最近日志：\n" + logs.slice(-10).join("\n"));
}

/* ── 反向代理（含 HMR websocket） ── */
function proxyHttp(req, res) {
  const headers = Object.assign({}, req.headers, { host: "127.0.0.1:" + vitePort });
  const up = http.request({ host: "127.0.0.1", port: vitePort, path: req.url, method: req.method, headers }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  up.on("error", (e) => sendJson(res, 502, { ok: false, error: "vite 代理失败：" + String(e.message || e) }));
  req.pipe(up);
}
function proxyUpgrade(req, socket, head) {
  const remote = net.connect(vitePort, "127.0.0.1", () => {
    const lines = ["GET " + req.url + " HTTP/1.1"];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = k.toLowerCase() === "host" ? "127.0.0.1:" + vitePort : req.rawHeaders[i + 1];
      lines.push(k + ": " + v);
    }
    remote.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) remote.write(head);
    remote.pipe(socket);
    socket.pipe(remote);
  });
  remote.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
  socket.on("error", () => { try { remote.destroy(); } catch { /* ignore */ } });
}


/* 目录浏览（与 DSH 插件 /browse 同结构：path/parent/dirs/here） */
const SKIP_DIRS = new Set(["node_modules", ".git", ".ve-data", "dist", "build", ".next", ".vite"]);
function detectProject(dir) {
  try {
    const hasPkg = fs.existsSync(path.join(dir, "package.json"));
    const hasIndex = fs.existsSync(path.join(dir, "index.html"));
    if (hasPkg && fs.existsSync(path.join(dir, "node_modules/vite"))) return { mode: "vite", framework: "vite" };
    if (hasPkg) return { mode: "static", framework: "node" };
    if (hasIndex) return { mode: "static", framework: "static" };
    return { mode: "", framework: "" };
  } catch { return { mode: "", framework: "" }; }
}
function browseDir(dir) {
  const target = dir && fs.existsSync(dir) ? path.resolve(dir) : PROJECT_ROOT;
  const out = { path: target, parent: path.dirname(target) === target ? null : path.dirname(target), dirs: [], here: detectProject(target) };
  try {
    out.dirs = fs.readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => {
        const full = path.join(target, e.name);
        const info = detectProject(full);
        return { name: e.name, path: full, mode: info.mode, framework: info.framework };
      })
      .sort((a, b) => (a.mode === b.mode ? a.name.localeCompare(b.name) : a.mode ? -1 : 1));
  } catch (e) {
    out.error = "读不了这个目录：" + String(e.message || e);
  }
  return out;
}

/* ── 启动 ── */
if (isStatic) {
  const handlerMod = await import(pathToFileURL(path.join(VENDOR, "handler.mjs")).href);
  const { createStore } = await import(pathToFileURL(path.join(VENDOR, "api.mjs")).href);
  apiHandler = handlerMod.createApiHandler(
    createStore({ root: PROJECT_ROOT, dataDir: ".ve-data", cssOut, token: "", uploadUrlBase: "/__ve/files/" })
  );
  injectRuntime = handlerMod.injectRuntime;
} else {
  await startViteServer();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const p = url.pathname;
  try {
    /* 工作台前端（本地） */
    if (p === "/ve/wb" || p.startsWith("/ve/wb/")) {
      const rel = p === "/ve/wb" || p === "/ve/wb/" ? "index.html" : p.slice("/ve/wb/".length);
      const file = safeJoin(WB_DIR, rel);
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
        send(res, 200, fs.readFileSync(file), { "content-type": mimeOf(file) });
      } else send(res, 404, "not found");
      return;
    }

    /* 宿主接口（本地） */
    if (p.startsWith("/ve/plugin/")) {
      const sub = p.slice("/ve/plugin".length);
      if (req.method === "GET" && sub === "/projects") {
        sendJson(res, 200, {
          ok: true,
          projects: [{ id: "standalone", dir: PROJECT_ROOT, mode: hasVite ? "vite" : "static", url: "http://127.0.0.1:" + listenPort + "/", at: Date.now() }],
        });
        return;
      }
      if (req.method === "GET" && sub === "/pages") {
        if (hasVite) {
          sendJson(res, 200, { ok: true, pages: [], hint: "Vite / SPA 项目请用框架路由切换页面" });
          return;
        }
        const pages = listStaticPages(PROJECT_ROOT).map((p) => Object.assign({}, p, { current: p.path === "/" || p.path === "/index.html" }));
        sendJson(res, 200, { ok: true, pages });
        return;
      }
      if (req.method === "GET" && sub === "/state") {
        sendJson(res, 200, { ok: true, dir: PROJECT_ROOT, mode: hasVite ? "vite" : "static", url: "http://127.0.0.1:" + listenPort + "/" });
        return;
      }
      if (req.method === "GET" && sub === "/ui-command") { sendJson(res, 200, { ok: true, command: null }); return; }
      if (req.method === "GET" && sub === "/fixate-status") { sendJson(res, 200, { ok: true, state: "none" }); return; }
      if (req.method === "POST" && sub === "/open") { sendJson(res, 200, { ok: true }); return; }
      if (req.method === "GET" && sub === "/browse") { sendJson(res, 200, Object.assign({ ok: true }, browseDir(url.searchParams.get("path") || PROJECT_ROOT))); return; }
      if (req.method === "GET" && sub === "/default-dir") { sendJson(res, 200, { ok: true, path: PROJECT_ROOT }); return; }
      if (req.method === "POST" && sub === "/close") { sendJson(res, 200, { ok: true }); return; }
      if (req.method === "GET" && sub === "/styles") { sendJson(res, 200, { ok: true, styles: styleList() }); return; }
      if (req.method === "POST" && sub === "/styles/apply") {
        const body = parseJson(await readBody(req));
        const st = readStyle(body.id);
        if (!st.meta) { sendJson(res, 200, { ok: false, error: "风格不存在：" + body.id }); return; }
        const dir = String(body.dir || PROJECT_ROOT);
        sendJson(res, 200, { ok: true, text: composePrompt(st, dir), style: { id: body.id, name: st.meta.name } });
        return;
      }
      if (req.method === "POST" && sub === "/handoff") {
        const body = parseJson(await readBody(req));
        console.log("\n===== 风格提示（独立模式：交给你的 Agent） =====");
        console.log(String(body.text || ""));
        console.log("=================================================\n");
        sendJson(res, 200, { ok: false, reason: "standalone-no-agent" });
        return;
      }
      if (req.method === "GET" && sub === "/styles/cover.svg") {
        const id = url.searchParams.get("id") || "";
        const file = path.join(STYLES_DIR, id, "cover.svg");
        if (fs.existsSync(file)) { send(res, 200, fs.readFileSync(file), { "content-type": "image/svg+xml" }); return; }
        send(res, 404, "nf"); return;
      }
      if (req.method === "GET" && sub === "/styles/font.css") {
        const id = url.searchParams.get("id") || "";
        const file = path.join(STYLES_DIR, id, "fonts.css");
        if (fs.existsSync(file)) { send(res, 200, fs.readFileSync(file), { "content-type": "text/css; charset=utf-8" }); return; }
        send(res, 200, "/* no fonts */", { "content-type": "text/css; charset=utf-8" }); return;
      }
      sendJson(res, 200, { ok: false, error: "独立启动器暂不支持：" + sub });
      return;
    }

    /* Vite 模式：其它请求全部代理（含 /__ve 与 HMR） */
    if (hasVite) { proxyHttp(req, res); return; }

    /* 静态模式：内核 API */
    if (p.startsWith("/__ve")) {
      if (await apiHandler(req, res)) return;
    }

    /* 静态模式：项目文件 */
    let rel = p === "/" ? "/index.html" : p;
    let file = safeJoin(PROJECT_ROOT, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const idx = safeJoin(PROJECT_ROOT, path.posix.join(rel, "index.html"));
      if (idx && fs.existsSync(idx)) { rel = path.posix.join(rel, "index.html"); file = idx; }
      else { send(res, 404, "not found"); return; }
    }
    if (/\.html?$/i.test(file)) {
      let html = fs.readFileSync(file, "utf8");
      html = injectRuntime(html, { config: { token: "", contentJson: "", mode: "standalone" } });
      send(res, 200, html, { "content-type": "text/html; charset=utf-8" });
      return;
    }
    send(res, 200, fs.readFileSync(file), { "content-type": mimeOf(file) });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});
server.on("upgrade", (req, socket, head) => { if (hasVite) proxyUpgrade(req, socket, head); else socket.destroy(); });

let listenPort = PORT;
for (let i = 0; i < 12; i++) {
  try {
    await new Promise((resolve, reject) => {
      const onErr = (e) => { server.removeListener("listening", onOk); reject(e); };
      const onOk = () => { server.removeListener("error", onErr); resolve(); };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(listenPort, "127.0.0.1");
    });
    break;
  } catch (e) {
    if (String(e && e.code) !== "EADDRINUSE" || i === 11) throw e;
    listenPort += 1;
  }
}

const urlBase = "http://127.0.0.1:" + listenPort;
console.log("dsh-ui-editor 独立启动器已启动");
console.log("  项目：" + PROJECT_ROOT + "（" + (hasVite ? "Vite 项目（已自动起 dev server，端口 " + vitePort + "）" : "静态站") + "）");
console.log("  工作台：" + urlBase + "/ve/wb/index.html?api=" + encodeURIComponent(urlBase) + "&standalone=1");
  console.log("  编辑器：" + urlBase + "/?ve=1");
console.log("  工作台：" + urlBase + "/ve/wb/index.html?api=" + encodeURIComponent(urlBase) + "&standalone=1");
console.log("  风格库：" + STYLES_DIR + "（" + styleList().length + " 个风格）");
console.log("  默认打开：网页工作台（想直接开编辑器加 --editor）");
  console.log("  Ctrl+C 退出");

if (OPEN) {
  const { exec } = await import("node:child_process");
  const wbUrl = urlBase + "/ve/wb/index.html?api=" + encodeURIComponent(urlBase) + "&standalone=1";
  const target = OPEN_EDITOR ? urlBase + "/?ve=1" : wbUrl;
  const cmd = process.platform === "win32" ? 'start "" "' + target + '"' : process.platform === "darwin" ? 'open "' + target + '"' : 'xdg-open "' + target + '"';
  exec(cmd, () => {});
}

const shutdown = () => {
  try { if (viteChild) viteChild.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => { try { if (viteChild) viteChild.kill(); } catch { /* ignore */ } });
