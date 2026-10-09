import { build } from 'esbuild';
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
// Excalidraw 0.18.1 adds an esm.sh font fallback even with a local asset base.
// Remove only that fallback in the bundled copy, so offline previews never try a CDN.
let fontFallbackPatches = 0;
await build({
  absWorkingDir: root,
  entryPoints: ['web/entry.js'],
  outfile: 'dist/app.js',
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  plugins: [{
    name: 'local-fonts-only',
    setup(build) {
      build.onLoad({ filter: /@excalidraw\/excalidraw\/dist\/prod\/chunk-.*\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const needle = /return (\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\),\1/g;
        const contents = source.replace(needle, (_, urls) => { fontFallbackPatches++; return `return ${urls}`; });
        return { contents, loader: 'js' };
      });
    },
  }],
});
if (fontFallbackPatches !== 1) throw new Error('Excalidraw font helper changed; verify local-only font handling before upgrading.');
await cp(join(root, 'web/index.html'), join(dist, 'index.html'));
await cp(join(root, 'web/style.css'), join(dist, 'app.css'));
await cp(join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'), join(dist, 'assets/fonts'), { recursive: true });
