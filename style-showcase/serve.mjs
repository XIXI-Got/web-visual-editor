// 纯净静态服务器（录视频用，不做任何编辑器脚本注入）
// 用法：node serve.mjs [端口]
//   默认 http://127.0.0.1:8890/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const PORT = Number(process.argv[2]) || 8890;

const MIME = {
  '.html': 'text/html; charset=utf-8',
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
};

http.createServer((req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500).end('500 ' + String((e && e.message) || e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('风格切换演示站（纯净预览）：http://127.0.0.1:' + PORT + '/');
  console.log('按 Ctrl+C 停止');
});
