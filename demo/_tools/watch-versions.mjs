// 监听风格备份目录，自动刷新对比页的版本清单
// 用法：
//   node demo/_tools/watch-versions.mjs          # 刷新一次
//   node demo/_tools/watch-versions.mjs --watch  # 常驻监听（生成新风格后自动更新）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(HERE, '..');
const BACKUPS = path.join(DEMO, '.ve-data', 'style-backups');
const SCRIPT = path.join(HERE, 'refresh-versions.mjs');

function signature() {
  try {
    return fs.readdirSync(BACKUPS)
      .map((n) => {
        try { const st = fs.statSync(path.join(BACKUPS, n)); return n + ':' + st.mtimeMs; } catch { return n; }
      })
      .sort()
      .join('|');
  } catch { return ''; }
}

function refresh() {
  const r = spawnSync(process.execPath, [SCRIPT], { stdio: 'pipe', encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.includes('versions=')) || '';
  console.log('[' + new Date().toLocaleTimeString() + '] ' + (line || '刷新失败'));
}

if (process.argv.includes('--watch')) {
  let last = signature();
  refresh();
  console.log('监听中：' + BACKUPS + '（生成新风格后自动更新 compare-versions.json）');
  setInterval(() => {
    const now = signature();
    if (now !== last) { last = now; refresh(); }
  }, 2500);
} else {
  refresh();
}
