import { Worker } from 'node:worker_threads';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

async function decodeDrawing(language, payload, maxBytes) {
  if (language === 'json') {
    if (Buffer.byteLength(payload) > maxBytes) throw new Error('Drawing JSON exceeds the decoded size limit.');
    return payload;
  }
  const encoded = payload.replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,3}$/.test(encoded)) {
    throw new Error('Invalid Obsidian compressed-json drawing data.');
  }
  // LZ-String has no output limit. Isolate decoding so corrupt/compression-bomb
  // inputs cannot exhaust the CLI/server heap or block HTTP request processing.
  const worker = new Worker(new URL('./obsidian-decode-worker.mjs', import.meta.url), {
    workerData: { encoded, maxBytes },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
  });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Obsidian compressed-json decompression timed out.')), 5_000);
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.text));
      worker.once('error', error => reject(new Error(`Obsidian compressed-json decompression failed: ${error.message}`)));
      worker.once('exit', code => reject(new Error(`Obsidian compressed-json decompression ended unexpectedly (${code}).`)));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

export async function extractDrawingJson(text, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let inDrawing = false;
  let fence;
  let payload = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length) {
        if (fence.capture) return decodeDrawing(fence.language, payload.join('\n'), maxBytes);
        fence = undefined;
      } else if (fence.capture) {
        payload.push(line);
      }
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening) {
      const language = opening[2].trim().toLowerCase();
      fence = { marker: opening[1], language, capture: inDrawing && ['json', 'compressed-json'].includes(language) };
      payload = [];
      continue;
    }
    if (/^ {0,3}##[ \t]+Drawing[ \t]*#*[ \t]*$/i.test(line)) {
      inDrawing = true;
    } else if (/^ {0,3}#{1,2}[ \t]+/.test(line)) {
      inDrawing = false;
    }
  }
  if (fence?.capture) throw new Error('Obsidian Drawing code block is not closed.');
  throw new Error('No Excalidraw Drawing json/compressed-json block found in this Markdown file.');
}
