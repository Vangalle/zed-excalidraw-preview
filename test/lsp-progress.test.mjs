import test from 'node:test';
import assert from 'node:assert/strict';

function transport() {
  const events = []; const cancellations = [];
  return {
    events, cancellations,
    window: {
      async createWorkDoneProgress() {
        const id = cancellations.length;
        return {
          token: { onCancellationRequested(callback) { cancellations.push(callback); return { dispose() {} }; } },
          begin(title) { events.push({ id, kind: 'begin', title }); },
          report(...args) { events.push({ id, kind: 'report', args }); },
          done() { events.push({ id, kind: 'end' }); },
        };
      },
      showInformationMessage(message, ...actions) { events.push({ kind: 'notice', message, actions }); return new Promise(() => {}); },
    },
    console: { log() {} },
  };
}

test('first-download notice is nonblocking and immutable native titles distinguish download from rendering', async () => {
  const { createPreviewProgress } = await import('../src/lsp-progress.mjs');
  const connection = transport(); const controller = new AbortController();
  const progress = createPreviewProgress(connection, { controller, showLog: async () => {}, isActive: () => true });
  await progress.phase('checking'); await progress.phase('download');
  progress.report({ message: 'Downloading browser 20% of 100 MiB', percentage: 20 });
  await progress.phase('render'); progress.done();
  assert.deepEqual(connection.events.filter(e => e.kind === 'begin').map(e => e.title), ['Excalidraw: Checking existing browsers', 'Excalidraw: Downloading Chromium', 'Excalidraw: Rendering PNG']);
  assert.equal(connection.events.filter(e => e.kind === 'notice').length, 1);
  const notice = connection.events.find(e => e.kind === 'notice');
  assert.match(notice.message, /first-time setup/i);
  assert.match(notice.message, /rendering has not started/i);
  assert.ok(notice.actions.some(action => action.title === 'Cancel download'));
  assert.deepEqual(connection.events.filter(e => e.kind === 'report')[0].args, [20, 'Downloading browser 20% of 100 MiB']);
  const downloadEnd = connection.events.findIndex(e => e.kind === 'end' && e.id === 1);
  const renderBegin = connection.events.findIndex(e => e.kind === 'begin' && /Rendering/.test(e.title));
  assert.ok(downloadEnd < renderBegin);
});

test('warm reuse has no setup notice; cancellation from either stage still cancels the entire operation', async () => {
  const { createPreviewProgress } = await import('../src/lsp-progress.mjs');
  const connection = transport(); const controller = new AbortController();
  const progress = createPreviewProgress(connection, { controller, showLog: async () => {}, isActive: () => true });
  await progress.phase('checking'); await progress.phase('render');
  assert.ok(!connection.events.some(e => e.kind === 'notice'));
  connection.cancellations[0]();
  assert.equal(controller.signal.aborted, true);
  progress.done();
});
