# 项目硬约束

## 前端交付必须自适应（强制）

任何网页 / 组件 / 展示页交付前，必须满足：

- 从 360px 手机到 1920px 全屏都能稳定居中、比例缩放，不出现横向滚动条
- 字号用 `--u` / `clamp()` / `calc()`，不能只写固定 px
- 容器用 `width:min(...)` + `margin-inline:auto`，不能写死 `width:2400px`
- 文字容器禁止写死 `height`
- 布局禁止用 `left/top` 像素位移
- 每个 grid/flex 子项加 `min-width:0`
- `body` / `.page` 加 `overflow-x:clip`

详细规范与代码骨架见：

- `docs/responsive-architecture.md`
- Skill: `adaptive-frontend`
- 当前基准页面：`demo/muse.html`（单一设计单位 `--u`）

## 交付验收（每次必跑）

宽度 360 / 480 / 768 / 1024 / 1280 / 1440 / 1920：

```js
document.documentElement.scrollWidth <= innerWidth + 1
```

并记录 H1 字号、容器宽度对照表；任何一项溢出或字不缩放，不算完成。

## 编辑器固化的规则

- 文字选择器（p / h1-h6 / span / a / button / li）不写 width/height
- 容器宽度只写 `%` / `vw` / `calc`，并加 `max-width:100%; box-sizing:border-box`
- 不固化 `left/top`
- 源文件被外部修改后，旧覆写自动备份并停用（1.1.44+）
