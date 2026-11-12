# UNEO 暖石拟物 · Warm-Stone Neumorphism

> 自有拟物组件页 `uneo.html` 的视觉系统。暖石纸面、双光源浮雕、深咖啡与古铜，强调“可按的实体感”。

## 01 设计原则
- 暖石纸面：画布 `#F3EFE9`，表面 `#F6F3EE`，凹陷 `#EDE8E0`；不使用纯白大底。
- 双光源：所有抬起元素同时有右下深影 `#E2DDD4` 与左上高光 `#FFFFFF`，形成浮雕。
- 实体交互：hover 必须伴随阴影变化或轻微位移，不做平面 hover。
- 单一强调：古铜 `#8C6F52` 只用于眉题、细环、小标签与选中态；主按钮用深咖啡 `#33281E`。

## 02 色彩
| token | 值 | 用途 |
| --- | --- | --- |
| `--canvas` | `#F3EFE9` | 页面画布 |
| `--card` | `#F6F3EE` | 卡片 |
| `--elevated` | `#F8F6F2` | 抬起表面 |
| `--recessed` | `#EDE8E0` | 凹陷 / 输入槽 |
| `--shadowDark` | `#E2DDD4` | 暗侧阴影 |
| `--shadowDeep` | `#D5CFC4` | 深凹槽阴影 |
| `--shadowLight` | `#FFFFFF` | 亮侧高光 |
| `--espresso` | `#33281E` | 主文字 / 主按钮 |
| `--bronze` | `#8C6F52` | 眉题 / 细环 / 强调 |
| `--bronzeSoft` | `#B69D82` | 浅古铜 |
| `--textSecondary` | `#756B61` | 正文次级 |
| `--textMuted` | `#A39A90` | 说明 / 占位 |
| `--hairline` | `rgba(255,255,255,.78)` | 亮侧发丝边 |

## 03 字体
- `--font-display`: 思源宋体（Source Han Serif SC）/ Noto Serif SC / Songti SC，衬线标题，字重 600。
- `--font-sans`: Inter / 系统无衬线，正文 400–500。
- 中文标题使用同气质宋体回退（Noto Serif SC / 思源宋体 / Songti SC），字重 ≥ 600。

## 04 圆角 / 阴影
- 圆角：`10 / 16 / 24 / 32 / 999px`；卡片常用 32px，按钮常用 pill。
- 抬起：`16px 16px 34px #E2DDD4, -16px -16px 34px #FFFFFF`
- 小抬起：`6px 6px 14px #E2DDD4, -6px -6px 14px #FFFFFF`
- 凹陷：`inset 4px 4px 9px #E2DDD4, inset -4px -4px 9px #FFFFFF`
- 主按钮：`7px 9px 18px rgba(51,40,30,.26), -4px -4px 10px #FFFFFF`

## 05 版式 / 组件
- 画布可带极淡圆点纸纹：`radial-gradient(rgba(51,40,30,.022) 1px,transparent 0)`。
- 卡片、按钮、滑轨、旋钮都使用同一套双光源阴影，不允许只加单侧投影。
- 主按钮深咖啡底、白字；次按钮同色系浅底 + 浮雕。
- 输入/滑块用凹陷阴影，不画粗边框。

## 06 动效
- `cubic-bezier(.22,1,.36,1)`，200ms；旋钮/开关 140ms。
- hover：上浮 1–2px 并加深阴影；active：下压并转 inset。
- 支持 `prefers-reduced-motion: reduce`。

## 07 响应式
- 760px 以下单列；图片 16:9，正文与按钮完整可见，`overflow-x: clip`。
- 任何宽度 `scrollWidth <= innerWidth + 1`。

## 08 导航栏

- 高度 `56px`；表面 `rgba(243,239,233,.88)`，底部 1px `rgba(51,40,30,.10)`，无硬投影。
- 左侧品牌：24px 抬起方块（`3px 3px 8px #E2DDD4` + `-3px -3px 8px #FFFFFF`）+ `Inter 10px / 600 / .15em`。
- 中间链接：`Inter 11px / 500`，默认 `--textSecondary`，当前项 `--espresso`；绝对居中。
- 右侧 CTA：深咖啡渐变 pill，白字，`5px 6px 12px rgba(51,40,30,.24)` + 左上高光；hover 上浮 1px 并加深阴影。
- 导航只使用「抬起」阴影，不使用平面描边；窄于 900px 时链接回到右侧，640px 以下只保留当前项。
