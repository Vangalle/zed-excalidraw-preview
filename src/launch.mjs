import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function openInZed(file, { command = process.env.ZED_EXCALIDRAW_ZED_BIN || 'zed' } = {}) {
  try {
    await exec(command, ['--existing', file], { timeout: 15_000 });
  } catch (error) {
    throw new Error(`PNG is saved at ${file}, but opening Zed failed: ${error.message}`);
  }
}

export async function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['/usr/bin/open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  await exec(command, args, { timeout: 15_000 });
}
