import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
      if (path.startsWith('public/') && /\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval)\b/.test(await readFile(path, 'utf8'))) throw new Error(`Unsafe rendering boundary in ${path}`);
    }
  }
}
for (const directory of ['src', 'public/js', 'scripts', 'test']) await check(directory);
console.log('JavaScript syntax and frontend safety checks passed');
