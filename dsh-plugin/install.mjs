#!/usr/bin/env node
/**
 * dsh-ui-editor —— DSH 组合包（bundle）的本地安装器
 *
 * 方式 A（推荐，在 DSH 界面里）：
 *   设置 → 插件 → 添加插件 → 输入本地目录路径：<这个 dsh-plugin 目录> → 安装 → 重启 DSH
 *
 * 方式 B（命令行，等价）：
 *   node dsh-plugin/install.mjs
 *   node dsh-plugin/install.mjs --uninstall
 *
 * 原理：本包声明了 `dsh.bundle.patch = ./cordis.patch.yml`，安装 = 把包名
 * 加进 profile 的 `dsh.profile.bundles` 列表；Loader 启动时应用该 patch。
 *
 * 命令行安装器：
 *   1. 复制包 → ~/.dsh/plugins/dsh-ui-editor/
 *   2. 复制到 ~/.dsh/profiles/node_modules/dsh-ui-editor/（已存在则保留）
 *   3. 备份 profile/package.json，把 "dsh-ui-editor" 加进 dsh.profile.bundles
 *   4. 清理旧版本留下的 cordis.patch.yml 手写条目，避免重复挂载
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME ? process.env.DSH_HOME : path.join(HOME, ".dsh");
const PKG_NAME = "dsh-ui-editor";
const PLUGIN_DEST = path.join(DSH_HOME, "plugins", PKG_NAME);
const PROFILES = path.join(DSH_HOME, "profiles");
const NODE_MODULES = path.join(PROFILES, "node_modules");
const LEGACY_NAMES = ["@local/dsh-plugin-web-editor", "@local/web-page-editor", "web-page-editor"];

const uninstall = process.argv.includes("--uninstall");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const log = (...a) => console.log(...a);
const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

function rm(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) fs.unlinkSync(p);
    else fs.rmSync(p, { recursive: true, force: true });
  } catch { /* 不存在 */ }
}

const COPY_SKIP = new Set([".ve-data", "node_modules", "shots", ".git", ".DS_Store"]);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (COPY_SKIP.has(entry.name)) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function profileDirs() {
  return ["desktop", "web"].filter((p) => fs.existsSync(path.join(PROFILES, p, "package.json")));
}

function readProfilePkg(profile) {
  const file = path.join(PROFILES, profile, "package.json");
  return { file, pkg: JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) };
}

function backup(file) {
  const dst = file + ".bak-" + stamp;
  fs.copyFileSync(file, dst);
  return dst;
}

/** 清理旧机制写进 profile cordis.patch.yml 的那条 insert（如果存在） */
function stripLegacyPatchEntries(profile) {
  const file = path.join(PROFILES, profile, "cordis.patch.yml");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const re = /(?:^|\n)(?:#[^\n]*\n)?- insert:\n\s+- id: [\w-]+\n\s+name: ["'](?:dsh-ui-editor|@local\/dsh-plugin-web-editor|web-page-editor)["']\n/g;
  if (!re.test(text)) return;
  backup(file);
  fs.writeFileSync(file, text.replace(re, "\n").replace(/\n{3,}/g, "\n\n"), "utf8");
  log(`• 已清理 ${profile}/cordis.patch.yml 里旧的手写条目`);
}

/* ─────────── 0. 刷新内置内核（tools/visual-editor → lib/vendor） ─────────── */
const TOOLS_DIR = path.join(path.dirname(HERE), "tools", "visual-editor");
if (fs.existsSync(TOOLS_DIR)) {
  fs.mkdirSync(path.join(HERE, "lib", "vendor"), { recursive: true });
  for (const f of ["core.mjs", "api.mjs", "handler.mjs", "runtime.js", "vite-plugin.mjs", "vite-plugin.d.mts"]) {
    const src = path.join(TOOLS_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HERE, "lib", "vendor", f));
  }
  log("✓ 已从 tools/visual-editor 刷新内置内核");

/* 0.1 同步独立工作台前端（workbench-ui → lib/workbench-ui） */
try {
  const WB_SRC = path.join(path.dirname(HERE), "workbench-ui");
  const WB_DST = path.join(HERE, "lib", "workbench-ui");
  if (fs.existsSync(WB_SRC)) {
    fs.rmSync(WB_DST, { recursive: true, force: true });
    copyDir(WB_SRC, WB_DST);
    log("✓ 已同步工作台前端（workbench-ui）");
  }
} catch (e) { log("工作台前端同步失败：" + String(e && e.message || e)); }

}
/* ─────────── 卸载 ─────────── */
if (uninstall) {
  rm(path.join(NODE_MODULES, PKG_NAME));
  rm(PLUGIN_DEST);
  for (const legacy of LEGACY_NAMES) rm(path.join(NODE_MODULES, legacy));

  for (const profile of profileDirs()) {
    const { file, pkg } = readProfilePkg(profile);
    const bundles = pkg?.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.includes(PKG_NAME)) {
      backup(file);
      pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG_NAME);
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      log(`✓ 已从 ${profile} profile 的 bundles 移除`);
    }
    stripLegacyPatchEntries(profile);
  }
  log("\n卸载完成，重启 DSH 生效。");
  process.exit(0);
}

/* ─────────── 检查 ─────────── */
if (!fs.existsSync(PROFILES)) die("找不到 " + PROFILES + "（可用 DSH_HOME 覆盖）");
const profiles = profileDirs();
if (!profiles.length) die("没找到 desktop/web profile 的 package.json");
for (const f of ["lib/index.js", "lib/client.js", "lib/vendor/runtime.js", "cordis.patch.yml"]) {
  if (!fs.existsSync(path.join(HERE, f))) die("插件包不完整，缺少 " + f);
}

/* ─────────── 1. 复制包到 ~/.dsh/plugins ─────────── */
rm(PLUGIN_DEST);
fs.mkdirSync(PLUGIN_DEST, { recursive: true });
for (const item of ["package.json", "cordis.patch.yml", "README.md"]) {
  if (fs.existsSync(path.join(HERE, item))) fs.copyFileSync(path.join(HERE, item), path.join(PLUGIN_DEST, item));
}
copyDir(path.join(HERE, "lib"), path.join(PLUGIN_DEST, "lib"));
log("✓ 包已复制到 " + PLUGIN_DEST);

/* ─────────── 2. profile node_modules ─────────── */
const nmTarget = path.join(NODE_MODULES, PKG_NAME);
// 旧副本会导致重启后仍加载旧代码（DSH 面板安装时也会放一份），一律删掉重新复制
rm(nmTarget);
copyDir(PLUGIN_DEST, nmTarget);
log("✓ 已刷新 profile 副本 " + nmTarget);
for (const legacy of LEGACY_NAMES) {
  const p = path.join(NODE_MODULES, legacy);
  if (fs.existsSync(p)) { rm(p); log("• 已清理旧版本目录 " + legacy); }
}

/* ─────────── 2.5 同步各 profile 自己目录里的副本（desktop/web 会从这里加载） ─────────── */
for (const profile of profiles) {
  const target = path.join(PROFILES, profile, "node_modules", PKG_NAME);
  if (!fs.existsSync(target)) continue;
  try {
    fs.mkdirSync(path.join(target, "lib"), { recursive: true });
    rm(path.join(target, "lib"));
    copyDir(path.join(PLUGIN_DEST, "lib"), path.join(target, "lib"));
    for (const item of ["package.json", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE"]) {
      if (fs.existsSync(path.join(PLUGIN_DEST, item))) fs.copyFileSync(path.join(PLUGIN_DEST, item), path.join(target, item));
    }
    log("✓ 已同步 " + profile + " profile 副本");
  } catch (e) {
    log("• " + profile + " profile 副本同步失败：" + String((e && e.message) || e));
  }
}

/* ─────────── 3. 加进 profile 的 bundles 列表 ─────────── */
for (const profile of profiles) {
  const { file, pkg } = readProfilePkg(profile);
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(PKG_NAME)) {
    const b = backup(file);
    pkg.dsh.profile.bundles = [...bundles, PKG_NAME];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    log(`✓ ${profile} profile 的 bundles 已加入「${PKG_NAME}」（备份 ${path.basename(b)}）`);
  } else {
    log(`• ${profile} profile 里已有该组合包，跳过`);
  }
  stripLegacyPatchEntries(profile);
}

log("");
log("装好了。下一步：**完全退出 DSH 再打开**");
log("  重启后：侧边栏底部「✎ 网页」→ 选源码文件夹 → 打开并编辑 → 框选交给 AI → 保存");
log("");
log("回滚：node dsh-plugin/install.mjs --uninstall 然后重启");
