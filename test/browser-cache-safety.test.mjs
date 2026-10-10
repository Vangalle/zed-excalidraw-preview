import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedBrowserCache } from '../src/browser-cache.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'browser-cache-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = createOwnedBrowserCache(join(root, 'state'));
  await cache.install(async path => { await mkdir(join(path, 'chromium_headless_shell-1248')); });
  return { root, cache };
}

test('cache ownership marker symlink is rejected instead of following an external file', async t => {
  const { root, cache } = await fixture(t);
  const marker = join(cache.path, '.excalidraw-cache-owner.json');
  const external = join(root, 'external.json');
  await writeFile(external, await readFile(marker));
  await rm(marker); await symlink(external, marker);
  await assert.rejects(cache.clear(), /symlink|owned|ownership/i);
  assert.match(await readFile(external, 'utf8'), /excalidraw-preview/);
});

test('lease-directory symlink cannot delete external files during detail or cleanup checks', async t => {
  const { root, cache } = await fixture(t);
  const external = join(root, 'external-leases'); await mkdir(external);
  const file = join(external, '999999999-not-a-lease'); await writeFile(file, 'keep');
  await symlink(external, join(cache.path, '.excalidraw-leases'), 'dir');
  assert.equal((await cache.details()).clearable, false);
  await assert.rejects(cache.clear(), /symlink|lease/i);
  assert.equal(await readFile(file, 'utf8'), 'keep');
});
