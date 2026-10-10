import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'browser-manager-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const ownedCacheDir = join(stateDir, 'browsers');
  const sharedPath = join(root, 'shared', 'browser');
  const ownedPath = join(ownedCacheDir, 'chromium_headless_shell-1248', 'browser');
  const writeBrowser = async path => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'browser fixture', { mode: 0o700 }); };
  return { root, stateDir, ownedCacheDir, sharedPath, ownedPath, writeBrowser };
}
const candidate = (source, path) => ({ source, path, launchOptions: { executablePath: path } });
const probe = async () => ({ version: '156.0.8078.4' });

test('verified shared browser is reused without downloading or modifying shared files', async t => {
  const { createBrowserManager } = await import('../src/browser-manager.mjs');
  const f = await fixture(t); await f.writeBrowser(f.sharedPath);
  const before = await readFile(f.sharedPath); let installs = 0;
  const manager = createBrowserManager({ stateDir: f.stateDir }, {
    candidates: () => [candidate('shared-playwright', f.sharedPath)], probe,
    install: async () => { installs++; },
  });
  const selected = await manager.resolve();
  assert.equal(selected.source, 'shared-playwright');
  assert.equal(selected.path, f.sharedPath);
  assert.equal(selected.version, '156.0.8078.4');
  assert.equal(installs, 0);
  assert.deepEqual(await readFile(f.sharedPath), before);
  assert.equal((await manager.details()).selected.source, 'shared-playwright');
});

test('failed candidate verification falls through; an explicit invalid override fails instead of downloading', async t => {
  const { createBrowserManager } = await import('../src/browser-manager.mjs');
  const f = await fixture(t); await f.writeBrowser(f.sharedPath);
  const bad = join(f.root, 'bad-browser'); await f.writeBrowser(bad);
  let installs = 0;
  const adapters = {
    candidates: () => [candidate('shared-playwright', bad), candidate('system-chrome', f.sharedPath)],
    probe: async entry => { if (entry.path === bad) throw new Error('canvas verification failed'); return probe(); },
    install: async () => { installs++; },
  };
  const manager = createBrowserManager({ stateDir: f.stateDir }, adapters);
  assert.equal((await manager.resolve()).source, 'system-chrome');
  const explicit = createBrowserManager({ stateDir: f.stateDir, executablePath: bad }, adapters);
  await assert.rejects(explicit.resolve(), /configured|explicit/i);
  assert.equal(installs, 0);
});

test('managed-only policy installs once, reports download phase, and uses the owned cache on subsequent resolution', async t => {
  const { createBrowserManager } = await import('../src/browser-manager.mjs');
  const f = await fixture(t); await f.writeBrowser(f.sharedPath);
  let installs = 0; const phases = [];
  const manager = createBrowserManager({ stateDir: f.stateDir, mode: 'managed-only' }, {
    candidates: () => [candidate('shared-playwright', f.sharedPath), candidate('owned-cache', f.ownedPath)], probe,
    install: async () => { installs++; await f.writeBrowser(f.ownedPath); },
  });
  assert.equal((await manager.resolve({ onPhase: phase => phases.push(phase) })).source, 'owned-cache');
  await manager.resolve();
  assert.equal(installs, 1);
  assert.ok(phases.includes('download'));
  const info = await manager.details();
  assert.ok(info.ownedCache.bytes > 0);
  assert.equal(info.ownedCache.clearable, true);
});

test('owned-cache cleanup preserves shared/system files and denies deletion while a browser lease is active', async t => {
  const { createBrowserManager } = await import('../src/browser-manager.mjs');
  const f = await fixture(t); await f.writeBrowser(f.sharedPath);
  const manager = createBrowserManager({ stateDir: f.stateDir, mode: 'managed-only' }, {
    candidates: () => [candidate('owned-cache', f.ownedPath)], probe,
    install: () => f.writeBrowser(f.ownedPath),
  });
  const selected = await manager.resolve();
  const release = await manager.acquireLease(selected);
  await assert.rejects(manager.clearOwnedCache(), /use|busy|lease/i);
  await release();
  await manager.clearOwnedCache();
  await assert.rejects(access(f.ownedPath));
  assert.equal(await readFile(f.sharedPath, 'utf8'), 'browser fixture');
});

test('a symlinked cache and unrelated files cannot be removed', async t => {
  const { createBrowserManager } = await import('../src/browser-manager.mjs');
  const f = await fixture(t); await f.writeBrowser(f.sharedPath);
  await mkdir(f.stateDir, { recursive: true });
  await symlink(join(f.root, 'shared'), f.ownedCacheDir, 'dir');
  const linked = createBrowserManager({ stateDir: f.stateDir }, { candidates: () => [], probe });
  await assert.rejects(linked.clearOwnedCache(), /symlink|owned|unsafe/i);
  assert.equal(await readFile(f.sharedPath, 'utf8'), 'browser fixture');
  await rm(f.ownedCacheDir); await mkdir(f.ownedCacheDir);
  await writeFile(join(f.ownedCacheDir, 'personal-data.txt'), 'keep me');
  const unrelated = createBrowserManager({ stateDir: f.stateDir }, { candidates: () => [], probe });
  await assert.rejects(unrelated.clearOwnedCache(), /owned|unknown|unrecognized/i);
  assert.equal(await readFile(join(f.ownedCacheDir, 'personal-data.txt'), 'utf8'), 'keep me');
});

test('pinned shared-cache discovery exposes browser executable paths without scanning profiles', async () => {
  const { discoverBrowserCandidates } = await import('../src/browser-manager.mjs');
  const list = await discoverBrowserCandidates({ ownedCacheDir: join(tmpdir(), 'test-owned-browser-cache') });
  assert.ok(list.some(entry => entry.source === 'shared-playwright' && /chromium.*-\d+/.test(entry.path)));
  assert.ok(list.every(entry => !entry.launchOptions.userDataDir));
});
