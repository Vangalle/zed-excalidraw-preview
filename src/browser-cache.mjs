import { mkdir, readdir, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep, parse } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const OWNER = 'excalidraw-preview';
const MARKER = '.excalidraw-cache-owner.json';
const LEASES = '.excalidraw-leases';
const inside = (path, root) => path === root || path.startsWith(root + sep);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

export function createOwnedBrowserCache(stateDir, sharedRoots = []) {
  const state = resolve(stateDir);
  const assigned = process.env.EXCALIDRAW_MANAGED_CACHE_DIR;
  const path = assigned ? resolve(assigned) : join(state, 'browsers');
  const legacyTrusted = !!assigned && basename(state) === 'state' && path === join(dirname(state), 'browsers');
  if (assigned && !legacyTrusted) throw new Error('Managed browser cache must be inside the assigned extension work directory.');
  const marker = join(path, MARKER);
  const lock = `${path}.excalidraw-lock`;

  async function location() {
    if (path === parse(path).root || path === resolve(homedir())) throw new Error('Unsafe owned browser cache path.');
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing a symlink or non-directory owned browser cache.');
    const actual = await realpath(path);
    const parent = await realpath(dirname(path));
    if (actual !== join(parent, basename(path))) throw new Error('Owned browser cache resolves outside its assigned directory.');
    for (const root of sharedRoots) {
      let canonical;
      try { canonical = await realpath(root); } catch { canonical = resolve(root); }
      if (inside(actual, canonical) || inside(canonical, actual)) throw new Error('Refusing to modify a shared browser cache.');
    }
    const systemRoots = process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.SystemRoot].filter(Boolean)
      : ['/Applications', '/System', '/usr', '/opt'];
    if (systemRoots.some(root => inside(actual, resolve(root)))) throw new Error('Refusing to modify a system browser installation.');
    return true;
  }

  async function readMetadata(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing symlinked browser-cache ownership metadata.');
    return JSON.parse(await readFile(file, 'utf8'));
  }

  async function ownership() {
    await location();
    const names = await readdir(path);
    const known = name => /^(chromium(?:_headless_shell)?|ffmpeg)-\d+$/.test(name) || ['.links', MARKER, LEASES].includes(name);
    if (names.some(name => !known(name))) throw new Error('Owned cache contains unrecognized files; refusing to remove them.');
    try {
      const data = await readMetadata(marker);
      if (data.owner !== OWNER || data.path !== await realpath(path)) throw new Error('Invalid owned browser cache marker.');
    } catch (error) {
      if (error.code !== 'ENOENT' || !legacyTrusted) throw new Error('Browser cache ownership is not established; refusing cleanup.');
    }
  }

  async function prepare() {
    if (await location()) {
      const names = await readdir(path);
      if (names.length) await ownership();
    } else await mkdir(path, { recursive: true, mode: 0o700 });
    await location();
    try { await writeFile(marker, JSON.stringify({ owner: OWNER, path: await realpath(path) }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await ownership(); }
  }

  async function locked(operation, { signal, wait = true } = {}) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 300_000;
    for (;;) {
      if (signal?.aborted) throw new Error('Excalidraw preview cancelled.');
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      let lockInfo;
      try { lockInfo = await lstat(lock); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) throw new Error('Refusing a symlinked browser-cache lock.');
      let data;
      try { data = await readMetadata(join(lock, 'owner.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Browser cache operation has unrecognized ownership metadata.'); }
      if (data && (data.owner !== OWNER || !Number.isInteger(data.pid) || data.pid <= 0)) throw new Error('Browser cache operation has unrecognized ownership metadata.');
      if (data && !alive(data.pid)) { await rm(lock, { recursive: true, force: true }); continue; }
      if (!wait || Date.now() > deadline) throw new Error('Browser cache operation is busy in another window.');
      try { await delay(50, undefined, { signal }); } catch { throw new Error('Excalidraw preview cancelled.'); }
    }
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ owner: OWNER, pid: process.pid }), { mode: 0o600 });
      return await operation();
    } finally { await rm(lock, { recursive: true, force: true }); }
  }

  async function liveLeases() {
    let files;
    try {
      const info = await lstat(join(path, LEASES));
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refusing a symlinked browser-cache lease directory.');
      files = await readdir(join(path, LEASES));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const active = [];
    for (const file of files) {
      const pid = Number(file.split('-')[0]);
      if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) active.push(file);
      else await rm(join(path, LEASES, file), { force: true });
    }
    return active;
  }

  async function size(directory) {
    let bytes = 0;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, item.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) continue;
      bytes += info.isDirectory() ? await size(child) : info.size;
    }
    return bytes;
  }

  return {
    path,
    async containsExecutable(file) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
        return inside(await realpath(file), await realpath(path));
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
    async install(operation, options) {
      return locked(async () => { await prepare(); return operation(path); }, options);
    },
    async acquireLease(signal) {
      return locked(async () => {
        await ownership();
        await liveLeases();
        await mkdir(join(path, LEASES), { recursive: true, mode: 0o700 });
        const file = join(path, LEASES, `${process.pid}-${randomBytes(8).toString('hex')}`);
        await writeFile(file, '', { flag: 'wx', mode: 0o600 });
        return async () => { await rm(file, { force: true }); };
      }, { signal });
    },
    async details() {
      try {
        if (!await location()) return { path, bytes: 0, clearable: false, reason: 'No extension-owned browser cache exists.' };
        const bytes = await size(path);
        await ownership();
        const active = await liveLeases();
        return { path, bytes, clearable: !active.length, reason: active.length ? 'Browser cache is in use by an active preview.' : 'Only this extension-owned cache may be cleared, after confirmation.' };
      } catch (error) { return { path, bytes: 0, clearable: false, reason: error.message }; }
    },
    async clear() {
      return locked(async () => {
        if (!await location()) return;
        await ownership();
        if ((await liveLeases()).length) throw new Error('Browser cache is in use by an active preview lease.');
        await rm(path, { recursive: true });
      }, { wait: false });
    },
  };
}
