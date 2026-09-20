/** Local-only fixture server; no API calls or production userscript execution. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/compact') {
    response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="en"><title>Compact player UI check</title><body style="background:#141820;color:white;font-family:system-ui"><h1>360 × 480 player viewport</h1><iframe title="Compact player" src="/?panel=1" style="width:360px;height:480px;border:1px solid white"></iframe></body></html>');
    return;
  }
  const relative = pathname === '/' ? 'benchmark/player-ui.html' : pathname.slice(1);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) || !(relative === 'benchmark/player-ui.html' || relative === 'benchmark/provider-control-fixtures.js' || relative.startsWith('src/'))) {
    response.writeHead(404).end(); return;
  }
  fs.readFile(target, (error, content) => {
    if (error) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control':'no-store' });
    response.end(content);
  });
}).listen(8096, '127.0.0.1', () => console.log('Player UI fixture: http://127.0.0.1:8096'));
