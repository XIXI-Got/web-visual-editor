// 扫描风格备份 + 模板版本，生成对比页可读取的版本清单 demo/compare-versions.json
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/AI_Sandbox/网页调整工具/demo';
const BACKUPS = path.join(ROOT, '.ve-data', 'style-backups');
const OUT = path.join(ROOT, 'compare-versions.json');

const versions = [
  { id: 'neutral', label: '原版模板', note: '无风格基线', url: 'template-neutral.html', chip: '#9aa0a6', group: '模板', kind: 'before' },
  { id: 'glass', label: '拟态玻璃', note: 'Spatial Glass', url: 'template-versions/glass.html', chip: '#e8c496', group: '模板版本' },
  { id: 'white', label: '极简白点', note: 'Prmpt 白点', url: 'template-versions/white.html', chip: '#111111', group: '模板版本' },
  { id: 'aurora', label: '极光', note: 'Aurora', url: 'template-versions/aurora.html', chip: '#11d8b7', group: '模板版本' },
  { id: 'pixelos', label: 'PixelOS 95', note: '像素桌面', url: 'template-versions/pixelos.html', chip: '#008080', group: '模板版本' },
  { id: 'uneo', label: 'UNEO 暖石拟物', note: 'Neumorphism', url: 'template-versions/uneo.html', chip: '#8c6f52', group: '模板版本' },
  { id: 'bluewhite', label: 'DEMO 蓝白', note: 'Blue White', url: 'template-versions/bluewhite.html', chip: '#2563eb', group: '模板版本' },
  { id: 'muse-original', label: 'muse 原版', note: '旧 demo 初始版', url: 'muse.original.html', chip: '#2563eb', group: '项目历史' },
  { id: 'muse-current', label: 'muse 当前', note: '工作版本', url: 'muse.html', chip: '#4d6bfe', group: '项目历史' },
];

const seen = new Set(versions.map((v) => v.url));

if (fs.existsSync(BACKUPS)) {
  const entries = fs.readdirSync(BACKUPS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const name of entries) {
    const dir = path.join(BACKUPS, name);
    const filesDir = path.join(dir, 'files');
    if (!fs.existsSync(filesDir)) continue;

    let styleName = name;
    let createdAt = '';
    try {
      const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (man.styleName) styleName = String(man.styleName).replace(/\s+/g, ' ').trim();
      if (man.createdAt) createdAt = man.createdAt;
    } catch { /* 无 manifest 就跳过命名 */ }

    const htmls = fs.readdirSync(filesDir).filter((f) => f.endsWith('.html'));
    const pick = htmls.find((f) => f === 'muse.html') || htmls.find((f) => f === 'index.html') || htmls[0];
    if (!pick) continue;

    // 只保留「有意义的快照」：至少有一个 html
    const url = '/.ve-data/style-backups/' + encodeURIComponent(name) + '/files/' + pick;
    if (seen.has(url)) continue;
    seen.add(url);

    const stamp = (createdAt || name).replace(/[T:.\-]/g, '').slice(0, 12);
    versions.push({
      id: 'bak-' + name.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40),
      label: '历史 · ' + styleName,
      note: stamp,
      url,
      chip: '#8a8a8a',
      group: '风格备份',
    });
  }
}

const payload = { updatedAt: new Date().toISOString(), versions };
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
console.log('wrote', OUT, 'versions=' + versions.length);
for (const v of versions) console.log(' -', v.group, '|', v.label, '|', v.url);
