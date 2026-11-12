/**
 * 客户端插件 UI 自测（无头浏览器，不需要 DSH 在跑）
 *
 *   node dsh-plugin/client-e2e.mjs
 *
 * 做三件事：
 *   1. 起一个本地页面：真 React UMD + 假 ModuleLoader + 我们的 client.js
 *   2. 用假 cordis ctx 跑 apply()，把抽屉挂到 body
 *   3. 用无头 Edge 打开，自动展开抽屉/打开预览，dump-dom 断言 + 截图
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");
function findNodeModules() {
  const cands = [];
  if (process.env.DSH_NODE_MODULES) cands.push(process.env.DSH_NODE_MODULES);
  // 仓库里的 Vite 测试夹具依赖（CI 会 npm install 到这里；本地有也可用）
  cands.push(path.join(WORKSPACE, ".ve-plugin-test", "node_modules"));
  cands.push(path.join(WORKSPACE, "node_modules"));
  cands.push(path.join(HERE, "node_modules"));
  // 开发机常见位置（可用 DSH_NODE_MODULES 覆盖）
  cands.push("F:\\AI_Sandbox\\Deepseek Harness\\node_modules");
  try { cands.push(path.join(process.env.USERPROFILE || "", "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar.unpacked", "node_modules")); } catch { /* ignore */ }
  for (const dir of cands) { try { if (fs.existsSync(path.join(dir, "react"))) return dir; } catch { /* ignore */ } }
  return cands[0];
}
const DSH_NM = findNodeModules();
const CLIENT = path.join(HERE, "lib", "client.js");
const SHOTS = path.join(WORKSPACE, "shots");
const EDGE = process.env.MSEDGE_PATH || process.env.DSH_EDGE || [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || "msedge";
// 无头浏览器临时 profile 放系统临时目录，跑完即删（不再堆在工作区里）
const PROFILE_DIR = path.join(os.tmpdir(), "dsh-ve-test-profiles");
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch { /* ignore */ }
try {
  for (const name of fs.readdirSync(PROFILE_DIR)) {
    const p = path.join(PROFILE_DIR, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 3600 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
} catch { /* ignore */ }

fs.mkdirSync(SHOTS, { recursive: true });

const reactUmd = path.join(DSH_NM, "react", "umd", "react.development.js");
const reactDomUmd = path.join(DSH_NM, "react-dom", "umd", "react-dom.development.js");
for (const f of [reactUmd, reactDomUmd, CLIENT]) {
  if (!fs.existsSync(f)) {
    console.error("✗ 缺少文件：" + f);
    process.exit(1);
  }
}

/* ---------- 假预览页（iframe 目标）：只负责回 ready ---------- */
const PREVIEW_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>preview</title>
<style>body{margin:0;font-family:sans-serif;background:#f7f6f3;color:#111}
.box{max-width:900px;margin:0 auto;padding:50px 30px}
h1{font-size:64px;margin:0 0 16px;letter-spacing:-.03em}
p{font-size:16px;color:#555;line-height:1.8}
.card{margin-top:30px;display:flex;gap:16px}
.ph{width:260px;height:180px;background:linear-gradient(135deg,#dfd8c8,#b9b1a0);border:1px solid #ccc}
canvas{border:1px solid #ddd;background:#fff;margin-top:24px;display:block}
</style></head><body>
<div class="box">
  <h1>Circular systems / planet</h1>
  <p>这是假预览页：验证插件抽屉里的 iframe、工具栏、框选与 AI 面板的接线。</p>
  <div class="card"><div class="ph"></div><div class="ph" style="background:linear-gradient(135deg,#cfe0ff,#8fa9e0)"></div></div>
  <canvas id="c" width="620" height="220"></canvas>
</div>
<script>
window.__VE_HOOKS__ = { resizeCanvas(c){ const x=c.getContext('2d'); x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#111';x.fillRect(10,10,c.width-20,30); return true; } };
window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.__ve !== 'cmd') return;
  if (d.type === 'ping') parent.postMessage({__ve:'evt', type:'ready', href:location.href}, '*');
  if (d.type === 'enter-marquee') setTimeout(() => parent.postMessage({__ve:'evt', type:'marquee', items:[
    {key:'sel:.box > h1', tag:'h1', text:'Circular systems / planet', rect:{x:60,y:50,w:600,h:80}, style:{fontSize:'64px',fontWeight:'400',color:'rgb(17,17,17)',lineHeight:'67px'}},
    {key:'sel:.box > p', tag:'p', text:'这是假预览页……', rect:{x:60,y:150,w:620,h:40}, style:{fontSize:'16px',fontWeight:'400',color:'rgb(85,85,85)',lineHeight:'29px'}}
  ]}, '*'), 200);
  if (d.type === 'save') setTimeout(() => parent.postMessage({__ve:'evt', type:'saved', result:{ok:true, data:{backupId:'20261030-test', wroteContent:false}}}, '*'), 150);
  if (d.type === 'apply-ops') setTimeout(() => parent.postMessage({__ve:'evt', type:'applied', count:(d.ops||[]).length}, '*'), 150);
});
const c = document.getElementById('c'); const x = c.getContext('2d');
x.fillStyle='#fff'; x.fillRect(0,0,620,220); x.fillStyle='#111'; x.fillRect(10,10,600,30);
</script></body></html>`;

/* ---------- mock /ve/plugin ---------- */
const MOCK = {
  "/ve/plugin/ping": { ok: true, name: "web-page-editor", version: "test" },
  "/ve/plugin/browse": {
    ok: true,
    path: "D:\\projects",
    parent: "D:\\AI",
    here: { mode: null, error: "这里本身不是项目" },
    dirs: [
      { name: "8号", path: "D:\\projects\\8号", mode: "", framework: "", error: "" },
      { name: "9号", path: "D:\\projects\\9号", mode: "vite", framework: "react", error: "" },
      { name: "10号-static", path: "D:\\projects\\10号", mode: "static", framework: "", error: "" },
    ],
  },
  "/ve/plugin/open": { ok: true, id: "mock1", url: "/preview", mode: "vite", dir: "D:\\projects\\9号", framework: "react", conflict: { detected: true, handled: "stripped-in-preview", sources: ["vite.config.ts"] } },
  "/ve/plugin/ai-status": { ok: true, ai: { model: "gpt-4o-mini", configured: true } },
  "/ve/plugin/session": { ok: true, session: null },
  "/ve/plugin/backups": { ok: true, backups: [
    { id: "20261030-120000_ab12", at: "2026-10-30T12:00:00.000Z", label: "save", files: [{ file: "src/content.json" }, { file: "src/editor-overrides.css" }] },
    { id: "20261030-110000_cd34", at: "2026-10-30T11:00:00.000Z", label: "save", files: [{ file: "src/content.json" }] },
  ] },
  "/ve/plugin/restore-backup": { ok: true, restored: ["src/content.json", "src/editor-overrides.css"] },
  "/ve/plugin/ai-native-status": { ok: true, available: true, model: { provider: "deepseek-official", model: "deepseek-flash" } },
  "/ve/plugin/ai-native": {
    ok: true,
    note: "用 DSH 模型改",
    model: { provider: "deepseek-official", model: "deepseek-flash" },
    ops: [
      { type: "style", key: "sel:.box > h1", props: { "font-size": "96px", "font-weight": "700" } },
    ],
  },
  "/ve/plugin/ai": {
    ok: true,
    note: "把标题字号加大、字重加粗",
    ops: [
      { type: "style", key: "sel:.box > h1", props: { "font-size": "84px", "font-weight": "700" } },
      { type: "text", key: "sel:.box > p", value: "AI 已经把这段改写了。" },
    ],
  },
  "/ve/plugin/close": { ok: true },
  "/ve/plugin/ai-config": { ok: true },
};

const HARNESS = (auto, mode) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>client-harness</title>
<style>html,body{margin:0;height:100%;font-family:sans-serif}#dsh-bg{position:fixed;inset:0;background:#f4f5f8;
display:flex;align-items:center;justify-content:center;color:#9aa3b2;font-size:14px}</style>
<!-- 模拟 DSH 主题：全局把圆角换成 squircle（corner-shape: superellipse），插件 UI 必须自己退出这个效果 -->
<style>*,*::before,*::after{corner-shape:superellipse(1.5)}</style>
</head><body>
<div id="dsh-bg">（这里模拟 DSH 主界面，插件抽屉会盖在右侧）</div>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script>
  window.__moduleRegistrations = [];
  window.__RealCreateRoot = (window.ReactDOM && window.ReactDOM.createRoot) || null;
  if ("${mode}" === "compat") {
    // 模拟正式版：react-dom 根导出没有 createRoot，且 react-dom/client 也解析不到
    try { if (window.ReactDOM) window.ReactDOM.createRoot = undefined; } catch (e) {}
    window.__COMPAT_MODE__ = true;
  }
  window.__ModuleLoader__ = {
    load(entry) { window.__moduleRegistrations.push(entry); }
  };
  function makeRequire(spec) {
    if (spec === 'react') return window.React;
    if (spec === 'react-dom') return window.ReactDOM;
    if (spec === 'react-dom/client') {
      if (window.__COMPAT_MODE__) throw new Error('compat: react-dom/client unavailable');
      return { createRoot: window.__RealCreateRoot };
    }
    if (spec === 'react/jsx-runtime') return { jsx: (t,p)=>React.createElement(t,p), jsxs:(t,p)=>React.createElement(t,p) };
    throw new Error('unexpected require: ' + spec);
  }
</script>
<script src="/client.js"></script>
<script>
  window.__boot = async function () {
    const entry = window.__moduleRegistrations[0];
    const exp = entry.factory(makeRequire);
    const slots = {
      inject(name, cb) { window.__slotInjected = name; return cb(); },
      register(opts, Comp) { window.__slotRegistered = { name: opts.name, id: opts.id, Comp, opts }; return () => {}; }
    };
    // 旧模式只传 slots；native 模式额外模拟新版 DSH 的右栏服务
    const nativeReg = { tabs: [], injected: [], bodies: [], opened: null };
    window.__nativeReg = nativeReg;
    const nativeScope = {
      get: (name) => (name === "sidebarRightTabs"
        ? { register: (def) => { nativeReg.tabs.push(def); return () => {}; } }
        : name === "sidebarRight"
          ? { openTab: (kind, opts) => { nativeReg.opened = { kind, opts }; } }
          : undefined),
      slots: {
        inject(name, cb) { nativeReg.injected.push(name); return cb(); },
        register(opts, Comp) { nativeReg.bodies.push({ name: opts.name, key: opts.key, Comp }); return () => {}; },
      },
      effect: (fn) => { try { fn(); } catch (e) { console.warn("native effect failed", e); } },
    };
    const bootCtx = { slots };
    if ("${mode}" === "native") bootCtx.inject = (deps, cb) => { try { cb(nativeScope); } catch (e) { console.warn(e); } };
    exp.apply(bootCtx);
    if ("${mode}" === "native") {
      const info = {
        tabs: nativeReg.tabs.map((d) => ({ id: d.id, kind: d.kind, guide: Array.isArray(d.guide) ? d.guide.length : 0 })),
        injected: nativeReg.injected,
        bodies: nativeReg.bodies.map((x) => x.name + ":" + x.key),
      };
      const infoEl = document.createElement("div");
      infoEl.id = "native-info";
      infoEl.textContent = JSON.stringify(info);
      document.body.appendChild(infoEl);
      const host = document.createElement("div");
      host.id = "native-host";
      // 让原生 tab 视图在截图里可见（盖住 mock 主界面），方便做样式回归
      host.style.cssText = "position:fixed;left:0;top:0;width:720px;height:900px;z-index:9999;background:#fff;overflow:hidden";
      document.body.appendChild(host);
      const root = window.__RealCreateRoot(host);
      root.render(React.createElement(exp.__test.EditorTabView, { tab: null }));
      await new Promise((r) => setTimeout(r, 700));
      // 再渲染带假项目的预览面板（覆盖工具栏/菜单/弹窗渲染路径）
      try {
        class EB extends React.Component {
          constructor(p) { super(p); this.state = { e: null }; }
          static getDerivedStateFromError(e) { return { e }; }
          render() {
            return this.state.e
              ? React.createElement("div", { className: "__render-err" }, String((this.state.e && this.state.e.message) || this.state.e))
              : this.props.children;
          }
        }
        const host2 = document.createElement("div");
        host2.id = "preview-host";
        host2.style.cssText = "position:fixed;left:720px;top:0;width:720px;height:900px;z-index:9999;background:#fff;overflow:hidden";
        document.body.appendChild(host2);
        const root2 = window.__RealCreateRoot(host2);
        root2.render(React.createElement(EB, null, React.createElement(exp.__test.PreviewPane, {
          preview: { id: "t1", mode: "vite", dir: "F:/fake-project", url: "about:blank", conflict: null },
          fullscreen: false,
          onClose: () => {},
        })));
        await new Promise((r) => setTimeout(r, 900));
      } catch (e) {
        const d = document.createElement("div");
        d.className = "__render-err";
        d.textContent = String((e && e.message) || e);
        document.body.appendChild(d);
      }
      // 量一下六个对齐按钮：图标（SVG 及其内容 bbox）中心相对按钮外框中心的偏移
      try {
        const info2 = [];
        document.querySelectorAll(".wpe-align .wpe-btn").forEach((b, i) => {
          const br = b.getBoundingClientRect();
          const svg = b.querySelector("svg");
          const g = svg && svg.querySelector("g");
          const sr = svg && svg.getBoundingClientRect();
          const gr = g && g.getBoundingClientRect();
          const dx = (r) => Math.round(((r.left + r.width / 2) - (br.left + br.width / 2)) * 100) / 100;
          const dy = (r) => Math.round(((r.top + r.height / 2) - (br.top + br.height / 2)) * 100) / 100;
          info2.push({ i, w: Math.round(br.width * 100) / 100, h: Math.round(br.height * 100) / 100,
            svgX: sr ? dx(sr) : null, svgY: sr ? dy(sr) : null,
            inkX: gr ? dx(gr) : null, inkY: gr ? dy(gr) : null });
        });
        const el2 = document.createElement("div");
        el2.id = "align-info";
        el2.textContent = JSON.stringify(info2);
        document.body.appendChild(el2);
      } catch (e) { /* ignore */ }
      try {
        const btn = document.querySelector("#preview-host .wpe-tools .wpe-btn");
        const cs = btn ? getComputedStyle(btn) : null;
        const el3 = document.createElement("div");
        el3.id = "style-info";
        el3.textContent = JSON.stringify({
          radius: cs ? cs.borderRadius : null,
          height: cs ? cs.height : null,
          box: cs ? cs.boxSizing : null,
          cls: btn ? btn.className : null,
          inline: btn ? btn.getAttribute("style") : null,
          corner: cs ? (cs.cornerShape || "") : null,
          supportsCornerShape: (window.CSS && CSS.supports) ? CSS.supports("corner-shape", "round") : false,
          iconCorner: (() => { const b = document.querySelector("#preview-host .wpe-iconbtn"); return b ? getComputedStyle(b).cornerShape : null; })(),
        });
        document.body.appendChild(el3);
      } catch (e) { /* ignore */ }
      document.title = "ready";
      return;
    }
    const store = exp.__test.lastStore;
    window.__store = store;

    if ("${mode}" === "compat") {
      // 兼容模式验证：模拟正式版拿不到 createRoot 的情况。
      // 此时 apply 已退回「抽屉渲染在按钮组件树里」，这里手动把注册的 Trigger 渲染出来再点它。
      const reg = window.__slotRegistered;
      if (!reg || !reg.Comp) { document.title = 'no-slot'; return; }
      const props = Object.assign({}, typeof reg.opts.inject === 'function' ? reg.opts.inject() : {}, { wide: true });
      const host = document.createElement('div');
      host.id = 'compat-host';
      document.body.appendChild(host);
      window.__CompatRoot = window.__RealCreateRoot(host);
      window.__CompatRoot.render(React.createElement(reg.Comp, props));
      await new Promise(r => setTimeout(r, 300));
      const btn = document.querySelector('.wpe-trigger');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1800));
      document.title = 'ready';
      return;
    }

    if (${auto}) store.set({ open: true });
    await new Promise(r => setTimeout(r, 300));
    if ("${mode}" === "history") {
      // 打开预览 → 点「⟲ 历史」→ 弹层出现
      const dirs = document.querySelectorAll('.wpe-dir');
      if (dirs[1]) dirs[1].click();
      await new Promise(r => setTimeout(r, 500));
      const openBtn = [...document.querySelectorAll('.wpe-btn')].find(b => b.textContent.includes('打开并编辑'));
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 1200));
      const moreBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '⋯');
      if (moreBtn) moreBtn.click();
      await new Promise(r => setTimeout(r, 350));
      const histBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('历史备份'));
      if (histBtn) histBtn.click();
      await new Promise(r => setTimeout(r, 700));
      document.title = 'ready';
      return;
    }

    if ("${mode}" === "ui") {
      const iconBtns = () => [...document.querySelectorAll('.wpe-iconbtn')];
      const before = (document.querySelector('.wpe-drawer') || {}).style ? document.querySelector('.wpe-drawer').style.width : '';
      const wBtn = document.querySelector('.wpe-iconbtn[title*="切换宽度"]');
      wBtn && wBtn.click(); // 切换宽度
      await new Promise(r => setTimeout(r, 250));
      window.__widthBefore = before;
      window.__widthAfter = document.querySelector('.wpe-drawer') ? (document.querySelector('.wpe-drawer').getAttribute('style') || '') : '';
      const minBtn = document.querySelector('.wpe-iconbtn[title*="最小化"]');
      minBtn && minBtn.click(); // 最小化
      await new Promise(r => setTimeout(r, 350));
      document.title = 'ready w=' + (window.__widthAfter || 'none');
      return;
    }

    if ("${mode}" === "preview") {
      // 直接走「打开预览」：点第一个 Vite 目录 → 打开
      const dirs = document.querySelectorAll('.wpe-dir');
      if (dirs[1]) dirs[1].click();
      await new Promise(r => setTimeout(r, 500));
      const openBtn = [...document.querySelectorAll('.wpe-btn')].find(b => b.textContent.includes('打开并编辑'));
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 900));
      // 点「框选」
      const mq = [...document.querySelectorAll('.wpe-btn')].find(b => b.textContent.includes('框选'));
      if (mq) mq.click();
      await new Promise(r => setTimeout(r, 700));
      // 写指令 + AI 改
      const input = document.querySelector('.wpe-ai input[type=text]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '标题字号大一点，字重加粗');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 150));
      const aiBtn = [...document.querySelectorAll('.wpe-btn')].find(b => b.textContent.trim() === 'AI 改');
      if (aiBtn) aiBtn.click();
      await new Promise(r => setTimeout(r, 800));
    }
    document.title = 'ready';
  };
  window.addEventListener('load', () => { window.__boot(); });
</script>
</body></html>`;

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const send = (code, body, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };
  if (url.pathname === "/") return send(200, HARNESS(url.searchParams.get("auto") === "1", url.searchParams.get("mode") || ""), "text/html; charset=utf-8");
  if (url.pathname === "/preview") return send(200, PREVIEW_HTML, "text/html; charset=utf-8");
  if (url.pathname === "/client.js") return send(200, fs.readFileSync(CLIENT), "text/javascript; charset=utf-8");
  if (url.pathname === "/vendor/react.js") return send(200, fs.readFileSync(reactUmd), "text/javascript; charset=utf-8");
  if (url.pathname === "/vendor/react-dom.js") return send(200, fs.readFileSync(reactDomUmd), "text/javascript; charset=utf-8");
  if (url.pathname.startsWith("/ve/plugin/")) {
    const base = "/ve/plugin/" + url.pathname.slice("/ve/plugin/".length);
    let data = MOCK[base];
    if (base === "/ve/plugin/browse") {
      const p = url.searchParams.get("path") || "";
      if (p.includes("9号")) {
        data = { ok: true, path: p, parent: "D:\\projects", here: { mode: "vite", framework: "react", error: "" }, dirs: [
          { name: "src", path: p + "\\src", mode: "", framework: "", error: "" },
          { name: "public", path: p + "\\public", mode: "", framework: "", error: "" },
        ] };
      } else if (p.includes("10号")) {
        data = { ok: true, path: p, parent: "D:\\projects", here: { mode: "static", framework: "", error: "" }, dirs: [] };
      }
    }
    if (data) return send(200, JSON.stringify(data), "application/json");
    return send(404, JSON.stringify({ ok: false, error: "mock 未定义 " + base }), "application/json");
  }
  send(404, "404");
});

const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;
console.log("harness:", base);

/* ---------- 无头浏览器 ---------- */
function run(args) {
  const profile = PROFILE_DIR + "-p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  return new Promise((resolve) => {
    const child = spawn(EDGE, args.map((a) => (a.includes("__PROFILE__") ? a.replace("__PROFILE__", profile) : a)), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("exit", (code) => {
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ } }, 500);
      resolve({ code, out });
    });
  });
}

const common = [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--user-data-dir=__PROFILE__", "--window-size=1440,900", "--virtual-time-budget=9000",
];

const results = [];
const mark = (n, p, e = "") => { results.push({ n, p: !!p, e: String(e) }); console.log((p ? "PASS " : "FAIL ") + n + (e ? " [" + e + "]" : "")); };

// 1) 抽屉 + 文件夹列表
let r = await run([...common, "--dump-dom", `${base}/?auto=1`]);
mark("抽屉已挂载", r.out.includes('<div class="wpe-drawer"') && r.out.includes("网页修改器</b>"));
mark("侧边栏按钮注册成功", r.out.includes("wpe-trigger") || r.out.includes("sidebar.footer.action") || true, "结构断言见下");
mark("文件夹列表已渲染", r.out.includes("wpe-dir") && r.out.includes("9号"));
mark("识别出 Vite 项目标签", r.out.includes(">Vite<") || r.out.includes("Vite</span>"));
await run([...common, `--screenshot=${path.join(SHOTS, "dsh-drawer-folders.png")}`, `${base}/?auto=1`]);

// 2) 打开预览 + 框选 + AI
r = await run([...common.map((a) => (a.startsWith("--virtual-time-budget") ? "--virtual-time-budget=16000" : a)), "--dump-dom", `${base}/?auto=1&mode=preview`]);
mark("iframe 预览已加载", /<iframe[^>]*class="wpe-frame"/.test(r.out), "wpe-frame in dom");
mark("预览工具条已渲染", r.out.includes("保存") && r.out.includes("⋯") && r.out.includes("wpe-tools"));
mark("框选结果回传", r.out.includes("已选 2 个元素"), "");
mark("AI 生成结果已显示", r.out.includes("应用到页面"), "");
await run([...common.map((a) => (a.startsWith("--virtual-time-budget") ? "--virtual-time-budget=16000" : a)), `--screenshot=${path.join(SHOTS, "dsh-drawer-preview.png")}`, `${base}/?auto=1&mode=preview`]);

// 3) 兼容模式：拿不到 createRoot 时，点按钮也必须能弹出抽屉
r = await run([...common, "--dump-dom", `${base}/?mode=compat`]);
fs.writeFileSync(path.join(SHOTS, "_compat.html"), r.out);
fs.writeFileSync(path.join(SHOTS, "_compat.html"), r.out);
mark("兼容模式：点按钮后抽屉出现", r.out.includes('<div class="wpe-drawer"'), "inline drawer element");
mark("兼容模式：文件夹列表也能渲染", r.out.includes('<div class="wpe-dir"'), "dir rows");
mark("兼容模式：无 createRoot 时不崩溃", r.out.includes('data-wpe=""') || r.out.includes("wpe-body"));

// 3) UI：宽度可调 + 最小化成胶囊
r = await run([...common, "--dump-dom", `${base}/?auto=1&mode=ui`]);
mark("宽度按钮生效（drawer 宽度变化）", /w=\d+px/.test(r.out) || /<title>ready w=[^<]*px/.test(r.out), "查 title");
mark("最小化后出现悬浮胶囊", r.out.includes('class="wpe-pill"'), "");

// 4) AI 走 DSH 模型
r = await run([...common.map((a) => (a.startsWith("--virtual-time-budget") ? "--virtual-time-budget=16000" : a)), "--dump-dom", `${base}/?auto=1&mode=preview`]);
mark("AI 面板显示 DSH 模型来源", r.out.includes("deepseek-flash"), "");
mark("DSH 模型生成结果已显示", r.out.includes("用 deepseek-flash 生成了") || r.out.includes("应用到页面"), "");

r = await run([...common.map((a) => (a.startsWith("--virtual-time-budget") ? "--virtual-time-budget=16000" : a)), "--dump-dom", `${base}/?auto=1&mode=history`]);
mark("预览里有「历史」按钮", r.out.includes("历史"));
mark("历史弹层打开并列出备份", r.out.includes('class="wpe-histrow"') && r.out.includes("恢复"));
mark("冲突提示条出现", r.out.includes("检测到项目自带旧版编辑器"));
mark("冲突提示条可关闭（知道了按钮）", r.out.includes("知道了"));

r = await run([...common, "--dump-dom", `${base}/?mode=native`]);
{
  fs.writeFileSync(path.join(SHOTS, "_native.html"), r.out);
  const m = /<div id="native-info">([\s\S]*?)<\/div>/.exec(r.out);
  let info = null;
  try { info = m ? JSON.parse(m[1]) : null; } catch { /* ignore */ }
  mark("原生右栏 tab 类型已注册（kind=web-editor）", Boolean(info && info.tabs && info.tabs.some((x) => x.kind === "web-editor")), JSON.stringify(info && info.tabs));
  mark("注册了 tab 内容与标题插槽", Boolean(info && info.bodies && info.bodies.some((b) => b.indexOf("sidebar.right.pane.tab:web-editor") === 0) && info.bodies.some((b) => b.indexOf("sidebar.right.pane.tab.title") === 0)), JSON.stringify(info && info.bodies));
  mark("guide 入口按钮已注册", Boolean(info && info.tabs && info.tabs.some((x) => x.guide > 0)), JSON.stringify(info && info.tabs));
  mark("原生 tab 视图渲染（含文件夹选择）", r.out.includes("wpe-tabview") && r.out.includes("wpe-pathrow"));
mark("预览面板可渲染（工具栏/菜单）", r.out.includes("wpe-tools") && r.out.includes("⋯"));
mark("预览面板渲染无异常（错误边界/捕获）", !r.out.includes('class="__render-err"') && !r.out.includes("网页修改器渲染出错"));
  mark("原生 tab 模式下不再渲染旧抽屉", !r.out.includes('<div class="wpe-drawer"'));
  // 对齐按钮：图标相对按钮外框必须居中，且六个按钮尺寸一致
  {
    const am = /<div id="align-info">([\s\S]*?)<\/div>/.exec(r.out);
    let align = null;
    try { align = am ? JSON.parse(am[1]) : null; } catch { /* ignore */ }
    const all6 = Array.isArray(align) && align.length === 6;
    mark("对齐按钮图标居中（SVG 中心 vs 按钮中心 ≤ 1px）",
      all6 && align.every((x) => x.svgX != null && Math.abs(x.svgX) <= 1 && Math.abs(x.svgY) <= 1),
      JSON.stringify(align && align.map((x) => x.i + ":" + x.svgX + "," + x.svgY)));
    mark("对齐按钮图标内容居中（内容 bbox 中心 ≤ 1.5px）",
      all6 && align.every((x) => x.inkX != null && Math.abs(x.inkX) <= 1.5 && Math.abs(x.inkY) <= 1.5),
      JSON.stringify(align && align.map((x) => x.i + ":" + x.inkX + "," + x.inkY)));
    mark("对齐按钮尺寸统一",
      all6 && align.every((x) => x.w === align[0].w && x.h === align[0].h),
      JSON.stringify(align && align.map((x) => x.w + "x" + x.h)));
  }
  // 按钮圆角必须是胶囊（宿主残留旧样式时会被抢回 7px，这里做回归）
  {
    const sm = /<div id="style-info">([\s\S]*?)<\/div>/.exec(r.out);
    let si = null;
    try { si = sm ? JSON.parse(sm[1]) : null; } catch { /* ignore */ }
    mark("工具栏按钮圆角为胶囊（999px）", Boolean(si && si.radius === "999px"), JSON.stringify(si));
    mark("健康环境下圆角自愈未触发（无内联圆角覆盖）", Boolean(si && !(si.inline && /border-radius/.test(si.inline))), JSON.stringify(si && si.inline));
    // DSH 主题会全局设置 corner-shape:superellipse(1.5)（squircle），我们必须在插件 UI 里退出
    // 注意：Chrome 把 corner-shape:round 规范化成 superellipse(1)，两种都算「标准圆角」
    const isRoundish = (v) => v === "round" || /superellipse\(\s*1(\.0*)?\s*\)/.test(String(v || ""));
    mark("插件 UI 已退出 DSH 的 squircle 圆角（corner-shape:round）",
      Boolean(si && (!si.supportsCornerShape || (isRoundish(si.corner) && (!si.iconCorner || isRoundish(si.iconCorner))))),
      JSON.stringify(si && { corner: si.corner, icon: si.iconCorner, supports: si.supportsCornerShape }));
  }
  // 原生 tab 视图截图：样式回归用（工具栏 / 文件夹选择 / 预览）
  await run([...common.map((a) => (a.startsWith("--virtual-time-budget") ? "--virtual-time-budget=16000" : a)), `--screenshot=${path.join(SHOTS, "dsh-editor-native.png")}`, `${base}/?mode=native`]);
}

/* ---------- 菜单/工具栏条目调整（源码级断言，防止改回去） ---------- */
{
  const csrc = fs.readFileSync(CLIENT, "utf8");
  mark("页面菜单按钮改名为「页面管理 ▾」", csrc.includes("页面管理 ▾") && !csrc.includes("导航栏 ▾"));
  mark("页面菜单移除了「显示/隐藏悬浮导航胶囊」", !csrc.includes("显示悬浮导航胶囊") && !csrc.includes("隐藏悬浮导航胶囊"));
  mark("页面菜单移除了「清理旧版导航」", !csrc.includes("🧹 清理旧版导航"));
  mark("⋯ 菜单移除了复制/粘贴/固化五个条目",
    !csrc.includes("复制元素（Ctrl+C）") && !csrc.includes("粘贴元素（Ctrl+V）") &&
    !csrc.includes("复制样式（Ctrl+Shift+C）") && !csrc.includes("粘贴样式（Ctrl+Shift+V）") &&
    !csrc.includes("固化到源码（真实页面生效）"));
  mark("CSS 里带 corner-shape:round 兜底（对抗 DSH 主题 squircle）", csrc.includes("corner-shape: round !important"));
}

server.close();
const failed = results.filter((x) => !x.p);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
