#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScene } from './scene.mjs';
import { startServer } from './server.mjs';
import { openInZed, openInBrowser } from './launch.mjs';

const cliPath = fileURLToPath(import.meta.url);

export async function startBrowserServer(file) {
  await loadScene(file);
  const child = spawn(process.execPath, [cliPath, 'serve', file], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview server startup timed out.')), 15_000);
      const done = (fn, value) => { clearTimeout(timer); fn(value); };
      child.once('error', error => done(reject, error));
      child.once('exit', code => done(reject, new Error(`Preview server exited before startup (${code}).`)));
      child.once('message', message => message.error ? done(reject, new Error(message.error)) : done(resolve, message.url));
    });
    child.disconnect();
    child.unref();
    return { url, pid: child.pid };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function main(args) {
  const [mode, ...rest] = args;
  const flags = rest.filter(arg => arg === '--no-open');
  const inputs = rest.filter(arg => arg !== '--no-open');
  const input = inputs[0] ?? process.env.EXCALIDRAW_SOURCE_FILE;
  if (!['png', 'browser', 'serve'].includes(mode) || !input || inputs.length > 1 || inputs.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: node src/cli.mjs png|browser FILE.excalidraw|FILE.md [--no-open]');
  }
  const file = resolve(input);
  if (mode === 'serve') {
    try {
      const server = await startServer(file);
      process.on('SIGTERM', () => server.close());
      process.on('SIGINT', () => server.close());
      process.send?.({ url: server.url });
    } catch (error) {
      process.send?.({ error: error.message });
      throw error;
    }
    return;
  }
  if (mode === 'png') {
    const { renderPng } = await import('./render.mjs');
    const output = await renderPng(file);
    console.log(output);
    if (!flags.includes('--no-open')) await openInZed(output);
  } else {
    const { url, pid } = await startBrowserServer(file);
    console.log(url);
    try {
      if (!flags.includes('--no-open')) await openInBrowser(url);
    } catch (error) {
      process.kill(pid, 'SIGTERM');
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === cliPath) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Excalidraw preview: ${error.message}`);
    process.exitCode = 1;
  });
}
