import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScene } from './scene.mjs';

export const defaultDistDir = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

export async function startServer(file, { distDir = defaultDistDir, idleMs = 30 * 60 * 1000 } = {}) {
  await loadScene(file);
  const root = await realpath(distDir);
  const prefix = `/${randomBytes(24).toString('hex')}/`;
  let origin;
  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(close, idleMs);
    idle.unref();
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const reply = (status, body) => { res.statusCode = status; res.end(body); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      return reply(403, 'Forbidden');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Read-only server');
    let path;
    try { path = decodeURIComponent(req.url.split('?')[0]); } catch { return reply(404, 'Not found'); }
    if (!path.startsWith(prefix)) return reply(404, 'Not found');
    const route = path.slice(prefix.length);
    if (route.includes('\\') || route.split('/').some(part => part === '..' || part === '.')) return reply(404, 'Not found');
    if (route === 'scene') {
      resetIdle();
      try {
        const scene = await loadScene(file);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return reply(200, req.method === 'HEAD' ? '' : JSON.stringify(scene));
      } catch (error) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return reply(422, JSON.stringify({ error: error.message }));
      }
    }
    const asset = route === '' ? 'index.html' : route;
    if (!['index.html', 'app.js', 'app.css'].includes(asset) && !/^assets\/[\w./-]+\.(woff2?|ttf)$/.test(asset)) {
      return reply(404, 'Not found');
    }
    try {
      const filename = await realpath(join(root, asset));
      if (!filename.startsWith(root + sep)) return reply(404, 'Not found');
      const data = await readFile(filename);
      resetIdle();
      const extension = filename.slice(filename.lastIndexOf('.'));
      res.setHeader('Content-Type', MIME[extension] ?? 'application/octet-stream');
      return reply(200, req.method === 'HEAD' ? '' : data);
    } catch {
      return reply(404, 'Not found');
    }
  });
  function close() {
    clearTimeout(idle);
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  }
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  resetIdle();
  return { url: origin + prefix, close };
}
