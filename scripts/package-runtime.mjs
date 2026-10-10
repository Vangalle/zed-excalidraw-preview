import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = ['lz-string', 'playwright', 'playwright-core', 'vscode-jsonrpc', 'vscode-languageserver', 'vscode-languageserver-protocol', 'vscode-languageserver-types', 'vscode-languageserver-textdocument'];
const sources = ['cli.mjs', 'downloads.mjs', 'launch.mjs', 'lsp.mjs', 'lsp-preview.mjs', 'obsidian.mjs', 'obsidian-decode-worker.mjs', 'render.mjs', 'scene.mjs', 'server.mjs'];
const exclude = new Set(['docs', 'test', 'tests', '.git', '.DS_Store']);
const copy = (from, to) => cp(from, to, { recursive: true, filter: path => !exclude.has(basename(path)) });

async function dependencyNotices() {
  const base = join(root, 'node_modules');
  const directories = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(base, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) directories.push(`${entry.name}/${scoped.name}`);
      }
    } else directories.push(entry.name);
  }
  const notices = [];
  for (const name of directories.sort()) {
    for (const entry of await readdir(join(base, name), { withFileTypes: true })) {
      if (entry.isFile() && /^(licen[cs]e|copying|notice)(?:\.|$)/i.test(entry.name)) {
        notices.push(`\n=== ${name}/${entry.name} ===\n${await readFile(join(base, name, entry.name), 'utf8')}`);
      }
    }
  }
  return notices.join('\n');
}

export async function buildRuntimeArchive({ outputDir = join(root, 'releases') } = {}) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const staging = await mkdtemp(join(tmpdir(), 'excalidraw-release-'));
  try {
    await mkdir(join(staging, 'src'));
    for (const name of sources) await cp(join(root, 'src', name), join(staging, 'src', name));
    await copy(join(root, 'dist'), join(staging, 'dist'));
    await copy(join(root, 'third-party'), join(staging, 'third-party'));
    await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
    await writeFile(join(staging, 'third-party/dependency-NOTICES.txt'), await dependencyNotices());
    const dependencies = {};
    for (const name of modules) {
      const from = join(root, 'node_modules', name);
      const info = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
      dependencies[name] = info.version;
      // Dependency directories named "test" can be required runtime code
      // (for example Playwright's lib/mcp/test/testBackend). Preserve packages.
      await cp(from, join(staging, 'node_modules', name), { recursive: true });
    }
    await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'excalidraw-preview-runtime', version: metadata.version, private: true, license: metadata.license, type: 'module', engines: metadata.engines, dependencies }, null, 2));
    await writeFile(join(staging, 'runtime.json'), JSON.stringify({ version: metadata.version, entry: 'src/lsp.mjs', playwright: dependencies.playwright }, null, 2));
    await mkdir(outputDir, { recursive: true });
    const archive = join(resolve(outputDir), `excalidraw-runtime-${metadata.version}.tar.gz`);
    await exec('tar', ['-czf', archive, '-C', staging, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRuntimeArchive().then(path => console.log(path)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
