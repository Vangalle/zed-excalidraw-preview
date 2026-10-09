import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installZed } from '../src/zed-config.mjs';

try {
  const result = await installZed({
    configDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'zed'),
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
  });
  console.log('Installed Zed tasks and shortcuts:');
  console.log('  Cmd+Ctrl+Option+P: render temporary PNG and open in Zed');
  console.log('  Cmd+Ctrl+Option+B: open read-only browser preview');
  console.log(`  ${result.taskPath}\n  ${result.keyPath}`);
  for (const backup of result.backups) console.log(`  Backup: ${backup}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
