/**
 * 工作台前端端到端回归（真实 workbench-ui/app.js + 无头 Edge）
 *
 * 覆盖：
 *  A. 内嵌（DSH 右侧栏）模式：打开项目 → 编辑视图，工具栏有「✦ AI 调整」和「↗ 独立窗口」，
 *     点 AI 调整弹出对话框、发送后调用宿主 agent.prompt；点独立窗口调用 workbench.popup 并带 dir/page
 *  B. 独立窗口模式（宿主带 api + dir 参数打开）：直接进项目编辑（不中转工作台首页），
 *     且不显示独立模式的接口连接条（布局和嵌入时一致）
 *
 * 跑法：node tools/visual-editor/e2e/workbench.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, "..", "..", "..", "workbench-ui");
const EDGE = process.env.MSEDGE_PATH || process.env.DSH_EDGE || [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || "msedge";

const DRIVER_EMBED = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>wb-driver</title></head><body>
<iframe id="frame" src="/index.html?embedded=1" style="width:1400px;height:860px;border:0"></iframe>
<pre id="out"></pre>
<script>
const RESULTS = [];
function mark(n, ok, extra) { RESULTS.push({ n, ok: Boolean(ok), extra: extra == null ? "" : String(extra).slice(0, 300) }); }
const calls = [];
const frame = document.getElementById("frame");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 6000)) { try { if (fn()) return true; } catch (e) {} await sleep(50); } return false; }
const doc = () => frame.contentWindow.document;
window.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.source !== "ve-wb") return;
  if (d.type === "call") {
    calls.push({ method: d.method, args: d.args || {} });
    let data = { ok: true };
    if (d.method === "projects.list") data = { ok: true, projects: [{ id: "p1", dir: "D:\\\\fake-project", url: "/preview.html", page: "/" }], info: { dir: "D:\\\\fake-project" }, styles: [] };
    else if (d.method === "project.open") data = { ok: true, url: "/preview.html", dir: d.args.dir, page: d.args.page || "/index.html" };
    else if (d.method === "styles.list") data = { ok: true, styles: [] };
    else if (d.method === "agent.prompt") data = { ok: true, via: "chat" };
    else if (d.method === "workbench.popup") data = { ok: true };
    frame.contentWindow.postMessage({ source: "ve-host", type: "result", id: d.id, ok: true, data }, "*");
    return;
  }
  if (d.type === "ready") {
    frame.contentWindow.postMessage({ source: "ve-host", type: "init", data: { projects: [{ id: "p1", dir: "D:\\\\fake-project", url: "/preview.html", page: "/" }], info: { dir: "D:\\\\fake-project" }, styles: [], apiBase: "", theme: "paper" } }, "*");
  }
});
(async () => {
  try {
    mark("工作台 iframe 加载", await waitFor(() => { try { return Boolean(doc().querySelector("#app")); } catch (e) { return false; } }, 10000));
    await sleep(600);
    mark("首页有项目卡片", await waitFor(() => doc().querySelector('[data-act="open-editor"]'), 6000));
    doc().querySelector('[data-act="open-editor"]').click();
    mark("点项目卡进入编辑视图", await waitFor(() => doc().querySelector(".editor iframe"), 8000), doc().querySelector(".top") ? doc().querySelector(".top").textContent.slice(0, 60) : "");
    mark("编辑工具栏有「AI 调整」按钮", Boolean(doc().querySelector('[data-act="ai-open"]')));
    mark("编辑工具栏有「独立窗口」按钮（嵌入模式）", Boolean(doc().querySelector('[data-act="popup"]')));
    mark("嵌入模式没有独立连接条", !doc().querySelector(".standalone-bar"));

    // AI 调整弹窗
    doc().querySelector('[data-act="ai-open"]').click();
    mark("点 AI 调整弹出对话框", await waitFor(() => doc().querySelector(".ai-panel"), 4000));
    const ta = doc().querySelector(".ai-textarea");
    if (ta) { ta.value = "把标题加大加粗"; ta.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true })); }
    doc().querySelector('[data-act="ai-send"]').click();
    await sleep(500);
    const aiCall = calls.filter(c => c.method === "agent.prompt")[0];
    mark("发送后调用宿主 agent.prompt", Boolean(aiCall));
    mark("发送内容包含项目路径和需求", Boolean(aiCall && String(aiCall.args.text || "").includes("fake-project") && String(aiCall.args.text || "").includes("把标题加大加粗")), aiCall ? aiCall.args.text : "");
    mark("发送后对话框关闭", !doc().querySelector(".ai-panel"));

    // 独立窗口
    doc().querySelector('[data-act="popup"]').click();
    await sleep(300);
    const popCall = calls.filter(c => c.method === "workbench.popup")[0];
    mark("点独立窗口调用宿主 popup 并带当前项目", Boolean(popCall && popCall.args.dir === "D:\\\\fake-project"), JSON.stringify(popCall && popCall.args));
  } catch (e) { mark("执行异常", false, String((e && e.stack) || e)); }
  document.getElementById("out").textContent = JSON.stringify(RESULTS);
  document.title = "done";
})();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const send = (type, body) => { res.writeHead(200, { "content-type": type }); res.end(body); };
  if (u.pathname === "/app.js" || u.pathname === "/styles.css" || u.pathname === "/index.html") {
    const f = path.join(WB, u.pathname.slice(1));
    return send(u.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8", fs.readFileSync(f));
  }
  if (u.pathname === "/preview.html") return send("text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><h1 style='font:32px sans-serif'>fake page</h1>");
  if (u.pathname === "/driver-embed") return send("text/html; charset=utf-8", DRIVER_EMBED);
  if (u.pathname.startsWith("/ve/plugin/")) {
    let data = { ok: true };
    if (u.pathname === "/ve/plugin/projects") data = { ok: true, projects: [{ id: "p1", dir: "D:\\fake-project", url: "/preview.html", page: "/" }], info: { dir: "D:\\fake-project" }, styles: [] };
    else if (u.pathname === "/ve/plugin/open") data = { ok: true, url: "/preview.html", dir: "D:\\fake-project", page: "/index.html" };
    else if (u.pathname === "/ve/plugin/styles" || u.pathname === "/ve/plugin/styles/") data = { ok: true, styles: [] };
    else if (u.pathname === "/ve/plugin/pages") data = { ok: true, pages: [{ path: "/index.html", title: "首页" }] };
    else if (u.pathname === "/ve/plugin/handoff") data = { ok: true, via: "chat" };
    return send("application/json; charset=utf-8", JSON.stringify(data));
  }
  return send("text/html; charset=utf-8", "<!doctype html><title>404</title>");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-"));

async function runPage(pagePath) {
  const url = `http://127.0.0.1:${port}${pagePath}`;
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--force-device-scale-factor=1", "--window-size=1500,940",
    "--virtual-time-budget=30000",
    `--user-data-dir=${profile}`,
    "--dump-dom", url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", () => {});
  await new Promise((r) => child.on("exit", r));
  const m = /<pre id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(out);
  try { return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) : null; } catch { return null; }
}

async function runStandaloneDom() {
  const url = "http://127.0.0.1:" + port + "/index.html?api=" + encodeURIComponent("http://127.0.0.1:" + port) + "&standalone=1&dir=" + encodeURIComponent("D:\\fake-project") + "&page=" + encodeURIComponent("/index.html");
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--force-device-scale-factor=1", "--window-size=1500,940",
    "--virtual-time-budget=25000",
    `--user-data-dir=${profile}`,
    "--dump-dom", url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", () => {});
  await new Promise((r) => child.on("exit", r));
  const hasEditor = out.includes('id="editor-frame"');
  const hasBar = out.includes('class="standalone-bar"');
  const hasPath = /fake-project/.test(out);
  return [
    { n: "独立窗口直接进入项目编辑（不经过工作台首页）", ok: hasEditor, extra: hasEditor ? "" : "dump 里没有 editor-frame" },
    { n: "独立窗口不显示接口连接条（布局一致）", ok: !hasBar },
    { n: "独立窗口顶部显示当前项目路径", ok: hasPath },
  ];
}

const results = [];
results.push(...(await runPage("/driver-embed") || [{ n: "内嵌模式页面执行", ok: false, extra: "没拿到结果" }]));
results.push(...(await runStandaloneDom()));

server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }

let failed = 0;
for (const r of results) {
  if (r.ok) console.log("PASS " + r.n);
  else { failed++; console.log("FAIL " + r.n + (r.extra ? "  [" + r.extra + "]" : "")); }
}
console.log("\n汇总：" + (results.length - failed) + "/" + results.length + " 通过");
process.exit(failed ? 1 : 0);
