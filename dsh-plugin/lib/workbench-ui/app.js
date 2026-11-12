/* 网页工作台 · 独立前端
 * 运行方式：
 *   1) 被 DSH 插件 iframe 加载（有父窗口握手）→ 通过 postMessage 调宿主能力
 *   2) 浏览器直接打开 → 用 localStorage 里的接口地址 + token 调 /ve/plugin/*
 */
(function () {
  "use strict";
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var app = $("#app");
  var PAGE = 3;
  var QS = new URLSearchParams(location.search);
var EMBEDDED = Boolean(window.parent && window.parent !== window) || QS.get("embedded") === "1" || QS.get("ve_embed") === "1";
  var STORE_KEYS = { theme: "ve-wb:theme", api: "ve-wb:api", token: "ve-wb:token" };

  var S = {
    mode: EMBEDDED ? "embedded" : "standalone",
    ready: false,
    theme: "paper",
    fromHost: false,      // 独立窗口但由 DSH 宿主带 api 参数打开（隐藏独立模式连接条，布局和嵌入时一致）
    bootTarget: null,     // { dir, page }：独立窗口直接打开当前项目，不中转工作台首页
    projects: [],
    info: null,
    page: 0,
    view: "home", // home | edit
    proj: null,
    busy: false,
    msg: "",
    showPick: false,
    path: "",
    pick: { path: "", data: null, busy: false, err: "", typed: null },
    apiBase: "",
    token: "",
    styles: [],
    ai: { open: false, text: "", sel: null, busy: false, msg: "", marquee: false },
    style: { target: "", busy: false, addOpen: false, addPath: "", msg: "", open: false, selectedId: "" },
    confirm: null,
    pagesModal: { open: false, dir: "", list: null, loading: false },
    nav: { open: false, dir: "", list: null, loading: false, err: "", cur: "" },
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function baseName(p) {
    var s = String(p || "").replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function readLS(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  /* ── 宿主桥（DSH 插件） ── */
  var callSeq = 0;
  var pending = new Map();
  function callHost(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++callSeq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.parent.postMessage({ source: "ve-wb", type: "call", id: id, method: method, args: args || {} }, "*");
      } catch (e) { pending.delete(id); reject(e); return; }
      window.setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); reject(new Error("宿主未响应")); }
      }, 20000);
    });
  }
  function notifyHost(type, data) {
    try { window.parent.postMessage({ source: "ve-wb", type: type, data: data }, "*"); } catch (e) { /* ignore */ }
  }
  window.addEventListener("message", function (e) {
    var d = e.data;
    // 预览内核（runtime.js）发来的事件：框选结果等
    if (d && d.__ve === "evt") {
      if (d.type === "marquee") {
        var items = Array.isArray(d.items) ? d.items : [];
        S.ai.sel = items;
        S.ai.marquee = false;
        S.ai.open = true;
        S.ai.msg = d.cancelled ? "已取消框选" : (items.length ? "已框选 " + items.length + " 个元素" : "框选区域里没有可编辑元素");
        render();
      }
      return;
    }
    if (!d || d.source !== "ve-host") return;
    if (d.type === "init") {
      S.ready = true;
      if (d.data && Array.isArray(d.data.projects)) S.projects = d.data.projects;
      if (d.data && d.data.info) S.info = d.data.info;
      if (d.data && Array.isArray(d.data.styles)) {
        S.styles = d.data.styles;
        try { ensureAllStyleFonts(S.styles, String(d.data.apiBase || S.apiBase || '').replace(/\/+$/, '')); } catch (e) { /* ignore */ }
      }
      if (d.data && d.data.apiBase) S.apiBase = d.data.apiBase;
      if (d.data && d.data.info && d.data.info.dir && !S.style.target) S.style.target = d.data.info.dir;
      if (d.data && d.data.theme) setTheme(d.data.theme, false);
      render();
      return;
    }
    if (d.type === "theme" && d.data) { setTheme(d.data, false); return; }
    if (d.type === "result") {
      var p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.resolve(d.data); else p.reject(new Error(d.error || "宿主调用失败"));
    }
  });

  /* ── 独立模式：直连 HTTP 接口 ── */
  async function rest(pathname, opts) {
    var base = (S.apiBase || readLS(STORE_KEYS.api, "")).replace(/\/+$/, "");
    var token = S.token || readLS(STORE_KEYS.token, "");
    if (!base) throw new Error("还没有配置接口地址（顶部设置栏）");
    var res = await fetch(base + pathname, {
      method: (opts && opts.method) || "GET",
      headers: Object.assign({ "content-type": "application/json" }, token ? { "x-ve-token": token } : {}),
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || data.ok === false) throw new Error((data && (data.error || data.note)) || ("HTTP " + res.status));
    return data;
  }

  async function hostCall(method, args) {
    if (S.mode === "embedded") return callHost(method, args);
    if (method === "projects.list") return rest("/ve/plugin/projects");
    if (method === "project.open") return rest("/ve/plugin/open", { method: "POST", body: args });
    if (method === "pages.list") return rest("/ve/plugin/pages?dir=" + encodeURIComponent(args.dir || ""));
    if (method === "pages.nav") return rest("/ve/plugin/page-nav", { method: "POST", body: args });
    if (method === "project.close") return rest("/ve/plugin/close", { method: "POST", body: args });
    if (method === "browse") return rest("/ve/plugin/browse?path=" + encodeURIComponent((args && args.path) || ""));
    if (method === "defaultDir") return rest("/ve/plugin/default-dir");
    if (method === "workbench.close") throw new Error("独立模式没有可关闭的宿主");
    if (method === "styles.list") return rest("/ve/plugin/styles");
    if (method === "styles.add") return rest("/ve/plugin/styles/add", { method: "POST", body: args });
    if (method === "styles.remove") return rest("/ve/plugin/styles/remove", { method: "POST", body: args });
    if (method === "styles.apply") return rest("/ve/plugin/styles/apply", { method: "POST", body: args });
    if (method === "style.extract") return rest("/ve/plugin/style/extract", { method: "POST", body: args });
    if (method === "style.save") return rest("/ve/plugin/style/save", { method: "POST", body: args });
    if (method === "agent.prompt") return rest("/ve/plugin/handoff", { method: "POST", body: args });
    throw new Error("独立模式不支持：" + method);
  }

  /* ── 状态操作 ── */
  function setTheme(name, notify) {
    S.theme = name === "ink" ? "ink" : "paper";
    document.documentElement.setAttribute("data-theme", S.theme);
    writeLS(STORE_KEYS.theme, S.theme);
    if (notify !== false) notifyHost("theme", S.theme);
    render();
  }
  async function refreshProjects() {
    try {
      var r = await hostCall("projects.list");
      S.projects = (r && r.projects) || [];
      if (r && r.info) S.info = r.info;
      S.msg = "";
    } catch (e) {
      S.msg = "读取项目失败：" + String(e.message || e);
    }
    render();
  }
  /* ── 文件夹浏览器：路径可以直接输入 / 粘贴 ── */
  function cleanPickPath(v) {
    var s = String(v == null ? "" : v).trim();
    s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").trim(); // 去掉复制路径时常带的引号/空格
    return s;
  }
  function pickTypedRaw() {
    var el = $('[data-field="pickPath"]');
    if (el && typeof el.value === "string") return el.value;
    return S.pick.typed != null ? S.pick.typed : "";
  }
  function pickTypedDiffers() {
    var v = cleanPickPath(pickTypedRaw());
    return Boolean(v) && v !== String(S.pick.path || "");
  }
  function pickJump() {
    var v = cleanPickPath(pickTypedRaw());
    if (!v) { S.pick.err = "先输入一个目录路径（例如 D:\\\\AI\\\\网站测试集合）"; render(); return; }
    if (v === String(S.pick.path || "")) return;
    loadPick(v);
  }
  function syncPickOpenBtn() {
    var btn = $('[data-act="pick-open"]');
    if (!btn) return;
    var here = (S.pick.data && S.pick.data.here) || {};
    btn.disabled = Boolean(S.pick.busy) || (!here.mode && !pickTypedDiffers());
  }
  async function loadPick(target) {
    var wanted = cleanPickPath(target);
    S.pick.busy = true;
    S.pick.err = "";
    S.pick.typed = wanted;
    render();
    try {
      var d = null;
      if (wanted) d = await hostCall("browse", { path: wanted });
      else {
        try {
          var dd = await hostCall("defaultDir");
          d = await hostCall("browse", { path: (dd && dd.path) || "" });
        } catch (e) {
          d = await hostCall("browse", { path: "" });
        }
      }
      S.pick.data = d;
      S.pick.path = (d && d.path) || "";
      S.pick.typed = S.pick.path;
    } catch (e) {
      S.pick.err = "打不开这个目录：" + String((e && e.message) || e);
      S.pick.typed = wanted; // 保留用户输入，方便改完再试
    }
    S.pick.busy = false;
    render();
  }

  async function openFromPick() {
    // 输入框里改了路径但没按 Enter 就直接点「打开这个目录」：先跳到那个目录再判断
    var desired = cleanPickPath(pickTypedRaw());
    if (desired && desired !== String(S.pick.path || "")) {
      await loadPick(desired);
      if (S.pick.err) { render(); return; } // 路径打不开就别拿上一个目录去打开
    }
    var dir = S.pick.path || S.path;
    if (!dir) { S.msg = "先进到一个项目目录"; render(); return; }
    var d = S.pick.data || {};
    if (d && d.here && !d.here.mode) {
      S.msg = "这个目录不是前端项目（没有 package.json / index.html），进去子目录再试";
      render();
      return;
    }
    var r = await openProject(dir);
    if (r) { S.showPick = false; S.pick.data = null; }
  }

  function pickPanel() {
    var d = S.pick.data || {};
    var dirs = d.dirs || [];
    var here = d.here || {};
    var cur = S.pick.path || d.path || "";
    var typedVal = S.pick.typed != null ? S.pick.typed : cur;
    var typedDiff = cleanPickPath(typedVal) && cleanPickPath(typedVal) !== String(cur || "");
    var badge = here && here.mode
      ? '<span class="pick-ready" title="当前目录可以打开">✓ 可打开 · ' + esc(here.mode) + (here.framework ? " / " + esc(here.framework) : "") + "</span>"
      : '<span class="pick-ready dim" title="当前目录还不是前端项目">未识别项目</span>';
    var header =
      '<div class="pick-head">' +
      '<button class="btn ghost" data-act="pick-up" title="上一级"' + (d.parent ? "" : " disabled") + ">↑ 上一级</button>" +
      '<input class="pick-path-input" data-field="pickPath" value="' + esc(typedVal) + '" placeholder="输入或粘贴目录路径，Enter 进入" spellcheck="false" autocomplete="off" title="可以直接输入 / 粘贴目录路径，按 Enter 进入；复制来的引号会自动去掉" />' +
      badge +
      '<button class="btn pri" data-act="pick-open" title="打开当前目录（输入框里改了路径会先跳过去）"' + ((S.busy || (!(here && here.mode) && !typedDiff)) ? " disabled" : "") + ">" +
      (S.busy ? "打开中…" : "打开这个目录") +
      "</button>" +
      "</div>";
    var hint = "";
    var list = dirs.length
      ? dirs.map(function (x) {
          return '<button class="pick-dir' + (x.mode ? " known" : "") + '" data-act="pick-enter" data-dir="' + esc(x.path) + '">' +
            '<span class="pick-dir-name">📁 ' + esc(x.name) + "</span>" +
            (x.mode ? '<span class="pick-tag">' + esc(x.mode) + "</span>" : "") +
            "</button>";
        }).join("")
      : '<div class="pick-empty">' + (S.pick.busy ? "读取中…" : "这个目录下没有子文件夹") + "</div>";
    return (
      '<div class="pickbox">' +
      header +
      hint +
      (S.pick.err ? '<div class="pick-hint err">' + esc(S.pick.err) + "</div>" : "") +
      '<div class="pick-list">' + list + "</div>" +
      "</div>"
    );
  }

  async function openProject(dir) {
    var target = String(dir || S.path || (S.info && S.info.dir) || "").trim();
    if (!target) { S.showPick = true; S.msg = "先填项目目录"; render(); return null; }
    S.busy = true; S.msg = "正在打开…"; render();
    try {
      var r = await hostCall("project.open", { dir: target, source: "workbench" });
      S.busy = false;
      S.msg = "已打开：" + ((r && r.dir) || target);
      await refreshProjects();
      return r;
    } catch (e) {
      S.busy = false;
      S.msg = "打开失败：" + String(e.message || e);
      render();
      return null;
    }
  }
  /* ── 页面导航（工作台顶部工具栏：汉堡按钮 + 点击在下方展开页面列表） ── */
  function navActiveDir() {
    if (S.view === "edit" && S.proj && S.proj.dir) return String(S.proj.dir);
    if (S.proj && S.proj.dir && S.proj.url) return String(S.proj.dir);
    if (S.info && S.info.dir) return String(S.info.dir);
    var last = readLS("ve-wb:lastDir", "");
    if (last) return String(last);
    return S.projects && S.projects[0] ? String(S.projects[0].dir || "") : "";
  }
  function navCurPage() {
    if (S.view === "edit" && S.proj) return String(S.nav.cur || S.proj.page || "/");
    return "";
  }
  function navPageLabel(p) {
    var name = String(p.title || p.path || "").replace(/^\/+/, "").replace(/\.html?$/i, "");
    if (p.path === "/" || p.path === "/index.html") name = p.title || "首页";
    return name || "页面";
  }
  function navNormPage(p) {
    var s = String(p || "").replace(/^\/+/, "").split("?")[0].split("#")[0];
    if (!s) s = "index.html";
    return s;
  }
  function navIsCur(path, cur) {
    if (!cur) return false;
    return navNormPage(path) === navNormPage(cur);
  }
  function hamburgerIco() {
    return '<svg class="pagenav-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>';
  }
  function pagesDropEl() { return $("#ve-pages"); }
  function renderNav() {
    var drop = pagesDropEl();
    if (!drop) return;
    var editing = S.view === "edit" && S.proj && S.proj.url && QS.get("ve") !== "1";
    if (!editing) {
      S.nav.open = false;
      drop.hidden = true;
      drop.innerHTML = "";
      return;
    }
    var dir = navActiveDir();
    if (S.nav.dir !== dir) { S.nav.dir = dir; S.nav.list = null; S.nav.err = ""; }
    S.nav.cur = navCurPage();
    var btn = $(".pagenav-btn");
    if (btn) {
      btn.setAttribute("aria-expanded", S.nav.open ? "true" : "false");
      btn.setAttribute("data-open", S.nav.open ? "1" : "0");
      btn.title = S.nav.open ? "收起页面列表" : "页面：展开全部页面";
    }
    if (!S.nav.open) { drop.hidden = true; return; }
    var known = Array.isArray(S.nav.list);
    var pages = known ? S.nav.list.filter(function (p) { return p && p.path; }) : [];
    var cur = S.nav.cur;
    var rows;
    if (!known && S.nav.loading) {
      rows = '<div class="pagenav-tip">读取页面中…</div>';
    } else if (!pages.length) {
      rows = '<div class="pagenav-tip">这个站点只有一页</div>';
    } else {
      rows = pages.map(function (p) {
        var on = navIsCur(p.path, cur);
        return '<button type="button" class="pagenav-item" data-act="nav-page" data-page="' + esc(p.path) + '" data-current="' + (on ? "1" : "0") + '" title="切到：' + esc(p.path) + '">' +
          '<span class="pagenav-dot"></span>' +
          '<span class="pagenav-name">' + esc(navPageLabel(p)) + "</span>" +
          '<span class="pagenav-path">' + esc(p.path) + "</span>" +
          "</button>";
      }).join("");
    }
    drop.innerHTML =
      '<div class="pagenav-head"><b>页面</b><span title="' + esc(dir) + '">' + esc(baseName(dir)) + "</span></div>" +
      rows +
      (S.nav.err ? '<div class="pagenav-tip err">' + esc(S.nav.err) + "</div>" : "");
    drop.hidden = false;
    positionDrop();
  }
  function positionDrop() {
    var drop = pagesDropEl();
    var btn = $(".pagenav-btn");
    if (!drop || !btn || drop.hidden) return;
    try {
      var r = btn.getBoundingClientRect();
      var w = Math.min(320, Math.max(220, window.innerWidth - 24));
      var left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
      var top = r.bottom + 8;
      if (top + 320 > window.innerHeight) top = Math.max(8, window.innerHeight - 320);
      drop.style.width = w + "px";
      drop.style.left = left + "px";
      drop.style.top = top + "px";
    } catch (e) { /* ignore */ }
  }
  function loadNavPages() {
    var dir = navActiveDir();
    if (!dir) { S.nav.list = []; S.nav.loading = false; renderNav(); return; }
    var token = String(dir);
    S.nav.loading = true;
    S.nav.err = "";
    renderNav();
    hostCall("pages.list", { dir: dir }).then(function (r) {
      if (navActiveDir() !== token) return;
      S.nav.loading = false;
      S.nav.dir = token;
      S.nav.list = (r && Array.isArray(r.pages)) ? r.pages : [];
      renderNav();
    }).catch(function (e) {
      if (navActiveDir() !== token) return;
      S.nav.loading = false;
      S.nav.err = String((e && e.message) || e);
      S.nav.list = [];
      renderNav();
    });
  }
  function toggleNav() {
    if (S.view !== "edit" || !S.proj) return;
    S.nav.open = !S.nav.open;
    if (!S.nav.open) { renderNav(); return; }
    renderNav();
    loadNavPages();
  }
  function pageUrl(base, page) {
    try {
      var u = new URL(String(base || ""), location.href);
      var p = String(page || "/");
      if (p.charAt(0) !== "/") p = "/" + p;
      return u.origin + p;
    } catch (e) { return String(base || ""); }
  }
  async function navGo(page) {
    var dir = navActiveDir();
    if (!dir || !page) return;
    S.nav.open = false;
    S.nav.cur = page;
    renderNav();
    if (S.view === "edit" && S.proj) {
      try {
        var r = await hostCall("project.open", { dir: dir, page: page, source: "workbench" });
        var nextUrl = (r && r.url) ? r.url : pageUrl(S.proj.url, page);
        S.proj = Object.assign({}, S.proj, r || {}, { url: nextUrl, page: page });
        writeLS("ve-wb:lastDir", dir);
        render();
      } catch (e) {
        S.msg = "切换页面失败：" + String((e && e.message) || e);
        render();
      }
      return;
    }
    await openPage(dir, page);
  }
  function bindEditorFrame() {
    var f = $("#editor-frame");
    if (!f) return;
    f.addEventListener("load", function () {
      try { f.contentWindow.postMessage({ __ve: "cmd", type: "dock-set", closed: true }, "*"); } catch (e) { /* ignore */ }
    }, { once: true });
  }
  async function openEditor(dir) {
    var fromList = (S.projects || []).filter(function (p) { return dir && p.dir === dir; })[0];
    var info = fromList && fromList.url ? fromList : null;
    if (!info) {
      var r = await openProject(dir);
      if (r && r.url) info = r;
    }
    if (info && info.url) {
      S.proj = info; S.view = "edit"; S.msg = "";
      S.nav.dir = String(info.dir || dir || "");
      S.nav.cur = String(info.page || "/");
      S.nav.list = null;
      S.nav.open = false;
      if (S.nav.dir) writeLS("ve-wb:lastDir", S.nav.dir);
      render();
      return;
    }
    S.msg = "打开编辑器失败：没拿到预览地址，请确认目录是前端项目";
    render();
  }
  /** 独立窗口（从 DSH 宿主带 dir 参数打开）：直接进项目编辑，不中转工作台首页 */
  async function openBootTarget() {
    var t = S.bootTarget;
    S.bootTarget = null;
    if (!t || !t.dir) return;
    try {
      var r = await hostCall("project.open", { dir: t.dir, page: t.page || "", source: "workbench" });
      if (!r || !r.url) throw new Error(String((r && r.error) || "没拿到预览地址"));
      S.proj = Object.assign({ dir: t.dir }, r);
      S.view = "edit";
      S.msg = "";
      S.nav.dir = String(r.dir || t.dir);
      S.nav.cur = String(r.page || t.page || "/");
      S.nav.list = null;
      S.nav.open = false;
      writeLS("ve-wb:lastDir", t.dir);
    } catch (e) {
      S.msg = "独立窗口打开项目失败：" + String((e && e.message) || e);
    }
    render();
  }
  async function closeProject(id) {
    try { await hostCall("project.close", { id: id }); } catch (e) { /* ignore */ }    await refreshProjects();
  }
  async function refreshStyles() {
    try {
      var r = await hostCall('styles.list');
      S.styles = (r && Array.isArray(r.styles)) ? r.styles : [];
    } catch (e) { /* ignore */ }
    render();
  }
  async function addStyle() {
    var st = S.style;
    var p = String(st.addPath || '').trim();
    if (!p) { st.msg = '先填规范目录（含 design-tokens.json 或 UI-SPEC.md）'; render(); return; }
    st.busy = true; st.msg = '正在导入风格…'; render();
    try {
      var r = await hostCall('styles.add', { path: p });
      st.busy = false;
      if (r && r.ok) {
        S.styles = r.styles || S.styles;
        st.addOpen = false; st.addPath = ''; st.msg = '已导入：' + (r.name || '') + '风格';
        writeLS('ve-wb:lastSpec', p);
      } else st.msg = '导入失败：' + String((r && r.error) || '未知错误');
    } catch (e) { st.busy = false; st.msg = '导入失败：' + String(e.message || e); }
    render();
  }
  async function removeStyle(id) {
    try {
      var r = await hostCall('styles.remove', { id: id });
      if (r && r.ok) S.styles = r.styles || [];
      S.style.msg = r && r.ok ? '已删除该风格' : '删除失败';
    } catch (e) { S.style.msg = '删除失败：' + String(e.message || e); }
    render();
  }
  function askConfirm(opts) {
    S.confirm = opts || null;
    render();
  }
  var wbToastTimer = 0;
  function wbToast(text, ms) {
    try {
      var el = document.getElementById('wb-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'wb-toast';
        document.body.appendChild(el);
      }
      el.textContent = String(text || '');
      el.classList.add('on');
      clearTimeout(wbToastTimer);
      wbToastTimer = setTimeout(function () { el.classList.remove('on'); }, Number(ms) || 2800);
    } catch (e) { /* ignore */ }
  }

  function styleCompareUrl(pending, dir) {
    try {
      var proj = (S.proj && S.proj.dir === dir) ? S.proj : ((S.projects || []).filter(function (p) { return p.dir === dir; })[0] || {});
      var base = proj.url || '';
      if (!base) return '';
      var u = new URL(base, location.href);
      u.pathname = u.pathname.replace(/[^/]*$/, 'style-compare.html');
      u.search = pending ? '?pending=1' : '';
      u.hash = '';
      return u.toString();
    } catch (e) { return ''; }
  }

  async function doApplyStyle(id, name, dir, opts) {
    opts = opts || {};
    var st = S.style;
    st.msg = '正在生成风格规范并发送给 Agent…'; render(); try { wbToast('正在应用「' + (name || '') + '」风格…', 2300); } catch (e) {}
    try {
      var r = await hostCall('styles.apply', { id: id, dir: dir });
      if (!r || !r.ok) { st.msg = '失败：' + String((r && r.error) || '未知错误'); render(); return; }
      if (opts.openCompare) {
        var cu = styleCompareUrl(true, dir);
        if (cu) { try { window.open(cu, '_blank'); } catch (e) { /* ignore */ } }
      }
      var sent = await hostCall('agent.prompt', { text: r.text });
      var ok = Boolean(sent && (sent.ok || sent.via));
      try { wbToast(ok ? '已发送风格，Agent 开始改页面' : '风格发送失败', 3000); } catch (e) {}
      st.msg = ok ? (opts.openCompare ? '已应用「' + (name || '') + '」风格，对比页已打开，等待新风格生成' : '已把「' + (name || '') + '」风格发给 Agent，切回对话继续') : '发送失败：' + String((sent && (sent.reason || sent.error)) || '未知');
      writeLS('ve-wb:lastStyle', id);
      st.selectedId = id;
    } catch (e) { st.msg = '失败：' + String(e.message || e); }
    render();
  }

  function applyStyle(id, name, opts) {
    opts = opts || {};
    var st = S.style;
    var dir = st.target || (S.projects[0] && S.projects[0].dir) || '';
    if (!dir) { st.msg = '先打开一个项目'; render(); return; }
    st.selectedId = id;
    askConfirm({
      title: '应用风格到项目',
      rows: [
        ['风格', String(name || '')],
        ['项目', dir],
      ],
      note: '应用前会自动备份当前版本。可以选择只应用，或应用后立刻打开原版/新版对比。',
      okText: '应用到该项目',
      compareText: '应用并打开风格对比',
      cancelText: '取消',
      onOk: function () { S.confirm = null; doApplyStyle(id, name, dir, {}); },
      onCompare: function () { S.confirm = null; doApplyStyle(id, name, dir, { openCompare: true }); },
    });
  }
  function editorSend(type, payload) {
    var f = $("#editor-frame");
    try {
      if (f && f.contentWindow) f.contentWindow.postMessage(Object.assign({ __ve: "cmd", type: type }, payload || {}), "*");
    } catch (e) { /* ignore */ }
  }
  function closeWorkbench() {
    if (S.mode === "embedded") {
      // 交给宿主把主面板切回「对话」；失败时在页面里给出提示，而不是静默无反应
      callHost("workbench.close").then(function (r) {
        if (r && r.ok === false) {
          S.msg = "没能返回对话：" + (r.error || "请在左侧栏点「对话」");
          render();
        }
      }).catch(function (e) {
        S.msg = "没能返回对话：" + String((e && e.message) || e);
        render();
      });
      return;
    }
    S.view = "home"; render();
  }

  /* ── 渲染 ── */
  function featIco(d) {
    return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"></path></svg>';
  }
  function topBar() {
    var themeBtns =
      '<button class="btn ghost" data-act="theme-toggle" title="切换亮色 / 暗色">' +
      (S.theme === "ink" ? "☀ 亮色" : "☾ 暗色") +
      "</button>";
    // 固化/更新后用它重载工作台（iframe 不会自己刷新）
    var reloadBtn = '<button class="btn ghost" data-act="reload-workbench" title="重新加载工作台（固化后看不到变化时点它）">⟳ 刷新</button>';
    var right =
      S.mode === "embedded"
        ? reloadBtn + themeBtns +
          '<button class="btn" data-act="popup" title="在独立窗口打开工作台（可放第二个显示器）">↗ 独立窗口</button>' +
          '<button class="btn" data-act="close-wb" title="关闭工作台，回到对话（Esc）">← 返回对话</button>'
        : reloadBtn + themeBtns;
    var pathText = (S.info && S.info.dir) || (S.proj && S.proj.dir) || "独立模式";
    return (
      '<div class="top">' +
      '<span class="logo"><i></i>网页工作台</span>' +
      '<span class="path" title="' + esc(pathText) + '">' + esc(pathText) + "</span>" +
      '<span class="spacer"></span>' +
      right +
      "</div>"
    );
  }
  function standaloneBar() {
    // 从 DSH 宿主带 api 参数打开（独立窗口直接编辑当前项目）时不显示连接条，
    // 这样和右侧栏里的工作台布局一致
    if (S.mode === "embedded" || S.fromHost) return "";
    return (
      '<div class="standalone-bar">' +
      "<span>独立模式：填插件接口地址（DSH 运行时的 http://127.0.0.1:端口）</span>" +
      '<input class="api" data-field="apiBase" placeholder="http://127.0.0.1:19390" value="' + esc(S.apiBase) + '">' +
      '<input class="token" data-field="token" placeholder="token（可留空）" value="' + esc(S.token) + '">' +
      '<button class="btn" data-act="save-api">连接</button>' +
      '<button class="btn ghost" data-act="refresh">刷新项目</button>' +
      "</div>"
    );
  }
  // 每个风格可能有自己的 @font-face（data URI 内嵌），按需注入
  var loadedFontStyles = {};
  function ensureStyleFont(s, base) {
    try {
      if (!s || !s.id || loadedFontStyles[s.id]) return;
      if (!base) return;
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = base + "/ve/plugin/styles/font.css?id=" + encodeURIComponent(s.id);
      link.setAttribute("data-ve-style-font", s.id);
      document.head.appendChild(link);
      loadedFontStyles[s.id] = true;
    } catch (e) { /* ignore */ }
  }
  function ensureAllStyleFonts(styles, base) {
    (styles || []).forEach(function (s) { ensureStyleFont(s, base); });
  }

  function confirmModal() {
    var c = S.confirm || {};
    var rows = (c.rows || []).map(function (r) {
      return '<div class="cd-row"><span>' + esc(r[0]) + '</span><b title="' + esc(r[1]) + '">' + esc(r[1]) + '</b></div>';
    }).join('');
    return (
      '<div class="cd-mask" data-act="cd-cancel"></div>' +
      '<div class="cd-panel" role="dialog" aria-modal="true">' +
      '<div class="cd-kicker">' + esc(c.kicker || 'UI STYLE') + '</div>' +
      '<h2 class="cd-title">' + esc(c.title || '确认') + '</h2>' +
      rows +
      (c.note ? '<p class="cd-note">' + esc(c.note) + '</p>' : '') +
      '<div class="cd-actions">' +
      '<button class="btn ghost" data-act="cd-cancel">' + esc(c.cancelText || '取消') + '</button>' +
      (c.compareText ? '<button class="btn ghost" data-act="cd-compare">' + esc(c.compareText) + '</button>' : '') +
      '<button class="btn pri" data-act="cd-ok">' + esc(c.okText || '确定') + '</button>' +
      '</div>' +
      '</div>'
    );
  }

  /* ── AI 调整（工作台内直接唤起，不再需要回 DSH 侧边栏） ── */
  function aiModal() {
    var a = S.ai;
    var sel = Array.isArray(a.sel) ? a.sel : [];
    var selText = sel.length
      ? "已框选 " + sel.length + " 个元素：" + sel.slice(0, 4).map(function (x) { return (x.tag || "") + " " + String(x.text || "").slice(0, 18); }).join("；")
      : "还没框选（可点「框选元素」在页面上拖一个框，AI 会优先改这些元素）";
    return (
      '<div class="cd-mask" data-act="ai-close"></div>' +
      '<div class="cd-panel ai-panel" role="dialog" aria-modal="true">' +
      '<div class="cd-kicker">AI EDIT</div>' +
      '<h2 class="cd-title">AI 调整</h2>' +
      '<p class="cd-note">会用当前项目 / 页面（以及框选的元素）作为上下文，发给 DSH 对话里的 Agent 修改；改完会自动应用并保存。</p>' +
      '<textarea class="ai-textarea" data-field="aiText" rows="4" placeholder="想让 AI 怎么改？例如：把首屏标题字号加大、字重加粗，副标题改成两行">' + esc(a.text) + '</textarea>' +
      '<div class="ai-selrow">' +
      '<button class="btn ghost" data-act="ai-marquee" type="button">▣ 框选元素</button>' +
      '<span class="ai-selinfo" title="' + esc(selText) + '">' + esc(selText) + '</span>' +
      "</div>" +
      (a.msg ? '<div class="ai-msg">' + esc(a.msg) + "</div>" : "") +
      '<div class="cd-actions">' +
      '<button class="btn ghost" data-act="ai-close" type="button">取消</button>' +
      '<button class="btn pri" data-act="ai-send" type="button"' + (a.busy ? " disabled" : "") + ">" + (a.busy ? "发送中…" : "发送给 AI") + "</button>" +
      "</div>" +
      "</div>"
    );
  }

  async function sendAiPrompt() {
    var a = S.ai;
    var text = String(a.text || "").trim();
    if (!text) { a.msg = "先写一句想让 AI 怎么改"; render(); return; }
    var dir = (S.proj && S.proj.dir) || navActiveDir() || "";
    var page = (S.proj && S.proj.page) || "";
    var sel = Array.isArray(a.sel) ? a.sel : [];
    var lines = [];
    lines.push("请帮我改一下「" + (dir || "当前项目") + "」这个网页：");
    lines.push(text);
    lines.push("");
    lines.push("—— 来自网页工作台 ——");
    lines.push("当前页面：" + (page || "/"));
    if (sel.length) {
      lines.push("我框选了 " + sel.length + " 个元素：" + sel.slice(0, 5).map(function (x) {
        return (x.tag || "") + " " + String(x.text || x.key || "").slice(0, 24);
      }).filter(Boolean).join("；"));
    } else {
      lines.push("（没有框选，按整页/项目处理）");
    }
    a.busy = true; a.msg = "正在发送给对话里的 AI…";
    render();
    try {
      var sent = await hostCall("agent.prompt", { text: lines.join("\n") });
      if (sent && sent.ok === false) throw new Error(String(sent.reason || sent.error || "发送失败"));
      a.busy = false; a.open = false; a.text = ""; a.sel = null; a.msg = "";
      S.msg = "已把调整要求发给对话里的 AI（Agent 会在对话里继续改，改完回来自动生效）";
    } catch (e) {
      a.busy = false;
      a.msg = "发送失败：" + String((e && e.message) || e);
    }
    render();
  }

  function styleCoverHtml(s) {
    var bg = s.bgColor || (s.colors && s.colors[0]) || '#f5f5f5';
    var title = s.titleColor || '#1f2937';
    // 大标题字体：直接用该风格 UI 规范里的完整 display 字体栈（固定不猜）
    var family = s.fontStack || (s.font ? '"' + s.font + '", var(--sans)' : 'var(--sans)');
    var srcText = s.source ? '提取自 ' + baseName(s.source) : '';
    var desc = s.description || srcText;
    var smallFamily = s.smallFontStack || (s.smallFont ? '"' + s.smallFont + '", var(--sans)' : 'var(--sans)');
    // 卡内这一行：用一句话概述风格本身（不是来源）
    var summary = String(desc || '').replace(/\s+/g, ' ').trim();
    if (summary.length > 34) summary = summary.slice(0, 32).trim() + '…';
    var srcLine = s.source ? '提取自 ' + baseName(s.source) : '';
    // 次色调网点：用风格第 2/3 个颜色，缺省回退到标题色
    var accents = (s.colors || []).filter(function (c) { return /^#|rgb/i.test(String(c)); });
    var dotA = accents[1] || accents[0] || title;
    var dotB = accents[2] || accents[0] || title;
    var dots = '--dot-a:' + dotA + ';--dot-b:' + dotB + ';';
    var effect = s.titleEffect === 'stroke' ? ' stroke' : '';
    var strokeC = s.strokeColor || title;
    // 磨砂玻璃风格：背景交给 CSS 的渐变+磨砂层处理
    var glass = s.cardStyle === 'glass';
    var bgStyle = glass ? '' : 'background:' + esc(bg) + ';';
    return (
      '<div class="stylecard-cover' + '" style="' + bgStyle + 'color:' + esc(title) + ';' + esc(dots) + ';--stroke-c:' + esc(strokeC) + '">' +
      (function () {
        var lines = esc(s.name).split('\n').map(function (line, idx) {
          return '<span class="vc-line' + (idx > 0 ? ' vc-line-sm' : '') + '">' + esc(line) + '</span>';
        }).join('');
        var echo = effect ? '<span class="vc-echo" aria-hidden="true">' + lines + '</span>' : '';
        return '<span class="stylecard-name' + effect + '" style="font-family:' + esc(family) + '">' + lines + echo + '</span>';
      })() +
      (summary ? '<span class="stylecard-subline" style="font-family:' + esc(smallFamily) + '" title="' + esc(desc) + '">' + esc(summary) + '</span>' : '') +
      '<button class="stylecard-x" data-act="style-remove" data-id="' + esc(s.id) + '" title="删除这个风格">✕</button>' +
      '</div>' +
      '<div class="stylecard-cap"><b>' + esc(s.name) + '</b>' + (srcLine ? '<span title="' + esc(srcLine) + '">' + esc(srcLine) + '</span>' : '') + '</div>'
    );
  }

  function stylePreviewHtml(s) {
    var bg = s.bgColor || (s.colors && s.colors[0]) || '#ffffff';
    var ink = s.titleColor || '#111111';
    var family = s.fontStack || 'var(--sans)';
    var accents = (s.colors || []).filter(function (c) { return /^#|rgb/i.test(String(c)); });
    var accent = ink;
    for (var i = 0; i < accents.length; i++) {
      var c = String(accents[i]).toLowerCase();
      if (c !== String(bg).toLowerCase() && c !== String(ink).toLowerCase()) { accent = accents[i]; break; }
    }
    return '<div class="srp" style="background:' + esc(bg) + ';color:' + esc(ink) + ';font-family:' + esc(family) + ';--srp-accent:' + esc(accent) + '">' +
      '<div class="srp-bar"><i></i><span></span><span></span><span></span><b></b></div>' +
      '<div class="srp-body">' +
        '<div class="srp-copy"><small>THE FIELD / SYSTEM</small>' +
          '<strong>让内容<br>更有秩序</strong>' +
          '<p>留白、比例与克制的强调，组成安静的阅读节奏。</p>' +
          '<span class="srp-btn">阅读更多</span>' +
        '</div>' +
        '<div class="srp-stack"><div class="srp-card a"></div><div class="srp-card b"></div><div class="srp-card c"></div></div>' +
      '</div>' +
    '</div>';
  }

  function styleSection() {
    var st = S.style || {};
    var styles = S.styles || [];
    var target = st.target || (S.projects[0] && S.projects[0].dir) || '';
    var apiRoot = String(S.apiBase || '').replace(/\/+$/, '');
    var apiBase = (apiRoot && !/\/ve\/plugin$/.test(apiRoot)) ? apiRoot + '/ve/plugin' : (apiRoot || '/ve/plugin');
    var rows = styles.map(function (s, idx) {
      var nameLines = String(s.name || '').split('\n');
      var main = nameLines[0] || '';
      var sub = nameLines.slice(1).join(' ').trim();
      var tags = s.titleEffect === 'stroke'
        ? ['描边', '编辑']
        : (s.cardStyle === 'glass' ? ['玻璃', '层次'] : ['纯色', '干净']);
      var desc = String(s.description || '').replace(/\s+/g, ' ').trim();
      if (desc.length > 90) desc = desc.slice(0, 88).trim() + '…';
      // 暗色风格的胶囊别跟着变暗：画布色只取一点点做底色，文字仍用主题墨色；
      // 风格的主色太亮（如白色系）时，标签底色退回深墨，避免白字白底看不见。
      var hexLum = function (hex) {
        var m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        var n = parseInt(m[1], 16);
        return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      };
      var canvasHex = String(s.bgColor || '').trim();
      var canvasLum = hexLum(canvasHex);
      var darkCanvas = canvasLum != null && canvasLum < 0.42;
      // 彩色画布（比如复古像素的青绿桌面）不染色，直接用普通底色，跟「极简白点」一样
      var hexChroma = function (hex) {
        var m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return 0;
        var n = parseInt(m[1], 16);
        var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      };
      var coloredCanvas = hexChroma(canvasHex) > 0.22;
      var inkLum = hexLum(s.titleColor);
      var rowCanvas = coloredCanvas ? 'var(--paper-raised)' : (darkCanvas ? 'color-mix(in srgb,' + canvasHex + ' 15%,#fff)' : (s.bgColor || 'var(--paper-raised)'));
      var rowInk = darkCanvas ? 'var(--ink)' : (s.titleColor || 'var(--ink)');
      var rowAccent = (inkLum != null && inkLum > 0.66) ? '#373435' : (s.titleColor || 'var(--ink)');
      var rowVars = '--sr-title-font:' + esc(s.fontStack || 'var(--font-display)') + ';--sr-body-font:' + esc(s.smallFontStack || 'var(--font-sans)') + ';--sr-ink:' + esc(rowInk) + ';--sr-accent:' + esc(rowAccent) + ';--sr-canvas:' + esc(rowCanvas) + ';';
      return (
        '<div class="style-row' + (st.selectedId === s.id ? ' is-selected' : '') + '" style="' + rowVars + '" data-act="style-apply" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '" title="点击应用这个风格">' +
          '<div class="style-row-copy">' +
            '<div class="style-row-kicker">STYLE / 0' + (idx + 1) + '</div>' +
            '<h3 class="style-row-name"><b>' + esc(main) + '</b>' + (sub ? '<em>' + esc(sub) + '</em>' : '') + '</h3>' +
            '<div class="style-row-tags">' + tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' +
            (desc ? '<p class="style-row-desc">' + esc(desc) + '</p>' : '') +
          '</div>' +
          '<div class="style-row-visual"><div class="style-row-image" data-style-image="' + esc(s.id) + '">' + (s.preview ? '<img src="' + esc(apiBase + '/styles/file?id=' + encodeURIComponent(s.id) + '&name=' + encodeURIComponent(s.preview)) + '" alt="">' : '') + '</div></div>' +
        '</div>'
      );
    }).join('');
    var addRow =
      '<button class="style-row-add" data-act="style-add-open" title="添加风格：填规范目录（含 design-tokens.json / UI-SPEC.md）">' +
        '<span class="style-row-plus">＋</span>' +
        '<span class="style-row-addcopy"><b>添加风格</b><small>导入 UI-SPEC.md / design-tokens.json</small></span>' +
      '</button>';
    return (
      '<div class="stylelib">' +
        '<div class="stylelib-head"><h2 class="stylelib-title">风格优化</h2>' +
          '<span class="stylelib-sub">选一个风格，Agent 会按它把当前项目改成同样的视觉语言</span></div>' +
        '<div class="stylelib-target"><span>目标项目</span>' +
          (S.projects.length
            ? '<select data-field="styleTarget">' + S.projects.map(function (p) { return '<option value="' + esc(p.dir) + '"' + (target === p.dir ? ' selected' : '') + '>' + esc(baseName(p.dir)) + ' — ' + esc(p.dir) + '</option>'; }).join('') + '</select>'
            : '<span class="hint">先打开一个项目</span>') +
          (styles.length ? '' : '<span class="hint">还没有风格：点「＋ 添加风格」导入一份</span>') +
        '</div>' +
        (st.addOpen
          ? '<div class="stylelib-addrow">' +
            '<input data-field="styleAddPath" placeholder="规范目录，例如 D:\\styles\\my-style" value="' + esc(st.addPath || '') + '">' +
            '<button class="btn pri" data-act="style-add-confirm"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? '导入中…' : '导入') + '</button>' +
            '<button class="btn ghost" data-act="style-add-cancel">取消</button>' +
            '</div>'
          : '') +
        '<div class="style-rows">' + rows + addRow + '</div>' +
        (st.msg ? '<div class="note' + (/失败|错误/.test(st.msg) ? ' err' : '') + '">' + esc(st.msg) + '</div>' : '') +
      '</div>'
    );
  }

  function pagesModal() {
    var pm = S.pagesModal || {};
    var base = String(S.apiBase || '').replace(/\/+$/, '');
    var dir = pm.dir || '';
    var list = pm.list;
    var rows = '';
    if (list === null || list === undefined) {
      rows = '<div class="note">读取页面中…</div>';
    } else if (!list.length) {
      rows = '<div class="note">这个项目没有可识别的 HTML 页面（Vite/SPA 暂不支持页面列表）</div>';
    } else {
      rows = '<div class="pg-grid">' + list.map(function (p) {
        var shot = base + '/ve/plugin/page-shot?dir=' + encodeURIComponent(dir) + '&page=' + encodeURIComponent(p.path) + '&v=0';
        var name = p.title || p.path;
        return '<button class="pg-item" data-act="open-page" data-dir="' + esc(dir) + '" data-page="' + esc(p.path) + '" title="在编辑器打开：' + esc(p.path) + '">' +
          '<span class="pg-thumb" style="background-image:url(\'' + esc(shot) + '\')">' + (p.entry ? '首页' : '') + '</span>' +
          '<span class="pg-name">' + esc(name) + '</span>' +
          '<span class="pg-path">' + esc(p.path) + '</span>' +
          '</button>';
      }).join('') + '</div>';
    }
    return (
      '<div class="pg-mask" data-act="pages-close"></div>' +
      '<div class="pg-panel" role="dialog">' +
      '<div class="pg-head"><h2>页面</h2><span class="pg-sub">' + esc(baseName(dir)) + ' · ' + esc(dir) + '</span>' +
      '<button class="pg-close" data-act="pages-close" title="关闭（Esc）">✕</button></div>' +
      rows + '</div>'
    );
  }

  function genNav(dir) {
    if (!dir) return;
    var pm = S.pagesModal || {};
    pm.msg = "正在生成导航条…";
    S.pagesModal = pm;
    render();
    hostCall("pages.nav", { dir: dir }).then(function (r) {
      S.pagesModal.msg = r && r.ok ? ("已写入 " + (r.count || 0) + " 个页面：到编辑器/浏览器刷新预览，页面顶部会出现折叠胶囊（点 ▶ 展开）；如果还看到旧的长条浮动导航，在编辑器页面面板点「🧹 清理旧版导航」") : ("生成失败：" + ((r && r.error) || "未知"));
      render();
    }).catch(function (e) {
      S.pagesModal.msg = "生成失败：" + String((e && e.message) || e);
      render();
    });
  }

  function openPages(dir) {
    S.pagesModal = { open: true, dir: dir || "", list: null, loading: true };
    render();
    hostCall("pages.list", { dir: dir || "" }).then(function (r) {
      S.pagesModal.list = (r && Array.isArray(r.pages)) ? r.pages : [];
      S.pagesModal.loading = false;
      render();
    }).catch(function () {
      S.pagesModal.list = [];
      S.pagesModal.loading = false;
      render();
    });
  }

  async function openPage(dir, page) {
    S.pagesModal = { open: false, dir: "", list: null, loading: false };
    try { await hostCall("project.open", { dir: dir, page: page, source: "workbench" }); } catch (e) { /* ignore */ }
    await refreshProjects();
    openEditor(dir);
  }

  function styleModal() {
    var st = S.style;
    var styles = S.styles || [];
    var base = String(S.apiBase || '').replace(/\/+$/, '');
    var target = st.target || (S.projects[0] && S.projects[0].dir) || '';
    var selected = st.selectedId || (styles[0] && styles[0].id) || '';
    var cards = styles.map(function (s) {
      return (
        '<div class="sm-card' + (selected === s.id ? ' on' : '') + '" data-act="style-apply" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '" title="点击直接应用这个风格">' +
        styleCoverHtml(s).replace(/stylecard-cover/g, 'sm-cover').replace(/stylecard-name/g, 'sm-name').replace(/stylecard-subline/g, 'sm-subline').replace(/stylecard-x/g, 'sm-x') +
        '</div>'
      );
    }).join('');
    var addCard = '<div class="sm-card sm-add" data-act="style-add-open" title="添加风格"><div class="sm-cover"><div class="sm-plus">＋</div><div class="sm-addtext">添加风格</div></div></div>';
    var options = styles.map(function (s) { return '<option value="' + esc(s.id) + '"' + (selected === s.id ? ' selected' : '') + '>' + esc(s.name) + (s.source ? '（' + esc(baseName(s.source)) + '）' : '') + '</option>'; }).join('');
    return (
      '<div class="sm-mask" data-act="style-modal-close"></div>' +
      '<div class="sm-panel" role="dialog">' +
      '<div class="sm-head"><h2>风格优化</h2><span class="sm-sub">选一个风格，Agent 会按它把当前项目改成同样的视觉语言</span>' +
      '<button class="sm-close" data-act="style-modal-close" title="关闭（Esc）">✕</button></div>' +
      '<div class="sm-target"><span>目标项目</span>' +
      (S.projects.length
        ? '<select data-field="styleTarget">' + S.projects.map(function (p) { return '<option value="' + esc(p.dir) + '"' + (target === p.dir ? ' selected' : '') + '>' + esc(baseName(p.dir)) + ' — ' + esc(p.dir) + '</option>'; }).join('') + '</select>'
        : '<span class="hint">先打开一个项目</span>') +
      '</div>' +
      '<div class="sm-grid">' + cards + addCard + '</div>' +
      (styles.length
        ? '<div class="sm-actions"><span>记不住名字？直接选：</span>' +
          '<select data-field="styleSelect">' + options + '</select>' +
          '<button class="btn pri" data-act="style-apply-btn">应用这个风格</button>' +

          '</div>'
        : '<div class="note">还没有风格：点「＋ 添加风格」导入一份（目录里要有 design-tokens.json 或 UI-SPEC.md）</div>') +
      (st.addOpen
        ? '<div class="sm-addrow">' +
          '<input data-field="styleAddPath" placeholder="规范目录，例如 D:\\styles\\my-style" value="' + esc(st.addPath || '') + '">' +
          '<button class="btn pri" data-act="style-add-confirm"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? '导入中…' : '导入') + '</button>' +
          '<button class="btn ghost" data-act="style-add-cancel">取消</button>' +
          '</div>'
        : '') +
      (st.msg ? '<div class="note' + (/失败|错误/.test(st.msg) ? ' err' : '') + '">' + esc(st.msg) + '</div>' : '') +
      '</div>'
    );
  }
  function homeView() {
    var projects = S.projects || [];
    var totalPages = Math.max(1, Math.ceil(projects.length / PAGE));
    var cur = Math.min(S.page, totalPages - 1);
    var shown = projects.slice(cur * PAGE, cur * PAGE + PAGE);
    var thumbs = "";
    if (projects.length === 0) {
      thumbs =
        '<div class="empty"><b>还没有项目</b><span>点上面的「打开项目」选一个前端项目目录</span></div>';
    } else {
      thumbs =
        '<div class="thumbs">' +
        shown.map(function (p) {
          var frame = p.url
            ? '<iframe class="thumb-frame" src="' + esc(p.url) + '" loading="lazy" scrolling="no" title="' + esc(p.dir) + '"></iframe>'
            : '<div class="thumb-ph">' + esc(baseName(p.dir)) + "</div>";
          return (
            '<div class="thumb" data-act="open-editor" data-dir="' + esc(p.dir) + '" title="点击进入编辑：' + esc(p.dir) + '">' +
            '<div class="thumb-box">' + frame + '<div class="thumb-mask"></div>' +
            '<button class="thumb-pages" data-act="open-pages" data-dir="' + esc(p.dir) + '" title="查看这个项目的页面列表（缩略图 + 直接打开某一页）">▤ 页面</button>' +
            '<button class="thumb-x" data-act="close-project" data-id="' + esc(p.id) + '" title="从列表中移除（不删文件）">✕</button>' +
            "</div>" +
            '<div class="thumb-cap">' + esc(baseName(p.dir)) + "</div>" +
            "</div>"
          );
        }).join("") +
        "</div>";
    }
    var pager =
      projects.length > PAGE
        ? '<div class="pager">' +
          '<button class="pager-btn" data-act="page-prev"' + (cur === 0 ? " disabled" : "") + ">‹</button>" +
          "<span>" + (cur + 1) + " / " + totalPages + "</span>" +
          '<button class="pager-btn" data-act="page-next"' + (cur >= totalPages - 1 ? " disabled" : "") + ">›</button>" +
          "</div>"
        : "";
    return (
      '<div class="home">' +
      '<h1 class="h1"><span class="h1-main">开始编辑你的页面</span><span class="h1-echo" aria-hidden="true">开始编辑你的页面</span></h1>' +
      '<p class="sub">基于 Vite 的静态站点可视化编辑器</p>' +
      '<div class="cta-wrap">' +
      '<button class="cta" data-act="toggle-pick"><span class="cta-ico">📂</span>打开项目</button>' +
      (S.showPick ? pickPanel() : "") +
      "</div>" +
      '<div class="feats">' +
      '<div class="feat"><span class="feat-ico">' + featIco("M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11") + "</span><b>改动可撤销</b><i>轻松回退</i></div>" +
      '<div class="feat"><span class="feat-ico">' + featIco("M21 12a9 9 0 1 1-3-6.7M21 3v6h-6") + "</span><b>自动备份</b><i>每处改动都安全保存</i></div>" +
      '<div class="feat"><span class="feat-ico">' + featIco("M4 4l7 16 2.5-6.5L20 11 4 4z") + "</span><b>可视化编辑</b><i>所见即所得</i></div>" +
      "</div>" +
      thumbs +
      pager +
      styleSection() +

      (S.msg ? '<div class="note' + (/失败|错误/.test(S.msg) ? " err" : "") + '">' + esc(S.msg) + "</div>" : "") +
      "</div>"
    );
  }
  function editView() {
    var proj = S.proj || {};
    var base = String(proj.url || "");
    // ve_nav=0：工作台工具栏里已有「页面」按钮，预览里就不再显示内核那枚胶囊，避免重影
    var src = base + (base.indexOf("?") >= 0 ? "&" : "?") + "ve=1&ve_embed=1&ve_nav=0";
    return (
      '<div class="top">' +
      '<button class="btn ghost" data-act="back-home" title="回到工作台（Esc）">← 工作台</button>' +
      '<span class="logo"><i></i>' + esc(baseName(proj.dir)) + "</span>" +
      '<button class="btn ghost pagenav-btn" data-act="nav-toggle" data-open="' + (S.nav.open ? "1" : "0") + '" aria-haspopup="menu" aria-expanded="' + (S.nav.open ? "true" : "false") + '" title="页面：展开 / 收起全部页面">' + hamburgerIco() + "</button>" +
      '<span class="path" title="' + esc(proj.dir) + '">' + esc(proj.dir) + "</span>" +
      '<span class="spacer"></span>' +
      '<button class="btn" data-act="ai-open" title="AI 调整：把要求发给 DSH 对话里的 Agent（会带上当前项目/页面和框选）">✦ AI 调整</button>' +
      (S.mode === "embedded" ? '<button class="btn ghost" data-act="popup" title="在独立窗口打开当前项目（可放第二个显示器）">↗ 独立窗口</button>' : "") +
      '<button class="btn ghost" data-act="align" data-kind="align-left" title="左对齐（选中元素）">⇤</button>' +
      '<button class="btn ghost" data-act="align" data-kind="align-centerX" title="水平居中（选中元素）">↔</button>' +
      '<button class="btn ghost" data-act="align" data-kind="align-right" title="右对齐（选中元素）">⇥</button>' +
      '<button class="btn" data-act="save" title="保存（写回源码）">保存</button>' +
      '<button class="btn" data-act="undo" title="撤销 Ctrl+Z">↶</button>' +
      '<button class="btn" data-act="redo" title="重做 Ctrl+Shift+Z">↷</button>' +
      '<button class="btn ghost" data-act="reload" title="刷新预览">⟳</button>' +
      '<button class="btn" data-act="close-wb" style="background:#3b1116;border-color:#7f1d1d;color:#fecaca;font-weight:600" title="关闭工作台（Esc）">✕ 关闭</button>' +
      "</div>" +
      '<div class="editor"><iframe id="editor-frame" src="' + esc(src) + '" title="工作台编辑预览" allow="fullscreen"></iframe></div>' +
      (S.ai.open ? aiModal() : "")
    );
  }
  function render() {
    if (!app) return;
    try {
      var base0 = String(S.apiBase || '').replace(/\/+$/, '');
      ensureAllStyleFonts(S.styles, base0);
    } catch (e) { /* ignore */ }
    app.innerHTML = topBar() + standaloneBar() + (S.view === "edit" ? editView() : homeView()) + (S.pagesModal && S.pagesModal.open ? pagesModal() : "") + (S.confirm ? confirmModal() : "") + (S.ai.marquee ? '<div class="ai-hint">▣ 在页面上拖一个框选区域（Esc 取消）</div>' : "");
    renderNav();
    try { bindEditorFrame(); } catch (e) { /* ignore */ }
  }

  /* ── 事件 ── */
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!t) {
      // 点空白处收起页面下拉（点下拉内部不算）
      var inDrop = e.target && e.target.closest && e.target.closest("#ve-pages");
      if (!inDrop && S.nav && S.nav.open) { S.nav.open = false; renderNav(); }
      return;
    }
    var act = t.getAttribute("data-act");
    if (act === "theme-toggle") { setTheme(S.theme === "ink" ? "paper" : "ink", true); return; }
    if (act === "popup") {
      if (S.mode === "embedded") {
        // 带上当前项目/页面：独立窗口直接进项目编辑，不中转工作台首页
        callHost("workbench.popup", {
          dir: (S.proj && S.proj.dir) || "",
          page: (S.proj && S.proj.page) || "",
        }).catch(function () { /* ignore */ });
      } else {
        window.open(location.href, "_blank", "width=1440,height=920");
      }
      return;
    }
    if (act === "ai-open") { S.ai.open = true; S.ai.marquee = false; S.ai.msg = ""; S.ai.busy = false; render(); var ta = $('[data-field="aiText"]'); if (ta) { ta.focus(); } return; }
    if (act === "ai-close") { S.ai.open = false; S.ai.marquee = false; S.ai.busy = false; render(); return; }
    // 框选时先收起弹窗（弹窗遮罩会挡住 iframe 的拖拽），框选完再自动弹回来
    if (act === "ai-marquee") { S.ai.open = false; S.ai.marquee = true; S.ai.msg = ""; render(); editorSend("enter-marquee"); return; }
    if (act === "ai-send") { sendAiPrompt(); return; }
    if (act === "close-wb") { closeWorkbench(); return; }
    if (act === "nav-toggle") { e.preventDefault(); toggleNav(); return; }
    if (act === "nav-page") { e.preventDefault(); e.stopPropagation(); navGo(t.getAttribute("data-page")); return; }
    if (act === "back-home") { S.view = "home"; if (S.mode === "embedded") refreshProjects(); else render(); return; }
    if (act === "toggle-pick") {
      S.showPick = !S.showPick;
      if (S.showPick && !S.pick.data) loadPick(S.path || "");
      else render();
      return;
    }
    if (act === "pick-up") { loadPick((S.pick.data && S.pick.data.parent) || ""); return; }
    if (act === "pick-enter") { loadPick(t.getAttribute("data-dir") || ""); return; }
    if (act === "pick-open") { openFromPick(); return; }
    if (act === "open") { openProject(); return; }
    if (act === "open-editor") { openEditor(t.getAttribute("data-dir")); return; }
    if (act === "open-pages") { e.stopPropagation(); openPages(t.getAttribute("data-dir")); return; }
    if (act === "pages-close") { S.pagesModal = { open: false, dir: "", list: null, loading: false }; render(); return; }
    if (act === "open-page") { e.stopPropagation(); openPage(t.getAttribute("data-dir"), t.getAttribute("data-page")); return; }
    if (act === "gen-nav") { e.stopPropagation(); genNav(t.getAttribute("data-dir")); return; }
    if (act === "close-project") { e.stopPropagation(); closeProject(t.getAttribute("data-id")); return; }
    if (act === "page-prev") { S.page = Math.max(0, S.page - 1); render(); return; }
    if (act === "page-next") { S.page = S.page + 1; render(); return; }
    if (act === "align") { editorSend("align", { kind: t.getAttribute("data-kind") }); return; }
    if (act === "save") { editorSend("save"); return; }
    if (act === "undo") { editorSend("undo"); return; }
    if (act === "redo") { editorSend("redo"); return; }
    if (act === "reload") { var f = $("#editor-frame"); try { f.contentWindow.location.reload(); } catch (err) { /* ignore */ } return; }
    if (act === "style-open") { S.style.open = true; S.style.addOpen = false; render(); return; }
    if (act === "style-modal-close") { S.style.open = false; render(); return; }
    if (act === "style-apply-btn") { var sel = $('[data-field="styleSelect"]'); if (sel) { var opt = sel.options[sel.selectedIndex]; applyStyle(sel.value, opt ? opt.text : ''); } return; }
    if (act === "style-apply-open") { var sel2 = $('[data-field="styleSelect"]'); if (sel2) { var opt2 = sel2.options[sel2.selectedIndex]; applyStyle(sel2.value, opt2 ? opt2.text : '', { openCompare: true }); } return; }
    if (act === "cd-cancel") { S.confirm = null; render(); return; }
    if (act === "cd-ok") { var cb = S.confirm && S.confirm.onOk; S.confirm = null; render(); if (typeof cb === "function") cb(); return; }
    if (act === "cd-compare") { var cb2 = S.confirm && S.confirm.onCompare; S.confirm = null; render(); if (typeof cb2 === "function") cb2(); return; }
    if (act === "reload-workbench") { location.reload(); return; }
    if (act === "style-add-open") { S.style.addOpen = true; render(); return; }
    if (act === "style-add-cancel") { S.style.addOpen = false; render(); return; }
    if (act === "style-add-confirm") { addStyle(); return; }
    if (act === "style-apply") { applyStyle(t.getAttribute("data-id"), t.getAttribute("data-name")); return; }
    if (act === "style-remove") { e.stopPropagation(); removeStyle(t.getAttribute("data-id")); return; }
    if (act === "save-api") {
      var a = $('[data-field="apiBase"]');
      var k = $('[data-field="token"]');
      S.apiBase = (a && a.value.trim()) || "";
      S.token = (k && k.value.trim()) || "";
      writeLS(STORE_KEYS.api, S.apiBase);
      writeLS(STORE_KEYS.token, S.token);
      refreshProjects();
      return;
    }
  });
  document.addEventListener("input", function (e) {
    var f = e.target && e.target.getAttribute ? e.target.getAttribute("data-field") : null;
    if (f === "path") S.path = e.target.value;
    if (f === "pickPath") { S.pick.typed = e.target.value; syncPickOpenBtn(); }
    if (f === "styleTarget") S.style.target = e.target.value;
    if (f === "styleSelect") S.style.selectedId = e.target.value;
    if (f === "styleAddPath") S.style.addPath = e.target.value;
    if (f === "aiText") S.ai.text = e.target.value;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (S.nav && S.nav.open) { S.nav.open = false; renderNav(); return; }
      if (S.ai && S.ai.open) { S.ai.open = false; render(); return; }
      if (S.confirm) { S.confirm = null; render(); return; }
      if (S.style && S.style.open) { S.style.open = false; render(); return; }
      if (S.view === "edit") { S.view = "home"; render(); return; }
      closeWorkbench();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && S.ai && S.ai.open) { e.preventDefault(); sendAiPrompt(); return; }
    if (e.key === "Enter" && e.target && e.target.getAttribute && e.target.getAttribute("data-field") === "path") {
      openProject();
    }
    if (e.key === "Enter" && e.target && e.target.getAttribute && e.target.getAttribute("data-field") === "pickPath") {
      e.preventDefault();
      pickJump();
    }
  });
  // 胶囊固定在窗口上（像侧边栏），独立模式顶部有接口条时跟着它让位
  window.addEventListener("scroll", function () { positionDrop(); }, { passive: true });
  window.addEventListener("resize", function () { positionDrop(); });

  /* ── 启动 ── */
  try {
    var qs = new URLSearchParams(location.search);
    var qApi = qs.get("api");
    var qToken = qs.get("token");
    if (qApi) { S.apiBase = qApi; writeLS(STORE_KEYS.api, qApi); }
    if (qToken) { S.token = qToken; writeLS(STORE_KEYS.token, qToken); }
    if (qs.get("standalone") === "1") EMBEDDED = false;
    // 从 DSH 宿主打开：隐藏独立模式连接条（布局与右侧栏内嵌工作台一致）
    S.fromHost = Boolean(qApi);
    // 已打开项目时点「独立窗口」：宿主会把 dir/page 带过来，直接进编辑
    var qDir = qs.get("dir");
    if (qDir && !EMBEDDED) S.bootTarget = { dir: qDir, page: qs.get("page") || "" };
  } catch (e) { /* ignore */ }
  S.theme = readLS(STORE_KEYS.theme, "paper") === "ink" ? "ink" : "paper";
  S.apiBase = readLS(STORE_KEYS.api, "");
  S.token = readLS(STORE_KEYS.token, "");
  document.documentElement.setAttribute("data-theme", S.theme);
  render();
  try { S.style.addPath = readLS("ve-wb:lastSpec", ""); } catch (e) { /* ignore */ }
  try { if (!S.style.target && S.projects[0]) S.style.target = S.projects[0].dir; } catch (e) { /* ignore */ }
  notifyHost("ready");
  if (!EMBEDDED) {
    // 独立模式：有接口地址就自动读项目；带 bootTarget 时直接打开该项目
    if (S.apiBase) {
      refreshProjects();
      refreshStyles();
      if (S.bootTarget) openBootTarget();
    }
  }
})();
