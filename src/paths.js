const VENDOR_ROOT = new URL('../vendor/', import.meta.url);

export function vendorUrl(relativePath) {
  return new URL(relativePath, VENDOR_ROOT).href;
}

export const FFMPEG_URLS = Object.freeze({
  classWorkerURL: vendorUrl('ffmpeg/worker.js'),
  coreURL: vendorUrl('ffmpeg/ffmpeg-core.js'),
  wasmURL: vendorUrl('ffmpeg/ffmpeg-core.wasm'),
});
