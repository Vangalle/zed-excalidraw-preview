import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSceneText } from './scene.mjs';
import { renderPng } from './render.mjs';
import { startBrowserServer } from './cli.mjs';
import { ensureChromium } from './downloads.mjs';

export function createPreviewService(stateDir) {
  const browsers = [];
  let closing;
  const checkAbort = signal => { if (signal?.aborted || closing) throw new Error('Excalidraw preview cancelled.'); };
  const documentName = document => {
    const path = decodeURIComponent(new URL(document.uri).pathname);
    return basename(path).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'drawing.excalidraw';
  };
  async function snapshot(document) {
    await parseSceneText(document.getText(), { markdown: new URL(document.uri).pathname.toLowerCase().endsWith('.md') });
    const parent = join(stateDir, 'snapshots');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, 'scene-'));
    const file = join(directory, documentName(document));
    try { await writeFile(file, document.getText(), { mode: 0o600 }); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return { file, directory, uri: document.uri, version: document.version };
  }
  return {
    async preview(getDocument, { mode, logPath, onProgress, signal }) {
      if (mode === 'png') await ensureChromium({ logPath, onProgress, signal });
      checkAbort(signal);
      const document = getDocument();
      if (!document) throw new Error('The drawing document is no longer open.');
      const source = await snapshot(document);
      let keep = false;
      let service;
      try {
        checkAbort(signal);
        onProgress({ message: mode === 'png' ? 'Rendering the current editor snapshot as PNG.' : 'Starting the local read-only browser preview.' });
        if (mode === 'png') {
          const output = await renderPng(source.file);
          const current = getDocument();
          if (signal?.aborted || !current || current.version !== source.version) {
            await rm(dirname(output), { recursive: true, force: true });
            checkAbort(signal);
            throw new Error('Document changed while rendering. Run the preview action again.');
          }
          return { uri: pathToFileURL(output).href, external: false };
        }
        service = await startBrowserServer(source.file);
        checkAbort(signal);
        const current = getDocument();
        if (!current) throw new Error('The drawing document is no longer open.');
        if (current.version !== source.version) await writeFile(source.file, current.getText(), { mode: 0o600 });
        browsers.push({ ...source, ...service });
        keep = true;
        return { uri: service.url, external: true };
      } finally {
        if (!keep) {
          if (service) { try { process.kill(service.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
          await rm(source.directory, { recursive: true, force: true });
        }
      }
    },
    async refresh(document) {
      if (closing) return;
      await Promise.all(browsers.filter(browser => browser.uri === document.uri).map(browser => {
        // didChange notifications can overlap while filesystem writes are pending.
        // Serialize each preview's atomic replacement so the newest event wins.
        browser.pending = (browser.pending ?? Promise.resolve()).catch(() => {}).then(async () => {
          const temporary = `${browser.file}.update`;
          await writeFile(temporary, document.getText(), { mode: 0o600 });
          await rename(temporary, browser.file);
        });
        return browser.pending;
      }));
    },
    close() {
      if (!closing) closing = (async () => {
        for (const browser of browsers) {
          await browser.pending?.catch(() => {});
          try { process.kill(browser.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          await rm(browser.directory, { recursive: true, force: true });
        }
        browsers.length = 0;
      })();
      return closing;
    },
  };
}
