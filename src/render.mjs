import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startServer } from './server.mjs';

export async function renderPng(file) {
  const server = await startServer(file);
  let browser;
  let directory;
  let timer;
  try {
    browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const origin = new URL(server.url).origin;
    await context.route('**/*', route => {
      const url = route.request().url();
      return url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.goto(server.url, { timeout: 30_000 });
    await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error, null, { timeout: 30_000 });
    const error = await page.locator('body').getAttribute('data-error');
    if (error) throw new Error(await page.locator('#status').textContent());
    const base64 = await Promise.race([
      page.evaluate(() => window.exportPng()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PNG export timed out after 30 seconds.')), 30_000); }),
    ]);
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Exporter did not produce a PNG.');
    directory = await mkdtemp(join(tmpdir(), 'zed-excalidraw-'));
    const output = join(directory, basename(file).replace(/(?:\.excalidraw)?\.md$|\.excalidraw$/i, '') + '.png');
    await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
    return output;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (error.message.includes("Executable doesn't exist")) {
      throw new Error('Rendering browser is not installed. Run npm run setup in the excalidraw tool directory.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
    await server.close();
  }
}
