/**
 * 视觉编辑器 Vite 插件的类型声明。
 * 没有这个文件，strict 模式下的 `tsc -b` 会因为 import .mjs 没有声明而报 TS7016，导致 npm run build 失败。
 */

import type { Plugin } from "vite";

export interface VisualEditorOptions {
  /** 站点根目录，默认 Vite root */
  root?: string;
  /** 数据目录，默认 .ve-data */
  dataDir?: string;
  /** 站点内容 JSON（改文字会优先回写到这里） */
  contentJson?: string;
  /** 静态资源目录，上传的图片放这里（默认 public） */
  publicDir?: string;
  /** 每次保存后同步生成的纯 CSS 覆写文件 */
  cssOut?: string;
  /** 备份保留数量，默认 40 */
  maxBackups?: number;
  /** 启动时自动打开浏览器，默认 true */
  autoOpen?: boolean;
  /** 构建时也注入编辑器，默认只 dev 注入 */
  production?: boolean;
  /** 只在这些命令生效，默认 serve */
  apply?: "serve" | "build";
}

export function visualEditor(options?: VisualEditorOptions): Plugin;

/** Babel 插件：给 JSX 注入 data-ve-id（配合 @vitejs/plugin-react 的 babel.plugins 使用） */
export function visualEditorBabel(): any;

export default visualEditor;
