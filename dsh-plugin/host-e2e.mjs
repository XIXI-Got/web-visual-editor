/**
 * 宿主插件自测（不需要 DSH 在跑）
 *
 *   node dsh-plugin/host-e2e.mjs
 *
 * 用一个假的 cordis ctx 捕获 /ve/plugin 路由，然后用假的 req/res 打它，
 * 覆盖：ping / browse / 静态站 open / Vite 项目 open / 注入检查 / close。
 */

import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");
const VENDOR_SRC = path.join(WORKSPACE, "tools", "visual-editor");
const VENDOR_DST = path.join(HERE, "lib", "vendor");
function firstExistingDir(cands) {
  for (const d of cands) { try { if (d && fs.existsSync(d)) return d; } catch { /* ignore */ } }
  return "";
}
const SITE9 = firstExistingDir([
  process.env.VE_TEST_SITE,
  "D:\\AI\\网站测试集合\\9号",
  path.join(WORKSPACE, ".ve-test-site"),
]);
const TEST_PROJECT = path.join(WORKSPACE, ".ve-plugin-test");

const results = [];
const mark = (name, pass, extra = "") => {
  results.push({ name, pass: Boolean(pass), extra: String(extra) });
  console.log((pass ? "PASS " : "FAIL ") + name + (extra ? "  [" + extra + "]" : ""));
};

/* ---------- 1. 准备 vendor 与 Vite 测试项目 ---------- */
fs.mkdirSync(VENDOR_DST, { recursive: true });
for (const f of ["core.mjs", "api.mjs", "handler.mjs", "runtime.js", "vite-plugin.mjs", "package.json"]) {
  const src = path.join(VENDOR_SRC, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(VENDOR_DST, f));
}

function copyDirSafe(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirSafe(s, d);
    else fs.copyFileSync(s, d);
  }
}

function prepareViteProject() {
  // 有外部真实 Vite 站点夹具时（本地开发机）：按它重建测试项目，可测真实的 Vite 启动；
  // 没有时（CI / 干净 clone）：直接用仓库里提交好的 .ve-plugin-test 夹具，
  // 由 CI 里的 npm install 提供 node_modules/vite，避免把夹具删坏。
  if (!SITE9) {
    if (!fs.existsSync(path.join(TEST_PROJECT, "src"))) {
      throw new Error("缺少 Vite 测试夹具（.ve-plugin-test/src 不存在），请检查仓库是否完整");
    }
    if (!fs.existsSync(path.join(TEST_PROJECT, "vite.config.ts"))) {
      fs.writeFileSync(path.join(TEST_PROJECT, "vite.config.ts"), "export default {};\n", "utf8");
    }
    return TEST_PROJECT;
  }
  const nm = path.join(TEST_PROJECT, "node_modules");
  try {
    const st = fs.lstatSync(nm);
    if (st.isSymbolicLink() || st.isDirectory()) fs.unlinkSync(nm); // 只删联接，不碰目标
  } catch { /* 不存在 */ }
  fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
  fs.mkdirSync(TEST_PROJECT, { recursive: true });
  for (const item of ["src", "public"]) {
    copyDirSafe(path.join(SITE9, item), path.join(TEST_PROJECT, item));
  }
  for (const file of ["index.html", "package.json", "postcss.config.js", "tailwind.config.js", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
    const src = path.join(SITE9, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEST_PROJECT, file));
  }
  // 原始 vite.config（模拟「没装过插件」的项目）
  fs.writeFileSync(
    path.join(TEST_PROJECT, "vite.config.ts"),
    `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: false },
});
`,
    "utf8",
  );
  try { if (SITE9 && fs.existsSync(path.join(SITE9, "node_modules"))) fs.symlinkSync(path.join(SITE9, "node_modules"), nm, process.platform === "win32" ? "junction" : "dir"); } catch { /* 没有夹具时忽略 */ }
  return TEST_PROJECT;
}

/* ---------- 2. 假 cordis ctx ---------- */
const handlers = [];
const disposers = [];
const toolRegistry = { defs: [], register(def) { this.defs.push(def); return () => {}; } };
const ctx = {
  get: (name) => (name === "tools" ? toolRegistry : undefined),
  webServer: { register: (route) => { handlers.push(route); return () => {}; }, port: 0, host: "127.0.0.1" },
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); return () => {}; },
  logger: { info: (...a) => console.log("  · " + a.join(" ")) },
};

const { apply } = await import(pathToFileURL(path.join(HERE, "lib", "index.js")).href);
apply(ctx);
const route = handlers.find((x) => x.path === "/ve/plugin");
mark("插件 apply() 注册了 /ve/plugin 路由", Boolean(route), "handlers=" + handlers.length);
disposers.length = 0;

/* ---------- 3. 假 req/res ---------- */
function call(method, sub, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
    const req = Readable.from(payload);
    req.method = method;
    req.url = "/ve/plugin" + sub;
    req.headers = { "content-type": "application/json" };
    const chunks = [];
    const res = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.writeHead = () => res;
    res.statusCode = 0;
    res.on("finish", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 json */ }
      resolve({ status: res.statusCode, text, json });
    });
    res.on("error", reject);
    // writeHead 记录状态码
    const origWriteHead = res.writeHead;
    res.writeHead = (code) => { res.statusCode = code; return res; };
    Promise.resolve(route.handler(req, res)).catch(reject);
    void origWriteHead;
  });
}

/* ---------- 4. 用例 ---------- */
let auxPort = 0;
for (let i = 0; i < 20; i += 1) {
  const probe = await call("GET", "/ping");
  if (probe.json && probe.json.auxPort) { auxPort = probe.json.auxPort; break; }
  await new Promise((r) => setTimeout(r, 150));
}
if (auxPort) {
  const direct = await fetch(`http://127.0.0.1:${auxPort}/ve/plugin/ping`).then((r) => r.json()).catch(() => null);
  mark("桌面窗口兼容端口已就绪", Boolean(direct && direct.ok), "port=" + auxPort);
} else {
  mark("桌面窗口兼容端口已就绪", false, "no auxPort in ping");
}

const nativeStatus = await call("GET", "/ai-native-status");
mark("GET /ai-native-status（无 llm 时优雅降级）", nativeStatus.json && nativeStatus.json.ok === true && nativeStatus.json.available === false, JSON.stringify(nativeStatus.json));

const ping = await call("GET", "/ping");
mark("GET /ping", ping.json && ping.json.ok === true, ping.text.slice(0, 80));

const browse = await call("GET", "/browse?path=" + encodeURIComponent("D:\\projects"));
mark("GET /browse 列出目录", browse.json && Array.isArray(browse.json.dirs) && browse.json.dirs.length > 0, "dirs=" + (browse.json ? browse.json.dirs.length : "?"));

/* 工作台：项目列表 */
const projectsRes = await call("GET", "/projects");
mark("GET /projects 返回项目列表", Boolean(projectsRes.json && projectsRes.json.ok === true && Array.isArray(projectsRes.json.projects)), JSON.stringify(projectsRes.json && projectsRes.json.projects && projectsRes.json.projects.length));

/* 风格规范：提取 + 保存 */
const styleSrc = path.join(WORKSPACE, ".ve-style-fixture");
try {
  fs.mkdirSync(styleSrc, { recursive: true });
  fs.writeFileSync(path.join(styleSrc, "design-tokens.json"), JSON.stringify({
    meta: { name: "测试风格", version: "1.0" },
    color: { paper: { value: "#F4F1EA", role: "底" }, ink: { value: "#222222", role: "字" } },
    typography: { families: { display: "Bodoni Moda, serif", sans: "Inter, sans-serif" } },
    radius: { pill: "999px" },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(styleSrc, "UI-SPEC.md"), "# 测试规范\n## 原则\n少即是多。", "utf8");
} catch { /* ignore */ }
/* 风格库：集中存储 + 封面 + 应用 */
const stylesEmpty = await call("GET", "/styles");
mark("GET /styles 返回风格列表", Boolean(stylesEmpty.json && stylesEmpty.json.ok === true && Array.isArray(stylesEmpty.json.styles)), JSON.stringify(stylesEmpty.json && stylesEmpty.json.styles && stylesEmpty.json.styles.length));
const styleAdd = await call("POST", "/styles/add", { path: styleSrc, name: "测试风格库" });
mark("POST /styles/add 导入风格", Boolean(styleAdd.json && styleAdd.json.ok === true && styleAdd.json.id && Array.isArray(styleAdd.json.styles) && styleAdd.json.styles.length >= 1), JSON.stringify(styleAdd.json && styleAdd.json.id));
const styleId = styleAdd.json && styleAdd.json.id;
if (styleId) {
  const cover = await fetch(`http://127.0.0.1:${auxPort}/ve/plugin/styles/cover.svg?id=${encodeURIComponent(styleId)}`).then((r) => r.text()).catch(() => "");
  mark("GET /styles/cover.svg 生成封面", cover.includes("<svg") && cover.includes("linearGradient"));
  const styleOutDir = path.join(WORKSPACE, ".ve-style-out");
  try { fs.mkdirSync(styleOutDir, { recursive: true }); } catch { /* ignore */ }
  const styleApply = await call("POST", "/styles/apply", { id: styleId, dir: styleOutDir });
  mark("POST /styles/apply 生成 Agent 提示词", Boolean(styleApply.json && styleApply.json.ok === true && styleApply.json.text.includes("风格") && fs.existsSync(path.join(styleOutDir, ".ve-data", "style-brief.md"))), JSON.stringify(styleApply.json && styleApply.json.text && styleApply.json.text.slice(0, 40)));
  const styleRemove = await call("POST", "/styles/remove", { id: styleId });
  mark("POST /styles/remove 删除风格", Boolean(styleRemove.json && styleRemove.json.ok === true), JSON.stringify(styleRemove.json && styleRemove.json.error));
}
const styleEx = await call("POST", "/style/extract", { path: styleSrc });
mark("POST /style/extract 提取设计 token", Boolean(styleEx.json && styleEx.json.ok === true && styleEx.json.spec && styleEx.json.spec.colors.length >= 2 && styleEx.json.spec.name === "测试风格"), JSON.stringify(styleEx.json && styleEx.json.summary));
const styleOut = path.join(WORKSPACE, ".ve-style-out");
try { fs.mkdirSync(styleOut, { recursive: true }); } catch { /* ignore */ }
const styleSv = await call("POST", "/style/save", { dir: styleOut, path: styleSrc });
mark("POST /style/save 写入 spec + brief", Boolean(styleSv.json && styleSv.json.ok === true && fs.existsSync(styleSv.json.specFile) && fs.existsSync(styleSv.json.briefFile)), JSON.stringify(styleSv.json && { spec: styleSv.json.specFile }));
/* 静态站：用 demo/ */
const demoDir = path.join(WORKSPACE, "demo");
const openStatic = await call("POST", "/open", { dir: demoDir });
mark("POST /open 静态站", openStatic.json && openStatic.json.ok === true, openStatic.json ? openStatic.json.mode + " " + openStatic.json.url : openStatic.text.slice(0, 120));
if (openStatic.json && openStatic.json.ok) {
  const url = openStatic.json.url;
  const html = await fetch(url).then((r) => r.text());
  mark("静态预览已注入编辑器", html.includes("__VE_BOOT__") && html.includes("/__ve/runtime.js"));
  const cfg = await fetch(url + "__ve/config").then((r) => r.json());
  mark("静态预览内核接口可用", Boolean(cfg && cfg.token), "token len=" + (cfg && cfg.token ? cfg.token.length : 0));
  const close = await call("POST", "/close", { id: openStatic.json.id });
  mark("关闭静态预览", close.json && close.json.ok === true);
}

/* Vite 项目：非侵入启动 */
const dir = prepareViteProject();
mark("Vite 测试项目已准备（原始 vite.config）", fs.existsSync(path.join(dir, "vite.config.ts")));
const openVite = await call("POST", "/open", { dir });
mark("POST /open Vite 项目", openVite.json && openVite.json.ok === true, openVite.json ? openVite.json.mode + " " + openVite.json.url : openVite.text.slice(0, 300));
if (openVite.json && openVite.json.ok) {
  const url = openVite.json.url;
  const html = await fetch(url).then((r) => r.text());
  mark("Vite 页面注入了编辑器", html.includes("__VE_BOOT__") && html.includes("/__ve/runtime.js"));
  mark("Vite 原配置未被修改", !fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8").includes("visualEditor"));
  const rt = await fetch(url + "__ve/runtime.js").then((r) => r.text());
  mark("内核 runtime 可访问", rt.includes("__VE__") && rt.length > 10000, "len=" + rt.length);
  const cfg = await fetch(url + "__ve/config").then((r) => r.json());
  mark("Vite 侧内核接口可用", Boolean(cfg && cfg.token));
  const aiStatus = await call("GET", "/ai-status?id=" + encodeURIComponent(openVite.json.id));
  mark("GET /ai-status 透传", aiStatus.json && aiStatus.json.ok === true, JSON.stringify(aiStatus.json && aiStatus.json.ai));
  const close = await call("POST", "/close", { id: openVite.json.id });
  mark("关闭 Vite 预览", close.json && close.json.ok === true);
}

/* 关闭全部 */
for (const d of disposers) { try { await d(); } catch { /* ignore */ } }


/* ---------- 4. 新能力：agent 工具 / 冲突检测 / 历史 ---------- */
{
  const session0 = await call("GET", "/session");
  mark("GET /session available", Boolean(session0.json && session0.json.ok === true), JSON.stringify(session0.json && session0.json.session && session0.json.session.id));

  const detectDemo = await call("GET", "/detect?path=" + encodeURIComponent(demoDir));
  mark("detect returns embeddedEditor", Boolean(detectDemo.json && detectDemo.json.embeddedEditor && detectDemo.json.embeddedEditor.detected === false), JSON.stringify(detectDemo.json && detectDemo.json.embeddedEditor));

  const conflictDir = path.join(HERE, ".tmp-conflict-" + Date.now().toString(36));
  fs.mkdirSync(path.join(conflictDir, "tools", "visual-editor"), { recursive: true });
  fs.writeFileSync(path.join(conflictDir, "index.html"), "<!doctype html><body>conflict</body>", "utf8");
  fs.writeFileSync(path.join(conflictDir, "vite.config.ts"), "import { visualEditor } from './tools/visual-editor/vite-plugin.mjs'\nexport default { plugins: [visualEditor()] }\n", "utf8");
  const detectConflict = await call("GET", "/detect?path=" + encodeURIComponent(conflictDir));
  mark("detects project embedded editor", Boolean(detectConflict.json && detectConflict.json.embeddedEditor && detectConflict.json.embeddedEditor.detected === true), JSON.stringify(detectConflict.json && detectConflict.json.embeddedEditor));
  const openConflict = await call("POST", "/open", { dir: conflictDir });
  mark("opens project with conflict (static)", Boolean(openConflict.json && openConflict.json.ok === true && openConflict.json.mode === "static"), "mode=" + (openConflict.json && openConflict.json.mode));
  if (openConflict.json && openConflict.json.id) await call("POST", "/close", { id: openConflict.json.id });
  try { fs.rmSync(conflictDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const tool = toolRegistry.defs.find((d) => d.name === "web_editor_open");
  if (!tool) {
    // CI / 纯 Node 环境没有 @deepseek-ai/dsh-tools：这组用例正常跳过，不算失败
    console.log("SKIP agent 工具相关用例（当前环境没有 @deepseek-ai/dsh-tools，CI / 纯 Node 环境属正常）");
  } else {
    mark("agent tool web_editor_open registered", Boolean(tool.output && typeof tool.output.render === "function" && typeof tool.execute === "function"), "ok");
    const opened = await tool.execute({ dir: demoDir }, { signal: AbortSignal.timeout(30000) });
    mark("agent tool opens project", Boolean(opened && opened.ok === true && opened.url && opened.id), (opened && opened.url) || "no url");
    const ses = await call("GET", "/session");
    mark("/session records agent-opened project", Boolean(ses.json && ses.json.session && ses.json.session.url === opened.url), JSON.stringify(ses.json && ses.json.session && ses.json.session.url));
    const backups = await call("GET", "/backups?id=" + encodeURIComponent(opened.id));
    mark("GET /backups proxied", Boolean(backups.json && backups.json.ok === true && Array.isArray(backups.json.backups)), "count=" + (backups.json && backups.json.backups && backups.json.backups.length));
    const history = await call("GET", "/history?id=" + encodeURIComponent(opened.id));
    mark("GET /history proxied", Boolean(history.json && history.json.ok === true && Array.isArray(history.json.history)), "count=" + (history.json && history.json.history && history.json.history.length));
    await call("POST", "/close", { id: opened.id });
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
