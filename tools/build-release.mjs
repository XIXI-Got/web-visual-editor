#!/usr/bin/env node
/**
 * 构建发布包：
 *  1) 复制插件目录（排除 .ve-data / node_modules）
 *  2) 删除 @dev-start … @dev-end 测试功能区
 *  3) 清理只被测试 UI 引用的定义（devToolsOn / UE_REC / 录制函数等），并做语法校验
 *  4) npm pack → dsh-plugin/ + releases/
 * 用法：node tools/build-release.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PLUGIN = path.join(ROOT, "dsh-plugin");
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, "package.json"), "utf8").replace(/^\uFEFF/, ""));
const outName = `dsh-ui-editor-${pkg.version}.tgz`;

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ue-release-"));
const dest = path.join(stage, "pkg");
fs.mkdirSync(dest, { recursive: true });
for (const rel of ["lib", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE", "docs", "package.json"]) {
  const s = path.join(PLUGIN, rel);
  if (!fs.existsSync(s)) continue;
  fs.cpSync(s, path.join(dest, rel), {
    recursive: true,
    filter: (src) => !/\.ve-data([\\/]|$)/.test(src) && !/node_modules/.test(src),
  });
}

const clientFile = path.join(dest, "lib/client.js");
let c = fs.readFileSync(clientFile, "utf8");
const before = c.length;

/* ── 第一轮：删除显式 dev 标记块 ── */
c = c.replace(/[ \t]*\/\* @dev-start[^*]*\*\/[\s\S]*?\/\* @dev-end \*\/\n?/g, "");
c = c.replace("const DEV_TOOLS_DEFAULT = true; /* @dev-tools-default */", "const DEV_TOOLS_DEFAULT = false; /* @dev-tools-default */");

/* ── 第二轮：删除只被 dev UI 引用的定义（字符串/括号感知，失败回滚） ── */
const beforeSecond = c;
function scan(src, start, open, close) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function removeStatement(src, declRe) {
  const m = src.match(declRe);
  if (!m) return src;
  const start = m.index;
  let depth = 0, inStr = null, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) {
      let end = i + 1;
      if (src[end] === "\n") end++;
      return src.slice(0, start) + src.slice(end);
    }
  }
  return src;
}
function removeFunction(src, fnRe) {
  const m = src.match(fnRe);
  if (!m) return src;
  const start = m.index;
  const paren = src.indexOf("(", start);
  if (paren < 0) return src;
  const parenEnd = scan(src, paren, "(", ")");
  if (parenEnd < 0) return src;
  const brace = src.indexOf("{", parenEnd);
  if (brace < 0) return src;
  const braceEnd = scan(src, brace, "{", "}");
  if (braceEnd < 0) return src;
  let end = braceEnd + 1;
  if (src[end] === "\n") end++;
  return src.slice(0, start) + src.slice(end);
}
function removeLineContaining(src, text) {
  const idx = src.indexOf(text);
  if (idx < 0) return src;
  const ls = src.lastIndexOf("\n", idx) + 1;
  let le = src.indexOf("\n", idx);
  if (le < 0) le = src.length;
  return src.slice(0, ls) + src.slice(le + 1);
}

c = removeStatement(c, /const DEV_TOOLS_DEFAULT\s*=\s*/);
c = removeFunction(c, /function devToolsOn\(\)/);
c = removeStatement(c, /const UE_REC\s*=\s*/);
c = removeFunction(c, /function ueRecStart\(\)/);
c = removeFunction(c, /async function ueRecStop\(\)/);
c = removeLineContaining(c, "const [menuWide, setMenuWide] = useState(false);");
c = removeLineContaining(c, "menuWide ? h(WideParamsBox, { onClose: () => setMenuWide(false) }) : null,");
c = removeLineContaining(c, "const [showWideCfg, setShowWideCfg] = useState(false);");
c = removeLineContaining(c, "showWideCfg ? h(WideParamsBox, { onClose: () => setShowWideCfg(false) }) : null,");

/* 语法校验，失败回滚第二轮 */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chk-"));
  fs.writeFileSync(path.join(tmp, "c.js"), c, "utf8");
  let ok = true;
  try { execFileSync(process.execPath, ["--check", path.join(tmp, "c.js")], { stdio: "ignore" }); }
  catch { ok = false; }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!ok) {
    c = beforeSecond;
    console.warn("⚠ 第二轮清理语法校验失败，已回滚（发布包保留少量死代码）");
  }
}

fs.writeFileSync(clientFile, c, "utf8");
const leftovers = ["测试工具（发布排除）", "记录拖动", "浮动对话（测试）", "宽屏/窄屏参数", "ueRecStart", "devToolsOn", "UE_REC.on"].filter((k) => c.includes(k));
if (leftovers.length) {
  console.error("✗ 发布包仍含测试功能：" + leftovers.join(" / "));
  process.exit(1);
}
console.log(`✓ 测试功能已剔除：client.js ${before} → ${c.length} bytes`);

const outDir = path.join(stage, "out");
fs.mkdirSync(outDir, { recursive: true });
execFileSync("npm", ["pack", "--pack-destination", outDir], { cwd: dest, stdio: "ignore", shell: true });
const tgz = fs.readdirSync(outDir).find((f) => f.endsWith(".tgz"));
if (!tgz) { console.error("✗ npm pack 未产出 tgz"); process.exit(1); }
fs.copyFileSync(path.join(outDir, tgz), path.join(PLUGIN, outName));
fs.mkdirSync(path.join(ROOT, "releases"), { recursive: true });
fs.copyFileSync(path.join(outDir, tgz), path.join(ROOT, "releases", outName));
console.log("✓ 发布包：" + path.join("releases", outName) + "（" + fs.statSync(path.join(PLUGIN, outName)).size + " bytes）");
fs.rmSync(stage, { recursive: true, force: true });
