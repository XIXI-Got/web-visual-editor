# 瑞士国际主义 SWISS+ — UI 规范

**International Typographic Style · 设计工作室 / 设计系统展示页**
版本 1.0 · 2026.11 · 参考视口 1440×960 / 移动端 390×844
来源：`demo/swiss-studio/index.html`

> 用一页纸的网格、Helvetica 和一个红色信号，把信息按秩序排开；装饰为零，留白即结构。
>
> 本规范为纯文字 / 线框规范，不附照片；影像只以比例与裁切参数记录。
>
> 配套：`design-tokens.json` / `design-tokens.css` / 参考实现 `index.html`

## 01 · 设计原则

| 原则 | 说明 |
| --- | --- |
| **网格先行 Grid first** | 内容落在 4 / 6 / 12 列栅格与 1px 细线上；不靠 `left/top` 像素摆放 |
| **单字体 One family** | 全站一套 Helvetica / Arial，只靠字重 300 / 500 / 700 / 750 与字号分层 |
| **红是信号 Red as signal** | `#E30613` 面积 < 10%，只用于主按钮、年份条、当前态与关键强调 |
| **黑白影像 Monochrome** | 摄影统一 `grayscale(1)`，无圆角无阴影，比例固定，`object-fit: cover` |
| **左对齐、不对称留白** | 文本左对齐、右侧留白；标题紧字距 -0.065em，正文行高 1.55 |

**house rule：像一页瑞士设计年鉴的跨页，而不是一张营销海报。**

## 02 · 色彩

| Token | 色值 | 角色 / 使用位置 |
| --- | --- | --- |
| `--paper` | `#F8F8F6` | 页面底色 |
| `--white` | `#FFFFFF` | 反白表面、按钮文字 |
| `--ink` | `#090909` | 主文字、正文、1px 结构线、主按钮底 |
| `--ink-soft` | `#444444` | 次级说明 |
| `--muted` | `#6F6F6F` | 元数据：色值标签、日期、版权 |
| `--red` | `#E30613` | 强调：主按钮、年份条、当前态（< 10%） |
| `--red-deep` | `#C20511` | 红色 hover / 按压 |
| `--line` | `#DEDEDE` | 固定 1px 栅格线 |
| `--line-strong` | `#BDBDBD` | 强分隔线：Hero 引线、统计竖线 |
| `--tint` | `#F8DADA` | 12 列网格示意条 |

配比：纸白约 70% / 墨黑 20% / 红 6% / 细线与灰 4%。红色永远作为少量信号出现。

对比度：Ink / Paper 18.73:1；Ink-soft / Paper 9.16:1；Muted / Paper 4.73:1；White / Red 4.88:1；Red / Paper 4.59:1。正文不用纯 `#000`；红色不承载长正文；分隔线固定 1px。

## 03 · 字体

| 角色 | Token | 字体栈 |
| --- | --- | --- |
| 展示字体 | `--font-display` | `Helvetica Neue, Helvetica, Arial, PingFang SC, Microsoft YaHei, sans-serif` |
| 正文字体 | `--font-sans` | `Arial, Helvetica Neue, Helvetica, PingFang SC, Microsoft YaHei, sans-serif` |

不引入第二种字体。中文回退 PingFang SC / 微软雅黑，标题字重 ≥ 600。

| 角色 | 字号 | 字重 | 行高 | 字距 | 大小写 |
| --- | --- | --- | --- | --- | --- |
| display / Hero | `clamp(32px, 2.95vw, 62px)` | 750 | .99 | -.065em | 原样 |
| year | `clamp(30px, 2.3vw, 48px)` | 300 | 1 | -.05em | 原样 + `tabular-nums` |
| specimen Aa | `clamp(76px, 7vw, 140px)` | 500 | .8 | -.09em | 原样 |
| quote | `clamp(16px, 1.15vw, 22px)` | 400 | 1.2 | -.04em | 原样 |
| stat | `clamp(22px, 1.5vw, 32px)` | 400 | 1 | -.05em | 原样 |
| section label | `clamp(12px, .9vw, 13px)` | 750 | 1.2 | .045em | UPPERCASE |
| card title | `clamp(10.5px, .78vw, 11px)` | 750 | 1.25 | 0 | 原样 |
| body | `clamp(11px, .82vw, 12px)` | 400 | 1.55 | 0 | 原样 |
| micro / meta | `clamp(8.5px, .6vw, 9px)` | 400 | 1.4 | .02em | 部分大写 |

标题最长 3 行，用显式 `<br>` 控制断行；正文行宽 ≤ 72ch；小标签与按钮 UPPERCASE + 字距 .05em。

## 04 · 版式与构图

页面节奏：顶栏 + 四栏「Hero / Projects / Typography / Buttons」→ 红色年份带 → 底部六栏「Grid / Quotes / Statistics / Articles / Newsletter / Footer」。一屏读完一个设计系统。

| 项 | 值 |
| --- | --- |
| 内容最大宽 | `1920px`，`width: min(100%, 1920px)` 居中 |
| 顶部四栏 | `1.48fr .95fr .88fr .72fr` |
| 底部六栏 | `1fr 1fr .95fr 1fr .85fr 1.55fr` |
| 面板内边距 | `clamp(15px, 25u, 25px)` × `clamp(18px, 28u, 32px)` |
| 栅格线 | `1px solid #DEDEDE`，面板右/下边 |
| 最小高 | 顶部 `clamp(420px, 520u, 520px)` / 底部 `clamp(220px, 260u, 260px)` |

间距：单一设计单位；1440 视口下 1u = 1px，向两侧按 clamp 缩放。

```css
--u: clamp(.45px, calc(100vw / 1440), 1px);
--space-1: max(3px, calc(4 * var(--u)));
--space-2: max(6px, calc(8 * var(--u)));
--space-3: max(8px, calc(12 * var(--u)));
--space-4: max(12px, calc(16 * var(--u)));
--space-5: max(16px, calc(24 * var(--u)));
--space-6: max(22px, calc(32 * var(--u)));
```

Hero：导航 40px 一行；标题左栏 55%，3 行；图片右栏 45%，比例 3:4，`object-position: 52% 42%`；图片右缘竖排黑底白字标签；红色年份带全宽出血（负 margin 抵消面板 padding），min-height 94px，三栏：年份 / 引文 / 圆点。

## 05 · 组件

| 组件 | 规则 |
| --- | --- |
| 导航 | 40px 高；链接 9.5–10px / 600；hover 变红；≤ 700 隐藏链接，≤ 1100 在 3 栏布局中收为汉堡 |
| Primary 按钮 | `#E30613` 底 + 白字；hover `#C20511`；无圆角 |
| Secondary 按钮 | `#090909` 底 + 白字；hover 变红 |
| Tertiary 按钮 | 透明底 + 1px `#090909` 描边；无圆角 |
| Text 按钮 | 无边框，底边 1px `#BDBDBD` |
| 项目卡 | 图片 4:5、`grayscale(1)`、hover `scale(1.06)`；标题 11px / 750；无圆角无阴影 |
| 表单 | min-height 32px；1px `#DEDEDE` 边框；focus 边框变红；无圆角 |
| 模态 | `min(560px, 100%)` 纸白卡片；16:10 图片；Esc 关闭，焦点回触发卡 |
| Toast | 黑底白字、底部 24px、2.2s 自动消失、`role="status"` |
| 设计系统展示 | 字号 Aa 样张；5 格色板；12 列 `#F8DADA` 网格条；7px 圆点分页（25px 热区） |

所有按钮：UPPERCASE、9px / 700、字距 .05em、内边距 12px、hover `translateX(3px)`；圆角恒为 0。

## 06 · 动效

缓动 `cubic-bezier(.22, .61, .21, 1)`；UI 过渡 240ms、图片 hover 600ms、Hero 缩放 1200ms。只动 transform / opacity / color / border-color，禁止布局属性动画；每个视口最多 1 个持续动效；必须支持 `prefers-reduced-motion: reduce`（关闭位移缩放，时长压到 0.01ms）。

## 07 · 摄影 / 图像与文案

| 项 | 规则 |
| --- | --- |
| Hero | 3:4，`object-fit: cover`，`object-position: 52% 42%`，`grayscale(1) contrast(1.02)` |
| 项目卡 | 4:5，居中裁切，`grayscale(1)` |
| 文章缩略图 | 65:47，`grayscale(1)`；模态图 16:10 |
| 禁用 | 圆角、阴影、彩色滤镜、渐变叠加、发光、玻璃拟态 |

文案：短句、陈述式、无营销感叹号；标题 ≤ 3 行；中英混排时中文单独成行。

## 08 · 响应式与无障碍

| 名称 | 值 | 主要变化 |
| --- | --- | --- |
| wide | `> 1340px` | 顶部 4 栏；底部 6 栏；导航完整 |
| laptop | `≤ 1340px` | 导航收紧；底部 6 → 3 栏 |
| tablet | `≤ 1100px` | 顶部 4 → 3 栏；隐藏 Buttons 栏；底部 3 栏 |
| mid | `901–1100px` | 导航链接收起为汉堡 |
| stack | `≤ 900px` | 顶部单栏；按钮栏恢复；项目 6 栏；底部 2 栏 |
| phone | `≤ 700px` | Hero 1fr/.75fr；项目 3 栏；底部 2 栏 |
| small | `≤ 420px` | Hero 堆叠、图片 75% 右对齐；底部 1 栏 |

无障碍：正文对比度 ≥ 4.5:1；焦点 2px 红色 outline；跳过导航；图片 alt、表单 label、Toast `aria-live`；模态 `role="dialog"` + Esc + 焦点回收；圆点 `aria-pressed`、分页 `aria-current`；动效可关闭。

## 09 · 令牌与交付

```css
--paper:#F8F8F6; --white:#FFFFFF; --ink:#090909; --ink-soft:#444444;
--muted:#6F6F6F; --red:#E30613; --red-deep:#C20511;
--line:#DEDEDE; --line-strong:#BDBDBD; --tint:#F8DADA;
--font-display:"Helvetica Neue",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif;
--font-sans:Arial,"Helvetica Neue",Helvetica,"PingFang SC","Microsoft YaHei",sans-serif;
--u:clamp(.45px, calc(100vw / 1440), 1px);
--radius:0; --ease-out:cubic-bezier(.22,.61,.21,1); --dur-ui:240ms;
```

改任何 token 必须同步 `design-tokens.json`、`design-tokens.css` 与本文件；页面禁止写死色值 / 字号 / 间距。

## 附录 · 硬约束

1. 只用本规范色板与字体栈，不引入新主色或第二种字体。
2. 只改现有元素样式与排布，不重写整页结构、不新增装饰。
3. 宽度 / 字号 / 间距用 `min()` / `clamp()` / `calc()` / token，不写死 px 布局。
4. 红色面积 < 10%，只用于主按钮、当前态与关键强调。
5. 图片统一黑白、固定比例、无圆角无阴影；中文标题字重 ≥ 600。
