// 极简静态服务器：给「录视频 / 纯净对比」用，不做任何编辑器脚本注入
// 用法：node demo/_tools/serve-demo.mjs [端口]
//   默认 http://127.0.0.1:8848/style-compare.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.argv[2]) || 8848;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (pathname === '/') pathname = '/style-compare.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('404 ' + pathname); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500).end('500 ' + String(e && e.message || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('纯净预览（无编辑器脚本）：');
  console.log('  http://127.0.0.1:' + PORT + '/style-compare.html');
  console.log('  http://127.0.0.1:' + PORT + '/template-neutral.html');
  console.log('按 Ctrl+C 停止');
});
