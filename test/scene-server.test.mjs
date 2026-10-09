import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const scene = { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#fff' }, files: {} };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '中文 drawing.excalidraw');
  await writeFile(file, JSON.stringify(scene));
  await writeFile(join(dir, 'index.html'), '<h1>viewer</h1>');
  await writeFile(join(dir, 'secret.txt'), 'not an asset');
  return { dir, file };
}

// Removing input validation would allow arbitrary JSON into the browser exporter.
test('loads a Unicode/spaced scene without changing its bytes', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  const { file } = await fixture(t);
  const before = await readFile(file);
  assert.deepEqual(await loadScene(file), scene);
  assert.deepEqual(await readFile(file), before);
});

test('rejects malformed JSON, unrelated files, and invalid image data', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  const { file } = await fixture(t);
  for (const data of ['{', '[]', '{"type":"other","elements":[]}', '{"type":"excalidraw","elements":{}}', JSON.stringify({ ...scene, files: { bad: { dataURL: 'https://external.example/image.png' } } })]) {
    await writeFile(file, data);
    await assert.rejects(loadScene(file), /Excalidraw|JSON|image/i);
  }
  await assert.rejects(loadScene(`${file}.missing`), /ENOENT/);
});

test('allows only authorized read-only scene and bundled asset routes', async t => {
  const { startServer } = await import('../src/server.mjs');
  const { dir, file } = await fixture(t);
  const server = await startServer(file, { distDir: dir });
  t.after(() => server.close());
  const response = await fetch(`${server.url}scene`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), scene);
  assert.equal((await fetch(server.url)).status, 200);
  assert.equal((await fetch(new URL('/scene', server.url))).status, 404);
  assert.equal((await fetch(`${server.url}secret.txt`)).status, 404);
  assert.equal((await fetch(`${server.url}scene`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${server.url}scene`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const url = new URL(`${server.url}scene`);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  // A path derived from a request must never escape the bundled asset directory.
  const status = await new Promise((resolve, reject) => {
    const url = new URL(server.url);
    http.get({ hostname: url.hostname, port: url.port, path: `${url.pathname}assets/%2e%2e/%2e%2e/secret.txt` }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 404);
  await writeFile(file, '{');
  assert.equal((await fetch(`${server.url}scene`)).status, 422);
});

test('idle server shuts down instead of accumulating background processes', async t => {
  const { startServer } = await import('../src/server.mjs');
  const { dir, file } = await fixture(t);
  const server = await startServer(file, { distDir: dir, idleMs: 40 });
  t.after(() => server.close());
  await new Promise(resolve => setTimeout(resolve, 120));
  await assert.rejects(fetch(server.url));
});
