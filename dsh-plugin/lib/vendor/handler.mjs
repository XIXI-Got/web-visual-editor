/**
 * 视觉编辑器 · HTTP 处理器（独立服务器与 Vite 插件共用）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mimeOf } from "./api.mjs";

export const PREFIX = "/__ve";
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_FILES = new Set(["runtime.js", "core.mjs", "runtime.css"]);

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readBody(req, limit = 30 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("文件太大（上限 30MB）");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readBody(req, 4 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

/**
 * @returns {(req, res) => Promise<boolean>} 返回 true 表示已处理
 */
export function createApiHandler(store, options = {}) {
  const publicRuntime = options.publicRuntime !== false;
  const extraContext = options.contextProvider || (() => ({}));

  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(PREFIX)) return false;

    const route = url.pathname.slice(PREFIX.length) || "/";

    try {
      // ---- 静态运行时资源（无需 token） ----
      if (req.method === "GET" && route.startsWith("/") && RUNTIME_FILES.has(route.slice(1))) {
        if (!publicRuntime) return false;
        const file = path.join(TOOL_DIR, route.slice(1));
        if (!fs.existsSync(file)) return sendText(res, 404, "not found"), true;
        sendText(res, 200, fs.readFileSync(file), mimeOf(file));
        return true;
      }

      if (req.method === "GET" && route === "/config") {
        const ai = store.readAiConfig();
        sendJson(res, 200, {
          token: store.config().token,
          root: store.root,
          contentJson: store.config().contentJson,
          ai: { model: ai.model, configured: Boolean(ai.apiKey) },
          maxBackups: store.config().maxBackups,
          context: extraContext(),
        });
        return true;
      }

      if (req.method === "GET" && route === "/overrides") {
        let conflict = null;
        try { conflict = store.checkSource ? store.checkSource() : null; } catch (e) { conflict = null; }
        const headers = conflict && conflict.stale ? { "X-VE-Source-Stale": "1", "X-VE-Source-Backup": String(conflict.backupId || "") } : {};
        sendJson(res, 200, store.readOverrides(), headers);
        return true;
      }

      if (req.method === "GET" && route === "/overrides.css") {
        sendText(res, 200, store.overridesCss(), "text/css; charset=utf-8");
        return true;
      }

      if (req.method === "GET" && route === "/history") {
        sendJson(res, 200, { ok: true, history: store.readHistory(Number(url.searchParams.get("limit")) || 200) });
        return true;
      }
      if (req.method === "GET" && route === "/backups") {
        sendJson(res, 200, { ok: true, backups: store.listBackups() });
        return true;
      }

      if (req.method === "GET" && route.startsWith("/files/")) {
        const file = store.readUpload(route.slice("/files/".length));
        if (!file) return sendText(res, 404, "not found"), true;
        sendText(res, 200, fs.readFileSync(file), mimeOf(file));
        return true;
      }

      // ---- 写操作：必须带 token ----
      const token = req.headers["x-ve-token"];
      if (req.method === "POST" && token !== store.config().token) {
        sendJson(res, 403, { ok: false, error: "token 不对，请刷新页面重试" });
        return true;
      }

      if (req.method === "POST" && route === "/save") {
        const body = await readJsonBody(req);
        const ops = Array.isArray(body.ops) ? body.ops : [];
        if (!ops.length) return sendJson(res, 400, { ok: false, error: "没有要保存的修改" }), true;
        const result = store.applyOps(ops);
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === "POST" && route === "/upload") {
        const name = url.searchParams.get("name") || "image.png";
        const buf = await readBody(req);
        if (!buf.length) return sendJson(res, 400, { ok: false, error: "空文件" }), true;
        sendJson(res, 200, store.saveUpload(name, buf));
        return true;
      }

      if (req.method === "POST" && route === "/replace-overrides") {
        const body = await readJsonBody(req);
        sendJson(res, 200, store.replaceOverrides(body.overrides || {}, body.label || "replace"));
        return true;
      }

      if (req.method === "GET" && route === "/steps") {
        sendJson(res, 200, { ok: true, schema: 2, steps: store.listSteps(200), ptr: store.stepsPtr() });
        return true;
      }

      if (req.method === "POST" && route === "/steps") {
        const body = await readJsonBody(req);
        sendJson(res, 200, store.appendStep(body || {}));
        return true;
      }

      if (req.method === "POST" && route === "/steps-replace") {
        const body = await readJsonBody(req);
        sendJson(res, 200, store.replaceSteps(body && body.steps, body && body.ptr));
        return true;
      }

      if (req.method === "POST" && route === "/restore") {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, restored: store.restoreBackup(String(body.id || "")) });
        return true;
      }

      if (req.method === "POST" && route === "/ai") {
        const body = await readJsonBody(req);
        const result = await store.askAI({
          instruction: String(body.instruction || ""),
          selection: body.selection || null,
          context: String(body.context || ""),
          history: Array.isArray(body.history) ? body.history : [],
        });
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === "POST" && route === "/ai-html") {
        const body = await readJsonBody(req);
        const result = await store.askAIHtml({
          instruction: String(body.instruction || ""),
          reference: String(body.reference || ""),
          context: String(body.context || ""),
        });
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === "POST" && route === "/ai-config") {
        const body = await readJsonBody(req);
        sendJson(res, 200, store.writeAiConfig({
          baseURL: body.baseURL ? String(body.baseURL) : undefined,
          apiKey: body.apiKey ? String(body.apiKey) : undefined,
          model: body.model ? String(body.model) : undefined,
        }).ok ? { ok: true } : { ok: false });
        return true;
      }

      sendJson(res, 404, { ok: false, error: `未知接口 ${route}` });
      return true;
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      return true;
    }
  };
}

/** 往 HTML 里注入编辑器脚本 */
export function injectRuntime(html, opts = {}) {
  if (html.includes(`${PREFIX}/runtime.js`)) return html;
  // 去掉项目自带的旧版编辑器脚本/样式：它们与我们的内核共用同一批 DOM，会互相抢
  //（表现为：左侧面板消失、点击元素无法编辑）
  try {
    html = html
      .replace(/<script[^>]*src=["'][^"']*visual-editor\/runtime\.js[^"']*["'][^>]*>\s*<\/script>/gi, "")
      .replace(/<script[^>]*src=["'][^"']*visual-editor\/editor[^"']*["'][^>]*>\s*<\/script>/gi, "")
      .replace(/<link[^>]*href=["'][^"']*visual-editor[^"']*\.css[^"']*["'][^>]*>/gi, "");
  } catch { /* ignore */ }
  const nonce = opts.nonce || "";
  const config = JSON.stringify(opts.config || {}).replace(/</g, "\\u003c");
  const tags = [
    `<script>window.__VE_BOOT__=${config};</script>`,
    `<script type="module" src="${PREFIX}/runtime.js"${nonce ? ` nonce="${nonce}"` : ""}></script>`,
  ].join("\n");
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tags}\n</head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tags}\n</body>`);
  return html + tags;
}
