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

const input = new StreamMessageReader(process.stdin);
const connection = createConnection(ProposedFeatures.all, input, new StreamMessageWriter(process.stdout));
const documents = new TextDocuments(TextDocument);
const stateDir = process.env.EXCALIDRAW_STATE_DIR || join(tmpdir(), `excalidraw-lsp-${process.pid}`);
const logPath = join(stateDir, 'download.log');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await appendDownloadLog(logPath, 'Excalidraw preview server started. Chromium is downloaded only on first PNG preview.');
const previews = createPreviewService(stateDir);
const jobs = new Set();
let pngBusy = false;
let stopping = false;
const commands = [
  ['Preview Excalidraw as PNG', 'excalidraw.preview.png'],
  ['Preview Excalidraw in Browser', 'excalidraw.preview.browser'],
  ['Excalidraw: View Download Log', 'excalidraw.downloadLog'],
];

connection.onInitialize(() => ({
  capabilities: { textDocumentSync: TextDocumentSyncKind.Full, codeActionProvider: true, executeCommandProvider: { commands: commands.map(([, command]) => command) } },
  serverInfo: { name: 'Excalidraw Preview', version: '0.2.0' },
}));

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
  if (!['excalidraw.preview.png', 'excalidraw.preview.browser'].includes(command)) throw new ResponseError(LSPErrorCodes.RequestFailed, 'Unknown Excalidraw command.');
  const uri = args?.[0];
  const document = typeof uri === 'string' ? documents.get(uri) : undefined;
  if (!document || !isDrawingDocument(uri, document.getText())) throw new ResponseError(LSPErrorCodes.RequestFailed, 'Open an Excalidraw drawing before running this action.');
  const mode = command.endsWith('.png') ? 'png' : 'browser';
  if (mode === 'png' && pngBusy) throw new ResponseError(LSPErrorCodes.RequestFailed, 'A PNG preview/download is already running. Use View Download Log to inspect it.');
  if (mode === 'png') pngBusy = true;
  const controller = new AbortController();
  jobs.add(controller);
  let progress;
  let cancellation;
  try {
    await appendDownloadLog(logPath, `Excalidraw ${mode.toUpperCase()} preview requested.`);
    progress = await connection.window.createWorkDoneProgress();
    cancellation = progress.token.onCancellationRequested(() => controller.abort());
    progress.begin(`Excalidraw ${mode.toUpperCase()} preview`, undefined, 'Preparing preview. View Download Log is available from code actions.', true);
    const onProgress = report => {
      if (stopping) return;
      connection.console.log(report.message);
      if (report.percentage != null) progress.report(report.percentage, report.message);
      else progress.report(report.message);
    };
    const output = await previews.preview(() => documents.get(uri), { mode, logPath, onProgress, signal: controller.signal });
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
    cancellation?.dispose();
    progress?.done();
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
