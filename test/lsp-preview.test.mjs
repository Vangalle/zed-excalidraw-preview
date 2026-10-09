import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createPreviewService } from '../src/lsp-preview.mjs';

test('rapid editor changes are serialized into browser snapshots without missing temporary files', async t => {
  const state = await mkdtemp(join(tmpdir(), 'snapshot-update-test-'));
  const service = createPreviewService(state);
  t.after(async () => { await service.close(); await rm(state, { recursive: true, force: true }); });
  const json = await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8');
  const uri = 'file:///drawing.excalidraw';
  const initial = TextDocument.create(uri, 'excalidraw', 1, json);
  const output = await service.preview(() => initial, { mode: 'browser', onProgress: () => {}, signal: new AbortController().signal });
  const changes = [];
  for (let version = 2; version <= 10; version++) {
    const scene = JSON.parse(json);
    scene.elements.find(element => element.type === 'text').text = `Version ${version}`;
    changes.push(service.refresh(TextDocument.create(uri, 'excalidraw', version, JSON.stringify(scene))));
  }
  await Promise.all(changes);
  const scene = await (await fetch(`${output.uri}scene`)).json();
  assert.equal(scene.elements.find(element => element.type === 'text').text, 'Version 10');
});
