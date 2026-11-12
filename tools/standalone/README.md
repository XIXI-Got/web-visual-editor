# 独立启动器（不依赖 DSH）

本地 Node 直接跑「可视化编辑器 + 网页工作台」，适合其它 harness / 纯本地使用。

## 最快用法

把项目文件夹**直接拖到** `启动独立编辑器.bat` 上，或双击后输入路径。

命令行：

```bat
node tools\standalone\launcher.mjs --dir "F:\你的项目" --port 19391 --open
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--dir` | 要编辑的项目目录（必填） |
| `--port` | 端口，默认 19391（被占用自动 +1 顺延） |
| `--open` | 启动后自动打开浏览器 |
| `--static` | 强制按静态站处理（Vite 项目也可用，但无热更新） |
| `--styles` | 风格库目录，默认 `~/.dsh/plugin-data/dsh-ui-editor/styles` |
| `--help` | 显示帮助 |

## 自动识别项目类型

- **Vite / React**：检测到 `node_modules/vite` 就自动起项目自己的 dev server（随机端口），
  启动器做反向代理（含 HMR websocket），编辑器内核自动注入，**不改项目文件**
- **纯静态站**：启动器自己起服务，并在 HTML 里注入编辑器内核

> Vite 项目请先在项目里 `npm install`；没有依赖时加 `--static` 或先装依赖。

## 入口

- 编辑器：`http://127.0.0.1:<端口>/?ve=1`（右下角「✎ 编辑」，左侧「+」拉出组件栏）
- 工作台：`http://127.0.0.1:<端口>/ve/wb/index.html?api=...&standalone=1`
- 内核 API：`/__ve/*`（保存 / 覆写 / 历史 / 上传）

## 流程

1. 启动（`.bat` 或命令行）
2. 页面右下角「✎ 编辑」开始可视化编辑
3. 顶部「保存」写回项目（`.ve-data/overrides.json` + 备份）
4. 需要真实页面生效时点「固化到源码」

## 常见问题

**双击 `启动独立编辑器.bat` 闪退 / 没反应？**
- 先把项目文件夹**拖到 bat 上**再试（这样不用手动输入路径）
- 还不行就直接用命令行跑，能看到完整报错：

```bat
cd /d F:\AI_Sandbox\网页调整工具
node tools\standalone\launcher.mjs --dir "你的项目路径" --open
```

- 需要 Node.js 18+（bat 会自动在常见安装位置找 node）


**页面空白？**
- Vite 项目：确认项目目录里 `node_modules/vite` 存在；否则 `npm install` 或加 `--static`
- 看启动器终端有没有 `Vite dev server 启动超时` 之类的报错

**端口被占用？** 会自动顺延，看终端打印的实际端口。

**没有 Agent 怎么用风格？** 工作台/编辑器里应用风格时，风格提示会打印到启动器终端，复制给你的 Agent 即可。

**关闭？** 终端里 Ctrl+C；服务与 vite 子进程会一起退出。
