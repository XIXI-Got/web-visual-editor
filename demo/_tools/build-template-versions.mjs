// 由 template-neutral.html + _styles/*.css 生成各风格版本（同一份结构，只换 token 层）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/AI_Sandbox/网页调整工具/demo';
const tplPath = path.join(ROOT, 'template-neutral.html');
const tpl = fs.readFileSync(tplPath, 'utf8');
const OUT = path.join(ROOT, 'template-versions');

const STYLES = [
  { id: 'glass', title: 'ATLAS · 模板（拟态玻璃）', theme: '#07060a' },
  { id: 'white', title: 'ATLAS · 模板（极简白点）', theme: '#FBFBFB' },
  { id: 'aurora', title: 'ATLAS · 模板（极光）', theme: '#02070D' },
  { id: 'pixelos', title: 'ATLAS · 模板（PixelOS 95）', theme: '#008080' },
  { id: 'uneo', title: 'ATLAS · 模板（UNEO 暖石拟物）', theme: '#F3EFE9' },
  { id: 'bluewhite', title: 'ATLAS · 模板（DEMO 蓝白）', theme: '#FFFFFF' },
];

fs.mkdirSync(OUT, { recursive: true });
for (const s of STYLES) {
  const css = fs.readFileSync(path.join(OUT, '_styles', s.id + '.css'), 'utf8');
  const html = tpl
    .replace('<html lang="zh-CN">', `<html lang="zh-CN" data-style="${s.id}">`)
    .replace('<title>ATLAS · 模板（无风格基线）</title>', `<title>${s.title}</title>`)
    .replace('<meta name="theme-color" content="#ffffff" />', `<meta name="theme-color" content="${s.theme}" />`)
    .replace('</head>', `<style>\n${css}\n</style>\n</head>`);
  fs.writeFileSync(path.join(OUT, s.id + '.html'), html, 'utf8');
  console.log('built', s.id + '.html', html.length);
}
