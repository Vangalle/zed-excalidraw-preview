import { parentPort, workerData } from 'node:worker_threads';
import LZString from 'lz-string';

try {
  const text = LZString.decompressFromBase64(workerData.encoded);
  if (!text) throw new Error('Unable to decompress Obsidian compressed-json drawing data.');
  if (Buffer.byteLength(text) > workerData.maxBytes) throw new Error('Obsidian Drawing JSON exceeds the decoded size limit.');
  parentPort.postMessage({ text });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
