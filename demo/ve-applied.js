/* 由 DSH 网页修改器固化生成：把保存过的修改写进真实页面（不依赖编辑器内核）
 * 重新固化会覆盖本文件；删除本文件并移除入口里的引用即可还原。
 */
(function () {
  var DATA = {"base":{},"pages":{"muse.html":{"sel:html > body > header > div.wrap.nav > div.logo > svg > path:nth-of-type(2)":{"style":{}},"sel:html > body > section.wrap:nth-of-type(5) > div.cta-band > div > h2":{"text":"画布已备，等你启序","style":{}},"sel:html > body > section.quotes:nth-of-type(4) > div.wrap > h2":{"text":"献给重视每一处交付细节的人","style":{}}}}};
  // 按页面取覆写：入口页用 base，其它页面用 pages[slug] 覆盖
  function pageSlug() {
    try {
      var p = location.pathname || "/";
      try { p = decodeURIComponent(p); } catch (e) { /* keep */ }
      if (p === "/" || /\/index\.html?$/i.test(p)) return "";
      return p.replace(/^\/+/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "");
    } catch (e) { return ""; }
  }
  var OVERRIDES = {};
  try {
    var _b = DATA.base || {};
    for (var _k in _b) OVERRIDES[_k] = _b[_k];
    var _pg = (DATA.pages || {})[pageSlug()];
    if (_pg) for (var _k2 in _pg) OVERRIDES[_k2] = _pg[_k2];
  } catch (e) { /* ignore */ }
  // 编辑器预览里（URL 带 ve=1）由内核接管样式，这里不重复应用，避免内联样式与内核的 !important 规则冲突
  try {
    if (/[?&]ve=1([&#]|$)/.test(location.search) || document.documentElement.hasAttribute('data-ve-editor')) return;
  } catch (e) { /* ignore */ }
  function resolve(key) {
    try {
      if (key.indexOf('id:') === 0) return document.getElementById(key.slice(3));
      if (key.indexOf('sel:') === 0) return document.querySelector(key.slice(4));
      if (key.indexOf('overlay:') === 0) return null;
    } catch (e) { return null; }
    return null;
  }
  function paintOverlay(key, node) {
    try {
      if (!node) return;
      var el = document.createElement(node.tag === 'text' ? 'div' : node.tag || 'div');
      el.setAttribute('data-ve-applied-overlay', node.id || key.slice(8));
      var a = node.attrs || {};
      if (a.src) el.setAttribute('src', a.src);
      if (a.text) el.textContent = a.text;
      if (a.html) el.innerHTML = a.html;
      if (a.color) el.style.color = a.color;
      var s = node.style || {};
      el.style.cssText = 'position:absolute;left:' + (node.x || 0) + 'px;top:' + (node.y || 0) + 'px;width:' + (node.width || 200) + 'px;height:' + (node.height || 160) + 'px;z-index:' + (node.z || 900) + ';' + (node.rotate ? 'transform:rotate(' + node.rotate + 'deg);' : '');
      for (var k in s) { try { el.style[k] = s[k]; } catch (e) { /* ignore */ } }
      var ref = null;
      if (node.refKey) { try { ref = document.querySelector(node.refKey); } catch (e) { ref = null; } }
      var pin = node.pin || 'page';
      if (pin !== 'page' && node.refKey) ref = ref || document.body;
      var host = (pin === 'screen') ? document.body : (ref && ref.parentElement ? ref.parentElement : document.body);
      host.appendChild(el);
    } catch (e) { /* ignore */ }
  }
  function apply() {
    Object.keys(OVERRIDES).forEach(function (key) {
      var e = OVERRIDES[key];
      if (!e || typeof e !== 'object') return;
      if (e.__overlay) { paintOverlay(key, e.__overlay); return; }
      var node = resolve(key);
      if (!node) return;
      try {
        if (e.hidden) node.style.setProperty('display', 'none', 'important');
        if (e.style) for (var p in e.style) { var v = e.style[p]; if (v != null && v !== '') node.style.setProperty(p, String(v), 'important'); }
        if (typeof e.text === 'string' && node.textContent !== e.text) node.textContent = e.text;
        else if (typeof e.blockText === 'string' && node.innerHTML !== e.blockText) node.innerHTML = e.blockText;
        if (typeof e.image === 'string') {
          if (node.tagName === 'IMG') node.src = e.image;
          else { var img = node.querySelector('img'); if (img) img.src = e.image; }
        }
        if (e.attrs) for (var a in e.attrs) { if (e.attrs[a] == null) node.removeAttribute(a); else node.setAttribute(a, e.attrs[a]); }
        if (e.box) {
          node.style.transform = 'translate(' + (e.box.x || 0) + 'px,' + (e.box.y || 0) + 'px)';
          if (e.box.width) node.style.width = e.box.width + 'px';
          if (e.box.height) node.style.height = e.box.height + 'px';
        }
      } catch (err) { /* ignore */ }
    });
  }
  // 工作台这类页面是 app.js 异步渲染的（等父窗口 init），脚本执行时 #app 可能还是空的：
  // 先尝试，再用定时重试 + MutationObserver 在内容出现后补应用
  var tries = 0;
  function boot() {
    try { apply(); } catch (e) { /* ignore */ }
    var timer = setInterval(function () {
      tries += 1;
      try { apply(); } catch (e) { /* ignore */ }
      if (tries >= 24) clearInterval(timer);
    }, 150);
    try {
      var host = document.getElementById('app') || document.body;
      var mo = new MutationObserver(function () { try { apply(); } catch (e) { /* ignore */ } });
      mo.observe(host, { childList: true, subtree: true });
      setTimeout(function () { try { mo.disconnect(); } catch (e) { /* ignore */ } }, 6000);
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
