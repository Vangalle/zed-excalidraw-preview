import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';

export async function startLsp(t, { script = fileURLToPath(new URL('../../src/lsp.mjs', import.meta.url)), stateDir, env = {}, requestTimeout = 8_000 } = {}) {
  const root = stateDir ?? await mkdtemp(join(tmpdir(), 'excalidraw-lsp-test-'));
  if (!stateDir) t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [script, '--stdio'], { env: { ...process.env, EXCALIDRAW_STATE_DIR: root, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const events = [];
  const emitter = new EventEmitter();
  const record = event => { events.push(event); emitter.emit('event', event); };
  connection.onRequest('window/workDoneProgress/create', params => { record({ method: 'window/workDoneProgress/create', params }); return null; });
  connection.onRequest('window/showDocument', params => { record({ method: 'window/showDocument', params }); return { success: true }; });
  connection.onRequest('window/showMessageRequest', params => { record({ method: 'window/showMessageRequest', params }); return null; });
  // JSON-RPC deliberately excludes $/ methods from the unhandled callback.
  connection.onNotification('$/progress', params => record({ method: '$/progress', params }));
  connection.onNotification((method, params) => record({ method, params }));
  connection.onClose(() => connection.dispose());
  connection.listen();
  const request = (method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LSP ${method} timed out. ${stderr}`)), requestTimeout);
    connection.sendRequest(method, params).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      try { await request('shutdown'); connection.sendNotification('exit'); } catch { child.kill(); }
      await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 1000).unref(); });
    }
    connection.dispose();
  });
  const waitFor = predicate => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { emitter.off('event', listener); reject(new Error(`LSP notification timed out. ${stderr}`)); }, 8_000);
      const listener = event => { if (predicate(event)) { clearTimeout(timer); emitter.off('event', listener); resolve(event); } };
      emitter.on('event', listener);
    });
  };
  const initialized = await request('initialize', { processId: process.pid, rootUri: null, capabilities: { window: { workDoneProgress: true, showDocument: { support: true } }, textDocument: { synchronization: { didSave: true } } } });
  connection.sendNotification('initialized', {});
  return { request, notify: (method, params) => connection.sendNotification(method, params), waitFor, events, initialized, stateDir: root };
}

export const actionParams = uri => ({ textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, context: { diagnostics: [] } });
export const openDocument = (client, uri, text, languageId = 'excalidraw') => client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
