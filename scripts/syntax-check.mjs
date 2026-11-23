import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function walkJs(dir) {
  const list = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) list.push(...walkJs(full));
    else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) list.push(full);
  }
  return list;
}

const files = [...walkJs('src'), ...walkJs('scripts')];
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`Syntax check passed for ${files.length} files.`);
