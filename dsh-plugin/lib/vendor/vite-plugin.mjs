/**
 * 视觉编辑器 · Vite 插件
 *
 * 在 vite.config.ts 里加一行就能用：
 *
 *   import { visualEditor } from "./tools/visual-editor/vite-plugin.mjs";
 *   export default defineConfig({
 *     plugins: [visualEditor({ contentJson: "src/content.json", cssOut: "src/editor-overrides.css" }), react()],
 *   });
 *
 * dev 下自动注入编辑器；构建时把覆写层导出成 CSS（可选），所以生产环境也能带上样式改动。
 */

import path from "node:path";
import fs from "node:fs";
import { createStore } from "./api.mjs";
import { createApiHandler, PREFIX } from "./handler.mjs";

/**
 * @param {object} options
 * @param {string} [options.root]        站点根目录，默认 Vite root
 * @param {string} [options.dataDir]     数据目录，默认 .ve-data
 * @param {string} [options.contentJson] 站点内容 JSON（改文字会优先回写到这里）
 * @param {string} [options.publicDir]   静态资源目录，上传图片放这里
 * @param {string} [options.cssOut]      每次保存后同步生成纯 CSS 覆写文件
 * @param {boolean} [options.production] 构建时也注入编辑器（默认只 dev 注入）
 * @param {boolean} [options.dataAttrs]  是否在构建期给 JSX 注入 data-ve-id（需要配合 babelPlugin）
 */
export function visualEditor(options = {}) {
  let store = null;
  let handle = null;
  let root = null;
  let isDev = true;
  const stores = new Map();
  const handlers = new Map();

  const opts = {
    dataDir: options.dataDir || ".ve-data",
    contentJson: options.contentJson || "",
    publicDir: options.publicDir === undefined ? "public" : options.publicDir,
    cssOut: options.cssOut || "",
    maxBackups: options.maxBackups ?? 40,
    autoOpen: options.autoOpen !== false,
    injectInProd: Boolean(options.production),
  };

  const normPage = (p) => {
    let n = String(p || "/").split("?")[0].split("#")[0];
    if (!n.startsWith("/")) n = "/" + n;
    return n || "/";
  };
  const pageSlugOf = (p) => {
    const n = normPage(p);
    return n === "/" ? "" : n.replace(/^\/+/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "");
  };

  function ensureStore(viteRoot) {
    if (store) return store;
    root = path.resolve(options.root || viteRoot);
    store = createStore({ root, ...opts });
    handle = createApiHandler(store);
    return store;
  }

  /** 按页面创建独立 store/handler（入口页沿用旧数据，其它页面 .ve-data/pages/<slug>/） */
  function storeForPage(p) {
    const base = ensureStore(root);
    const key = normPage(p);
    if (!stores.has(key)) {
      stores.set(key, key === "/" ? base : createStore({ root: path.resolve(root), ...opts, page: pageSlugOf(key) }));
      handlers.set(key, key === "/" ? handle : createApiHandler(stores.get(key)));
    }
    return stores.get(key);
  }
  function handlerForPage(p) {
    storeForPage(p);
    return handlers.get(normPage(p)) || handle;
  }
  const pageFromReq = (req) => {
    try {
      const ref = req.headers && req.headers.referer;
      if (ref) {
        let p = new URL(ref).pathname || "/";
        try { p = decodeURIComponent(p); } catch { /* keep */ }
        return p;
      }
    } catch { /* ignore */ }
    return "/";
  };

  const bootConfig = (s, page) => ({
    token: s.config().token,
    contentJson: s.config().contentJson,
    mode: "vite",
    page: normPage(page),
    version: "1.1.0",
  });

  return {
    name: "visual-editor",
    apply: options.apply || "serve",
    enforce: "post",

    configResolved(config) {
      isDev = config.command === "serve";
      ensureStore(config.root);
    },

    configureServer(server) {
      const s = ensureStore(server.config.root);
      // 放在 Vite 内部中间件之前，直接接管 /__ve/*
      server.middlewares.use(async (req, res, next) => {
        try {
          const done = await handlerForPage(pageFromReq(req))(req, res);
          if (!done) next();
        } catch (err) {
          next(err);
        }
      });

      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const port = typeof addr === "object" && addr ? addr.port : server.config.server.port;
        const url = `http://127.0.0.1:${port}/`;
        console.log("");
        console.log("  ✎ 视觉编辑器已挂载  " + url);
        console.log("    数据目录 " + s.dataDir);
        if (s.config().contentJson) console.log("    内容文件 " + s.config().contentJson + "（改文字会回写）");
        if (s.config().publicDir) console.log("    图片目录 " + s.config().publicDir);
        console.log("");
        if (opts.autoOpen && !process.env.VE_NO_OPEN) openBrowser(url);
      });
    },

    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!isDev && !opts.injectInProd) return html;
        const pagePath = (ctx && (ctx.path || ctx.filename)) || "/";
        const s = storeForPage(pagePath);
        const config = JSON.stringify(bootConfig(s, pagePath)).replace(/</g, "\\u003c");
        return html.replace(
          /<\/head>/i,
          `<script>window.__VE_BOOT__=${config};</script>\n` +
            `<script type="module" src="${PREFIX}/runtime.js"></script>\n</head>`,
        );
      },
    },

    // 构建前把覆写层写成 CSS，方便生产带上样式改动
    buildStart() {
      if (!isDev && opts.cssOut && store) {
        const css = store.overridesCss();
        const file = path.resolve(root || process.cwd(), opts.cssOut);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `/* 由视觉编辑器生成 */\n${css}\n`, "utf8");
      }
    },

    closeBundle() {
      // 构建结束后提示覆写层的存在，避免「本地改了但构建没带上」的困惑
      if (!isDev && store && !opts.cssOut && Object.keys(store.readOverrides()).length) {
        this.warn?.(
          "检测到视觉编辑器的覆写层（.ve-data/overrides.json），但没配置 cssOut。生产构建不会带上这些改动；" +
            "建议给插件加 cssOut: 'src/editor-overrides.css' 并在入口 import 它。",
        );
      }
    },
  };
}

/**
 * Babel 插件：给每个 JSX 元素注入 data-ve-id="文件:行:列"。
 * 这样编辑器能知道「这个元素来自哪个源文件的哪一行」，覆写层按源位置寻址，比 CSS 选择器稳。
 *
 * 用法：
 *   import react from "@vitejs/plugin-react";
 *   react({ babel: { plugins: [visualEditorBabel()] } })
 *
 * 注意：只在 dev 使用，生产构建会变慢且没必要。
 */
export function visualEditorBabel() {
  return {
    name: "ve-data-id",
    visitor: {
      JSXOpeningElement(nodePath, state) {
        const node = nodePath.node;
        const loc = node.loc;
        if (!loc) return;
        const exists = node.attributes.some(
          (a) => a.type === "JSXAttribute" && a.name && a.name.name === "data-ve-id",
        );
        if (exists) return;
        const file = String(state.filename || "").replace(/\\/g, "/");
        const rel = file.split("/").slice(-2).join("/");
        const id = `${rel}:${loc.start.line}:${loc.start.column}`;
        node.attributes.push({
          type: "JSXAttribute",
          name: { type: "JSXIdentifier", name: "data-ve-id" },
          value: { type: "StringLiteral", value: id },
        });
      },
    },
  };
}

function openBrowser(url) {
  import("node:child_process").then(({ exec }) => {
    if (process.platform === "win32") exec(`start "" "${url}"`);
    else if (process.platform === "darwin") exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  });
}

export default visualEditor;
