import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VENDOR_DIR = 'vendor';
const CHECKSUM_FILE = path.join(VENDOR_DIR, 'CHECKSUMS.sha256');

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile() && full !== CHECKSUM_FILE) {
      results.push(full.split(path.sep).join('/'));
    }
  }
  return results.sort();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const isCheckMode = process.argv.includes('--check');
const actualFiles = walkFiles(VENDOR_DIR);

if (!isCheckMode) {
  const lines = actualFiles.map((f) => `${sha256File(f)}  ${f}`);
  fs.writeFileSync(CHECKSUM_FILE, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Generated ${CHECKSUM_FILE} (${actualFiles.length} files).`);
  process.exit(0);
}

if (!fs.existsSync(CHECKSUM_FILE)) {
  console.error(`Missing ${CHECKSUM_FILE}`);
  process.exit(1);
}

const expectedMap = new Map();
for (const line of fs.readFileSync(CHECKSUM_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
  const m = line.match(/^([a-f0-9]{64})  (.+)$/);
  if (!m) {
    console.error(`Invalid checksum line: ${line}`);
    process.exit(1);
  }
  expectedMap.set(m[2], m[1]);
}

let failed = false;
for (const file of actualFiles) {
  if (!expectedMap.has(file)) {
    console.error(`UNTRACKED FILE in vendor/: ${file}`);
    failed = true;
  }
}
for (const [file, expectedHash] of expectedMap.entries()) {
  if (!fs.existsSync(file)) {
    console.error(`MISSING FILE: ${file}`);
    failed = true;
    continue;
  }
  const actualHash = sha256File(file);
  if (actualHash !== expectedHash) {
    console.error(`HASH MISMATCH: ${file}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Verified ${expectedMap.size} vendor files successfully.`);
