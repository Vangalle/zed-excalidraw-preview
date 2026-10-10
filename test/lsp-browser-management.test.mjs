import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createOwnedBrowserCache } from '../src/browser-cache.mjs';
import { startLsp, openDocument } from './helpers/lsp-client.mjs';

async function ownedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lsp-browser-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const cache = createOwnedBrowserCache(stateDir);
  await cache.install(async path => { await mkdir(join(path, 'chromium_headless_shell-1248')); await writeFile(join(path, 'chromium_headless_shell-1248', 'fixture'), 'owned'); });
  const sentinel = join(root, 'other-app-browser'); await writeFile(sentinel, 'keep');
  return { stateDir, cache, sentinel };
}

test('browser details exposes cache size; dismissed cleanup confirmation removes nothing', async t => {
  const f = await ownedFixture(t);
  const client = await startLsp(t, { stateDir: f.stateDir });
  const report = await client.request('workspace/executeCommand', { command: 'excalidraw.browserInfo' });
  const info = JSON.parse(await readFile(new URL(report.uri), 'utf8'));
  assert.equal(info.ownedCache.path, f.cache.path);
  assert.ok(info.ownedCache.bytes > 0);
  const result = await client.request('workspace/executeCommand', { command: 'excalidraw.clearBrowserCache' });
  assert.equal(result.cleared, false);
  await access(f.cache.path);
  const warning = client.events.find(event => event.method === 'window/showMessageRequest' && event.params.type === 2);
  assert.ok(warning);
  assert.ok(warning.params.message.includes(f.cache.path));
  assert.match(warning.params.message, /shared|system/i);
});

test('confirmed cleanup removes only the extension-owned cache and refuses active browser leases', async t => {
  const f = await ownedFixture(t);
  const client = await startLsp(t, { stateDir: f.stateDir, onMessageRequest: params => params.actions?.find(action => action.title === 'Remove extension cache') });
  const release = await f.cache.acquireLease();
  await assert.rejects(client.request('workspace/executeCommand', { command: 'excalidraw.clearBrowserCache' }), /use|busy|lease/i);
  await release();
  const result = await client.request('workspace/executeCommand', { command: 'excalidraw.clearBrowserCache' });
  assert.equal(result.cleared, true);
  await assert.rejects(access(f.cache.path));
  assert.equal(await readFile(f.sentinel, 'utf8'), 'keep');
});

test('explicit browser renders even when the process default cache is empty', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explicit-browser-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = chromium.executablePath();
  const client = await startLsp(t, { stateDir: join(root, 'state'), requestTimeout: 45_000, env: { PLAYWRIGHT_BROWSERS_PATH: join(root, 'empty-cache') }, initializationOptions: { browser: { executablePath } } });
  const uri = 'file:///explicit-browser-render.excalidraw';
  openDocument(client, uri, await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8'));
  const result = await client.request('workspace/executeCommand', { command: 'excalidraw.preview.png', arguments: [uri] });
  t.after(() => rm(dirname(fileURLToPath(result.uri)), { recursive: true, force: true }));
  assert.equal((await readFile(new URL(result.uri))).readUInt32BE(16), 340);
  const report = await client.request('workspace/executeCommand', { command: 'excalidraw.browserInfo' });
  assert.equal(JSON.parse(await readFile(new URL(report.uri), 'utf8')).selected.source, 'configured');
});

test('invalid explicit browser path never triggers a download or opens a PNG', async t => {
  const client = await startLsp(t, { initializationOptions: { browser: { executablePath: join(tmpdir(), 'definitely-missing-explicit-chromium') } } });
  const uri = 'file:///explicit-browser.excalidraw';
  openDocument(client, uri, await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8'));
  await assert.rejects(client.request('workspace/executeCommand', { command: 'excalidraw.preview.png', arguments: [uri] }), /configured browser|override/i);
  assert.ok(!client.events.some(event => event.method === '$/progress' && /Downloading/.test(event.params.value.title ?? '')));
  assert.ok(!client.events.some(event => event.method === 'window/showDocument' && /\.png$/.test(event.params.uri)));
});
