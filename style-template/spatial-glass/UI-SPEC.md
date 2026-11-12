# Spatial Glass 拟态玻璃暗色界面 — UI 规范

**漂浮玻璃面板 / 环境模糊 / 空间深度**
版本 1.0 · 2026.11 · 参考视口 1440 × 900（基准设计宽 1440）/ 移动端 390 × 844

> **房屋规则：界面不是贴在页面上，而是「浮」在一张失焦夜景照片前面——全站只有一块玻璃，所有光都来自照片里的室内灯。** 纯文字 / 线框规范，不附照片与截图，影像只以比例、位置与图层参数记录。

配套：`design-tokens.json`（硬 token，所有数值的权威来源）、`design-tokens.css`（同值变量）。**§01 的执行摘要优先于一切细节。**

## 01 · 设计原则

| 原则 | 说明 |
| --- | --- |
| **同一块玻璃** | 全站只有一种材质：`tint + 158° 渐变 + 1px 亮边 + backdrop-blur`。卡片/开关/日历/播放器全复用 `--glass-*`；实心块只允许在「玻璃关闭」态。 |
| **光是借来的** | 暖光来自背景照片。禁止给玻璃加彩色外发光或彩色渐变描边；唯一自发光是琥珀细边高光与焦点环。 |
| **比例先于像素** | 一切尺寸 = `N × var(--u)`，`--u` 在 1440 视口恰为 1px；一致性靠比例，不靠断点改字号。 |
| **两端让步** | 背景左下压暗给标题，右中留亮给面板折射；任一方向破坏，文字或玻璃立刻失效。 |

**执行摘要（硬约束）**
1. 只用 §02 色板与 §03 两个字体栈：不加新主色、不加第三种字体、不用纯黑白。
2. 只调现有元素样式与排布，不重写结构、不加装饰性元素；面板一律复用 `--glass-*`。
3. 尺寸走 `calc(N * var(--u))`，圆角取 `10/14/22/30u + pill`，间距取阶内值，禁写死任意像素。
4. 琥珀是唯一强调色且面积 < 3%，只用于当前选中、滑杆填充、状态点与一个关键数字；禁彩色发光。
5. 照片是唯一光源：文字不得直压最亮折射区（靠左侧 scrim 或面板承载）。
6. 中文只用 `--font-ui` 且字重 ≥ 400，不与 230 字重的拉丁展示字体同行。

## 02 · 色彩

| Token | 色值 | 角色 |
| --- | --- | --- |
| `--paper` / `--void` | `#07060a` | 页面最底、遮罩底；全站唯一「黑」 |
| `--void-warm` | `#0d0a07` | 照片未加载时的暖炭兜底 |
| `--ink` | `#f6f1e9` | 主文字、面板标题、数值 |
| `--ink-strong` | `#fffcfa` | Hero 大字、选中态（最亮，不用 `#fff`） |
| `--ink-dim` | `rgba(243,236,224,.64)` | 正文、次级说明、kicker（正文唯一允许色） |
| `--ink-faint` / `--ink-ghost` | `rgba(243,236,224,.42)` / `.24` | 单位、时间码、页脚 / 图表轴与占位（仅装饰） |
| `--amber` | `#e8c496` | 唯一强调：选中日期、滑杆填充、状态点、峰值、焦点环（< 3%） |
| `--amber-hi` / `--amber-lo` | `#fbe6c4` / `#b98a56` | 琥珀高光 / 暗部（头像底、渐变暗端） |
| `--mint` / `--sky` / `--rose` | `#86dcae` / `#a9c7de` / `#e8a292` | 仅状态语义 Done / In Progress / Review（< 2%） |
| `--glass-tint` / `--glass-stroke` | `rgba(18,13,10,.20)` / `rgba(255,255,255,.155)` | 玻璃底 / 1px 外框（hover → .30，固定 1px） |
| `--line` / `--line-soft` | `rgba(255,255,255,.10)` / `.06` | 分隔线 / 卡片内细线 |

配比：照片与暗部 ≈ 62% / 玻璃 28% / 文字与线 7% / 琥珀 ≤ 3%。琥珀只做「当前选中 + 一个数字 + 一条填充」。

对比度（玻璃合成暗部 `#1c1713` / 亮部 `#241f1b`）：ink/底 17.97、ink/玻璃 15.81、ink-strong/玻璃 17.40、ink-dim/玻璃 6.80（AA 正文）、ink-faint/玻璃 3.65（仅 ≥10px 辅助）、ink/玻璃亮部 14.51、amber/玻璃 10.81、amber-lo/玻璃 5.78（仅图形与 ≥14px）。

禁用：不用纯黑白；玻璃上不叠彩色 glow；琥珀不做大面积底；不新增比 `--ink-faint` 更淡的字。

## 03 · 字体

`--font-display` 仅拉丁大写标题（Inter Tight → Neue Haas → Segoe UI Variable Display → Arial）；`--font-ui` = Inter（自托管 variable woff2，latin 48 KB，weight 100–900）+ 系统中文字体；`--font-mono` 仅左下印章。完整字体栈见 `design-tokens.json`。不引入第四种字体。

| 角色 | 字号（1440 时） | 字重 | 行高 | 字距 | 大小写 | 颜色 |
| --- | --- | --- | --- | --- | --- | --- |
| hero | `clamp(46px, 60u+16px, 84px)` → 76px | 230 | .92 | .048em | upper | ink-strong |
| lede | `max(9.5px, 8.6u+1px)` | 400 | 2.1 | .215em | upper | ink-dim |
| panelTitle | `clamp(15px, 14u+2px, 18px)` → 16px | 460 | 1.14 | -.012em | none | ink-strong |
| metric | `clamp(30px, 30u+6px, 46px)` → 36px | 300 | 1 | -.02em | none | ink-strong |
| body | `clamp(12.5px, 11u+1.6px, 14.5px)` | 400 | 1.5 | .002em | none | ink-dim |
| kicker | `clamp(10px, 8u+1.2px, 11.5px)` | 400 | 1.3 | .01em | none | ink-dim |
| label | `max(9px, 8u+1.2px)` | 500 | 1.2 | .16em | upper | ink-faint |
| micro | 7–7.5px（唯一允许 < 9px 处） | 500 | 1.2 | 0–.06em | upper | ink-faint |
| stamp | mono `~9.5px` | 400 | 2.15 | .3em | upper | ink-faint |

数字全部 `tabular-nums`；大写微标签字距 ≥ .14em、正文 ≤ .005em；正文行宽 ≤ 34ch；hero 每行 ≤ 7 个大写字母。

## 04 · 版式与构图

节奏：固定顶栏 → 双栏 Hero（左宣言 24% / 右工作台 76%）→ 页脚两行标语。1440×900 一屏完整呈现；1280–1920 实测 page height = 900，无纵向滚动。

| 项 | 值 |
| --- | --- |
| 内容宽 / 边距 | `min(1400u, 100% - 2*--gutter)` → 1440 时 1380px；`--gutter: max(16px, 30u)` |
| Hero | `minmax(0,.62fr) minmax(0,2.1fr)` gap 30u；左栏 `space-between`，印章贴底与工作台等高 |
| 工作台 | `minmax(0,1.92fr) minmax(0,1fr)` gap 16u；≤1420 收窄为 `1.72fr / 1.06fr` |
| 舞台 | 12 栅格 × 4 行，gap 12u，行高 `minmax(100u/100u/106u/112u, auto)` |
| 轨道 | 2 列瀑布（左 toggles→levels→music，右 calendar→volume→brightness→activity），高度差 ≤ 6%，卡片不拉伸 |

舞台分区：focus 列 1–4 × 行 1–2；overview 5–9 × 1–2；profile 10–12 × 1–3；weather 1–4 行 3；upcoming 5–9 行 3；performance 1–6 行 4；tasks 7–12 行 4。
间距：单位 `--u`；阶 `2/4/6/8/10/12/14/16/18/20/22/24/26/30/34/38`；面板内边距 20u、面板间距 12u、大块 26–38u、文字内部 2–6u。

## 05 · 组件

| 组件 | 规格 |
| --- | --- |
| **Glass Panel**（唯一材质） | radius 22u、padding 20u、1px `rgba(255,255,255,.155)`；底 = `--glass-tint` + `--glass-grad`（158°，白 .105 → .038 → 黑 -.05 → -.19）；`backdrop-filter: blur(20u) saturate(118%)`；阴影/内高光取 `--shadow-glass` / `--shadow-glass-inner`；hover 只提边色到 .30，禁位移缩放 |
| **玻璃状态** | `html[data-glass]` on/off（off：blur 归 0、tint → `rgba(16,13,10,.62)`、渐变改实色暖玻璃）；`html[data-blur-level]` off/low/md/high = blur 0 / 7u / 20u / 34u |
| **Switch / 分段器** | 开关 40u×22u、knob 16u 白圆，on 时轨道 `rgba(232,196,150,.35)` + knob 右移 18u；分段器 3 档等宽 grid，active = `rgba(255,255,255,.10)` + 图标转 amber，`role="radiogroup"` |
| **Calendar** | 7 等宽列、单元格 `aspect-ratio:1`、10.5px；邻月 .3 透明；选中日 amber 实心圆 + `0 0 0 4px rgba(232,196,150,.14)`；今日 1px 亮环；月份 `aria-live` |
| **Slider** | 轨道 2px（未填充 `rgba(255,255,255,.16)`、已填充 amber）、拇指 9u 白圆 + amber 光；`--fill` 由 JS 写入，填充终点落于拇指圆心 |
| **Dock / Chip / Button** | Dock 胶囊玻璃 padding 4u、item 30u、active 拉高显示 9px 标签；Chip pill / `rgba(255,255,255,.055)` / 10.5px；按钮四型 solid（#f6f1e9 + #14100a）/ glass（1px 玻璃边）/ outline（透明底、10px 大写 .16em）/ icon（29u 圆），hover 统一 `translateY(-1px)` + 提亮 |

## 06 · 动效

缓动：`out = cubic-bezier(.22,.68,.28,1)`（入场/hover/位移）、`soft = cubic-bezier(.4,.2,0,1)`（遮罩/模糊/颜色）。
时序：面板入场 900ms / 位移 16u / 错峰 `索引×65ms`；玻璃开关 320ms、档位 500ms；面板 hover 边色 500ms；曲线描线 1400ms；30 柱错峰 20ms；计数 1200ms（rAF）；声波 1500ms、扫描 5500ms 循环。
无障碍：`prefers-reduced-motion: reduce` 时位移/缩放归零、时长 ≤ 1ms、内容直接显示；每视口主动效最多 1 个。

## 07 · 影像与文案

主背景 2560×1102（≈2.32:1）失焦夜景建筑，`cover`，焦点 50% 50%；竖版 1200×1800（2:3）由主图中部裁切，≤760px 启用；兜底 1600×689（σ26 模糊）供不支持 `backdrop-filter` 时作面板底。
图层顺序：照片 → amber glow（screen .20）→ 竖向窗格线（1px/84u，.14）→ 颗粒（opacity .055，overlay）→ 三段暗角（左向 .60→.30→.08→透明，径向 .46，上下 .38/.55）；`--scene-brightness` 0.62–1.18 仅作用于照片层。完整参数见 `design-tokens.json` 的 `effects` / `imagery`。
禁用：亮底照片、清晰对焦主体、大面积纯色天空、霓虹彩光、二次彩色渐变。

文案：克制、技术自证，像说明书不像广告；面板标题 ≤ 2 词，hero ≤ 6 个大写字母一行；中文仅眉题副标题（≤ 12 字）；禁感叹号与「震撼/极致/赋能」。好：`Clarity is the new speed.` 坏：`震撼！超越想象的下一代玻璃界面`。

## 08 · 响应式与无障碍

≤1420 工作台收窄、微标签降档；≤1180 Hero 单列（标题 `clamp(44px,8.2vw,78px)`）；≤1023 舞台 6 列、轨道移到舞台下方 2 列；≤900 导航折叠为玻璃下拉 + 汉堡；≤760 换竖版照片 + 左向强 scrim；≤620 全部单列、轨道 1 列；≤400 顶栏压缩。
正文 ≥ 4.5:1、大字 ≥ 3:1（最暗 6.80）；`:focus-visible` 2px `--amber` + offset 3px 永不移除；reduced-motion 全量降级；`scrollWidth ≤ innerWidth + 1` 在 360/390/480/768/1024/1280/1440/1920 实测通过；`role="switch"`、`radiogroup`、月份 `aria-live`、弹层 `Esc` 关闭 + 焦点回位、单一 `h1`。

## 09 · 令牌与治理

色值 / 圆角 / 模糊档位只允许改 `design-tokens.css`，页面内禁止写死色值；改动需同步 json / css / 本文件三处；新增面板必须复用既有 `--glass-*`，不得新造材质；玻璃关闭态与三档模糊需在每个新组件上各验证一遍。

## 10 · 原生背景（推荐背景）
- 本风格的原生背景在 `background.css`（暖炭夜色 + 琥珀室内光 + 冷色补光 + 三段暗角 + 1px 窗格线 + 颗粒）。
- 应用风格时必须和前景区一起应用，替换页面原有背景，不要在旧背景上叠加；玻璃/发光/暗色都靠背景托底。
- 风格导入时会自动读取 `background.css`，写进 `style-spec.json` 的 `background` 字段，生成的 style-brief 会在最前面列出「推荐背景（必须一起应用）」。
