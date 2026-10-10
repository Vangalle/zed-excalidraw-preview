import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/demo.excalidraw', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function browserPage(t, url) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const external = [];
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http') && !request.url().startsWith(new URL(url).origin)) external.push(request.url());
  });
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error);
  assert.equal(await page.locator('body').getAttribute('data-error'), null, await page.locator('#status').textContent());
  assert.deepEqual(errors, [], 'Local preview should not use eval or a broken font worker.');
  return { page, external };
}

// Exporting an empty image, dropping embedded image data, or omitting source preservation breaks this test.
test('exports real shapes, text and embedded image to a unique temp PNG, entirely locally', async t => {
  const { renderPng } = await import('../src/render.mjs');
  const before = await readFile(fixture);
  const image = await renderPng(fixture);
  t.after(() => rm(dirname(image), { recursive: true, force: true }));
  const bytes = await readFile(image);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(resolve(image).startsWith(resolve(tmpdir()) + '/'));
  assert.ok(bytes.readUInt32BE(16) >= 310);
  assert.ok(bytes.readUInt32BE(20) >= 180);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pixels = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return [Array.from(ctx.getImageData(50, 50, 1, 1).data), Array.from(ctx.getImageData(285, 35, 1, 1).data)];
  }, bytes.toString('base64'));
  assert.deepEqual(pixels[0], [255, 0, 0, 255]);
  assert.deepEqual(pixels[1], [0, 0, 255, 255]);
  const second = await renderPng(fixture);
  t.after(() => rm(dirname(second), { recursive: true, force: true }));
  assert.notEqual(dirname(second), dirname(image));
  assert.deepEqual(await readFile(fixture), before);
});

test('cancelled renderer does not launch or return a PNG', async () => {
  const { renderPng } = await import('../src/render.mjs');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => {
    const output = await renderPng(fixture, { signal: controller.signal });
    await rm(dirname(output), { recursive: true, force: true });
  }, /cancel/i);
});

test('browser viewer supports read-only zoom, pan, reset and reload without external requests', async t => {
  const { startServer } = await import('../src/server.mjs');
  const server = await startServer(fixture);
  t.after(() => server.close());
  const { page, external } = await browserPage(t, server.url);
  assert.equal(await page.locator('#drawing svg').count(), 1);
  assert.match(await page.locator('#drawing').textContent(), /Hello 中文/);
  assert.ok(await page.evaluate(() => Array.from(document.fonts).some(font => font.family === 'Virgil' && font.status === 'loaded')), 'Legacy hand-drawn font must be loaded, not replaced by a system font.');
  assert.equal(await page.locator('input, textarea, [contenteditable="true"]').count(), 0);
  const initial = await page.locator('#drawing').getAttribute('style');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.notEqual(await page.locator('#drawing').getAttribute('style'), initial);
  await page.mouse.move(800, 450); await page.mouse.down(); await page.mouse.move(850, 490); await page.mouse.up();
  const panned = await page.locator('#drawing').getAttribute('style');
  await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
  assert.notEqual(await page.locator('#drawing').getAttribute('style'), panned);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.deepEqual(external, []);
});

test('modern hand-drawn Latin and Chinese fonts are loaded locally in the SVG viewer', async t => {
  const { startServer } = await import('../src/server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-font-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'modern.excalidraw');
  const scene = JSON.parse(await readFile(fixture, 'utf8'));
  scene.elements.find(element => element.type === 'text').fontFamily = 5;
  await writeFile(file, JSON.stringify(scene));
  const server = await startServer(file);
  t.after(() => server.close());
  const { page, external } = await browserPage(t, server.url);
  const loaded = await page.evaluate(() => Array.from(document.fonts).filter(font => font.status === 'loaded').map(font => font.family));
  assert.ok(loaded.includes('Excalifont'), 'Modern Latin text must not fall back to sans-serif.');
  assert.ok(loaded.includes('Xiaolai'), 'Chinese hand-drawn fallback must be loaded.');
  assert.deepEqual(external, []);
});

test('empty/deleted-only scenes still produce a valid image and viewer', async t => {
  const { renderPng } = await import('../src/render.mjs');
  const { startServer } = await import('../src/server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'empty-excalidraw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'empty.excalidraw');
  await writeFile(file, JSON.stringify({ type: 'excalidraw', elements: [], appState: {}, files: {} }));
  const png = await renderPng(file);
  t.after(() => rm(dirname(png), { recursive: true, force: true }));
  assert.equal((await readFile(png)).readUInt32BE(16), 640);
  const server = await startServer(file);
  t.after(() => server.close());
  const { page } = await browserPage(t, server.url);
  assert.match(await page.locator('#status').textContent(), /Empty canvas/);
});

test('CLI --no-open handles Unicode/spaced paths and errors without invoking applications', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '图形 with spaces.excalidraw');
  await writeFile(file, await readFile(fixture));
  // A regression must never open a real application during unattended tests.
  const env = { ...process.env, ZED_EXCALIDRAW_ZED_BIN: join(dir, 'must-not-launch') };
  const { stdout } = await exec(process.execPath, [cli, 'png', file, '--no-open'], { env });
  const png = stdout.trim();
  t.after(() => rm(dirname(png), { recursive: true, force: true }));
  assert.ok((await readFile(png)).length > 100);
  const environmentRun = await exec(process.execPath, [cli, 'png', '--no-open'], { env: { ...env, EXCALIDRAW_SOURCE_FILE: file } });
  const environmentPng = environmentRun.stdout.trim();
  t.after(() => rm(dirname(environmentPng), { recursive: true, force: true }));
  assert.ok((await readFile(environmentPng)).length > 100);
  await writeFile(file, '{');
  await assert.rejects(exec(process.execPath, [cli, 'png', file], { env }), error => error.code === 1 && /JSON/.test(error.stderr) && !/opening Zed/.test(error.stderr));
});

test('reload reads saved changes and reports corrupt files instead of silently showing stale content', async t => {
  const { startServer } = await import('../src/server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-reload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'reload.excalidraw');
  const scene = JSON.parse(await readFile(fixture, 'utf8'));
  await writeFile(file, JSON.stringify(scene));
  const server = await startServer(file);
  t.after(() => server.close());
  const { page } = await browserPage(t, server.url);
  const text = scene.elements.find(element => element.type === 'text');
  text.text = text.originalText = 'Saved change';
  await writeFile(file, JSON.stringify(scene));
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#drawing').textContent.includes('Saved change'));
  await writeFile(file, '{');
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.error);
  assert.match(await page.locator('#status').textContent(), /JSON/);
});

test('large scenes are downscaled to the canvas limit and deleted-only scenes stay empty', async t => {
  const { renderPng } = await import('../src/render.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-large-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'large.excalidraw');
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const scene = { ...original, elements: [{ ...original.elements[0], width: 100_000 }], files: {} };
  await writeFile(file, JSON.stringify(scene));
  const output = await renderPng(file);
  t.after(() => rm(dirname(output), { recursive: true, force: true }));
  const png = await readFile(output);
  assert.equal(Math.max(png.readUInt32BE(16), png.readUInt32BE(20)), 8192);
  scene.elements[0].isDeleted = true;
  await writeFile(file, JSON.stringify(scene));
  const blank = await renderPng(file);
  t.after(() => rm(dirname(blank), { recursive: true, force: true }));
  assert.equal((await readFile(blank)).readUInt32BE(16), 640);
});

test('detached browser service reports a working URL without launching a visible browser', async t => {
  const { startBrowserServer } = await import('../src/cli.mjs');
  const { url, pid } = await startBrowserServer(fixture);
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await (await fetch(`${url}scene`)).json()).type, 'excalidraw');
});

test('Zed launcher passes the literal PNG path as one argument without a shell', async t => {
  const { openInZed } = await import('../src/launch.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-launch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recorder = join(dir, 'recorder');
  const out = join(dir, 'args.json');
  await writeFile(recorder, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(recorder, 0o700);
  const path = join(dir, '中文 ; $(evil).png');
  await openInZed(path, { command: recorder });
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), ['--existing', path]);
});
