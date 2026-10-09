import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import LZString from 'lz-string';
import { chromium } from 'playwright';

const emptyScene = { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#fff' }, files: {} };
// Fixed LZ-String Base64 fixture, independently checked against the Obsidian codec.
const compressedEmpty = 'N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcmTGAWxkbBoQBtALrl0UKAGUw6MHHigK2GEQBC6VAGsA5vnoBXRrgDC9TPXwIQAYgBm9kAF9yt7JwELHjoA===';
const markdown = (language, payload) => `---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n# Excalidraw Data\n## Text Elements\nUnrelated note text ^note-id\n%%\n## Drawing\n\`\`\`${language}\n${payload}\n\`\`\`\n%%\n`;
async function temporaryFile(t, content, name = '中文 diagram.md') {
  const dir = await mkdtemp(join(tmpdir(), 'obsidian-preview-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

// A raw-JSON-only loader or stripping the LZ-String line wrapping breaks this contract.
test('loads wrapped compressed-json from Obsidian .md, including BOM and CRLF, without writing it', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  const wrapped = compressedEmpty.match(/.{1,24}/g).join('\n\n');
  const file = await temporaryFile(t, '\uFEFF' + markdown('compressed-json', wrapped).replaceAll('\n', '\r\n'));
  const before = await readFile(file);
  assert.deepEqual(await loadScene(file), emptyScene);
  assert.deepEqual(await readFile(file), before);
});

test('loads uncompressed Drawing json and ignores unrelated fenced examples', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  const unrelated = '```json\n{"not":"a drawing"}\n```\n```markdown\n## Drawing\n```\n';
  const file = await temporaryFile(t, unrelated + markdown('json', JSON.stringify(emptyScene)), 'diagram.excalidraw.md');
  assert.deepEqual(await loadScene(file), emptyScene);
});

test('accepts valid Markdown fence lengths and tilde fences in the Drawing section', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  for (const fence of ['````', '~~~']) {
    const file = await temporaryFile(t, `## Drawing\n${fence}json\n${JSON.stringify(emptyScene)}\n${fence}\n`);
    assert.deepEqual(await loadScene(file), emptyScene);
  }
});

test('ordinary Markdown, unrelated sections and unfinished Drawing fences fail explicitly', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  for (const text of [
    '# Ordinary note\n```json\n{"hello":"world"}\n```',
    '## Drawing\nNo drawing here\n## Other section\n```json\n' + JSON.stringify(emptyScene) + '\n```',
    '```markdown\n## Drawing\n```\n```json\n' + JSON.stringify(emptyScene) + '\n```',
    '## Drawing\n```json\n' + JSON.stringify(emptyScene),
  ]) {
    const file = await temporaryFile(t, text);
    await assert.rejects(loadScene(file), /Drawing|drawing|Markdown/);
  }
});

test('corrupt compression and decoded non-scenes do not reach the renderer', async t => {
  const { loadScene } = await import('../src/scene.mjs');
  for (const payload of ['', '%%%invalid%%%', compressedEmpty.slice(0, 16)]) {
    const file = await temporaryFile(t, markdown('compressed-json', payload));
    await assert.rejects(loadScene(file), /compressed-json|decompress/i);
  }
  for (const json of ['not JSON', '{"type":"other","elements":[]}', '{"type":"excalidraw","elements":[null]}']) {
    const file = await temporaryFile(t, markdown('compressed-json', LZString.compressToBase64(json)));
    await assert.rejects(loadScene(file), /Excalidraw|JSON|element/);
  }
});

test('decoded byte budget is enforced for compressed and plain Drawing data', async () => {
  const { extractDrawingJson } = await import('../src/obsidian.mjs');
  const json = JSON.stringify({ text: '中文'.repeat(20) });
  for (const [language, payload] of [['json', json], ['compressed-json', LZString.compressToBase64(json)]]) {
    await assert.rejects(extractDrawingJson(markdown(language, payload), { maxBytes: 100 }), /limit|large|size/i);
  }
});

test('both preview modes render Obsidian Markdown with embedded images, retaining source bytes', async t => {
  const { renderPng } = await import('../src/render.mjs');
  const { startServer } = await import('../src/server.mjs');
  const json = await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8');
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  t.after(() => browser.close());
  for (const name of ['中文 diagram.md', 'diagram.excalidraw.md']) {
    const file = await temporaryFile(t, markdown('compressed-json', LZString.compressToBase64(json)), name);
    const before = await readFile(file);
    const output = await renderPng(file);
    t.after(() => rm(dirname(output), { recursive: true, force: true }));
    assert.equal(basename(output), name === '中文 diagram.md' ? '中文 diagram.png' : 'diagram.png');
    const png = await readFile(output);
    assert.equal(png.readUInt32BE(16), 340);
    assert.equal(png.readUInt32BE(20), 200);
    const server = await startServer(file);
    t.after(() => server.close());
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error);
    assert.equal(await page.locator('body').getAttribute('data-error'), null);
    assert.match(await page.locator('#drawing').textContent(), /Hello 中文/);
    assert.equal(await page.locator('#drawing svg image').count(), 1);
    assert.deepEqual(await readFile(file), before);
    await page.close();
  }
});
