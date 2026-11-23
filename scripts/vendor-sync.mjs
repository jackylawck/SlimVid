import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

fs.mkdirSync(path.join('vendor', 'ffmpeg'), { recursive: true });

fs.copyFileSync(
  path.join('node_modules', 'mp4-muxer', 'build', 'mp4-muxer.mjs'),
  path.join('vendor', 'mp4-muxer.mjs')
);

await esbuild.build({
  entryPoints: [path.join('node_modules', 'mp4box', 'dist', 'mp4box.all.min.js')],
  bundle: true,
  format: 'esm',
  outfile: path.join('vendor', 'mp4box.esm.js'),
});

const ffmpegFiles = ['index.js', 'classes.js', 'const.js', 'errors.js', 'utils.js', 'worker.js'];
for (const file of ffmpegFiles) {
  fs.copyFileSync(
    path.join('node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', file),
    path.join('vendor', 'ffmpeg', file)
  );
}

for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  fs.copyFileSync(
    path.join('node_modules', '@ffmpeg', 'core', 'dist', 'esm', file),
    path.join('vendor', 'ffmpeg', file)
  );
}

execFileSync(process.execPath, [path.join('scripts', 'vendor-checksum.mjs')], {
  stdio: 'inherit',
});
console.log('Vendor sync complete.');
