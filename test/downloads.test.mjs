import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t, script) {
  const dir = await mkdtemp(join(tmpdir(), 'excalidraw-download-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'installer.mjs');
  await writeFile(file, script);
  return { file, logPath: join(dir, 'state', 'download.log') };
}

test('installer command resolves the actual Playwright CLI despite restricted package exports', async () => {
  const { chromiumInstallCommand } = await import('../src/downloads.mjs');
  const command = chromiumInstallCommand();
  const { stdout } = await promisify(execFile)(command.command, [command.args[0], '--version']);
  assert.match(stdout, /Version 1\.64\.0/);
  assert.deepEqual(command.args.slice(1), ['install', 'chromium', '--only-shell']);
});

// Dropping split output chunks or keeping progress only in stdout makes this fail.
test('installer stages, split percent output and stderr are logged and reported in real time', async t => {
  const { runLoggedCommand } = await import('../src/downloads.mjs');
  const { file, logPath } = await fixture(t, `
    process.stdout.write('Downloading Chrome Headless Shell (99 MiB)\\n');
    process.stdout.write('\\x1b[32m|######');
    setTimeout(() => { process.stdout.write('| 25% of 99 MiB\\x1b[0m\\r'); process.stderr.write('Network retry 1\\n'); }, 25);
    setTimeout(() => process.stdout.write('|############| 100% of 99 MiB\\nDownloaded successfully\\n'), 60);
  `);
  const reports = [];
  await runLoggedCommand(process.execPath, [file], { logPath, onProgress: report => reports.push(report) });
  assert.ok(reports.some(report => report.percentage === 25));
  assert.ok(reports.some(report => report.percentage === 100));
  assert.ok(reports.some(report => /retry/.test(report.message)));
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /Downloading Chrome/);
  assert.match(log, /25% of 99 MiB/);
  assert.match(log, /Network retry 1/);
  assert.match(log, /Downloaded successfully/);
  assert.ok(!log.includes('\x1b'));
});

test('installer failure leaves diagnostic output and permits another attempt', async t => {
  const { runLoggedCommand } = await import('../src/downloads.mjs');
  const { file, logPath } = await fixture(t, "console.error('Download failed: connection reset'); process.exitCode = 7;");
  await assert.rejects(runLoggedCommand(process.execPath, [file], { logPath }), /7|connection reset/);
  assert.match(await readFile(logPath, 'utf8'), /connection reset/);
  await writeFile(file, "console.log('Retry succeeded');");
  await runLoggedCommand(process.execPath, [file], { logPath });
  assert.match(await readFile(logPath, 'utf8'), /Retry succeeded/);
});

test('cancellation stops a running installer and prevents its later side effect', async t => {
  const { runLoggedCommand } = await import('../src/downloads.mjs');
  const { file, logPath } = await fixture(t, "console.log('Download started'); setTimeout(()=>console.log('Must not finish'), 5000);");
  const controller = new AbortController();
  const reports = [];
  const running = runLoggedCommand(process.execPath, [file], {
    logPath, signal: controller.signal,
    onProgress: report => { reports.push(report); if (/started/.test(report.message)) controller.abort(); },
  });
  await assert.rejects(running, /cancel/i);
  assert.ok(reports.some(report => /started/.test(report.message)));
  assert.ok(!(await readFile(logPath, 'utf8')).includes('Must not finish'));
});

test('already-cancelled work never starts an installer', async t => {
  const { runLoggedCommand } = await import('../src/downloads.mjs');
  const { file, logPath } = await fixture(t, "console.log('Must not start');");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runLoggedCommand(process.execPath, [file], { logPath, signal: controller.signal }), /cancel/i);
});

test('document snapshots reuse scene validation and ordinary Markdown is not a drawing', async () => {
  const { parseSceneText, isDrawingDocument } = await import('../src/scene.mjs');
  const json = await readFile(new URL('./fixtures/demo.excalidraw', import.meta.url), 'utf8');
  assert.equal((await parseSceneText(json)).elements.length, 3);
  const wrapped = `---\nexcalidraw-plugin: parsed\n---\n## Drawing\n\`\`\`json\n${json}\n\`\`\``;
  assert.equal((await parseSceneText(wrapped, { markdown: true })).elements.length, 3);
  assert.equal(isDrawingDocument('file:///notes.md', wrapped), true);
  assert.equal(isDrawingDocument('file:///broken.excalidraw', '{'), true);
  assert.equal(isDrawingDocument('file:///diagram.excalidraw.md', ''), true);
  assert.equal(isDrawingDocument('file:///notes.md', '# Ordinary note\nDiscuss excalidraw-plugin: parsed'), false);
  assert.equal(isDrawingDocument('file:///config.json', '{"type":"normal"}'), false);
  assert.equal(isDrawingDocument('file:///scene.json', json), true);
  await assert.rejects(parseSceneText('{'), /JSON/);
});
