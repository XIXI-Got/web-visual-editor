#!/usr/bin/env node
/**
 * 视觉编辑器 · 一键装进一个 Vite 项目
 *
 *   node tools/visual-editor/install.mjs "D:\小红书\Portfolio （白点）"
 *
 * 会做三件事（都可回滚）：
 *   1. 把编辑器内核复制到 <项目>/tools/visual-editor/
 *   2. 备份 <项目>/vite.config.* 到 <项目>/.ve-data/backups/<时间戳>_install/
 *   3. 在 vite.config 里加一个插件（幂等：装过就不再重复）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["core.mjs", "api.mjs", "handler.mjs", "runtime.js", "vite-plugin.mjs", "vite-plugin.d.mts", "server.mjs", "package.json"];

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const targetArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".";
const target = path.resolve(process.cwd(), targetArg);

if (!fs.existsSync(path.join(target, "package.json"))) {
  console.error(`✗ 这不像一个前端项目（没有 package.json）：${target}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8").replace(/^\uFEFF/, ""));
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
if (!deps.vite) {
  console.error("✗ 没检测到 vite。这个工具是 Vite 插件；纯静态站请改用 server.mjs 直接起服务。");
  process.exit(1);
}

/* ---------- 1. 复制内核 ---------- */
const destDir = path.join(target, "tools", "visual-editor");
fs.mkdirSync(destDir, { recursive: true });
for (const file of FILES) {
  fs.copyFileSync(path.join(TOOL_DIR, file), path.join(destDir, file));
}
fs.mkdirSync(path.join(destDir, "test"), { recursive: true });
for (const file of fs.readdirSync(path.join(TOOL_DIR, "test"))) {
  fs.copyFileSync(path.join(TOOL_DIR, "test", file), path.join(destDir, "test", file));
}
console.log(`✓ 编辑器内核已复制到 ${path.relative(target, destDir)}`);

/* ---------- 2. 找到 vite.config ---------- */
const candidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"];
const configName = candidates.find((n) => fs.existsSync(path.join(target, n)));
if (!configName) {
  console.error("✗ 找不到 vite.config.ts/js。请手动在插件数组里加 visualEditor()。");
  process.exit(1);
}
const configPath = path.join(target, configName);
let configText = fs.readFileSync(configPath, "utf8");

/* ---------- 3. 备份（只在真的要改配置时做） ---------- */
const needPatch = !configText.includes("visual-editor/vite-plugin");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backupDir = path.join(target, ".ve-data", "backups", `${stamp}_install`);
if (needPatch) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(configPath, path.join(backupDir, configName));
  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    JSON.stringify({ at: new Date().toISOString(), files: [configName], note: "安装视觉编辑器前的备份" }, null, 2),
  );
  console.log(`✓ 原配置已备份到 .ve-data/backups/${stamp}_install/`);
}

/* ---------- 4. 推断参数 ---------- */
const contentJson = arg("content", fs.existsSync(path.join(target, "src", "content.json")) ? "src/content.json" : "");
const publicDir = arg("public", fs.existsSync(path.join(target, "public")) ? "public" : "");
const cssOut = arg("css-out", fs.existsSync(path.join(target, "src")) ? "src/editor-overrides.css" : "");

const pluginOptions = [
  contentJson ? `contentJson: ${JSON.stringify(contentJson)}` : "",
  publicDir ? `publicDir: ${JSON.stringify(publicDir)}` : "",
  cssOut ? `cssOut: ${JSON.stringify(cssOut)}` : "",
].filter(Boolean);

/* ---------- 5. 改配置（幂等） ---------- */
const wantDataAttrs = flag("data-attrs");
if (!needPatch) {
  console.log("• 配置里已经有 visualEditor，跳过修改");
} else {
  const importNames = wantDataAttrs ? "{ visualEditor, visualEditorBabel }" : "{ visualEditor }";
  const importLine = `import ${importNames} from "./tools/visual-editor/vite-plugin.mjs";\n`;
  // 加 import：插在最后一条 import 之后
  const importMatches = [...configText.matchAll(/^import[\s\S]*?;?\s*$/gm)];
  if (importMatches.length) {
    const last = importMatches[importMatches.length - 1];
    const at = last.index + last[0].length;
    configText = configText.slice(0, at) + "\n" + importLine + configText.slice(at);
  } else {
    configText = importLine + configText;
  }

  const call = `visualEditor({ ${pluginOptions.join(", ")} })`;
  const pluginsArray = /plugins\s*:\s*\[/.exec(configText);
  if (pluginsArray) {
    const at = pluginsArray.index + pluginsArray[0].length;
    configText = configText.slice(0, at) + `\n    ${call},\n    ` + configText.slice(at);
  } else {
    const defineConfig = /defineConfig\s*\(\s*\{/.exec(configText);
    if (!defineConfig) {
      console.error("✗ 配置结构无法自动识别，请手动加插件：plugins: [" + call + "]");
      process.exit(1);
    }
    const at = defineConfig.index + defineConfig[0].length;
    configText = configText.slice(0, at) + `\n  plugins: [${call}],` + configText.slice(at);
  }

  // 可选：把 react() 换成 react({ babel: { plugins: [visualEditorBabel()] } })
  if (wantDataAttrs) {
    if (/react\(\s*\)/.test(configText)) {
      configText = configText.replace(
        /react\(\s*\)/,
        "react({ babel: { plugins: [visualEditorBabel()] } })",
      );
      console.log("✓ 已给 @vitejs/plugin-react 挂上 data-ve-id 注入");
    } else {
      console.log("• react() 已有参数，跳过多余的 babel 注入（需要可手动加 visualEditorBabel）");
    }
  }

  fs.writeFileSync(configPath, configText, "utf8");
  console.log(`✓ 已修改 ${configName}，加入 visualEditor 插件`);
}

/* ---------- 5.5 把工具产物写进 .gitignore ---------- */
const gitignore = path.join(target, ".gitignore");
if (fs.existsSync(gitignore)) {
  const text = fs.readFileSync(gitignore, "utf8");
  const missing = [".ve-data/", "src/editor-overrides.css"].filter((l) => !text.includes(l));
  if (missing.length) {
    fs.appendFileSync(gitignore, `\n# 视觉编辑器（本地编辑数据与导出样式）\n${missing.join("\n")}\n`, "utf8");
    console.log("✓ .gitignore 已追加 .ve-data/ 与 editor-overrides.css");
  }
}

/* ---------- 6. 记录 + 提示 ---------- */
const recordPath = path.join(target, ".ve-data", "install.json");
fs.mkdirSync(path.dirname(recordPath), { recursive: true });
fs.writeFileSync(
  recordPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      tool: "visual-editor",
      version: "1.0.0",
      config: configName,
      options: { contentJson, publicDir, cssOut },
      backupsDir: ".ve-data/backups",
    },
    null,
    2,
  ),
);

console.log("");
console.log("装好了。接下来：");
console.log(`  1) cd "${target}"`);
console.log("  2) npm run dev");
console.log("  3) 浏览器右下角点「✎ 编辑」");
console.log("");
if (contentJson) console.log(`  改文字会自动回写 ${contentJson}（唯一匹配时），其余进 .ve-data/overrides.json`);
if (cssOut) console.log(`  每次保存同步生成 ${cssOut}；要在生产带上样式改动，就在 src/main.tsx 里 import 它`);
console.log("  所有改动前都会自动备份到 .ve-data/backups/");
if (flag("verbose")) console.log(`\n备份目录：${backupDir}`);
