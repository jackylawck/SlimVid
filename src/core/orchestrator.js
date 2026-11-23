/**
 * Compression Orchestrator
 * Thin routing layer: Capabilities -> WebCodecs Worker -> Lazy FFmpeg.wasm Fallback
 */

import { detectCapabilities } from './capabilities.js';
import { planCompression, FFMPEG_MAX_SAFE_BYTES } from './planner.js';
import { PIPELINE_STAGE, runWorkerJob } from './protocol.js';

const WEBCODECS_WORKER_URL = new URL('../engines/webcodecs.worker.js', import.meta.url);

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function isHevcCodec(codecStr) {
  return typeof codecStr === 'string' && /^(hvc1|hev1)/i.test(codecStr);
}

function probeVideoElementMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    const finish = (meta) => {
      URL.revokeObjectURL(url);
      resolve(meta);
    };

    video.onloadedmetadata = () => {
      finish({
        width: video.videoWidth || 1280,
        height: video.videoHeight || 720,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        // 保守預設 hasAudio: true（無音軌時僅多扣少量碼率預算，有音軌時唔會漏扣超標）
        hasAudio: true,
        canCopyAudio: false,
        videoCodec: null,
      });
    };

    video.onerror = () => {
      finish({
        width: 1280,
        height: 720,
        duration: 0,
        hasAudio: true,
        canCopyAudio: false,
        videoCodec: null,
      });
    };

    video.src = url;
  });
}

export class CompressionOrchestrator {
  constructor() {
    this.ffmpegEngine = null;
    this.capabilities = null;
  }

  async getCapabilities({ forceRefresh = false } = {}) {
    if (!this.capabilities || forceRefresh) {
      this.capabilities = await detectCapabilities({ forceRefresh });
    }
    return this.capabilities;
  }

  async _getFFmpegEngine() {
    if (!this.ffmpegEngine) {
      const { FFmpegEngine } = await import('../engines/ffmpeg.engine.js');
      this.ffmpegEngine = new FFmpegEngine();
    }
    return this.ffmpegEngine;
  }

  async compress(file, options = {}) {
    const {
      preset = 'balanced',
      targetSizeMB = null,
      highPrivacyMode = false,
      writableStream = null,
      signal = null,
      onProgress = () => {},
      onLog = () => {},
    } = options;

    const caps = await this.getCapabilities();

    if (caps.preferredEngine === 'none') {
      if (writableStream) await writableStream.abort().catch(() => {});
      const err = new Error('此瀏覽器同時不支援 WebCodecs 與 WebAssembly。');
      err.code = 'NO_ENGINE_SUPPORTED';
      throw err;
    }

    const userPlanOpts = { preset, targetSizeMB };
    let fallbackMeta = null;

    if (caps.webCodecsAvailable) {
      let worker = null;
      const jobId = createJobId();

      try {
        worker = new Worker(WEBCODECS_WORKER_URL, { type: 'module' });
        return await runWorkerJob({
          worker,
          jobId,
          file,
          plan: userPlanOpts,
          capabilities: caps,
          writableStream,
          signal,
          onProgress,
          onLog,
        });
      } catch (err) {
        if (writableStream) {
          await writableStream.abort().catch(() => {});
        }
        if (err?.name === 'AbortError' || err?.stage === PIPELINE_STAGE.ABORT) {
          throw err;
        }
        if (
          err?.stage === PIPELINE_STAGE.STREAM ||
          err?.code === 'PROTOCOL_VERSION_MISMATCH'
        ) {
          throw err;
        }

        fallbackMeta = err?.parsedMeta || null;

        if (
          err?.code === 'UNSUPPORTED_VIDEO_DECODER' &&
          isHevcCodec(fallbackMeta?.videoCodec) &&
          file.size > FFMPEG_MAX_SAFE_BYTES
        ) {
          const hevcErr = new Error('HEVC unsupported and file exceeds 150 MB fallback limit.');
          hevcErr.code = 'HEVC_UNSUPPORTED_LARGE_FILE';
          throw hevcErr;
        }

        onLog(`WebCodecs (${err?.stage || 'init'}) fallback -> FFmpeg.wasm (${err.message})`);
      } finally {
        try {
          worker?.terminate();
        } catch (_) {}
      }
    } else if (writableStream) {
      await writableStream.abort().catch(() => {});
    }

    if (!caps.hasWasm) {
      const err = new Error('WebAssembly fallback unavailable.');
      err.code = 'NO_ENGINE_SUPPORTED';
      throw err;
    }

    const startTime = performance.now();
    const meta = fallbackMeta || (await probeVideoElementMetadata(file));

    // meta.width/height 皆為正向顯示尺寸，rotation 必須為 0
    const plan = planCompression({
      width: meta.width,
      height: meta.height,
      rotation: 0,
      duration: meta.duration,
      fps: meta.estimatedFps || 30,
      sourceSizeBytes: file.size,
      hasAudio: meta.hasAudio !== false,
      deviceMemoryGB: caps.deviceMemoryGB,
      isMobile: caps.isMobile,
      webCodecsAvailable: false,
      useStreamTarget: false,
      options: userPlanOpts,
    });

    if (plan.blocked) {
      const err = new Error(plan.reason);
      err.code = 'FILE_TOO_LARGE_FOR_FFMPEG';
      throw err;
    }
    if (plan.antiBloatFailed && plan.antiBloatNote) {
      onLog(plan.antiBloatNote);
    }
    if (plan.autoDownscaled) {
      onLog(`Auto downscaled to ${plan.targetWidth}x${plan.targetHeight}`);
    }

    const audioMode =
      meta.hasAudio === false ? 'none' : meta.canCopyAudio ? 'copy' : 'aac';

    const ffmpegEngine = await this._getFFmpegEngine();
    const blob = await ffmpegEngine.transcode({
      file,
      targetWidth: plan.targetWidth,
      crf: plan.crf,
      targetBitrate: plan.rateControlMode === 'target-size' ? plan.targetBitrate : null,
      audioMode,
      highPrivacyMode,
      signal,
      onProgress: (pct) => onProgress(pct, PIPELINE_STAGE.ENCODE),
      onLog,
    });

    return {
      blob,
      streamed: false,
      engine: 'ffmpeg.wasm (single-thread)',
      stats: {
        outputBytes: blob.size,
        elapsedMs: Math.round(performance.now() - startTime),
        width: plan.targetWidth,
        height: plan.targetHeight,
      },
    };
  }
}
