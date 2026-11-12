/**
 * 撤销/重做端到端回归（真实内核 runtime.js + 无头 Edge）
 *
 * 覆盖用户反馈的 bug：
 *   ① 改 → ② 撤销 → ① 再改 → ③ 再改 → ④
 *   撤销 → ③，再撤销 → 应该回到 ①（分支点），而不是回到已经被撤销掉的旧分支 ②。
 *
 * 关键点：撤销之后的新改动不能被 900ms「合并到上一步」逻辑并进旧步骤，
 * 也不能让旧分支留在历史里（否则后续撤销会退回到已经撤销过的状态）。
 *
 * 跑法：node tools/visual-editor/e2e/undo.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = path.resolve(HERE, "..", "runtime.js");
const CORE = path.resolve(HERE, "..", "core.mjs");
const EDGE = process.env.MSEDGE_PATH || process.env.DSH_EDGE || [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || "msedge";

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>undo-page</title>
<style>body{margin:0;font-family:sans-serif;color:#111}.box{max-width:900px;margin:40px auto;padding:0 30px}
h1{font-size:64px;margin:0 0 16px}p{font-size:16px;color:#555}</style></head><body>
<div class="box"><h1 id="h">Undo 测试标题</h1><p id="p">这是用于撤销回归的假页面。</p></div>
<script>
window.__VE_BOOT__ = { token: "test" };
window.addEventListener("error", (e) => { try { parent.postMessage({ __ve: "evt", type: "page-error", text: String(e.message || e) }, "*"); } catch (err) {} });
window.addEventListener("unhandledrejection", (e) => { try { parent.postMessage({ __ve: "evt", type: "page-error", text: String(e.reason && e.reason.message ? e.reason.message : e.reason) }, "*"); } catch (err) {} });
window.fetch = async function (url, opts) {
  const u = String(url || "");
  const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.indexOf("/__ve/steps") === 0 && opts && opts.method === "POST") return ok({ ok: true });
  if (u.indexOf("/__ve/steps") === 0) return ok({ ok: true, schema: 2, steps: [], ptr: -1 });
  if (u.indexOf("/__ve/overrides") === 0) return ok({ ok: true, overrides: {} });
  if (u.indexOf("/__ve/replace-overrides") === 0) return ok({ ok: true });
  if (u.indexOf("/__ve/save") === 0) return ok({ ok: true, applied: [], overrides: {}, backupId: "t" });
  if (u.indexOf("/__ve/config") === 0) return ok({ ok: true, dir: "", mode: "static" });
  if (u.indexOf("/__ve/ai-config") === 0) return ok({ ok: true, ai: {} });
  return ok({ ok: true });
};
</script>
<script type="module" src="/runtime.js"></script>
</body></html>`;

const DRIVER_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>undo-driver</title></head><body>
<iframe id="frame" src="/page?ve=1" style="width:1200px;height:800px;border:0"></iframe>
<pre id="out" data-done="0"></pre>
<script>
const RESULTS = [];
function mark(name, ok, extra) { RESULTS.push({ name, ok: Boolean(ok), extra: extra == null ? "" : String(extra).slice(0, 400) }); }
const frame = document.getElementById("frame");
const events = [];
window.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.__ve === "evt") events.push(d);
});
const send = (msg) => frame.contentWindow.postMessage({ __ve: "cmd", ...msg }, "*");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) {} await sleep(40); }
  return false;
}
const doc = () => frame.contentWindow.document;
const el = (sel) => doc().querySelector(sel);
const css = (sel, prop) => { try { return frame.contentWindow.getComputedStyle(el(sel))[prop]; } catch (e) { return ""; } };
const evtCount = (type) => events.filter((x) => x.type === type).length;
async function applyStyle(sel, prop, value) {
  const before = evtCount("applied");
  send({ type: "apply-ops", ops: [{ type: "style", key: "sel:" + sel, props: { [prop]: value } }] });
  const ok = await waitFor(() => evtCount("applied") > before, 5000);
  await sleep(20);
  return ok;
}
async function undo() {
  const before = evtCount("history-state");
  send({ type: "undo" });
  await waitFor(() => evtCount("history-state") > before, 3000);
  await sleep(60);
}
function history() {
  const before = evtCount("history");
  send({ type: "history-list" });
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      const hs = events.filter((x) => x.type === "history");
      if (hs.length > before) { resolve(hs[hs.length - 1]); return; }
      if (++tries > 100) { resolve(null); return; }
      setTimeout(tick, 30);
    };
    tick();
  });
}
(async () => {
  try {
    const ready = await waitFor(() => evtCount("ready") > 0, 10000);
    mark("内核注入并 ready", ready);
    await sleep(900);
    const h0 = await history();
    mark("初始历史有基线", Boolean(h0 && h0.steps && h0.steps.length >= 1), JSON.stringify(h0 && { len: h0.steps.length, ptr: h0.ptr }));

    // ── A. 撤销后继续改同一元素：旧分支（80px）必须被丢弃 ──
    await applyStyle(".box > h1", "font-size", "80px");
    mark("A1 第一次改动生效（80px）", css(".box > h1", "fontSize") === "80px", css(".box > h1", "fontSize"));
    await undo();
    mark("A2 撤销回到 64px", css(".box > h1", "fontSize") === "64px", css(".box > h1", "fontSize"));

    await applyStyle(".box > h1", "color", "rgb(255, 0, 0)");
    await applyStyle(".box > h1", "font-weight", "700");
    await applyStyle(".box > h1", "letter-spacing", "2px");
    const hA = await history();
    // 同一元素快速改动可能被合并成 1 步，也可能是 3 步；两种都算正常，关键是别把旧的 80px 分支留下
    mark("A3 撤销后新分支都是有效步骤（基线+1~3 步，指针在末尾）",
      Boolean(hA && hA.steps.length >= 2 && hA.steps.length <= 4 && hA.ptr === hA.steps.length - 1),
      JSON.stringify(hA && { len: hA.steps.length, ptr: hA.ptr, labels: hA.steps.map((s) => s.label) }));

    let sawOldBranch = false;
    let undoCount = 0;
    for (let i = 0; i < 3; i++) {
      await undo();
      undoCount++;
      if (css(".box > h1", "fontSize") === "80px") sawOldBranch = true;
      const hs = await history();
      if (hs && hs.ptr === 0) break;
    }
    mark("A4 一路撤销回基线：字号 64px、颜色不再是红色、且中途没出现旧 80px 分支",
      css(".box > h1", "fontSize") === "64px" && css(".box > h1", "color") !== "rgb(255, 0, 0)" && !sawOldBranch,
      JSON.stringify({ font: css(".box > h1", "fontSize"), color: css(".box > h1", "color"), sawOldBranch, undoCount }));

    // ── B. 从基线重新做：分支后逐步撤销应回到分支点，不能出现旧分支 ──
    await applyStyle(".box > p", "color", "rgb(0, 0, 255)");
    await applyStyle(".box > h1", "letter-spacing", "3px");
    await applyStyle(".box > p", "font-size", "20px");
    const hB = await history();
    mark("B1 分支后历史为 4 步（基线+3 步，不含旧分支）",
      Boolean(hB && hB.steps.length === 4 && hB.ptr === 3),
      JSON.stringify(hB && { len: hB.steps.length, ptr: hB.ptr, labels: hB.steps.map((s) => s.label) }));
    await undo();
    await undo();
    mark("B2 撤销两步回到分支点（p 蓝、p 字号 16px、h1 字距恢复 normal）",
      css(".box > p", "color") === "rgb(0, 0, 255)" && css(".box > p", "fontSize") === "16px" && css(".box > h1", "letterSpacing") === "normal",
      JSON.stringify({ pColor: css(".box > p", "color"), pSize: css(".box > p", "fontSize"), h1Spacing: css(".box > h1", "letterSpacing") }));
    await undo();
    mark("B3 再撤销回到基线：h1 字号 64px、p 颜色恢复（旧 80px 分支没有复活）",
      css(".box > h1", "fontSize") === "64px" && css(".box > p", "color") !== "rgb(0, 0, 255)",
      JSON.stringify({ h1Font: css(".box > h1", "fontSize"), pColor: css(".box > p", "color") }));

    const errs = events.filter((x) => x.type === "page-error").map((x) => x.text);
    mark("页面无 JS 异常", errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) {
    mark("执行异常", false, String((e && e.stack) || e));
  }
  const out = document.getElementById("out");
  out.textContent = JSON.stringify(RESULTS);
  out.setAttribute("data-done", "1");
  document.title = "done";
})();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url || "/";
  const send = (type, body) => {
    res.writeHead(200, { "content-type": type });
    res.end(body);
  };
  if (u.startsWith("/runtime.js")) return send("application/javascript; charset=utf-8", fs.readFileSync(KERNEL));
  if (u.startsWith("/core.mjs")) return send("application/javascript; charset=utf-8", fs.readFileSync(CORE));
  if (u.startsWith("/page")) return send("text/html; charset=utf-8", PAGE_HTML);
  return send("text/html; charset=utf-8", DRIVER_HTML);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ve-undo-"));
const url = `http://127.0.0.1:${port}/driver`;

const args = [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--force-device-scale-factor=1", "--window-size=1300,900",
  "--virtual-time-budget=120000",
  `--user-data-dir=${profile}`,
  "--dump-dom", url,
];

const child = spawn(EDGE, args, { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", () => {});
const code = await new Promise((r) => child.on("exit", (c) => r(c)));
server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }

const m = /<pre id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(out);
let results = null;
try {
  results = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) : null;
} catch { results = null; }

if (!Array.isArray(results)) {
  console.log("FAIL 无法从页面收集结果（exit=" + code + "）");
  console.log(out.slice(0, 1200));
  process.exit(1);
}
let failed = 0;
for (const r of results) {
  if (r.ok) console.log("PASS " + r.name);
  else { failed++; console.log("FAIL " + r.name + (r.extra ? "  [" + r.extra + "]" : "")); }
}
console.log("\n汇总：" + (results.length - failed) + "/" + results.length + " 通过");
process.exit(failed ? 1 : 0);
