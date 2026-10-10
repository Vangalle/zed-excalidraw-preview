import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedBrowserCache } from '../src/browser-cache.mjs';

test('host-assigned legacy cache can be inspected and explicitly cleared without affecting neighbors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-browser-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assigned = join(root, 'browsers');
  const old = process.env.EXCALIDRAW_MANAGED_CACHE_DIR;
  process.env.EXCALIDRAW_MANAGED_CACHE_DIR = assigned;
  t.after(() => { if (old === undefined) delete process.env.EXCALIDRAW_MANAGED_CACHE_DIR; else process.env.EXCALIDRAW_MANAGED_CACHE_DIR = old; });
  await mkdir(join(assigned, 'chromium_headless_shell-1248'), { recursive: true });
  await writeFile(join(assigned, 'chromium_headless_shell-1248', 'old-browser'), 'legacy');
  const other = join(root, 'other-browser'); await writeFile(other, 'preserve');
  const cache = createOwnedBrowserCache(join(root, 'state'));
  assert.equal((await cache.details()).clearable, true);
  await cache.clear(); await assert.rejects(access(assigned));
  assert.equal(await readFile(other, 'utf8'), 'preserve');
  process.env.EXCALIDRAW_MANAGED_CACHE_DIR = join(root, 'other-software');
  assert.throws(() => createOwnedBrowserCache(join(root, 'state')), /assigned|work directory/i);
});
