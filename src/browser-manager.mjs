import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { createOwnedBrowserCache } from './browser-cache.mjs';
import { appendDownloadLog, chromiumInstallCommand, runLoggedCommand } from './downloads.mjs';

const require = createRequire(import.meta.url);
// Version-pinned Playwright exports this namespace. Using its platform/revision
// metadata avoids guessing browser paths or scanning users' browser profiles.
const bundled = require('playwright-core/lib/coreBundle').registry;
const cancelled = signal => { if (signal?.aborted) throw new Error('Excalidraw preview cancelled.'); };

export async function discoverBrowserCandidates({ ownedCacheDir }) {
  const metadata = JSON.parse(await readFile(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
  const candidates = [];
  const addCache = (root, source) => {
    for (const name of ['chromium-headless-shell', 'chromium']) {
      const executable = bundled.registry.findExecutable(name)?.executablePath();
      if (!executable) continue;
      const suffix = relative(bundled.registryDirectory, executable);
      if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Pinned Playwright browser metadata changed; refusing an unsafe cache path.');
      const path = join(root, suffix);
      candidates.push({ source, path, expectedVersion: metadata.browsers.find(browser => browser.name === name)?.browserVersion, launchOptions: { executablePath: path } });
    }
  };
  const shared = bundled.defaultRegistryDirectory();
  if (resolve(shared) !== resolve(ownedCacheDir)) addCache(shared, 'shared-playwright');
  addCache(ownedCacheDir, 'owned-cache');
  for (const channel of ['chrome', 'msedge']) {
    const path = bundled.registry.findExecutable(channel)?.executablePath();
    if (path) candidates.push({ source: channel === 'chrome' ? 'system-chrome' : 'system-edge', path, launchOptions: { channel } });
  }
  return candidates;
}

export async function probeBrowser(candidate, signal) {
  cancelled(signal);
  let browser;
  const abort = () => { browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // launch(), never launchPersistentContext(): no personal browser profile.
    browser = await chromium.launch({ ...candidate.launchOptions, headless: true, args: ['--mute-audio'], timeout: 10_000 });
    cancelled(signal);
    const page = await browser.newPage();
    const valid = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const context = canvas.getContext('2d'); context.fillStyle = '#123456'; context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png').startsWith('data:image/png;base64,iVBOR');
    });
    if (!valid) throw new Error('Browser cannot export a canvas as PNG.');
    const version = browser.version();
    if (candidate.expectedVersion && version !== candidate.expectedVersion) throw new Error(`Cached browser version ${version} does not match pinned ${candidate.expectedVersion}.`);
    return { version };
  } finally {
    signal?.removeEventListener('abort', abort);
    if (browser) await browser.close();
  }
}

export function createBrowserManager({ stateDir, mode = 'auto', executablePath } = {}, adapters = {}) {
  if (!['auto', 'managed-only'].includes(mode)) throw new Error('browser.mode must be "auto" or "managed-only".');
  if (executablePath !== undefined && (typeof executablePath !== 'string' || !isAbsolute(executablePath))) throw new Error('browser.executablePath must be an absolute path.');
  const cache = createOwnedBrowserCache(stateDir, [bundled.defaultRegistryDirectory()]);
  const discover = adapters.candidates ?? discoverBrowserCandidates;
  const probe = adapters.probe ?? probeBrowser;
  let selected;
  let checks = [];

  async function report(message, options) {
    if (options.logPath) await appendDownloadLog(options.logPath, message);
    options.onProgress?.({ message });
  }
  async function verify(candidate, options, lease = true) {
    cancelled(options.signal);
    let release;
    try {
      await access(candidate.path, constants.X_OK);
      if (candidate.source === 'owned-cache' && lease) release = await cache.acquireLease();
      const result = await probe(candidate, options.signal);
      cancelled(options.signal);
      checks.push({ source: candidate.source, path: candidate.path, usable: true, version: result.version });
      return { ...candidate, ...result };
    } catch (error) {
      cancelled(options.signal);
      checks.push({ source: candidate.source, path: candidate.path, usable: false, reason: error.message.slice(0, 1024) });
      await report(`Browser candidate ${candidate.source} unavailable: ${candidate.path} (${error.message.slice(0, 512)})`, options);
      return null;
    } finally { if (release) await release(); }
  }
  async function candidates() {
    const all = await discover({ ownedCacheDir: cache.path });
    return mode === 'managed-only' ? all.filter(candidate => candidate.source === 'owned-cache') : all;
  }
  async function finish(candidate, options) {
    selected = candidate;
    await report(`Using Chromium-compatible browser: ${candidate.source}, version ${candidate.version}, ${candidate.path}. Rendering uses an isolated temporary profile.`, options);
    return candidate;
  }

  return {
    async resolve(options = {}) {
      checks = [];
      await options.onPhase?.('checking');
      await report('Checking existing browsers and exact-build Playwright caches before downloading anything.', options);
      if (executablePath) {
        const entry = { source: 'configured', path: executablePath, launchOptions: { executablePath } };
        const verified = await verify(entry, options);
        if (!verified) throw new Error(`Explicitly configured browser failed verification: ${executablePath}. Fix browser.executablePath or remove the override. See the download log for details.`);
        return finish(verified, options);
      }
      for (const entry of await candidates()) {
        const verified = await verify(entry, options);
        if (verified) return finish(verified, options);
      }
      cancelled(options.signal);
      await options.onPhase?.('download');
      await report('No compatible existing browser was found. First-time setup: downloading Chromium (approximately 100–150 MB). PNG rendering has NOT started. Future previews will reuse this browser.', options);
      const install = adapters.install ?? (async path => {
        const command = chromiumInstallCommand();
        await runLoggedCommand(command.command, command.args, { ...options, env: { PLAYWRIGHT_BROWSERS_PATH: path } });
      });
      const installed = await cache.install(async path => {
        await install(path);
        for (const entry of (await candidates()).filter(entry => entry.source === 'owned-cache')) {
          const verified = await verify(entry, options, false);
          if (verified) return verified;
        }
        throw new Error('Downloaded Chromium failed PNG compatibility verification. See the download log.');
      });
      return finish(installed, options);
    },
    async acquireLease(candidate) { return candidate.source === 'owned-cache' ? cache.acquireLease() : async () => {}; },
    async details() {
      return { policy: mode, configuredExecutable: executablePath ?? null, selected: selected ? { source: selected.source, version: selected.version, path: selected.path } : null, isolatedTemporaryProfile: true, ownedCache: await cache.details(), lastChecks: checks };
    },
    async writeDetails() {
      const file = join(stateDir, 'browser-info.json');
      await mkdir(stateDir, { recursive: true });
      await writeFile(file, JSON.stringify(await this.details(), null, 2) + '\n', { mode: 0o600 });
      return file;
    },
    async clearOwnedCache() { await cache.clear(); if (selected?.source === 'owned-cache') selected = undefined; },
  };
}
