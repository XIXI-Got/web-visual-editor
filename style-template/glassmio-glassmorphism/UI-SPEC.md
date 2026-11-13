# Glassmio 玻璃拟态 · 流光冰蓝 — UI 规范

**冰蓝环境光上的一层超透白玻璃：单一强调色、4px 密度节奏、卡片只借光不发光。**

版本 1.0 · 2026.11 · 参考视口 1440 × 900 / 移动端 390 × 844
提取来源：单文件参考实现 `glassmio_glassmorphism_dashboard.html`（Tailwind CDN + 内联 SVG 环境光）

> **房屋规则：** 玻璃不是一块灰卡片，而是一片压着光的冰 —— 卡面只给 38%→16%→6% 的 135° 白渐变、1px 高光边和 22px 背景模糊；所有颜色都来自背后的奶油、天蓝与长春花光束，卡片自己**不发光、不上色**。
>
> **本规范是纯文字 / 令牌规范：** 视觉核对请看同目录 `spec-showcase.html`，背景实现看 `background.css` + `caustic-backdrop.svg`。

**配套文件**

- `design-tokens.json` — 硬 token 权威来源（系统从这里提取）
- `design-tokens.css` — 同值 CSS 变量 + `--u` 缩放基准
- `background.css` — 原生环境光背景（**必须一起应用**，玻璃靠它托底）
- `caustic-backdrop.svg` — 精确光焦层源文件（`background.css` 用纯 CSS 渐变近似；想要像素级，按文件末尾写法替换成这张 SVG）
- `spec-showcase.html` — 规范展示页（色板 / 字阶 / 材质 / 组件 / 动效实物）

---

## 01 · 设计原则

| 原则 | 说明 |
| --- | --- |
| **光在背后，不在卡上** | 卡片自身只用白色透明度（38% → 16% → 6%），强调色只出现在按钮、激活态、图表和 ≤2px 的线。给玻璃加彩色 glow 会立刻变成「塑料贴纸」。 |
| **底色必须是彩色氛围** | 冰蓝纸底（`#DCE4FA`）+ 奶油丝带 + 天蓝光束 + 长春花紫阴影袋。没有彩色底，玻璃就退化成半透明白卡 —— 这是整套风格唯一不可省略的前提。 |
| **1px 高光边定义玻璃** | 上/左 1px `rgba(255,255,255,.48)`、下/右 .14–.16；卡面再叠 `inset 0 1px 1px rgba(255,255,255,.72)`。没有这道亮边，「模糊 + 透明」看起来只是脏。 |
| **模糊打底、饱和提纯** | 主玻璃 `blur(22px) saturate(160%)`，亚层 `blur(16px) saturate(150%)`。少了 saturate，背后的彩光会被模糊洗成灰。 |
| **一切都为「读数」服务** | 这是仪表盘：数值 800 字重、tabular-nums、11–13.5px 的紧凑标注、20px 卡片节奏。玻璃只是材质，不牺牲信息密度。 |
| **单一强调色** | royal blue `#5B7CFA` 一处到底：主按钮、激活导航、焦点环、图表主线。语义色（绿/琥珀/玫瑰/天蓝/青/紫）只用于状态点与 sparkline，面积各 < 1%。 |

**执行摘要（硬约束，冲突时以此为准）**

1. 只用 §02 色板 + §03 单一字族；不引入第二主色、第三种字体、纯黑纯白大面积块。
2. 玻璃 = `135° 白渐变 + backdrop-filter blur(16–22px) saturate(150–160%) + 1px 高光边 + 两层 inset 高光`；四者缺一不可，且**禁止**给卡加彩色 `box-shadow` 光晕（唯一例外：Hero 内 indigo/purple 两团 `blur-2xl` 装饰光斑，面积 < 6%）。
3. 尺寸全部取 `--u` / token 阶，不写死任意像素；圆角只用 12 / 16 / 22 / 26 / 28 / pill。
4. 文字：标题 700–800、正文 400–500、微标签 500–600；数字 tabular-nums；**不做全大写微标签**（与本仓库 Spatial Glass 相反）。
5. 背景必须随前景一起换（`background.css`），禁止只改卡片不改底色。
6. 强调色面积 < 8%，且不用于长文本；正文只用 `ink` / `ink-muted` 两色。

---

## 02 · 色彩

### 色板

| Token | 色值 | 角色 | 说明 / 使用位置 |
| --- | --- | --- | --- |
| `--paper` | `#DCE4FA` | 页面底色 | 冰蓝雾面底，`html` 的 `background-color` |
| `--paper-deep` | `#CDD9F8` | 底色深处 | 125° 线性渐变中段，给玻璃一个暗底托住 |
| `--ink` | `#1E293B` | 主文字 / 结构 | 卡片标题、KPI 数值、导航常态；不用 `#000` |
| `--ink-muted` | `#5C6C84` | 次级文字 | 说明、单位、轴标签、时间戳（正文唯一允许的颜色） |
| `--accent` | `#5B7CFA` | 强调色 | 主按钮、激活导航、焦点环、图表主线（面积 < 8%） |
| `--accent-deep` / `--accent-bright` | `#4E6EF2` / `#6484FF` | 强调渐变两端 | 主按钮 135° 渐变；激活导航文字 `#4364F7` 为同族加深 |
| `--accent-soft` | `#93B4FF` | 弱强调 | 图表副线、面积填充下部、进度条 |
| `--accent-violet` | `#6B66F8` | 标题渐变紫端 | Hero 标题第二行 `bg-clip-text` 渐变终点 |
| `--indigo` | `#4F46E5` | 深靛 | 图标底色 / 渐变深端 / hover 加深 |
| `--beam-cream` | `#FFF9F4` | 暖奶油光束 | 左下卷曲光带，环境光里唯一的暖色 |
| `--beam-ice` | `#E8F5FF` | 冷白冰光束 | 右上 45° 光带高光段 |
| `--lilac` | `#D4D7F5` | 长春花紫阴影袋 | 左下 / 中上折角，玻璃的「阴影色」 |
| `--glass-tint` / `--glass-tint-mid` | `rgba(255,255,255,.38)` / `.16` | 玻璃面白 | 135° 渐变 0% / 52% 位；末端 `.06` 写在渐变里 |
| `--glass-stroke` | `rgba(255,255,255,.48)` | 亚层玻璃边框 | 上/左亮，下/右 `.14–.16`；固定 1px 不加重 |
| `--hairline` | `rgba(255,255,255,.35)` | 卡片内分隔线 | `border-top` / `border-bottom`，固定 1px |
| `--positive` | `#34D399` | 正向语义 | ↑ 增长、在线点、完成勾（8–14px 圆点 / 11px 文字） |
| `--warning` | `#FBBF24` | 警示语义 | 待办点、日程点（仅圆点 / 图标） |
| `--rose` | `#F43F5E` | 喜爱语义 | 收藏心形选中态（仅图标） |
| `--sky` / `--teal` / `--violet` | `#93C5FD` / `#2DD4BF` / `#A855F7` | 数据语义 | 第 2 / 4 / 3 条 sparkline 与玻璃透镜高光 |
| `--focus` | `#5B7CFA` | 焦点环 | 2px 实线 + 2px offset，永不移除 |

### 配比

近似面积配比：**底色与光 62% / 玻璃面 26% / 文字 9% / 强调 2.5% / 语义点 0.5%**。
强调色永远作为少量信号出现；底色一旦压过 70%，玻璃就变成「白纸上的白卡」。

### 对比度与使用约束

| 组合 | 对比度 | 结论 |
| --- | --- | --- |
| `ink` / `paper` | ≈ 11.5:1 | AAA，可承载标题与关键数值 |
| `ink` / 玻璃顶面（≈ `#E7ECFC`） | ≈ 10.2:1 | AAA |
| `ink-muted` / 玻璃顶面 | ≈ 4.5:1 | AA 边界，正文标准（13.5px 只放在玻璃卡上） |
| `ink-muted` / 裸 `paper` | ≈ 4.2:1 | 仅 ≥16px 或 600 字重可用，不承载长正文 |
| `#FFF` / `accent-deep`（按钮暗端） | ≈ 4.3:1 | 13.5px / 600 可读；严格 AA 校验时把渐变整体压深一档（`#4E6EF2 → #3F5AD8`） |
| `accent` / `paper` | ≈ 2.9:1 | **仅图形**：线、点、图标、边框，不承载文字 |

规则：

- 禁止纯黑 `#000` / 纯白 `#FFF` 作为大面积底；白色只以透明度形式出现在玻璃里。
- 正文只允许 `ink` 与 `ink-muted`；强调色不用于段落文字。
- 状态语义色只允许出现在圆点、图标、sparkline 和 ≤11px 的涨跌幅文字。
- 玻璃卡上的文字若压到彩色光束（Hero 右侧），必须让卡片自身提亮到 `--glass-grad` 顶档（.44 / .20 / .09）再放文字。

---

## 03 · 字体

### 字体家族

| 角色 | Token | 字体栈 | 说明 |
| --- | --- | --- | --- |
| 展示 + 正文 | `--font-sans`（`--font-display` 为同值别名） | `"Plus Jakarta Sans", "Inter", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif` | **全站单一字族**：标题、正文、数字、标签都走它 |

**不引入第三种字体，也不使用等宽字体。** 中英同栈：英文渲染 Plus Jakarta Sans，中文回退思源黑体 / 苹方 / 微软雅黑。
Plus Jakarta Sans 的特征是**几何骨架 + 略收的字距 + 800 字重不呆**，这正是这套风格「清爽科技感」的来源；换成衬线或圆体会立刻跑偏。

### 字阶

| 角色 | 字号（clamp） | 字重 | 行高 | 字距 | 大小写 | 颜色 |
| --- | --- | --- | --- | --- | --- | --- |
| hero | `clamp(26px, calc(16*--u + 14px), 34px)`（28→32） | 800 | 1.16 | -.025em | none | ink（第二行 accent→accent-violet 渐变字） |
| section | `clamp(15px, calc(2*--u + 14px), 17px)`（16） | 700 | 1.3 | -.012em | none | ink |
| cardTitle | `clamp(13.5px, calc(2*--u + 12.5px), 15.5px)`（14–15） | 700 | 1.3 | -.01em | none | ink |
| metric | `clamp(19px, calc(7*--u + 14px), 22px)`（20–21） | 800 | 1.1 | -.02em | none | ink，**tabular-nums** |
| metricBig | `clamp(28px, calc(20*--u + 14px), 36px)`（34） | 800 | 1.05 | -.02em | none | ink，tabular-nums（天气温度，全站最大数字） |
| body | `clamp(13px, calc(1.5*--u + 12px), 14px)`（13.5） | 400 | 1.62 | .002em | none | ink-muted，行宽 ≤ 46ch |
| navItem | `clamp(13.5px, calc(1*--u + 13px), 14.5px)`（14） | 500 → 600（激活） | 1.3 | .005em | none | ink-muted → ink |
| label | `clamp(11px, calc(2*--u + 10.5px), 13px)`（12–13） | 600 | 1.35 | .01em | none | ink |
| micro | `clamp(10px, calc(1*--u + 10px), 11.5px)`（10.5–11.5） | 500–600 | 1.3 | .02em | none | ink-muted |
| badge | `max(9.5px, calc(9.5*--u + .5px))`（10） | 600 | 1.2 | .02em | none | 语义色 / accent（胶囊内） |

### 排版规则

- 标题 700–800，正文 400–500，微标签 500–600；**中文标题字重 ≥ 600**，不允许把整段中文放在 < 400 的字重上。
- 数字统一 `font-variant-numeric: tabular-nums`（KPI、时间码、坐标轴、涨跌幅）。
- 不做全大写微标签，不加字距式「标签感」；这套风格的秩序来自字号阶与卡间距，不来自大写。
- 正文最大行宽 46ch；卡片内的说明文字最多 2 行，超出用 `truncate`（`overflow:hidden; text-overflow:ellipsis`）。
- Hero 标题强制两行：第一行纯 `ink`，第二行 `background: var(--heading-grad); -webkit-background-clip: text; color: transparent`。
- 禁止给标题加 `text-shadow`；玻璃上的文字靠卡面白度保证可读，不靠阴影。

---

## 04 · 版式与构图

### 页面节奏

`玻璃导航条（sticky 左栏） → Hero 横幅（左文右透镜） → 分析图卡 → 4×KPI → 活动流 → 底排五件套（天气 / 日历 / 任务 / 音乐 / 快捷宫格）`。
一整页就是一屏仪表盘：模块之间只有 20px 间距，靠**卡片圆角 + 玻璃面**分区，不靠色块或分割线。

### 页面栅格

| 项 | 值 |
| --- | --- |
| 外壳最大宽 | `min(1540px, calc(100% - 2 * var(--space-gutter)))`，`margin-inline: auto` |
| 外壳内边距 | 12px（<640）/ 20px（<1024）/ 24px（≥1024） |
| 侧栏 | 245px，`position: sticky`，高 `calc(100svh - 3rem)`；<1024px 变抽屉 + 遮罩 |
| 主区 | flex 单列，`gap: 20px` |
| 主网格（≥1280） | 12 列：左 6（Hero + Analytics）/ 右 6（KPI + Recent Activity） |
| 底排（≥1024） | 12 列 = 2 + 2 + 3 + 3 + 2 |
| KPI 行 | 2 列（<640）→ 4 列（≥640） |
| 卡片间距 | `20px`；KPI 之间 14–16px |

### 玻璃外壳解剖

| 项 | 值 / 规则 |
| --- | --- |
| 外壳结构 | `display:flex`（<1024）→ `flex-direction:row`（≥1024）；`gap:20px`；高度不足时页面自然滚动，不锁死视口高度 |
| 侧栏玻璃 | `radius 26px` / `padding 16px` / 占满可见高度（`calc(100svh - 3rem)`）/ 品牌区 → 导航（gap 6px）→ 底部升级卡 + 用户行，`justify-content: space-between` |
| 导航项 | 高 42px / `radius 16px` / `padding 0 14px` / 18px 线性图标 + 14px 文字，`gap 12px` |
| 移动端 | 侧栏 `translateX(-115%)` → 0，`transition 300ms`；遮罩 `rgba(15,23,42,.20)` + `blur(4px)` |
| 顶栏 | 高 40px，左搜索胶囊（`flex:1; max-width:28rem`）+ 右当前视图胶囊 / 通知 / 主题三键，`gap 10px` |

### 卡片内解剖（以 KPI 卡为例）

| 项 | 值 / 规则 |
| --- | --- |
| 尺寸 | `radius 22px` / `padding 16px` / 高度随内容（`min-height` 不要写死） |
| 图标砖 | 32×32px / `radius 12px` / `background: color-mix(in srgb, accent 15%, transparent)` / `1px rgba(255,255,255,.60)` / 16px 图标 |
| 名称 | 11.5px / 500 / ink-muted |
| 数值 | 20–21px / 800 / ink / tabular-nums，距名称 2–4px |
| 底部 | 左 ↑12.5% 11px/600 positive，右 56×24 sparkline（`flex-end` 对齐），距数值 10px |
| 装饰 | 仅 sparkline 一条面积渐变；不放背景图、不放光晕 |

### 间距

- 基础单位：**4px**；卡片内 16 / 20 / 24，卡之间 20，KPI 之间 14–16。
- 间距阶：`2, 4, 8, 10, 12, 14, 16, 20, 24, 32`。
- 规则：只用阶内值；同一行内元素间距 ≤ 12px；**卡片外不要出现 40px 以上的空档**（这是密度型仪表盘，不是营销页）。

---

## 05 · 组件

> 每个玻璃组件都必须写清：底色渐变方向、模糊半径、边框亮度、inset 高光、hover 行为。玻璃的差别全在这五项。

### 玻璃卡 Glass Card（大面积 / 一级容器）

```css
background: linear-gradient(135deg,
  rgba(255,255,255,.38) 0%,
  rgba(255,255,255,.16) 52%,
  rgba(255,255,255,.06) 100%);
backdrop-filter: blur(22px) saturate(160%);
box-shadow:
  0 18px 42px -12px rgba(79,108,220,.14),
  0 4px 16px -2px rgba(15,23,42,.04),
  inset 0 1px 1px rgba(255,255,255,.72),
  inset 0 -1px 1px rgba(255,255,255,.12);
border-radius: 26px;   /* KPI 卡 22px */
```

| 状态 | 底色 | 边框 / 阴影 | 说明 |
| --- | --- | --- | --- |
| 默认 | `.38 / .16 / .06` | 双 inset 高光 + 蓝色柔影 | 不做 1px 实描边（高光边就是边） |
| hover（可交互卡） | `.44 / .20 / .09` | 阴影加强为 `glass-hover` | `translateY(-2px)`，`280ms cubic-bezier(.22,1,.36,1)`；只提亮不换色 |
| 无 `backdrop-filter` 支持 | `.72 / .58` 白 + 冰蓝 | 保留阴影 | 退化为实白玻璃，不允许变透明空壳 |
| 禁用做法 | — | — | 不加彩色 glow、不加 1px 灰描边、不做双层叠玻璃（除非内层是 subcard） |

### 亚层玻璃 Glass Subcard（卡内按钮 / 磁贴 / 快捷卡）

`.34 → .10` 135° 白渐变 + `blur(16px) saturate(150%)` + `border 1px rgba(255,255,255,.48)`（右/下 `.14–.16`）+ `shadow-subcard`。
hover：`.50 → .22` + `translateY(-2px)` + `shadow-subcard-hover`，`220ms ease`。
**规则：同一张卡里的 subcard 不超过 6 个，且不能再套第三层玻璃。**

### 导航项 / 激活胶囊

| 状态 | 底色 | 文字 | 边框 |
| --- | --- | --- | --- |
| 默认 | 透明 | `ink-muted` 500 | 无 |
| hover | `rgba(255,255,255,.25)` | `ink` | 无 |
| 激活 | `135° rgba(91,124,250,.22) → rgba(255,255,255,.24)` | `#4364F7` 600 | `1px rgba(255,255,255,.62)`，下边 `.22`，`shadow-nav-active` |
| 键盘焦点 | — | — | `2px var(--focus)` + `2px offset` |

### 按钮 Button

| 状态 | 底色 | 文字 | 圆角 | 说明 |
| --- | --- | --- | --- | --- |
| 主按钮 默认 | `135° #6484FF → #4E6EF2` | `#FFF` 13.5px 600 | pill（高 40px，padding 0 20px） | `shadow-accent` + `inset 0 1px 1px rgba(255,255,255,.50)` |
| 主按钮 hover | 同上 + `filter: brightness(1.04)` | 同上 | pill | `translateY(-1px)` + `shadow-accent-hover`，`250ms` |
| 主按钮 active | 同上 | 同上 | pill | `translateY(0)`，阴影回收 |
| 次按钮（玻璃） | `glass-subcard` | `ink` 600 | pill | hover 仅提亮，不位移阴影 |
| 图标按钮 | `glass-card` 圆 | `ink-muted` → `ink` | 圆 / pill（40px） | 通知点 8px `accent` + 2px 白环 |
| 禁用 | `rgba(255,255,255,.28)` | `ink-muted` 40–50% | pill | 不加阴影，`cursor: not-allowed` |

### 搜索胶囊

高 40px / pill / `glass-card`；左侧 16px 线性放大镜（`pointer-events:none`），输入文字 13.5px `ink`，placeholder `ink-muted` 85%；右侧 `⌘K` 键帽 11px/500 `ink-muted` + `bg rgba(255,255,255,.35)` + `1px rgba(255,255,255,.60)` + `radius 8px`。聚焦：`ring 2px rgba(91,124,250,.40)`。

### 图表 Chart（双平滑曲线）

- 主线 `accent` 2.6px、副线 `accent-soft` 2.2px，`stroke-linecap: round`；面积渐变从 `rgba(91,124,250,.34)` 到透明。
- 网格线 `#94A3B8` 22% 虚线 `3 3`，基线 28%；轴标签 11px `ink-muted`。
- 曲线用三次贝塞尔平滑（控制点在 45% / 55%），不用 `catmull-rom` 过度振荡。
- hover：竖向虚线指示 + 玻璃 tooltip（`bg rgba(255,255,255,.75)`、`blur(12px)`、`1px rgba(255,255,255,.80)`、`radius 12px`、11.5px）。
- 禁止：3D 效果、渐变描边、图表区背景色块。

### 胶囊标签 / 头像 / Toast / Modal

| 组件 | 规格 |
| --- | --- |
| 标签胶囊 | pill / 10px 600 / 底色为语义色 15% / 文字同色加深 700 / `padding 2px 8px` |
| Live 标记 | 11px 600 `accent` / `bg rgba(255,255,255,.35)` / `1px rgba(255,255,255,.50)` / pill |
| 头像 | 36px 圆 / `object-fit: cover` / `1px rgba(255,255,255,.80)` 描边；在线点 10px `positive` + 2px 白环 |
| Toast | 右下 20px / `radius 16px` / `glass-card` / `padding 12px 16px` / `accent` 圆点 + 13px 600 文案 / 2600ms 后 300ms 淡出 8px |
| Modal | `radius 28px` / `glass-card` / 最大宽 28rem / 遮罩 `rgba(15,23,42,.20)` + `blur(4px)` / 关闭键 32px 圆形 `bg rgba(255,255,255,.45)` |

---

## 06 · 动效

### 缓动

| 名称 | 值 | 用途 |
| --- | --- | --- |
| `--ease` | `cubic-bezier(.22, 1, .36, 1)` | 卡片抬升、按钮、主题切换（主缓动，只在 280ms 内用） |
| `--ease-soft` | `cubic-bezier(.4, 0, .2, 1)` | subcard 提亮、颜色过渡 |
| 线性 | `linear` | 呼吸 / 浮动等无限循环动画用 `ease-in-out`，禁止回弹 |

### 关键动效时序

| 动效 | 时长 | 说明 |
| --- | --- | --- |
| 玻璃卡 hover | `280ms` | `translateY(-2px)` + 底色提亮 + 阴影加强，三者同帧 |
| 亚层 hover | `220ms` | 只提亮 + 抬 2px |
| 按钮 hover | `250ms` | `translateY(-1px)` + `brightness(1.04)` |
| 环境光呼吸 | `14000ms` | `opacity .86→1`、位移 `(-12px, 10px)`、`scale 1→1.03`，`alternate infinite` |
| 透镜上浮 | `7000ms` | `translateY 0→-7px`、`rotate -18°→-15°` |
| 透镜下浮 | `8000ms` | `translateY 0→6px`、`rotate 14°→17°` |
| 音乐均衡条 | `450–750ms` | 三条错峰 0 / 150 / 300ms |
| 主题色调切换 | `400ms` | 换底色时只过渡 `background-image`，不闪白 |

**动效数量上限：** 每个视口最多 1 个环境动效（呼吸光束 **或** 浮动透镜）+ 局部 hover 反馈。仪表盘不是动效展示页。

### 无障碍

- 必须支持 `prefers-reduced-motion: reduce`：关掉浮动 / 呼吸 / 抬升位移，只保留 ≤150ms 的透明度变化。
- `hover` 提亮不是唯一的状态信号：激活导航必须有文字色差 + 边框，不能只靠底色。
- 动画不做视差滚动；玻璃层 `pointer-events: none`，不拦截点击。

---

## 07 · 影像与文案

### 影像

| 项 | 规则 |
| --- | --- |
| 头像 / 封面 | 1:1 正方形，`object-fit: cover`，圆形裁切，1px 白 80% 描边 |
| 专辑封面 | 1:1 / 56px / `radius 16px` / 三层渐变（indigo-300 → purple-300 → sky-300）+ 内圈径向高光 + 底部 accent 压暗 |
| 挂图 | 加载失败必须兜底：`accent` 底 + 白色姓名缩写（`onerror` 切换），不允许出现破图图标 |
| 装饰图形 | 只允许两类：Hero 两团 `blur-2xl` 光斑（≤6% 面积）、两片 3D 椭圆玻璃透镜（SVG 渐变） |
| 禁用 | 实拍大图铺底、噪点滤镜、二次彩色渐变描边、大面积纯白块、emoji 当图标 |

### 文案

- 语气：**克制、产品化、动词开头**。「Design the future.」「Upgrade to Pro」「View All Activity」。
- 标题长度：英文 ≤ 6 词 / 中文 ≤ 12 字；KPI 名称 ≤ 2 词。
- 禁用词：`惊艳 / 炫酷 / 未来感十足 / 奢华`，以及任何自夸形容词堆叠。
- 示例：
  - 好：`Design the future. With clarity & glass.` / `Recent Activity · Live Feed`
  - 坏：`EXPERIENCE THE ULTIMATE GLASSMORPHISM REVOLUTION!`

---

## 08 · 响应式与无障碍

### 断点

| 名称 | 值 | 主要变化 |
| --- | --- | --- |
| phone | `≤ 639px` | 单列；侧栏变抽屉；KPI 2 列；Hero 文字在上、透镜在下并缩小到 208px 宽；外壳 padding 12px |
| tablet | `640–1023px` | KPI 4 列；底排 2 列；侧栏仍是抽屉；顶栏显示当前视图胶囊 |
| laptop | `1024–1279px` | 侧栏常驻 245px；底排 12 列（2+2+3+3+2）；主网格仍单列堆叠 |
| desktop | `≥ 1280px` | 主网格 12 列左右分栏；Hero 高度 ≥ 255px；外壳最大 1540px 居中 |

- 尺寸全部由 `--u`（`clamp(.45px, 100vw / 1440, 1px)`）+ `clamp()` 驱动；媒体查询只切结构与比例，不改具体像素值。
- 容器一律 `width: min(var(--container), calc(100% - 2 * var(--space-gutter)))` + `margin-inline: auto`；`body` / `.page` 加 `overflow-x: clip`。
- 所有 grid / flex 子项 `min-width: 0`，长数字和长单词允许 `truncate`。
- 页面高度 `min-height: 100svh`，不写死 `height`。

### 无障碍清单

- [ ] 正文对比度 ≥ 4.5:1（大字 ≥ 3:1）；`ink-muted` 只出现在玻璃面（≈4.5:1）
- [ ] 焦点可见：`2px var(--focus)` + `2px offset`，永不移除；玻璃上的焦点环有足够对比
- [ ] 触控目标 ≥ 44 × 44px（实际图标按钮 40px，移动端补到 44px）
- [ ] 动效可关闭（`prefers-reduced-motion`）；不做闪烁
- [ ] `backdrop-filter` 不可用时退化为实白玻璃，文字仍可读
- [ ] 图表有文本替代（数值列表 / `aria-label`），不只靠颜色区分数据系列
- [ ] 玻璃层 `aria-hidden="true"` + `pointer-events: none`

---

## 09 · 令牌与交付

### CSS 变量清单

```css
:root {
  /* 缩放基准 */
  --design-w: 1440;
  --u: clamp(.45px, calc(100vw / var(--design-w)), 1px);

  /* 色彩 */
  --paper: #DCE4FA;
  --paper-deep: #CDD9F8;
  --ink: #1E293B;
  --ink-muted: #5C6C84;
  --accent: #5B7CFA;
  --accent-deep: #4E6EF2;
  --accent-bright: #6484FF;
  --accent-soft: #93B4FF;
  --accent-violet: #6B66F8;
  --beam-cream: #FFF9F4;
  --beam-ice: #E8F5FF;
  --lilac: #D4D7F5;
  --glass-stroke: rgba(255,255,255,.48);
  --hairline: rgba(255,255,255,.35);
  --positive: #34D399;
  --focus: #5B7CFA;

  /* 字体 */
  --font-sans: "Plus Jakarta Sans", "Inter", "Source Han Sans SC",
               "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-display: var(--font-sans);   /* 同值别名：全站单一字族 */

  /* 玻璃 */
  --glass-blur: calc(22 * var(--u));
  --glass-blur-sub: calc(16 * var(--u));
  --glass-sat: 160%;
  --glass-grad: linear-gradient(135deg,
      rgba(255,255,255,.38) 0%, rgba(255,255,255,.16) 52%, rgba(255,255,255,.06) 100%);

  /* 圆角 / 阴影 / 动效 */
  --radius-sm: calc(12 * var(--u));
  --radius-md: calc(16 * var(--u));
  --radius-lg: calc(22 * var(--u));
  --radius-xl: calc(26 * var(--u));
  --radius-pill: 999px;
  --shadow-glass: 0 18px 42px -12px rgba(79,108,220,.14), 0 4px 16px -2px rgba(15,23,42,.04);
  --ease: cubic-bezier(.22, 1, .36, 1);
}
```

### 治理

- 令牌唯一来源是 `design-tokens.json`；改色 / 改圆角必须同步 `design-tokens.css` 与本文件，三处不一致视为缺陷。
- 页面里不允许写死色值（除透明度的白/黑覆盖层），必须引用变量。
- 玻璃的五个参数（渐变方向、白度、blur、saturate、边框亮度）是**同一组**，只能整体调档，不能单点改。
- `background.css` 与前景是一体的：应用本风格时必须同时替换背景，否则玻璃失去光源。

---

## 附录 · 给 Agent 的执行摘要（6 条硬约束）

1. 只用 §02 色板与 §03 的**单一** `Plus Jakarta Sans` 栈；不加第二主色、不加衬线 / 等宽 / 圆体。
2. 玻璃卡只允许 `135° 白渐变(.38→.16→.06) + blur(22px) saturate(160%) + 1px 白 .48 高光边 + 双 inset 高光`；**禁止**彩色 `box-shadow` 光晕。
3. 强调色 `#5B7CFA` 面积 < 8%，只用于主按钮、激活态、焦点环、图表主线；正文只用 `ink` / `ink-muted`。
4. 尺寸走 `--u` / clamp / token 阶；容器 `min()` + `margin-inline:auto`；不写死文字宽高、不用 `left/top` 像素位移、每个 grid 子项 `min-width:0`、`body` 加 `overflow-x:clip`。
5. 背景必须一起换：`background.css` 的冰蓝底 + 奶油 / 天蓝 / 长春花光焦层；只改前景不改背景等于没应用。
6. 数字 tabular-nums；不做大写微标签；动效只用一种环境动效 + hover 反馈，并支持 `prefers-reduced-motion: reduce`。
