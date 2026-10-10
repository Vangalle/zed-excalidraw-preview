import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

const require = createRequire(import.meta.url);
const logWrites = new Map();
const cancelledError = () => new Error('Excalidraw download cancelled.');

export async function appendDownloadLog(path, message) {
  const previous = logWrites.get(path) ?? Promise.resolve();
  const writing = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    try {
      if ((await stat(path)).size > 2 * 1024 * 1024) {
        const tail = (await readFile(path)).subarray(-64 * 1024).toString('utf8');
        await writeFile(path, `Earlier log entries rotated.\n${tail}`, { mode: 0o600 });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await appendFile(path, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  });
  logWrites.set(path, writing);
  try { await writing; } finally { if (logWrites.get(path) === writing) logWrites.delete(path); }
}

export async function runLoggedCommand(command, args, { logPath, onProgress = () => {}, signal, env = {} } = {}) {
  if (signal?.aborted) throw cancelledError();
  await appendDownloadLog(logPath, 'Starting renderer dependency installation.');
  if (signal?.aborted) throw cancelledError();
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, { detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, CI: '1' } });
  let killed = false;
  let killTimer;
  let error;
  let lastLine = '';
  let writing = Promise.resolve();
  const kill = force => {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch (failure) { if (failure.code !== 'ESRCH') error = failure; }
  };
  const abort = () => {
    killed = true;
    kill(false);
    killTimer = setTimeout(() => kill(true), 2_000);
    killTimer.unref();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const report = raw => {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().slice(0, 4096);
    if (!line) return;
    lastLine = line;
    writing = writing.then(() => appendDownloadLog(logPath, line));
    const percentage = line.match(/(?:^|\s)(\d{1,3})%\s+of\s+/)?.[1];
    onProgress({ message: line, ...(percentage ? { percentage: Math.min(100, Number(percentage)) } : {}) });
  };
  const streams = [child.stdout, child.stderr].map(stream => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const consume = text => {
      pending += text;
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop();
      for (const line of lines) report(line);
      if (pending.length > 64 * 1024) { report(pending); pending = ''; }
    };
    stream.on('data', data => consume(decoder.write(data)));
    return () => { consume(decoder.end()); if (pending) report(pending); };
  });
  try {
    const code = await new Promise(resolve => {
      child.once('error', failure => { error = failure; });
      child.once('close', resolve);
    });
    for (const flush of streams) flush();
    await writing;
    if (killed) throw cancelledError();
    if (error) throw error;
    if (code !== 0) throw new Error(`Renderer installation failed (exit ${code}): ${lastLine}`);
  } catch (failure) {
    await appendDownloadLog(logPath, failure.message);
    throw failure;
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
  }
}

export function chromiumInstallCommand() {
  // Playwright exposes package.json, but not the ./cli package subpath.
  const cli = `${dirname(require.resolve('playwright/package.json'))}/cli.js`;
  return { command: process.execPath, args: [cli, 'install', 'chromium', '--only-shell'] };
}

