/**
 * Single-Threaded FFmpeg.wasm 0.12 Fallback Engine
 * - Strict CSP compliant (self-hosted via src/paths.js)
 * - Zero-copy input via Emscripten WORKERFS
 * - Isolated /tmp output + defensive VFS cleanup + optional highPrivacyMode heap termination
 */

import { FFMPEG_URLS, vendorUrl } from '../paths.js';
import { FFMPEG_MAX_SAFE_BYTES } from '../core/planner.js';

function createAbortError() {
  return new DOMException('Aborted', 'AbortError');
}

export class FFmpegEngine {
  constructor() {
    this.ffmpeg = null;
    this.loadPromise = null;
    this.isBusy = false;
  }

  async _ensureLoaded(onLog) {
    if (this.ffmpeg?.loaded) return this.ffmpeg;

    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        onLog('Loading self-hosted FFmpeg.wasm core...');
        const { FFmpeg } = await import(vendorUrl('ffmpeg/index.js'));
        const instance = new FFmpeg();
        await instance.load(FFMPEG_URLS);
        this.ffmpeg = instance;
        return instance;
      })().catch((err) => {
        this.loadPromise = null;
        this.ffmpeg = null;
        throw new Error(`FFmpeg.wasm load failed: ${err.message}`);
      });
    }

    return this.loadPromise;
  }

  terminate() {
    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch (_) {}
      this.ffmpeg = null;
    }
    this.loadPromise = null;
  }

  async transcode({
    file,
    targetWidth,
    crf = 28,
    targetBitrate = null,
    audioMode = 'aac',
    highPrivacyMode = false,
    signal = null,
    onProgress = () => {},
    onLog = () => {},
  }) {
    if (this.isBusy) {
      throw new Error('FFmpeg engine is busy.');
    }
    if (signal?.aborted) {
      throw createAbortError();
    }

    if (file.size > FFMPEG_MAX_SAFE_BYTES) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      const limitMB = Math.round(FFMPEG_MAX_SAFE_BYTES / 1024 / 1024);
      const err = new Error(`File (${sizeMB} MB) exceeds ${limitMB} MB FFmpeg fallback limit.`);
      err.code = 'FILE_TOO_LARGE_FOR_FFMPEG';
      throw err;
    }

    this.isBusy = true;

    const rawExt = (file.name.split('.').pop() || '').toLowerCase();
    const safeExt = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : 'mp4';
    const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const mountDir = `/in_${jobId}`;
    const safeInputName = `src.${safeExt}`;
    const inputPath = `${mountDir}/${safeInputName}`;
    const outputPath = `/tmp/out_${jobId}.mp4`;

    const safeFile = new File([file], safeInputName, { type: file.type || 'video/mp4' });

    let ffmpeg = null;
    let dirCreated = false;
    let mounted = false;
    let workerDead = false;

    const handleProgress = ({ progress }) => {
      if (Number.isFinite(progress)) {
        const clamped = Math.min(1, Math.max(0, progress));
        onProgress(Math.min(95, 20 + Math.round(clamped * 75)));
      }
    };

    const handleAbort = () => {
      workerDead = true;
      onLog('Terminating FFmpeg worker on abort...');
      this.terminate();
    };

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true });
    }

    try {
      onProgress(5);
      ffmpeg = await this._ensureLoaded(onLog);

      if (signal?.aborted) {
        throw createAbortError();
      }

      ffmpeg.on('progress', handleProgress);
      onProgress(15);

      try {
        await ffmpeg.createDir('/tmp');
      } catch (_) {}

      onLog('Mounting WORKERFS (zero-copy input)...');
      await ffmpeg.createDir(mountDir);
      dirCreated = true;

      await ffmpeg.mount('WORKERFS', { files: [safeFile] }, mountDir);
      mounted = true;

      const safeWidth = Math.max(32, Math.floor(targetWidth / 2) * 2);
      const audioArgs =
        audioMode === 'none'
          ? ['-an']
          : audioMode === 'copy'
            ? ['-c:a', 'copy']
            : ['-c:a', 'aac', '-b:a', '128k'];

      const rateControlArgs =
        targetBitrate && Number.isFinite(targetBitrate)
          ? ['-b:v', `${Math.max(200, Math.round(targetBitrate / 1000))}k`]
          : ['-crf', String(crf)];

      const args = [
        '-i', inputPath,
        '-vf', `scale=${safeWidth}:-2`,
        '-c:v', 'libx264',
        ...rateControlArgs,
        '-preset', 'veryfast',
        ...audioArgs,
        '-movflags', '+faststart',
        outputPath,
      ];

      onLog(`Transcoding via FFmpeg (${safeWidth}px | audio: ${audioMode})...`);
      onProgress(20);

      let exitCode;
      try {
        exitCode = await ffmpeg.exec(args);
      } catch (execErr) {
        if (signal?.aborted) throw createAbortError();
        workerDead = true;
        this.terminate();
        const crashErr = new Error(`FFmpeg worker crashed (possible OOM): ${execErr.message || execErr}`);
        crashErr.code = 'FFMPEG_WORKER_CRASH';
        throw crashErr;
      }

      if (signal?.aborted) throw createAbortError();
      if (exitCode !== 0) {
        const exitErr = new Error(`FFmpeg exited with code ${exitCode}`);
        exitErr.code = 'FFMPEG_NON_ZERO_EXIT';
        throw exitErr;
      }

      const outputData = await ffmpeg.readFile(outputPath);
      if (!(outputData instanceof Uint8Array) || outputData.byteLength === 0) {
        throw new Error('FFmpeg produced an empty output file.');
      }

      const blob = new Blob([outputData], { type: 'video/mp4' });
      onProgress(100);
      onLog('FFmpeg.wasm transcode complete.');
      return blob;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', handleAbort);
      }

      if (ffmpeg && !workerDead) {
        try {
          ffmpeg.off('progress', handleProgress);
        } catch (_) {}

        try {
          await ffmpeg.deleteFile(outputPath);
        } catch (_) {}

        if (mounted) {
          try {
            await ffmpeg.unmount(mountDir);
          } catch (_) {}
        }

        if (dirCreated) {
          try {
            await ffmpeg.deleteDir(mountDir);
          } catch (_) {}
        }

        if (highPrivacyMode) {
          onLog('High-privacy mode: terminating FFmpeg worker to wipe Wasm heap.');
          this.terminate();
        }
      }

      this.isBusy = false;
    }
  }
}
