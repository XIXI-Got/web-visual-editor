# 稳定居中 / 自适应架构方案

参考样本：`通用自适应参考页`

## 一、样本为什么能稳定居中自适应

### 1. 整页只有两层宽度模型

```css
/* 外层永远铺满，负责背景和裁切 */
.page { width: 100%; overflow-x: clip; }

/* 内层负责内容宽度和居中 */
.container {
  width: min(var(--container), calc(100% - var(--gutter) * 2));
  margin-inline: auto;
}
```

- 不给 section 写死宽度
- 所有“内容居中”都由内层容器完成，不靠元素自身 `left/transform`
- 外层 `overflow-x: clip` 兜底，任何装饰元素越界都不会产生横向滚动条

### 2. Hero 使用「固定比例舞台」，整块缩放而不是逐元素适配

```css
:root { --hero-ratio: 1.76842; }

.stage {
  position: absolute;
  top: 50%;
  left: 50%;
  width: max(100vw, calc(100svh * var(--hero-ratio)));
  aspect-ratio: 2688 / 1520;
  transform: translate3d(-50%, -50%, 0);
  overflow: hidden;
  container-type: inline-size;
}
```

要点：

- 舞台始终保持设计稿比例，宽度取 `max(视口宽, 视口高 × 比例)`，保证铺满且不压扁
- 舞台自己的 `translate(-50%, -50%)` 只做“整体居中”，不参与内容布局
- `container-type: inline-size` 后，内部可以用 `cqw` 相对舞台宽度定位：

```css
.map-pill-wrap {
  bottom: calc(max(32px, calc((100cqw / var(--hero-ratio) - 100svh) / 2 + 32px)));
}
```

这样视口变宽/变高时，背景图、标题、悬浮按钮、地图胶囊会作为一个整体缩放，视觉中心永远在窗口中心。

### 3. 内容区全部用 `min-height: 100svh` + flex 居中

```css
.statement, .facts {
  display: flex;
  min-height: 100vh;
  min-height: 100svh;
  align-items: center;
  justify-content: center;
  padding: 12vh clamp(22px, 5vw, 74px);
}

.statement__inner {
  width: 100%;
  max-width: 1460px;
  margin-inline: auto;
  text-align: center;
}
```

- `100svh` 而不是 `100vh`：移动端地址栏收起/展开不会跳动
- flex 居中 + `max-width`，内容自然在窗口中心
- 左右 padding 用 `clamp()`，窄屏不贴边、宽屏不散架

### 4. 所有尺寸都是相对量

```css
font-size: clamp(40px, 7.2vw, 132px);
gap: clamp(26px, 3.4vw, 48px);
padding: clamp(84px, 12vh, 138px) clamp(22px, 4vw, 56px);
```

- 字号：`clamp(最小值, vw 比例, 最大值)`
- 间距：`clamp()` + `vw/vh`
- 图片：`width/height` 属性给比例，CSS `max-width:100%` + `object-fit`
- 没有“某个窗口下量出来的固定 480px / 2400px”

### 5. 栅格用 `minmax(0, 1fr)`，防溢出

```css
.facts__inner {
  display: grid;
  width: min(1180px, 100%);
  grid-template-columns: 1.12fr 1.12fr 0.96fr;
  gap: clamp(26px, 3.4vw, 48px);
  align-items: start;
}

.facts__col { min-width: 0; }
```

- `minmax(0, 1fr)` / `min-width: 0` 是防止长文本把列撑破的关键
- 宽屏三列、窄屏在媒体查询里改成一列或两列
- 媒体查询只改**结构**，不改具体像素尺寸

### 6. 媒体查询只做艺术指导切换

```css
@media (max-width: 760px) {
  .hero__title { font-size: 15.6vw; }
  .nav { top: calc(22px + env(safe-area-inset-top)); }
  .statement { padding: 11vh 18px; }
  .statement__statement { font-size: 8.6vw; }
}
```

桌面/手机不是两套固定布局，而是同一套相对规则在两个区间取不同比例。

### 7. 编辑层不破坏布局

样本项目 `ve-applied.js` 里只有一条文字修改：

```js
"sel:#hero > ... > p.hero__eyebrow": { "text": "123", "style": {} }
```

文字内容不参与布局宽度计算，所以怎么改都不会破坏自适应。

真正会破坏自适应的是：给容器写 `width: 2400px`、给文字写 `height: 64px`、给元素写 `left: 44px`。

## 二、和当前 DEMO 页的本质差异

| 维度 | 参考页 | 当前 DEMO 页 |
|---|---|---|
| Hero | 固定比例舞台整块缩放 | 左右两栏 + 固定尺寸卡片（680×456） |
| 居中方式 | section flex 居中 + 容器 max-width | 容器 max-width，但局部靠像素定位 |
| 字号 | 全部 `clamp()` | 已有 clamp，但被旧固化 px 覆盖过 |
| 溢出兜底 | `overflow-x: clip` | 依赖元素不越界 |
| 编辑产物 | 只改文字 | 曾写入固定宽高、字号、位置 |
| 结果 | 任意窗口稳定居中 | 一旦固化固定值就歪 |

结论：**自适应不是“加几条媒体查询”，而是从布局模型上禁止绝对尺寸参与排版。**

## 三、推荐架构（可直接复用）

### 1. 基础层

```css
*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  overflow-x: clip;
  background: var(--paper);
}

img, svg, video { display: block; max-width: 100%; }
p, h1, h2, h3, figure, dl, dd { margin: 0; }
```

### 2. 变量层

```css
:root {
  --paper: #F4F1EA;
  --ink: #222222;
  --rust: #8C6A4A;

  --container: 1180px;
  --gutter: clamp(20px, 4vw, 74px);
  --section-y: clamp(64px, 12vh, 138px);

  --display-xl: clamp(40px, 7.2vw, 132px);
  --display-lg: clamp(34px, 4.25vw, 66px);
  --body: clamp(15px, 1.05vw, 18px);

  --hero-ratio: 1.76842;
}
```

### 3. 布局原语

```css
.section {
  display: flex;
  min-height: 100vh;
  min-height: 100svh;
  align-items: center;
  justify-content: center;
  padding: var(--section-y) var(--gutter);
}

.container {
  width: min(var(--container), 100%);
  margin-inline: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: clamp(24px, 3vw, 48px);
}

.grid > * { min-width: 0; }
```

### 4. Hero 艺术指导层

```css
.hero {
  position: relative;
  height: 100vh;
  height: 100svh;
  overflow: hidden;
}

.stage {
  position: absolute;
  top: 50%;
  left: 50%;
  width: max(100vw, calc(100svh * var(--hero-ratio)));
  aspect-ratio: 2688 / 1520;
  transform: translate(-50%, -50%);
  overflow: hidden;
  container-type: inline-size;
  isolation: isolate;
}

/* 舞台内所有定位都用 cqw / svh，而不是 px */
.stage__caption {
  position: absolute;
  left: 6cqw;
  bottom: 8cqw;
  font-size: clamp(14px, 1.2cqw, 22px);
}
```

### 5. 文字层

```css
.display {
  font-size: var(--display-xl);
  line-height: 1.06;
  letter-spacing: 0.004em;
  text-wrap: balance;
}

.body {
  max-width: 62ch;
  font-size: var(--body);
  line-height: 1.7;
}
```

### 6. 溢出兜底

```css
body, .page { overflow-x: clip; }

/* 调试期找越界元素 */
/* 浏览器控制台：
   [...document.querySelectorAll('*')]
     .filter(el => el.getBoundingClientRect().right > innerWidth + 1)
*/
```

## 四、编辑器 / 固化层要遵守的规则

### 允许写入源码的属性

- `color`、`background-color`、`font-weight`、`border-radius`
- `font-size`：转成 `clamp()`
- `padding`：转成 `em` 或 `%`
- `gap`：转成 `clamp()` / `em`

### 不允许写入源码的属性

- 文字的 `width` / `height`
- 容器的 `width` / `height`（除非转成 `%`/`min()`/`max()`）
- `left` / `top` / `margin` 的像素位移
- 固定 `font-size` 的 px

### 编辑操作到 CSS 的映射

| 编辑动作 | 写入源码的形式 |
|---|---|
| 拖宽 | `width: min(480px, 100%)` 或 `width: 40%` |
| 拖高 | `min-height` / `aspect-ratio`，不写死 `height` |
| 水平移动 | `margin-inline` / grid 对齐，不写 `left` |
| 居中 | `margin-inline:auto` / flex `justify-content:center` |
| 字号 | `font-size: clamp(...)` |
| 内边距 | `padding: clamp(...)` |

### 固化（应用到源码）的硬性规则

1. 文本选择器（`p/h1-h6/span/a/button/li`）不输出 `width/height`
2. 所有容器宽度输出为 `%` / `vw`，并加 `max-width:100%; box-sizing:border-box`
3. 不输出 `left/top` 位移
4. 字号统一转 `clamp()`
5. 写入后检查：`document.documentElement.scrollWidth <= innerWidth + 1`

## 五、验收清单

在 360 / 768 / 1024 / 1280 / 1440 / 1920 / 2560 宽度下检查：

- [ ] 没有横向滚动条：`scrollWidth <= innerWidth + 1`
- [ ] 每个 section 内容视觉居中
- [ ] 标题不折行异常，最大/最小字号生效
- [ ] 图片不拉伸，比例正确
- [ ] grid 在窄屏自动减列，不溢出
- [ ] 文字容器可以随内容变高，不被固定高度裁切
- [ ] 页面缩放到 200% 仍可读、不重叠
- [ ] 触屏安全区：`env(safe-area-inset-*)` 生效

## 六、给 DEMO 页的最小改造建议

1. 把 `.hero-visual` 的 680×456 固定卡片改成 `width: clamp(360px, 45vw, 680px); aspect-ratio: 680/456;`
2. 给 `.hero` 增加 `min-height:100svh; display:flex; align-items:center;`
3. `.wrap` 统一改成 `width:min(1200px, calc(100% - var(--gutter)*2)); margin-inline:auto;`
4. 给所有 grid 子项加 `min-width:0`
5. 删除 `ve-applied.js` 里所有文字/容器的 `width/height/left/top/font-size` px
6. 在 `body` 加 `overflow-x: clip`
7. 用 7 档宽度跑一次验收清单

做到以上，页面就不会再因为某个元素的固定尺寸而整体歪掉。
