#!/usr/bin/env node
/**
 * 视觉编辑器 · 本地服务器（适合静态站 / 已构建好的网页，零依赖）
 *
 * 用法：
 *   node tools/visual-editor/server.mjs --root ./my-site
 *   node tools/visual-editor/server.mjs --root ./my-site --content src/content.json --public public
 *
 * 打开 http://127.0.0.1:5270 后，右下角出现「✎ 编辑」。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { exec } from "node:child_process";
import { createStore, mimeOf } from "./api.mjs";
import { createApiHandler, injectRuntime, PREFIX } from "./handler.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const root = path.resolve(process.cwd(), arg("root", "."));
const port = Number(arg("port", "5270"));
if (!fs.existsSync(root)) {
  console.error(`目录不存在：${root}`);
  process.exit(1);
}

const store = createStore({
  root,
  dataDir: arg("data", ".ve-data"),
  contentJson: arg("content", ""),
  publicDir: arg("public", ""),
  cssOut: arg("css-out", ""),
  maxBackups: Number(arg("max-backups", "40")),
});


const ENTRY = arg("entry", "");

function listHtmlPages(dir = root, base = "", depth = 0) {
  if (depth > 3) return [];
  const out = [];
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const name = it.name;
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules" || name === "tools") continue;
    const abs = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (it.isDirectory()) out.push(...listHtmlPages(abs, rel, depth + 1));
    else if (/\.html?$/i.test(name)) out.push(rel);
  }
  return out;
}

function pageTitle(file) {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 5000);
    const m = head.match(/<title[^>]*>([^<]*)<\/title>/i);
    return (m && m[1].trim()) || path.basename(file);
  } catch { return path.basename(file); }
}

function pageUrl(rel) {
  return "/" + rel.split("/").map(encodeURIComponent).join("/");
}

function pickerHtml(pages) {
  const rows = pages.map((rel) => {
    const title = pageTitle(path.join(root, rel));
    const isIndex = rel.toLowerCase() === "index.html";
    return `<a class="row" href="${pageUrl(rel)}">
      <div class="meta"><span class="dot"></span><b>${title.replace(/[<>&]/g, "")}</b>${isIndex ? ' <em>默认</em>' : ""}<small>${rel}</small></div>
      <span class="go">打开 →</span>
    </a>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择页面 — 视觉编辑器</title>
  <style>
    :root{--ink:#0b1220;--gray:#5b667a;--dim:#8b95a8;--blue:#4d6bfe;--line:#e6ebf4}
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;background:#f6f8fc;color:var(--ink);font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;align-items:flex-start;justify-content:center;padding:72px 24px;background-image:radial-gradient(#e6ecf7 1px,transparent 1px);background-size:26px 26px}
    .card{width:min(760px,100%);background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 24px 60px rgba(20,40,90,.08);padding:34px 34px 26px}
    .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    .logo{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.4px}
    .logo i{width:22px;height:22px;border-radius:7px;background:var(--blue);display:inline-block}
    .tag{font-family:Consolas,monospace;font-size:10px;letter-spacing:2px;color:var(--dim)}
    h1{font-size:26px;letter-spacing:-.8px;margin:18px 0 6px}
    p.sub{font-size:13px;color:var(--gray);margin-bottom:22px}
    .rows{display:flex;flex-direction:column;gap:10px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#fbfcff;text-decoration:none;color:inherit;transition:.15s}
    .row:hover{border-color:var(--blue);background:#fff;box-shadow:0 10px 26px rgba(77,107,254,.10)}
    .meta{display:flex;align-items:center;gap:10px;min-width:0}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--blue);flex:0 0 auto}
    .meta b{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .meta em{font-style:normal;font-size:10px;color:var(--blue);background:#eef3ff;border-radius:999px;padding:2px 7px}
    .meta small{font-family:Consolas,monospace;font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .go{font-size:12px;color:var(--blue);font-weight:600;flex:0 0 auto}
    .foot{margin-top:22px;font-size:11px;color:var(--dim);line-height:1.7}
    kbd{font-family:Consolas,monospace;background:#f1f4fa;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:10px}
  </style></head><body>
  <div class="card">
    <div class="top"><div class="logo"><i></i>网页修改器</div><span class="tag">SELECT PAGE</span></div>
    <h1>选择要编辑的页面</h1>
    <p class="sub">这个目录下有 ${pages.length} 个 HTML 页面，选一个打开；打开后点右下角「✎ 编辑」。</p>
    <div class="rows">${rows}</div>
    <div class="foot">提示：也可以直接访问 <kbd>/文件名.html</kbd>，或用 <kbd>--entry 文件名.html</kbd> 指定默认页。</div>
  </div></body></html>`;
}

const handleApi = createApiHandler(store);
const types = new Map();

function htmlInjected(html) {
  return injectRuntime(html, {
    config: {
      token: store.config().token,
      contentJson: store.config().contentJson,
      version: "1.0.0",
      mode: "server",
    },
  });
}

function serveFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    let html = fs.readFileSync(file, "utf8");
    html = htmlInjected(html);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }
  const buf = fs.readFileSync(file);
  res.writeHead(200, { "Content-Type": mimeOf(file), "Cache-Control": "no-store" });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;

    const urlObj = new URL(req.url || "/", "http://127.0.0.1");
    let pathname = decodeURIComponent(urlObj.pathname);
    const pages = listHtmlPages();

    if (pathname === "/ve-pages") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ root, pages }));
      return;
    }
    if (pathname === "/ve-select") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(pickerHtml(pages));
      return;
    }
    // 根路径且目录里有多个 HTML：先给页面选择器（?ve=1 / ?pick=0 / --entry 可跳过）
    if (pathname === "/" && pages.length > 1 && !ENTRY && !urlObj.searchParams.has("ve") && urlObj.searchParams.get("pick") !== "0") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(pickerHtml(pages));
      return;
    }

    let file = path.join(root, pathname);
    if (pathname === "/" && ENTRY) file = path.join(root, ENTRY);

    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");

    if (!fs.existsSync(file)) {
      const fallback = path.join(root, "index.html");
      if (fs.existsSync(fallback) && !path.extname(pathname)) file = fallback;
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(`404 ${pathname}`);
      return;
    }
    serveFile(res, file);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err?.stack || err));
  }
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log("");
  console.log("  视觉编辑器已启动");
  console.log(`  站点目录  ${root}`);
  console.log(`  打开地址  ${url}`);
  console.log(`  数据目录  ${store.dataDir}`);
  if (store.config().contentJson) console.log(`  内容文件  ${store.config().contentJson}（文字会回写到这里）`);
  console.log("");
  console.log("  按 Ctrl+C 停止。");
  console.log("");
  if (!flag("no-open")) openBrowser(url);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用，换一个：--port 5271`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function openBrowser(url) {
  if (process.platform === "win32") exec(`start "" "${url}"`);
  else if (process.platform === "darwin") exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

void TOOL_DIR; void types; void PREFIX; void spawn;
