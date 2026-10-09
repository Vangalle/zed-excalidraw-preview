import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { extractDrawingJson } from './obsidian.mjs';

const MAX_BYTES = 50 * 1024 * 1024;

export async function loadScene(file) {
  const handle = await open(file, 'r');
  let text;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Expected an Excalidraw file, not a directory.');
    if (stat.size > MAX_BYTES) throw new Error('Excalidraw file exceeds the 50 MiB limit.');
    text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Excalidraw file exceeds the 50 MiB limit.');
  } finally {
    await handle.close();
  }
  return parseSceneText(text, { markdown: extname(file).toLowerCase() === '.md' });
}

export function isDrawingDocument(uri, text) {
  let path;
  try { path = new URL(uri).pathname.toLowerCase(); } catch { return false; }
  if (path.endsWith('.excalidraw') || path.endsWith('.excalidraw.md')) return true;
  if (path.endsWith('.md')) {
    const frontmatter = text.replace(/^\uFEFF/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
    return !!frontmatter && /^excalidraw-plugin\s*:/m.test(frontmatter);
  }
  return /"type"\s*:\s*"excalidraw"/.test(text.slice(0, 4096));
}

export async function parseSceneText(text, { markdown = false } = {}) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Excalidraw document exceeds the 50 MiB limit.');
  const json = markdown ? await extractDrawingJson(text, { maxBytes: MAX_BYTES }) : text.replace(/^\uFEFF/, '');
  let scene;
  try {
    scene = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON in the Excalidraw file.');
  }
  if (!scene || scene.type !== 'excalidraw' || !Array.isArray(scene.elements)) {
    throw new Error('Expected an Excalidraw scene with type="excalidraw" and an elements array.');
  }
  for (const element of scene.elements) {
    if (!element || typeof element !== 'object' || typeof element.type !== 'string') {
      throw new Error('Invalid Excalidraw element.');
    }
    for (const key of ['x', 'y', 'width', 'height']) {
      if (typeof element[key] !== 'number' || !Number.isFinite(element[key])) {
        throw new Error(`Invalid Excalidraw element ${key}.`);
      }
    }
  }
  if (scene.appState != null && (typeof scene.appState !== 'object' || Array.isArray(scene.appState))) {
    throw new Error('Invalid Excalidraw appState.');
  }
  if (scene.files != null && (typeof scene.files !== 'object' || Array.isArray(scene.files))) {
    throw new Error('Invalid Excalidraw image files.');
  }
  for (const image of Object.values(scene.files ?? {})) {
    if (!image || typeof image.dataURL !== 'string' || !/^data:image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)[;,]/i.test(image.dataURL)) {
      throw new Error('Excalidraw images must contain embedded image data, not external URLs.');
    }
  }
  return { ...scene, appState: scene.appState ?? {}, files: scene.files ?? {} };
}
