# 风格切换演示站 · STYLE SHIFT

独立站点（不在 `demo/` 里）：同一张页面 + 三套 token，可实时切换。

## 文件

```
style-showcase/
  index.html              风格切换演示站（默认 = Spatial Glass 拟态玻璃）
  assets/background.jpg   拟态玻璃风格用的夜景底图
```

## 三种风格

| 风格 | 说明 |
|---|---|
| Spatial Glass 拟态玻璃 | 夜景照片 + glass 面板 + 琥珀强调色（默认） |
| Prmpt 白点 | 白纸点阵 + 0 圆角 + 黑白 + mono 标签 |
| Aurora 极光 | 深空 + 极光光带 + 青绿/紫渐变 |

切换入口：导航右上分段控件、Hero 按钮、三张材质样本卡、CTA 按钮；也可以键盘 `← →`（分段控件内）。

## 打开 / 预览

- 在编辑器里把这个文件夹当项目打开（页面列表只有 `index.html`）
- 或直接双击 `index.html`
- 或起一个朴素静态服务（录视频推荐，无编辑器脚本注入）：

```bash
node serve.mjs        # → http://127.0.0.1:8890/
```

支持 URL 参数：`index.html?style=glass|white|aurora`。
选择会写入 `localStorage` 记住上一次。

## 与 demo 项目的区别

`demo/` 里的是「视觉编辑器」的项目演示页（`muse.html`）和风格对比工具；
本目录只放**风格切换演示站**本身，不依赖 demo 的任何文件。
