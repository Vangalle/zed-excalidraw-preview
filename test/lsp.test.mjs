import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import LZString from 'lz-string';
import { startLsp, actionParams, openDocument } from './helpers/lsp-client.mjs';

const fixture = new URL('./fixtures/demo.excalidraw', import.meta.url);

test('real LSP exposes previews only for drawing documents and validates synchronized content', async t => {
  const client = await startLsp(t);
  assert.equal(client.initialized.capabilities.codeActionProvider, true);
  const note = 'file:///ordinary.md';
  openDocument(client, note, '# Ordinary note', 'markdown');
  assert.deepEqual(await client.request('textDocument/codeAction', actionParams(note)), []);
  const drawing = 'file:///broken.excalidraw';
  openDocument(client, drawing, '{');
  const diagnostic = await client.waitFor(event => event.method === 'textDocument/publishDiagnostics' && event.params.uri === drawing && event.params.version === 1);
  assert.match(diagnostic.params.diagnostics[0].message, /JSON/);
  const actions = await client.request('textDocument/codeAction', actionParams(drawing));
  assert.deepEqual(actions.map(action => action.command.command), ['excalidraw.preview.png', 'excalidraw.preview.browser', 'excalidraw.downloadLog', 'excalidraw.browserInfo', 'excalidraw.clearBrowserCache']);
  const json = await readFile(fixture, 'utf8');
  client.notify('textDocument/didChange', { textDocument: { uri: drawing, version: 2 }, contentChanges: [{ text: json }] });
  const cleared = await client.waitFor(event => event.method === 'textDocument/publishDiagnostics' && event.params.uri === drawing && event.params.version === 2);
  assert.deepEqual(cleared.params.diagnostics, []);
});

test('PNG uses unsaved editor snapshot, reports native progress, and log remains inspectable during work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'drawing with spaces.excalidraw');
  const saved = await readFile(fixture, 'utf8');
  await writeFile(file, saved);
  const uri = pathToFileURL(file).href;
  const client = await startLsp(t);
  openDocument(client, uri, saved);
  const scene = JSON.parse(saved);
  scene.elements[0].width = 500;
  client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: JSON.stringify(scene) }] });
  const rendering = client.request('workspace/executeCommand', { command: 'excalidraw.preview.png', arguments: [uri] });
  await client.waitFor(event => event.method === '$/progress' && event.params.value.kind === 'begin');
  const logResult = await client.request('workspace/executeCommand', { command: 'excalidraw.downloadLog', arguments: [uri] });
  assert.match(new URL(logResult.uri).pathname, /download\.log$/);
  assert.match(await readFile(new URL(logResult.uri), 'utf8'), /Excalidraw|PNG/);
  const result = await rendering;
  const png = await readFile(new URL(result.uri));
  t.after(() => rm(dirname(new URL(result.uri).pathname), { recursive: true, force: true }));
  assert.equal(png.readUInt32BE(16), 540);
  assert.equal(await readFile(file, 'utf8'), saved);
  assert.ok(client.events.some(event => event.method === 'window/showDocument' && event.params.uri === result.uri && event.params.external === false));
  assert.ok(client.events.some(event => event.method === '$/progress' && event.params.value.kind === 'report'));
  assert.ok(client.events.some(event => event.method === '$/progress' && event.params.value.kind === 'end'));
  assert.ok(client.events.some(event => event.method === 'window/logMessage' && /Chromium/.test(event.params.message)));
  const titles = client.events.filter(event => event.method === '$/progress' && event.params.value.kind === 'begin').map(event => event.params.value.title);
  assert.ok(titles.includes('Excalidraw: Checking existing browsers'));
  assert.ok(titles.includes('Excalidraw: Rendering PNG'));
  assert.ok(!titles.includes('Excalidraw: Downloading Chromium'));
  assert.ok(!client.events.some(event => event.method === 'window/showMessageRequest' && /first-time setup/i.test(event.params.message)));
  const details = await client.request('workspace/executeCommand', { command: 'excalidraw.browserInfo', arguments: [] });
  const info = JSON.parse(await readFile(new URL(details.uri), 'utf8'));
  assert.ok(info.selected.path);
  assert.ok(info.selected.version);
  assert.equal(info.isolatedTemporaryProfile, true);
});

test('Obsidian editor snapshot opens a local browser URL through showDocument without launching applications', async t => {
  const client = await startLsp(t);
  const json = await readFile(fixture, 'utf8');
  const md = `---\nexcalidraw-plugin: parsed\n---\n## Drawing\n\`\`\`compressed-json\n${LZString.compressToBase64(json)}\n\`\`\``;
  const uri = 'file:///not-a-real-file/Obsidian drawing.md';
  openDocument(client, uri, md, 'markdown');
  assert.equal((await client.request('textDocument/codeAction', actionParams(uri))).length, 5);
  const result = await client.request('workspace/executeCommand', { command: 'excalidraw.preview.browser', arguments: [uri] });
  assert.equal(new URL(result.uri).hostname, '127.0.0.1');
  assert.equal((await (await fetch(`${result.uri}scene`)).json()).elements.length, 3);
  assert.ok(client.events.some(event => event.method === 'window/showDocument' && event.params.uri === result.uri && event.params.external === true));
});

test('cancelled PNG progress ends without opening an image; malformed input keeps log action available', async t => {
  const client = await startLsp(t);
  const uri = 'file:///cancel.excalidraw';
  openDocument(client, uri, await readFile(fixture, 'utf8'));
  const rendering = client.request('workspace/executeCommand', { command: 'excalidraw.preview.png', arguments: [uri] });
  const rejected = assert.rejects(rendering, /cancel/i);
  const progress = await client.waitFor(event => event.method === '$/progress' && event.params.value.kind === 'begin');
  client.notify('window/workDoneProgress/cancel', { token: progress.params.token });
  await rejected;
  await client.waitFor(event => event.method === '$/progress' && event.params.value.kind === 'end' && event.params.token === progress.params.token);
  assert.ok(!client.events.some(event => event.method === 'window/showDocument' && /\.png$/.test(event.params.uri)));
  client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: '{' }] });
  await assert.rejects(client.request('workspace/executeCommand', { command: 'excalidraw.preview.png', arguments: [uri] }), /JSON/);
  const log = await client.request('workspace/executeCommand', { command: 'excalidraw.downloadLog', arguments: [uri] });
  assert.match(await readFile(new URL(log.uri), 'utf8'), /JSON/);
});
