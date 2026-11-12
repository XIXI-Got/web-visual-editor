# 风格规范模板 · 使用说明

这套模板是一份可复用的风格规范骨架；示例 token 用于演示字段结构，不来自任何外部站点。
目的：你照着它批量产出多份风格规范，导入网页修改器的**风格库**即可直接用。

## 一个风格规范 = 一个目录

```
我的风格-XXX/
├── UI-SPEC.md              # 必填（人能读懂、Agent 会读的那半）
├── design-tokens.json      # 强烈建议（机器提取 token 的那半）
├── design-tokens.css       # 可选：没有 json 时系统会从这里解析 CSS 变量
└── ui-spec.html            # 可选：没有前两者时从这里提取 CSS 变量
```

**最少只需要 `UI-SPEC.md`**（纯文字也能导入），但**没有 `design-tokens.json` 就没有硬 token**，Agent 只能读到文字描述——所以建议两份都给。

## 导入方式

网页工作台 →「风格优化」→「＋ 添加风格」→ 填这个**目录的绝对路径** → 保存。
之后在编辑器里点「AI 设置 / 风格」选择该风格，系统会把 token 写成项目下的 `.ve-data/style-brief.md`，并给 Agent 一份「按此规范执行」的提示词。

## 两份文件的分工

| 文件 | 作用 | 谁在读 |
| --- | --- | --- |
| `UI-SPEC.md` | 解释「为什么、怎么用、什么不许做」：原则、配比、约束、组件状态、动效时序、无障碍 | **Agent 会读全文**（截断 6000 字符）；人也能读 |
| `design-tokens.json` | 精确数值：颜色、字体栈、间距阶、圆角、阴影、动效 | **系统提取成硬约束 token**，写进 style-brief.md 的 JSON 块 |

> 规则：**凡是数值，两边都要写**。JSON 里没有的，Agent 就没有硬约束。

## 系统实际提取的字段（已核对源码 `dsh-plugin/lib/index.js`）

### design-tokens.json（优先）
| JSON 路径 | 变成什么 | 说明 |
| --- | --- | --- |
| `meta.name` | 风格名 | 必填，取自这里；没有才回退目录名 |
| `meta.version` | 版本 | 显示用 |
| `meta.referenceViewport` | 参考视口 | 显示用 |
| `color.<name>` | `--<name>` 颜色 token | 取 `value`（或 `hex`），`role` 会一起带上 |
| `typography.families.<name>` | `--font-<name>` 字体 token | 字体栈字符串 |
| `spacing.<name>` | 间距 token | 值会原样变成字符串 |
| `radius.<name>` | 圆角 token | 支持 `"4px"` 或 `{"value":"4px"}` |
| `shadow.<name>` | 阴影 token | 同上 |
| `motion.<name>` | 动效 token | 同上 |

**不会被提取**（但可保留，供人或 Agent 阅读）：`typography.roles`、`layout`、`components`、`imagery`、`breakpoints`、任何 `_` 开头的键。

### design-tokens.css / ui-spec.html（json 缺失时）
解析所有 `--name: value;` 形式的 CSS 变量，按名字/值自动归类为 color / font / radius / shadow / space / motion。

### UI-SPEC.md
全文（最多 6000 字符）进入 style-brief.md 的「原始规范摘录」，Agent 能读到，但**不是**结构化 token。

## 几个影响效果的细节（从源码里挖出来的）

1. **底色 token 命名**建议含 `paper` / `bg` / `background` / `surface` / `canvas` → 风格卡片的封面底色会优先取它。
2. **字体 token** 第一个会成为"展示字体"；含 `sans` / `label` / `body` / `text` 的会成为"小字字体"。
3. 颜色值请写成 `#RRGGBB` 或 `rgba(...)`，封面自动生成依赖它。
4. `spacing` 如果是对象，会被逐条展开成 `--space-<key>`，值直接字符串化（数组建议像模板那样写成 `"scale": [...]` 或 `"unit": "..."`）。
5. 一份规范建议控制在一个目录、一个主题；不要混两个品牌的色板。

## 建议的写作顺序（产出一份新规范）

1. 先定 `01 设计原则`（4 条以内，能当判断标准）
2. 再定 `02 色彩`（6–8 个色，写清角色与配比；顺手算出对比度）
3. `03 字体`（2–3 个家族 + 6–9 个字阶角色）
4. `04 版式`（最大宽、栅格、边距、间距阶）
5. `05 组件`（只写这个风格**特有**的 3–6 个组件；通用组件不写）
6. `06 动效`（缓动表 + 关键时序；必须写 reduced-motion 规则）
7. `07 影像 / 文案`（比例、裁切、禁用做法）
8. `08 响应式与无障碍`（断点 + 清单）
9. `09 令牌与交付`（CSS 变量清单 + 治理规则）
10. 最后回填 `design-tokens.json`，保证数值与正文一致

## 校验清单（导入前自查）

- [ ] `meta.name` 已填，且与 `UI-SPEC.md` 标题一致
- [ ] 每个颜色都有 `value`；至少有一个 `paper`/`bg` 和一个 `ink`
- [ ] 至少两个字体家族（display + sans）
- [ ] `spacing` / `radius` / `motion` 至少各有一条
- [ ] `UI-SPEC.md` ≤ 8000 字（超出部分不进 brief）
- [ ] 文档里没有引用不存在的图片文件（规范要求纯文字/线框）
- [ ] 中文排版注意事项已写（标题字重 ≥ 600、中文替代字体）

## 模板文件

- [`UI-SPEC.template.md`](UI-SPEC.template.md) —— 带占位符与批注的规范正文模板
- [`design-tokens.template.json`](design-tokens.template.json) —— 对应的 JSON token 模板
