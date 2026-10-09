import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'jsonc-parser';

async function configDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zed-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('installer preserves JSONC, unrelated tasks and bindings, backs up originals and is idempotent', async t => {
  const { installZed } = await import('../src/zed-config.mjs');
  const dir = await configDir(t);
  const originalTasks = '// my tasks\n[{"label":"Keep me","command":"echo hi"},]\n';
  const originalKeys = '// my keymap\n[{"context":"Editor","bindings":{"cmd-alt-enter":"keep::Action",},},]\n';
  await writeFile(join(dir, 'tasks.json'), originalTasks);
  await writeFile(join(dir, 'keymap.json'), originalKeys);
  const result = await installZed({ configDir: dir, nodePath: '/node with spaces', cliPath: '/tool/cli.mjs' });
  assert.equal(result.backups.length, 2);
  assert.ok((await readFile(join(dir, 'tasks.json'), 'utf8')).includes('// my tasks'));
  assert.ok((await readFile(join(dir, 'keymap.json'), 'utf8')).includes('// my keymap'));
  const tasks = parse(await readFile(join(dir, 'tasks.json'), 'utf8'));
  assert.deepEqual(tasks[0], { label: 'Keep me', command: 'echo hi' });
  assert.equal(tasks.length, 3);
  assert.equal(tasks[1].save, 'current');
  assert.equal(tasks[1].reveal, 'never');
  const keys = parse(await readFile(join(dir, 'keymap.json'), 'utf8'));
  assert.equal(keys[0].bindings['cmd-alt-enter'], 'keep::Action');
  assert.equal(keys[1].bindings['cmd-ctrl-alt-p'][0], 'task::Spawn');
  assert.equal(keys[1].bindings['cmd-ctrl-alt-b'][1].task_name, 'Excalidraw: Browser preview');
  const originals = await Promise.all(result.backups.map(file => readFile(file, 'utf8')));
  assert.ok(originals.includes(originalTasks));
  assert.ok(originals.includes(originalKeys));
  const before = await readdir(dir);
  const second = await installZed({ configDir: dir, nodePath: '/node with spaces', cliPath: '/tool/cli.mjs' });
  assert.deepEqual(second.backups, []);
  assert.deepEqual(await readdir(dir), before);
});

test('conflicting shortcut or malformed configuration leaves both files untouched', async t => {
  const { installZed } = await import('../src/zed-config.mjs');
  const dir = await configDir(t);
  const originalTasks = '[{"label":"Keep me","command":"echo hi"}]';
  const conflict = '[{"context":"Editor","bindings":{"alt-ctrl-cmd-p":"user::Action"}}]';
  await writeFile(join(dir, 'tasks.json'), originalTasks);
  await writeFile(join(dir, 'keymap.json'), conflict);
  await assert.rejects(installZed({ configDir: dir, nodePath: '/node', cliPath: '/cli' }), /conflict/i);
  assert.equal(await readFile(join(dir, 'tasks.json'), 'utf8'), originalTasks);
  assert.equal(await readFile(join(dir, 'keymap.json'), 'utf8'), conflict);
  await writeFile(join(dir, 'keymap.json'), '[');
  await assert.rejects(installZed({ configDir: dir, nodePath: '/node', cliPath: '/cli' }), /JSON/i);
  assert.equal(await readFile(join(dir, 'tasks.json'), 'utf8'), originalTasks);
});

test('installed task forwards Unicode, spaces and shell metacharacters literally', async t => {
  const { installZed } = await import('../src/zed-config.mjs');
  const dir = await configDir(t);
  const tool = join(dir, "tool's $path");
  await mkdir(tool);
  const recorder = join(tool, 'cli.mjs');
  const output = join(dir, 'args.json');
  await writeFile(recorder, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), source:process.env.EXCALIDRAW_SOURCE_FILE}));\n`);
  await installZed({ configDir: dir, nodePath: process.execPath, cliPath: recorder });
  const tasks = parse(await readFile(join(dir, 'tasks.json'), 'utf8'));
  const file = join(dir, '中文 $() ; "drawing.excalidraw');
  // Zed substitutes template variables BEFORE shell parsing (not shell environment expansion).
  for (const [i, mode] of ['png', 'browser'].entries()) {
    const task = tasks[i];
    const command = task.command.replaceAll('$ZED_FILE', file);
    const env = Object.fromEntries(Object.entries(task.env ?? {}).map(([key, value]) => [key, value.replaceAll('$ZED_FILE', file)]));
    await promisify(execFile)('/bin/sh', ['-c', command], { env: { ...process.env, ...env, ZED_FILE: file } });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { args: [mode], source: file });
  }
});
