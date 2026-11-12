/**
 * DSH 插件 · 预览子进程入口
 *
 * 用「目标项目自己安装的 Vite」启动它的 dev server，并注入视觉编辑器插件。
 * 目标项目的任何配置文件都不会被修改。
 *
 * 冲突处理（重要）：如果项目自己已经装过编辑器插件（vite.config 里引用了
 * visual-editor / tools/visual-editor 目录），它会在本进程里**被从内存配置中过滤掉**，
 * 改由本进程注入最新内核 —— 项目文件一个字节都不改，原网页架构不受影响。
 *
 * 用法（由 preview.mjs 调用）：
 *   node vite-run.mjs --dir <项目> --port <端口> --token <token> [--content src/content.json] ...
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "vendor");

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const dir = path.resolve(arg("dir", "."));
const port = Number(arg("port", "0"));
const token = arg("token", "");
const dataDir = arg("data", ".ve-data");
const contentJson = arg("content", "");
const publicDir = arg("public", "");
const cssOut = arg("css-out", "");

if (!token) {
  console.error("缺少 --token");
  process.exit(2);
}
process.env.VE_TOKEN = token;

const viteEntry = path.join(dir, "node_modules", "vite", "dist", "node", "index.js");
if (!fs.existsSync(viteEntry)) {
  console.error("目标项目里找不到 vite：" + viteEntry + "（请先在该目录执行 npm install）");
  process.exit(3);
}

const viteMod = await import(pathToFileURL(viteEntry).href);
const { createServer } = viteMod;
const { visualEditor } = await import(pathToFileURL(path.join(VENDOR, "vite-plugin.mjs")).href);

const configNames = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];
const configFile = configNames.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));

/* ─────────── 冲突检测：项目里自带的编辑器插件 ─────────── */

const conflict = { detected: false, handled: configFile ? "loaded-in-memory" : "no-config", stripped: 0, sources: [] };

if (fs.existsSync(path.join(dir, "tools", "visual-editor"))) {
  conflict.detected = true;
  conflict.sources.push("tools/visual-editor 目录");
}
if (configFile) {
  try {
    const text = fs.readFileSync(configFile, "utf8");
    if (/visual-editor|visualEditor/.test(text)) {
      conflict.detected = true;
      if (!conflict.sources.includes(path.basename(configFile))) conflict.sources.push(path.basename(configFile));
    }
  } catch { /* ignore */ }
}

/* ─────────── 读取项目配置（内存里过滤旧插件，不改文件） ─────────── */

let baseConfig = {};
let configLoaded = false;
if (configFile && typeof viteMod.loadConfigFromFile === "function") {
  try {
    const loaded = await viteMod.loadConfigFromFile({ command: "serve", mode: "development" }, configFile, dir);
    if (loaded && loaded.config) {
      baseConfig = loaded.config;
      configLoaded = true;
    }
  } catch (e) {
    console.error("读取项目配置失败，退回让 Vite 自行加载：" + String(e && e.message ? e.message : e));
  }
}

/** 把插件数组拍平（Vite 配置里常见嵌套数组 / falsy） */
function flatten(list) {
  const out = [];
  const walk = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    out.push(v);
  };
  walk(list);
  return out;
}

const isEmbeddedEditor = (plugin) => {
  try {
    const nm = String((plugin && (plugin.name || (Array.isArray(plugin) && plugin[0] && plugin[0].name))) || "");
    return nm === "visual-editor" || nm.includes("visual-editor") || nm.includes("visualEditor");
  } catch {
    return false;
  }
};

let keptPlugins = [];
if (configLoaded) {
  keptPlugins = flatten(baseConfig.plugins).filter((p) => {
    if (isEmbeddedEditor(p)) {
      conflict.detected = true;
      conflict.stripped += 1;
      conflict.sources.push("插件 " + String(p.name || "visual-editor"));
      return false;
    }
    return true;
  });
}

if (conflict.detected) {
  conflict.handled = "stripped-in-preview";
  conflict.note = "项目自带的旧版编辑器插件已在本次预览中忽略（未修改项目任何文件），本次使用插件内置的最新内核。";
}

process.stdout.write(`VE_CONFLICT ${JSON.stringify(conflict)}\n`);

const serverConfig = {
  ...(configLoaded ? baseConfig : {}),
  root: dir,
  configFile: configLoaded ? false : configFile,
  plugins: [
    ...keptPlugins,
    visualEditor({
      root: dir,
      dataDir,
      ...(contentJson ? { contentJson } : {}),
      ...(publicDir ? { publicDir } : {}),
      ...(cssOut ? { cssOut } : {}),
      autoOpen: false,
    }),
  ],
  server: { ...(configLoaded && baseConfig.server ? baseConfig.server : {}), host: "127.0.0.1", port, strictPort: true },
  logLevel: "info",
  clearScreen: false,
};

const server = await createServer(serverConfig);

await server.listen();
process.stdout.write(`VE_READY ${port}\n`);

const shutdown = async () => {
  try { await server.close(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("message", (msg) => { if (msg === "close") shutdown(); });
