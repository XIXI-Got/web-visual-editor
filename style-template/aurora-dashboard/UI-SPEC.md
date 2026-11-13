# Aurora 极光暗色仪表盘 — UI 规范

**深空极光 / 三面板单页演示**
版本 1.0 · 2026.11 · 参考视口 1440×960 / 390×844

> **房屋规则：深空底上的一束极光——只用光（发光 / 渐变）与线（1px 描边），几乎不用实心面。** 纯文字 / 线框规范，不附截图，光效只以参数记录。

- 字族唯一：`Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
- 圆角 5/6/7/8/9/11px + pill + 50% 头像；间距阶 2/4/6/8/10/12/14/16/18/22/28/35px，壳层 18px 边距、12px 列距
- 壳层 `1.04fr 1fr .75fr`，`max-width: 2200px`，`min-height: 100vh`
- 360→1920 不横向滚动：`body / .page { overflow-x: clip }`，grid/flex 子项 `min-width: 0`
- 配套文件：`design-tokens.json`（硬 token）、`PRO-SPEC.md`（工程版：完整组件 / 状态机 / 动效时序 / 光效与声音）

## 01 · 设计原则

|原则|说明|
|---|---|
|**光与线，不用面**|面板一律「145° 渐变底 + 1px 线 + 11px 圆角」，实心块只在按钮、徽标、进度条内。|
|**三面板三层叙事**|landing 造氛围 → dashboard 证明可用 → design system 自证规则；只换内容密度。|
|**青绿主、紫次、蓝第三**|三色合计 < 10% 面积，只做数据、状态、渐变端；其余交给 ink / muted / line。|
|**光只做信号**|发光只在 hover、focus、状态点出现；静止页面近乎全暗，无光时也完整可读。|

## 02 · 色彩

|Token|色值|角色|
|---|---|---|
|`--bg` / `--paper`|`#030910` / `#02070D`|页面底 / 最暗舞台|
|`--panel` / `--panel-2` / `--surface` / `--surface-raised`|`#080F18` / `#0B1420` / `#09121D` / `#0C1723`|面板 / 输入 / 卡片 / hover 抬升底|
|`--line` / `--line-soft` / `--line-strong`|`#1A2938` / `#1B2A38` / `#233242`|外框 / 细边 / 可交互边，固定 1px|
|`--ink` / `--ink-soft`|`#EDF3FB` / `#F3F6FB`|主文字 / hero 大标题|
|`--muted` / `--muted-2` / `--dim`|`#8493A8` / `#9BAABD` / `#8FA2B7`|正文次级 / 说明 / 眉题 / 表头|
|`--green` / `--purple` / `--blue`|`#11D8B7` / `#A75CF5` / `#477CFF`|主强调 / 次强调 / 第三强调|
|`--warn` / `--danger` / `--info`|`#F5B45F` / `#FA7777` / `#73A0FF`|警告 / 错误 / 进行中，仅徽标文字|
|`--glow` / `--aurora-teal` / `--aurora-violet`|`#13D8C455` / `#19E3C477` / `#A64FF277`|光晕 / 极光青绿光带 / 紫光带，仅背景光效|
|`--focus`|`#25D9C4`|键盘焦点环，2px 实线 + offset 3px|

**配比**：深空底 ≈ 80% / 文字与线 ≈ 12% / 强调三色 < 8%，永远是少量信号。

**对比度实测**

|组合|对比度|
|---|---|
|ink / bg|17.9:1|
|ink / panel|17.0:1|
|muted-2 / panel|8.0:1|
|muted / bg|6.4:1|
|muted / panel|6.1:1|
|green / panel|10.4:1|
|blue / panel|5.06:1|
|purple / panel|4.96:1|

全部达 AA、ink 系 AAA；blue / purple 仅图标与徽标，purple 字重 ≥ 500。

**禁用规则**：不用纯黑 / 纯白（最亮 `#F3F6FB`、最暗 `#02070D`）；正文与说明只用 muted 系；不用实心大色块，面板底只有 `linear-gradient(145deg,#08111B,#050B13 65%,#070E17)`；glow 只作阴影色；不新增第 4 个强调色。

### 02.1 · 背景渐变（极光幕布）

页面底不是纯色，而是一张**渐进式极光渐变**：右上青绿主光源、左上紫副光源、底部蓝反射光，全部压在一层深空线性底上。层序固定，不可颠倒。

| 层 | 写法 | 作用 |
|---|---|---|
| ① 青绿主光源 | `radial-gradient(120% 92% at 82% -18%, var(--bg-grad-teal) 0%, #13D8B740 32%, transparent 64%)` | 右上角「一束光」的主来源 |
| ② 紫副光源 | `radial-gradient(92% 78% at 8% -14%, var(--bg-grad-violet) 0%, #8B4DDD33 34%, transparent 64%)` | 左上对位补光，制造纵深 |
| ③ 蓝反射光 | `radial-gradient(130% 84% at 52% 114%, var(--bg-grad-blue) 0%, transparent 62%)` | 底部湖面反射，收住画面下沿 |
| ④ 深空线性底 | `linear-gradient(158deg, var(--paper) 0%, var(--bg-grad-mid) 42%, var(--bg) 74%, var(--paper) 100%)` | 压暗兜底：保证所有文字对比度 |

```css
body {
  background-color: var(--bg);
  background-image:
    radial-gradient(120% 92% at 82% -18%, var(--bg-grad-teal) 0%, #13D8B740 32%, transparent 64%),
    radial-gradient(92% 78% at 8% -14%, var(--bg-grad-violet) 0%, #8B4DDD33 34%, transparent 64%),
    radial-gradient(130% 84% at 52% 114%, var(--bg-grad-blue) 0%, transparent 62%),
    linear-gradient(158deg, var(--paper) 0%, var(--bg-grad-mid) 42%, var(--bg) 74%, var(--paper) 100%);
  background-attachment: fixed;
  background-repeat: no-repeat;
  background-size: cover;
}
@media (max-width: 760px) { body { background-attachment: scroll; } }
```

**纪律**

- 光斑合计 **≤ 30% 面积**，且永远叠在 ④ 深空线性底之上；hero 文案区（左 45%）只允许落在 ④ 的深空端，**文字不压光斑**。
- 渐变层**不做动画**，漂移交给 `.aurora` 幕布层（18s）——大面积 `background-position` 动画会掉帧。
- 对比度不因渐变降级：ink / 背景仍 ≥ 17:1，muted / 背景 ≥ 6:1；所有文字要么压深空端，要么压在实体面板上。
- 不支持渐变时退回 `--bg` 纯色；**禁止**用彩色渐变做卡片 / 按钮 / 文字底（hero 关键词裁字渐变是唯一例外）。
- 移动端（≤760px）`background-attachment: scroll`，光斑尺寸收窄到 90% / 70% 省合成开销。

## 03 · 字体

**家族**（全站唯一）：`Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`；不用衬线、不用等宽。

**字阶**

|角色|字号|字重|行高|字距|颜色 / 备注|
|---|---|---|---|---|---|
|hero|`clamp(34px, 3.1vw, 57px)`|350|1.06|-0.045em|ink-soft，关键词绿→紫渐变裁字|
|statement|22px|400|1.2|-0.04em|ink|
|section|17px|400|1.4|—|ink|
|cardTitle|16px|450|1.3|—|ink|
|metric|15px|450|1.2|—|ink，tabular-nums（metric 卡数值）|
|stat|19px|450|1.2|—|ink，tabular-nums（stat 卡数值）|
|body|12px|400|1.5|-0.01em|muted|
|body-lg|11px|400|1.8|—|muted-2|
|label|10px|500|1.2|0.1em|ink-soft|
|micro|9px|400|1.2|0.12em|dim，大写眉题 / 导航|
|tiny|8px|400|1.2|0.05em|muted-2，装饰元数据|
|caption|6px|400|1.2|—|muted-2，色卡编号|

**排版规则**：中文回落 PingFang SC / Microsoft YaHei，中文标题字重 ≥ 500；可用字重仅 350–700；hero 正文 measure 330px；宽字距只用于英文 / 数字；6px 仅装饰编号。

## 04 · 版式与构图

**页面节奏**：横向三面板同一壳层——landing（hero + features）→ dashboard（134px 侧栏 + 主区）→ design system（色卡 / 字阶 / 按钮 / 输入 / 徽标 / 卡片 / 导航 / 控件），每块至少一屏高。

|项|值|
|---|---|
|壳层|`grid 1.04fr 1fr .75fr` / gap 12px / padding 18px / max-width 2200px / 居中|
|面板|radius 11px、1px `--line`、145° 渐变底、`overflow: hidden`|
|hero|高 69% / `min-height: 590px`；山形 37%、湖面 21%|
|features|`1.2fr repeat(3,1fr)` / gap 12px / padding 28px 7% 35px|
|dashboard|`134px 1fr` / gap 14px / 右 14px 下 14px 内边距|
|指标 / 中区 / 底区|`repeat(4,1fr)` gap 8 / `1.45fr 1fr` gap 9 / `1fr 1fr 1.1fr` gap 9，底区高 210px|
|hero 解剖|topnav 16px 7%、gap 25px；copy 11% 7% 0、max-width 560px；stats 4 列 gap 10、左右 7%、bottom 13%、高 105px|
|间距|基础 2px；页面 18、列 12、dashboard 14、中 / 底 9、组件内 8–14、区块 28–35|

## 05 · 组件

**面板 Panel**：11px 圆角、1px `--line`、145° 渐变底、`overflow: hidden`。

**按钮 Button**

|状态|底|文字|边|圆角|说明|
|---|---|---|---|---|---|
|默认|`#0B1522AA`|`#F3F6FB`|1px `#28394B`|7px|10px 字、padding 7px 12px|
|hover|同上|同上|1px `--green`|7px|上浮 3px + `button-hover` + 扫光 550ms|
|active|同上|同上|同上|7px|上浮 1px + scale(.97)，80ms|
|primary|`linear-gradient(105deg, #A75CF5, #11D8B7)`|`#F3F6FB`|1px `--green`|7px|`primary-glow`|
|focus|—|—|2px `--focus`|7px|offset 3px，禁止 outline:none|
|禁用|透明度 .4|muted|line|7px|不响应 hover，不发光|

**指标卡**：metric radius 7px、`--surface` 渐变、padding 12px 10px，数字 15px/450、sparkline 22px，hover 上浮 3px；stat radius 9px、`#08111CDB` + blur(10px)、高 105px，数值 19px/450，hover 上浮 5px。

**侧栏导航**：宽 134px、padding 17px 10px；项 radius 7px、9px 字、gap 4px，默认 `--dim`，hover / active 用 `#111D2B` 底 + 1px `#1B2B3B` + 右移 2px；图标用文本符号（▣ ▥ ▱ ▧ ✉ ▦ ⌘ ⚙）。

**徽标 Badge**：radius 20px、padding 3px 7px、7px 字、1px 同色系描边，仅 green / purple / blue / warn / danger 五种，不换行、不用实心底。

## 06 · 动效

|缓动|值|用途|
|---|---|---|
|ease-out|`cubic-bezier(.2,.8,.2,1)`|hover 上浮、卡片抬升|
|ease-glide|`cubic-bezier(.2,.7,.2,1)`|按钮扫光|
|ease-io|`ease-in-out`|极光漂移、光带往返|

|动效|时长|说明|
|---|---|---|
|hover 上浮|240–280ms|-3px（stat -5px、metric -3px）|
|按压|80ms|-1px + scale(.97)|
|扫光|550ms|斜切高光左→右，overflow hidden + z-index 隔离|
|toast|250ms|进场 + 1800ms 自动消失|
|极光幕布|18s|alternate 漂移 + rotate -11°→-5°|
|极光光带|13s / 17s|两层反向漂移，mix-blend-mode: screen|
|极光描边（conic）|4.8s / 5.8s|仅 hover，conic-gradient + mask 描边|

**reduced-motion**：`prefers-reduced-motion: reduce` 全局覆盖，动画与过渡降为 0.01ms、只播 1 次，`.float-glow` 全关、hover 不上浮。

## 07 · 图像与文案

**光效规则**：极光幕布＝三层 `radial-gradient` ellipse 18%×58% / 14%×55% / 10%×44% + blur 22px + rotate(-9deg)，18s 漂移；光带＝108° / 112° `linear-gradient` 斜带 + blur 15 / 26px + `mix-blend-mode: screen`，13s / 17s；点阵＝`radial-gradient` .7px / 38px 网格、opacity .24；山形＝`clip-path: polygon` 12 点、高 37%；湖面倒影＝`repeating-linear-gradient(180deg)` 12–16px + 顶部 1px 线；地图＝椭圆洲块 + 2px 城市点 + 9px 点阵。

禁用照片、位图 logo、外链图、玻璃拟态、纯色块；图标用几何符号。

**文案**：未来感但克制，名词 + 数据；hero 标题 ≤ 2 行、每行 ≤ 5 词，副文 ≤ 1 句 ≤ 28 汉字；数据带变化率（+24.6%）与相对时间（2 mins ago）；禁用「颠覆」「革命性」「史诗级」。好例「Total Revenue ↗ +24.6% from last month」。

## 08 · 响应式与无障碍

|名称|值|主要变化|
|---|---|---|
|desktop|≥ 1201px|三栏 1.04fr / 1fr / .75fr 全展开|
|tablet|761–1200px|壳层 2 列，design 跨列占满，色卡仍 8 列|
|phone|≤ 760px|flex 单列、padding 8px；hero min-height 640px；topnav 链接隐藏；stats 2 列；features 2 列、首块跨列；侧栏 85px；metric 2 列；中区 1 列；底区 2 列、world 跨列；upgrade 隐藏；色卡 4 列；卡片 2 列、末卡跨列|

**硬约束（360 → 1920）**：`scrollWidth <= innerWidth + 1` 七档全过；`body / .page { overflow-x: clip }`；字号全 `clamp()`，间距用阶内值；容器 `width: min(2200px, 100%); margin-inline: auto`；grid / flex 子项 `min-width: 0`；文字容器不写死 `height`；装饰层 `pointer-events: none`。

**无障碍清单**：对比度 ≥ 4.5:1 [x]；`focus-visible` 2px `--focus`、offset 3px [x]；reduced-motion [x]；触控目标 ≥ 44×44 [ ]；图标按钮 `aria-label`、toggle `aria-pressed` [ ]；装饰层 `aria-hidden` [ ]；8px 元数据 ≤ 2 行 [ ]。

## 09 · 令牌与交付

```css
:root {
  --bg:#030910; --paper:#02070D; --panel:#080F18; --panel-2:#0B1420;
  --surface:#09121D; --surface-raised:#0C1723;
  --line:#1A2938; --line-soft:#1B2A38; --line-strong:#233242;
  --ink:#EDF3FB; --ink-soft:#F3F6FB; --focus:#25D9C4;
  --muted:#8493A8; --muted-2:#9BAABD; --dim:#8FA2B7;
  --green:#11D8B7; --purple:#A75CF5; --blue:#477CFF;
  --warn:#F5B45F; --danger:#FA7777; --info:#73A0FF;
  --glow:#13D8C455; --aurora-teal:#19E3C477; --aurora-violet:#A64FF277;
  --bg-grad-teal:#19E3C48F; --bg-grad-violet:#A64FF27A;
  --bg-grad-blue:#477CFF4D; --bg-grad-mid:#050F19;
  --radius-md:7px; --radius-panel:11px; --radius-pill:999px;
  --ease-out:cubic-bezier(.2,.8,.2,1); --ease-glide:cubic-bezier(.2,.7,.2,1);
}
```

**阴影令牌（8 条）**：button-hover 0 7px 24px #13D8B733, 0 0 0 1px #27D8C21A；card-hover 0 8px 20px #0006；widget-hover 0 8px 24px #0005；stat-hover 0 10px 28px #0008, 0 0 18px #13D8B51C；feature-hover 0 12px 30px #0007, 0 0 20px #12D6B51A；primary-glow 0 0 20px #18BCA955；float-glow 0 9px 28px #02070D88, 0 0 18px #14D9C51A；focus-glow 0 0 14px #18CDBB35。

**治理**：唯一事实源是 `design-tokens.json`，改动须同步 JSON 与本文件；页面禁止写死色值、新增圆角 / 阴影、第三种字族、第 4 个强调色；交付自检九节、七档无横向滚动、对比度、reduced-motion、无位图。

## 附录 · 给 Agent 的执行摘要

1. 只用 02 / 03 节的色板与唯一字族，不新增颜色、字体、圆角、阴影。
2. 保持「渐变底 + 1px 线 + 11px 圆角」的面板语言，不改成实心卡片或玻璃拟态。
3. 强调三色合计 < 10%，只出现在数据、状态、渐变端与 hover 光。
4. 尺寸走 clamp / 阶内值；grid/flex 子项 `min-width: 0`，`body` `overflow-x: clip`。
5. 动效只做反馈：上浮 3px、按压 80ms、扫光 550ms，reduced-motion 全关。
