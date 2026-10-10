import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startLsp, openDocument, actionParams } from './helpers/lsp-client.mjs';
const exec = promisify(execFile);

test('release archive is self-contained and excludes private/development files', async t => {
  const { buildRuntimeArchive } = await import('../scripts/package-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw runtime package '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = await buildRuntimeArchive({ outputDir: dir });
  const { stdout } = await exec('tar', ['-tzf', archive], { maxBuffer: 4 * 1024 * 1024 });
  const files = stdout.split('\n');
  assert.ok(files.some(path => path.endsWith('src/lsp.mjs')));
  assert.ok(files.some(path => path.endsWith('dist/app.js')));
  // Project-private/development roots must be absent; dependency directories
  // named "test" can contain real runtime code and must not be filtered out.
  assert.ok(!files.some(path => /^\.\/(docs|test|tests|scripts|\.git|\.DS_Store|state)(?:\/|$)/.test(path)));
  assert.ok(files.filter(Boolean).every(path => path.startsWith('./') && !path.includes('../')));
  const unpack = join(dir, 'unpacked'); await mkdir(unpack);
  await exec('tar', ['-xzf', archive, '-C', unpack]);
  const metadata = JSON.parse(await readFile(join(unpack, 'runtime.json'), 'utf8'));
  assert.equal(metadata.version, '0.2.1');
  assert.match(await readFile(join(unpack, 'LICENSE'), 'utf8'), /MIT License/);
  assert.equal(JSON.parse(await readFile(join(unpack, 'package.json'), 'utf8')).license, 'MIT');
  const packagedCli = join(unpack, 'node_modules/playwright/cli.js');
  await access(packagedCli);
  const cliResult = await exec(process.execPath, [packagedCli, '--version'], { cwd: unpack });
  assert.match(cliResult.stdout, /Version 1\.64\.0/);
  await access(join(unpack, 'third-party/excalidraw-LICENSE'));
  const client = await startLsp(t, { script: join(unpack, 'src/lsp.mjs'), stateDir: join(dir, 'state') });
  const uri = 'file:///release.excalidraw';
  openDocument(client, uri, await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8'));
  assert.equal((await client.request('textDocument/codeAction', actionParams(uri))).length, 3);
  const browserResult = await client.request('workspace/executeCommand', { command: 'excalidraw.preview.browser', arguments: [uri] });
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(browserResult.uri);
  await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error);
  assert.equal(await page.locator('body').getAttribute('data-error'), null, await page.locator('#status').textContent());
  assert.match(await page.locator('#drawing').textContent(), /Hello 中文/);
  assert.ok(await page.evaluate(() => Array.from(document.fonts).some(font => font.family === 'Virgil' && font.status === 'loaded')));
});

test('packaged first PNG installs Chromium from an empty cache and exposes live progress/logs', {
  skip: process.env.EXCALIDRAW_TEST_COLD_DOWNLOAD !== '1',
  timeout: 240_000,
}, async t => {
  const { buildRuntimeArchive } = await import('../scripts/package-runtime.mjs');
  const root = await mkdtemp(join(tmpdir(), 'packaged cold download '));
  const cleanup = [];
  let output;
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    if (output) await rm(dirname(output), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const archive = await buildRuntimeArchive({ outputDir: root });
  const unpack = join(root, 'unpacked runtime'); await mkdir(unpack);
  await exec('tar', ['-xzf', archive, '-C', unpack]);
  const client = await startLsp({ after: fn => cleanup.push(fn) }, {
    script: join(unpack, 'src/lsp.mjs'), stateDir: join(root, 'state'), requestTimeout: 220_000,
    env: { PLAYWRIGHT_BROWSERS_PATH: join(root, 'empty browser cache'), NODE_PATH: '' },
  });
  const uri = 'file:///packaged-first-run.excalidraw';
  openDocument(client, uri, await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8'));
  const rendering = client.request('workspace/executeCommand', { command: 'excalidraw.preview.png', arguments: [uri] });
  await client.waitFor(event => event.method === '$/progress' && event.params.value.kind === 'begin');
  const log = await client.request('workspace/executeCommand', { command: 'excalidraw.downloadLog', arguments: [] });
  assert.match(new URL(log.uri).pathname, /download\.log$/);
  const result = await rendering;
  output = fileURLToPath(result.uri);
  const png = await readFile(output);
  assert.equal(png.readUInt32BE(16), 340);
  assert.equal(png.readUInt32BE(20), 200);
  assert.ok(client.events.some(event => event.method === '$/progress' && event.params.value.percentage === 100));
  assert.ok(!(await readFile(new URL(log.uri), 'utf8')).includes('Cannot find module'));
});
