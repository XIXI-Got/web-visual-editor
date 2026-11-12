/**
 * 一键跑全部测试
 *
 *   node tools/visual-editor/e2e/run-all.mjs
 *
 * 依次执行：
 *   1) core/api 单元测试（node --test tools/visual-editor/test/core.test.mjs tools/visual-editor/test/api.test.mjs，纯函数 + 后端 store/handler）
 *   2) 插件宿主端到端（dsh-plugin/host-e2e.mjs，模拟 DSH 宿主 + /ve/plugin 路由）
 *   3) 渲染端端到端（dsh-plugin/client-e2e.mjs，无头 Edge 加载真实 client.js + mock 宿主）
 *   4) 撤销分支端到端（tools/visual-editor/e2e/undo.mjs，真实内核 + 无头 Edge）
 *   5) 工作台前端端到端（tools/visual-editor/e2e/workbench.mjs，真实 workbench-ui + 无头 Edge）
 *
 * 任一失败退出码非 0。无头 Edge 路径默认用 Windows 自带的 Edge。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

const suites = [
  {
    name: "core / api 单元测试",
    cmd: process.execPath,
    args: ["--test", "tools/visual-editor/test/core.test.mjs", "tools/visual-editor/test/api.test.mjs"],
    cover: "选择器/网格吸附/历史/样式生成/AI 操作白名单 + 后端 store（保存/备份/恢复/上传/内容回写/风格）",
  },
  {
    name: "宿主端到端",
    cmd: process.execPath,
    args: ["dsh-plugin/host-e2e.mjs"],
    cover: "插件宿主与 /ve/plugin 路由：ping、浏览、打开/关闭预览、保存/历史/备份、风格库、handoff、agent 工具注册",
  },
  {
    name: "渲染端端到端",
    cmd: process.execPath,
    args: ["dsh-plugin/client-e2e.mjs"],
    cover: "真实 client.js 在 mock DSH 里：原生右栏 tab / 抽屉 / 文件夹选择 / 预览工具栏 / 菜单文案 / 胶囊圆角（squircle 回归）/ 对齐按钮居中",
  },
  {
    name: "撤销分支端到端",
    cmd: process.execPath,
    args: ["tools/visual-editor/e2e/undo.mjs"],
    cover: "真实内核 runtime.js：改→撤销→再改→再改→连续撤销，验证分支截断/合并窗口/历史恢复语义",
  },
  {
    name: "工作台前端端到端",
    cmd: process.execPath,
    args: ["tools/visual-editor/e2e/workbench.mjs"],
    cover: "真实 workbench-ui/app.js：项目卡进编辑、AI 调整弹窗（发送走 agent.prompt）、独立窗口带项目参数、独立窗口直进编辑且布局一致",
  },
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("exit", (code) => resolve(code == null ? 1 : code));
    child.on("error", () => resolve(1));
  });
}

const results = [];
for (const s of suites) {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("▶ " + s.name + "  (" + s.args.join(" ") + ")");
  console.log("  覆盖：" + s.cover);
  console.log("══════════════════════════════════════════════════════");
  const code = await run(s.cmd, s.args);
  results.push({ name: s.name, ok: code === 0 });
}

console.log("\n──────────────────── 汇总 ────────────────────");
for (const r of results) console.log((r.ok ? "PASS  " : "FAIL  ") + r.name);
const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " 个测试套件通过");
process.exit(failed ? 1 : 0);
