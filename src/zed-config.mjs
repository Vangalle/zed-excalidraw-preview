import { readFile, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parse } from 'jsonc-parser';

const LABELS = ['Excalidraw: PNG in Zed', 'Excalidraw: Browser preview'];
const SHORTCUTS = ['cmd-ctrl-alt-p', 'cmd-ctrl-alt-b'];
const format = { insertSpaces: true, tabSize: 2, eol: '\n' };
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const normalizeKey = key => key.split(' ').map(stroke => {
  const parts = stroke.split('-'); const key = parts.pop();
  return [...parts.sort(), key].join('-');
}).join(' ');

function readArray(text, name) {
  const errors = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !Array.isArray(data)) throw new Error(`${name} must be a valid JSON/JSONC array. No configuration was changed.`);
  return data;
}
async function readOrEmpty(path) {
  try { return { text: await readFile(path, 'utf8'), exists: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { text: '[]\n', exists: false }; }
}
function replace(text, path, value) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: format }));
}

export async function installZed({ configDir, nodePath, cliPath }) {
  const taskPath = join(configDir, 'tasks.json');
  const keyPath = join(configDir, 'keymap.json');
  const taskSource = await readOrEmpty(taskPath);
  const keySource = await readOrEmpty(keyPath);
  const tasks = readArray(taskSource.text, 'tasks.json');
  const keys = readArray(keySource.text, 'keymap.json');
  const bindings = SHORTCUTS.map((key, index) => [key, ['task::Spawn', { task_name: LABELS[index] }]]);
  for (const entry of keys) {
    for (const [key, action] of Object.entries(entry?.bindings ?? {})) {
      const expected = bindings.find(([shortcut]) => normalizeKey(shortcut) === normalizeKey(key));
      if (expected && !isDeepStrictEqual(action, expected[1])) {
        throw new Error(`Shortcut conflict: ${key} is already assigned. No configuration was changed.`);
      }
    }
  }
  let taskText = taskSource.text;
  for (let i = 0; i < LABELS.length; i++) {
    const task = {
      label: LABELS[i],
      // Zed interpolates command strings before shell parsing. Keep the source path
      // in an environment value so filename quotes/$()/backticks cannot become code.
      command: `${shellQuote(nodePath)} ${shellQuote(cliPath)} ${i === 0 ? 'png' : 'browser'}`,
      env: { EXCALIDRAW_SOURCE_FILE: '$ZED_FILE' },
      save: 'current',
      reveal: 'never',
      hide: 'on_success',
      allow_concurrent_runs: false,
      show_summary: true,
      show_command: false,
    };
    const index = tasks.findIndex(entry => entry?.label === LABELS[i]);
    if (index < 0) {
      taskText = replace(taskText, [-1], task);
      tasks.push(task);
    } else if (!isDeepStrictEqual(tasks[index], task)) {
      taskText = replace(taskText, [index], task);
      tasks[index] = task;
    }
  }
  let keyText = keySource.text;
  const workspaceIndex = keys.findIndex(entry => entry?.context === 'Workspace');
  if (workspaceIndex < 0) {
    keyText = replace(keyText, [-1], { context: 'Workspace', bindings: Object.fromEntries(bindings) });
  } else {
    for (const [key, action] of bindings) {
      if (!isDeepStrictEqual(keys[workspaceIndex].bindings?.[key], action)) {
        keyText = replace(keyText, [workspaceIndex, 'bindings', key], action);
      }
    }
  }
  const changes = [
    { path: taskPath, source: taskSource, text: taskText },
    { path: keyPath, source: keySource, text: keyText },
  ].filter(change => change.source.text !== change.text || !change.source.exists);
  await mkdir(configDir, { recursive: true });
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const backups = [];
  // Validate both files before touching either; backup before replacing configuration.
  for (const change of changes) {
    const current = await readOrEmpty(change.path);
    if (current.text !== change.source.text || current.exists !== change.source.exists) {
      throw new Error('Zed configuration changed during installation. Please retry.');
    }
    if (change.source.exists) {
      const backup = `${change.path}.excalidraw-backup-${id}`;
      await copyFile(change.path, backup);
      backups.push(backup);
    }
  }
  for (const change of changes) {
    const staging = `${change.path}.excalidraw-${id}.tmp`;
    try {
      await writeFile(staging, change.text, { flag: 'wx', mode: 0o600 });
      await rename(staging, change.path);
    } finally {
      await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { taskPath, keyPath, backups };
}
