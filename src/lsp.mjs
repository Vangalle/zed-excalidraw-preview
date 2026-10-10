#!/usr/bin/env node
import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DiagnosticSeverity, ResponseError, LSPErrorCodes } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDrawingDocument, parseSceneText } from './scene.mjs';
import { appendDownloadLog } from './downloads.mjs';
import { createPreviewService } from './lsp-preview.mjs';
import { createPreviewProgress } from './lsp-progress.mjs';

const input = new StreamMessageReader(process.stdin);
const connection = createConnection(ProposedFeatures.all, input, new StreamMessageWriter(process.stdout));
const documents = new TextDocuments(TextDocument);
const stateDir = process.env.EXCALIDRAW_STATE_DIR || join(tmpdir(), `excalidraw-lsp-${process.pid}`);
const logPath = join(stateDir, 'download.log');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await appendDownloadLog(logPath, 'Excalidraw preview server started. Existing compatible browsers are reused; Chromium is downloaded only when needed.');
const previews = createPreviewService(stateDir);
const jobs = new Set();
let pngBusy = false;
let stopping = false;
const commands = [
  ['Preview Excalidraw as PNG', 'excalidraw.preview.png'],
  ['Preview Excalidraw in Browser', 'excalidraw.preview.browser'],
  ['Excalidraw: View Download Log', 'excalidraw.downloadLog'],
  ['Excalidraw: Browser Details', 'excalidraw.browserInfo'],
  ['Excalidraw: Clear Extension Browser Cache', 'excalidraw.clearBrowserCache'],
];

connection.onInitialize(params => {
  previews.configureBrowser(params.initializationOptions?.browser ?? {});
  return {
    capabilities: { textDocumentSync: TextDocumentSyncKind.Full, codeActionProvider: true, executeCommandProvider: { commands: commands.map(([, command]) => command) } },
    serverInfo: { name: 'Excalidraw Preview', version: '0.2.1' },
  };
});

async function validate(document) {
  let diagnostics = [];
  if (isDrawingDocument(document.uri, document.getText())) {
    try { await parseSceneText(document.getText(), { markdown: new URL(document.uri).pathname.toLowerCase().endsWith('.md') }); }
    catch (error) {
      diagnostics = [{ severity: DiagnosticSeverity.Error, source: 'Excalidraw', message: error.message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: Math.min(1, document.getText().split('\n')[0].length) } } }];
    }
  }
  if (!stopping && documents.get(document.uri)?.version === document.version) connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
}

documents.onDidChangeContent(({ document }) => {
  validate(document).catch(error => connection.console.error(error.message));
  previews.refresh(document).catch(error => connection.console.error(`Unable to refresh preview snapshot: ${error.message}`));
});
documents.onDidClose(({ document }) => connection.sendDiagnostics({ uri: document.uri, diagnostics: [] }));
connection.onCodeAction(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !isDrawingDocument(document.uri, document.getText())) return [];
  return commands.map(([title, command]) => ({ title, command: { title, command, arguments: [document.uri] } }));
});

async function show(uri, external = false) {
  const result = await connection.sendRequest('window/showDocument', { uri, external, takeFocus: true });
  if (!result?.success) throw new Error('The editor could not open the preview.');
  return { uri, external };
}
const showLog = () => show(pathToFileURL(logPath).href);

connection.onExecuteCommand(async ({ command, arguments: args }) => {
  if (command === 'excalidraw.downloadLog') return showLog();
  if (command === 'excalidraw.browserInfo') return show(pathToFileURL(await previews.browserInfoFile()).href);
  if (command === 'excalidraw.clearBrowserCache') {
    if (pngBusy) throw new ResponseError(LSPErrorCodes.RequestFailed, 'A PNG preview/download is busy. Wait before clearing its browser cache.');
    const { ownedCache } = await previews.browserDetails();
    if (!ownedCache.clearable) throw new ResponseError(LSPErrorCodes.RequestFailed, ownedCache.reason);
    const size = (ownedCache.bytes / 1024 / 1024).toFixed(1);
    const action = await connection.window.showWarningMessage(
      `Remove only Excalidraw's downloaded browser cache (${size} MiB)?\n${ownedCache.path}\nSystem browsers and shared Playwright caches will NOT be changed. Close any previews running in older extension versions first.`,
      { title: 'Remove extension cache' }, { title: 'Cancel' },
    );
    if (action?.title !== 'Remove extension cache') return { cleared: false };
    if (pngBusy) throw new ResponseError(LSPErrorCodes.RequestFailed, 'A PNG preview/download started while confirmation was open. Browser cache was not cleared.');
    try { await previews.clearBrowserCache(); }
    catch (error) { throw new ResponseError(LSPErrorCodes.RequestFailed, error.message); }
    await appendDownloadLog(logPath, `User-confirmed cleanup of extension-owned browser cache: ${ownedCache.path}`);
    return { cleared: true, path: ownedCache.path };
  }
  if (!['excalidraw.preview.png', 'excalidraw.preview.browser'].includes(command)) throw new ResponseError(LSPErrorCodes.RequestFailed, 'Unknown Excalidraw command.');
  const uri = args?.[0];
  const document = typeof uri === 'string' ? documents.get(uri) : undefined;
  if (!document || !isDrawingDocument(uri, document.getText())) throw new ResponseError(LSPErrorCodes.RequestFailed, 'Open an Excalidraw drawing before running this action.');
  const mode = command.endsWith('.png') ? 'png' : 'browser';
  if (mode === 'png' && pngBusy) throw new ResponseError(LSPErrorCodes.RequestFailed, 'A PNG preview/download is already running. Use View Download Log to inspect it.');
  if (mode === 'png') pngBusy = true;
  const controller = new AbortController();
  jobs.add(controller);
  const progress = createPreviewProgress(connection, { controller, showLog, isActive: () => jobs.has(controller), isStopping: () => stopping });
  try {
    await appendDownloadLog(logPath, `Excalidraw ${mode.toUpperCase()} preview requested.`);
    await progress.phase(mode === 'png' ? 'checking' : 'browser');
    const output = await previews.preview(() => documents.get(uri), { mode, logPath, onProgress: report => progress.report(report), onPhase: phase => progress.phase(phase), signal: controller.signal });
    if (controller.signal.aborted) throw new Error('Excalidraw preview cancelled.');
    await appendDownloadLog(logPath, `${mode.toUpperCase()} preview is ready.`);
    return await show(output.uri, output.external);
  } catch (error) {
    await appendDownloadLog(logPath, error.message);
    if (!stopping && !controller.signal.aborted) {
      connection.window.showErrorMessage(`Excalidraw preview failed: ${error.message}`, { title: 'View Download Log' })
        .then(action => action?.title === 'View Download Log' ? showLog() : undefined)
        .catch(failure => appendDownloadLog(logPath, `Unable to show download log: ${failure.message}`));
    }
    throw new ResponseError(controller.signal.aborted ? LSPErrorCodes.RequestCancelled : LSPErrorCodes.RequestFailed, error.message);
  } finally {
    progress.done();
    jobs.delete(controller);
    if (mode === 'png') pngBusy = false;
  }
});

async function stop() {
  stopping = true;
  for (const job of jobs) job.abort();
  await previews.close();
}
connection.onShutdown(stop);
connection.onExit(() => { stop().finally(() => process.exit(0)); });
input.onClose(() => { stop().finally(() => process.exit(0)); });
process.stdin.once('end', () => { stop().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { stop().finally(() => process.exit(0)); });
documents.listen(connection);
connection.listen();
