/**
 * Pure Compression Planner
 * Constraints: ZERO imports, ZERO async, NEVER throws.
 * Output is guaranteed to be plain JSON-serializable primitives/objects.
 */

export const FFMPEG_MAX_SAFE_BYTES = 150 * 1024 * 1024;
const MIN_DIMENSION = 32;
const MIN_VIDEO_BITRATE = 200_000;
const MAX_VIDEO_BITRATE = 20_000_000;
const DEFAULT_AUDIO_BITRATE = 128_000;
const SAFETY_MARGIN_RATIO = 0.05;
const CONTAINER_OVERHEAD_RATIO = 0.015;

const IS_DEV_MODE = (() => {
  try {
    const loc = globalThis.location;
    if (!loc) return false;
    const h = loc.hostname || '';
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    return new URLSearchParams(loc.search || '').get('dev') === '1';
  } catch (_) {
    return false;
  }
})();

export const PRESET_PROFILES = Object.freeze({
  high: Object.freeze({
    scale: 1.0,
    maxShortEdge: 2160,
    maxLongEdge: 3840,
    crf: 23,
    bpp: 0.105,
    maxSourceBitrateRatio: 0.85,
  }),
  balanced: Object.freeze({
    scale: 0.75,
    maxShortEdge: 1080,
    maxLongEdge: 1920,
    crf: 28,
    bpp: 0.065,
    maxSourceBitrateRatio: 0.70,
  }),
  compact: Object.freeze({
    scale: 0.75,
    maxShortEdge: 720,
    maxLongEdge: 1280,
    crf: 32,
    bpp: 0.04,
    maxSourceBitrateRatio: 0.55,
  }),
});

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeRotationValue(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  const snapped = Math.round(n / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

function alignEvenDimension(value) {
  const safe = Number.isFinite(value) ? value : MIN_DIMENSION;
  return Math.max(MIN_DIMENSION, Math.floor(safe / 2) * 2);
}

export function extractRotation(matrix) {
  if (!matrix || typeof matrix.length !== 'number' || matrix.length < 4) {
    return 0;
  }
  const a = Number(matrix[0]) / 65536;
  const b = Number(matrix[1]) / 65536;
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) {
    return 0;
  }
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return normalizeRotationValue(deg);
}

export function pickAvcCodec(width, height, fps = 30) {
  const safeW = alignEvenDimension(toPositiveNumber(width, 1280));
  const safeH = alignEvenDimension(toPositiveNumber(height, 720));
  const safeFps = Math.min(240, toPositiveNumber(fps, 30));

  const frameMBs = Math.ceil(safeW / 16) * Math.ceil(safeH / 16);
  const mbPerSec = frameMBs * safeFps;

  // Level 4.2 硬上限：MaxFS=8,704 MBs/frame、MaxMBPS=522,240 MBs/sec（H.264 Annex A Table A-1）
  if (frameMBs <= 8704 && mbPerSec <= 522_240) {
    return 'avc1.4d002a';
  }
  // Level 5.1 硬上限：MaxFS=36,864 MBs/frame、MaxMBPS=983,040 MBs/sec
  if (frameMBs <= 36864 && mbPerSec <= 983_040) {
    return 'avc1.4d0033';
  }
  return 'avc1.4d0034';
}

function capDimensions(displayWidth, displayHeight, maxShortEdge, maxLongEdge) {
  const shortEdge = Math.min(displayWidth, displayHeight);
  const longEdge = Math.max(displayWidth, displayHeight);
  const ratio = Math.min(1, maxShortEdge / shortEdge, maxLongEdge / longEdge);

  return {
    width: alignEvenDimension(displayWidth * ratio),
    height: alignEvenDimension(displayHeight * ratio),
    downscaled: ratio < 0.999,
  };
}

export function assessDeviceRisk({
  sourceSizeBytes = 0,
  estimatedOutputBytes = null,
  deviceMemoryGB = null,
  isMobile = false,
  webCodecsAvailable = true,
  useStreamTarget = false,
} = {}) {
  const srcBytes = toNonNegativeNumber(sourceSizeBytes, 0);
  const srcMB = srcBytes / (1024 * 1024);
  const outBytes =
    estimatedOutputBytes !== null && estimatedOutputBytes !== undefined
      ? toNonNegativeNumber(estimatedOutputBytes, srcBytes)
      : srcBytes;
  const outMB = outBytes / (1024 * 1024);

  const mem =
    deviceMemoryGB !== null && deviceMemoryGB !== undefined && Number.isFinite(Number(deviceMemoryGB))
      ? Number(deviceMemoryGB)
      : null;
  const lowMemory = mem !== null ? mem <= 4 : isMobile;

  if (!webCodecsAvailable) {
    if (srcBytes > FFMPEG_MAX_SAFE_BYTES) {
      return {
        estimatedRisk: 'high',
        blocked: true,
        reason: `檔案大小 (${srcMB.toFixed(1)} MB) 超過 FFmpeg 兜底安全上限 (150 MB)，建議改用桌面版 Chrome 或 Edge 啟用硬件加速。`,
      };
    }
    if (isMobile && (srcMB > 80 || (lowMemory && srcMB > 60))) {
      return {
        estimatedRisk: 'high',
        blocked: false,
        reason: `行動裝置執行 FFmpeg.wasm 處理 ${srcMB.toFixed(0)} MB 影片存在高 OOM 閃退風險，建議改用較短片段或桌面瀏覽器。`,
      };
    }
    if (srcMB > 50) {
      return {
        estimatedRisk: 'medium',
        blocked: false,
        reason: `目前將使用 FFmpeg.wasm 軟件轉碼，${srcMB.toFixed(0)} MB 檔案處理需時較長。`,
      };
    }
    return {
      estimatedRisk: 'low',
      blocked: false,
      reason: '使用單線程 FFmpeg.wasm 本地轉碼，檔案大小處於安全範圍。',
    };
  }

  if (useStreamTarget) {
    return srcMB > 2048
      ? {
          estimatedRisk: 'medium',
          blocked: false,
          reason: '超大檔案（超過 2 GB）已啟用磁碟流式寫入，記憶體安全但處理時間較長。',
        }
      : {
          estimatedRisk: 'low',
          blocked: false,
          reason: '使用 WebCodecs 與磁碟流式寫入，記憶體佔用極低。',
        };
  }

  if (isMobile && ((lowMemory && outMB > 100) || outMB > 160)) {
    return {
      estimatedRisk: 'high',
      blocked: false,
      reason: `預計輸出體積達 ${outMB.toFixed(0)} MB，行動裝置記憶體緩衝存在 OOM 風險；建議設定較細嘅目標大小（如 50 MB 以下）。`,
    };
  }
  if (!isMobile && outMB > 400) {
    return {
      estimatedRisk: 'medium',
      blocked: false,
      reason: `預計輸出體積較大 (${outMB.toFixed(0)} MB)，建議允許選擇存檔位置以啟用零記憶體流式寫盤。`,
    };
  }
  if (isMobile && outMB > 60) {
    return {
      estimatedRisk: 'medium',
      blocked: false,
      reason: `預計輸出約 ${outMB.toFixed(0)} MB，建議壓縮期間保持畫面開啟及留喺此頁面。`,
    };
  }

  return {
    estimatedRisk: 'low',
    blocked: false,
    reason: `預計輸出約 ${outMB.toFixed(1)} MB，WebCodecs 流式拆包記憶體安全。`,
  };
}

export function planCompression(input = {}) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const opts = safeInput.options && typeof safeInput.options === 'object' ? safeInput.options : {};

  const presetKey = Object.prototype.hasOwnProperty.call(PRESET_PROFILES, opts.preset)
    ? opts.preset
    : 'balanced';
  const profile = PRESET_PROFILES[presetKey];

  const rotation = normalizeRotationValue(safeInput.rotation);
  const codedW = alignEvenDimension(toPositiveNumber(safeInput.width, 1280));
  const codedH = alignEvenDimension(toPositiveNumber(safeInput.height, 720));
  const isRotated90 = rotation === 90 || rotation === 270;

  if (IS_DEV_MODE && isRotated90 && codedW < codedH) {
    console.warn(
      '[planner] 收到 rotation=90/270 且 codedW 小於 codedH，疑為已正向化尺寸（雙重旋轉風險）。'
    );
  }

  const displayWidth = isRotated90 ? codedH : codedW;
  const displayHeight = isRotated90 ? codedW : codedH;

  const durationSec = toNonNegativeNumber(safeInput.duration, 0);
  const fps = Math.min(240, toPositiveNumber(safeInput.fps, 30));
  const sourceSizeBytes = toNonNegativeNumber(safeInput.sourceSizeBytes, 0);
  const hasAudio = safeInput.hasAudio !== false;

  const requestedScale =
    opts.targetScale !== undefined && opts.targetScale !== null
      ? Math.min(1, Math.max(0.1, toPositiveNumber(opts.targetScale, profile.scale)))
      : profile.scale;

  const scaledW = alignEvenDimension(displayWidth * requestedScale);
  const scaledH = alignEvenDimension(displayHeight * requestedScale);
  let { width: targetWidth, height: targetHeight } = capDimensions(
    scaledW,
    scaledH,
    profile.maxShortEdge,
    profile.maxLongEdge
  );

  const targetSizeMB =
    opts.targetSizeMB !== undefined && opts.targetSizeMB !== null
      ? toPositiveNumber(opts.targetSizeMB, 0)
      : 0;

  let targetBitrate;
  let rateControlMode = 'preset';
  let autoDownscaled = false;
  let bitrateWarning = null;
  let antiBloatFailed = false;
  let antiBloatNote = null;

  if (targetSizeMB > 0 && durationSec > 0) {
    rateControlMode = 'target-size';
    const usableRatio = 1 - SAFETY_MARGIN_RATIO - CONTAINER_OVERHEAD_RATIO;
    const totalUsableBits = targetSizeMB * 1024 * 1024 * 8 * usableRatio;
    const audioBits = hasAudio ? DEFAULT_AUDIO_BITRATE * durationSec : 0;
    const rawVideoBitrate = Math.floor((totalUsableBits - audioBits) / durationSec);

    if (rawVideoBitrate < MIN_VIDEO_BITRATE) {
      targetBitrate = MIN_VIDEO_BITRATE;
      bitrateWarning = '目標檔案大小過細，已套用最低可用碼率與解像度，實際體積可能略大於目標。';
    } else {
      targetBitrate = Math.min(MAX_VIDEO_BITRATE, rawVideoBitrate);
    }

    let capShort = Infinity;
    let capLong = Infinity;
    if (targetBitrate < 350_000) {
      capShort = 360;
      capLong = 640;
    } else if (targetBitrate < 600_000) {
      capShort = 480;
      capLong = 854;
    } else if (targetBitrate < 1_200_000) {
      capShort = 720;
      capLong = 1280;
    }

    if (Number.isFinite(capShort)) {
      const capped = capDimensions(targetWidth, targetHeight, capShort, capLong);
      if (capped.downscaled) {
        targetWidth = capped.width;
        targetHeight = capped.height;
        autoDownscaled = true;
      }
    }
  } else {
    const bppBitrate = Math.round(targetWidth * targetHeight * fps * profile.bpp);
    let sourceCapBitrate = MAX_VIDEO_BITRATE;

    if (sourceSizeBytes > 0 && durationSec > 0) {
      const sourceTotalBitrate = (sourceSizeBytes * 8) / durationSec;
      const rawSourceVideoBitrate = Math.max(
        0,
        sourceTotalBitrate - (hasAudio ? DEFAULT_AUDIO_BITRATE : 0)
      );
      const rawCap = Math.round(rawSourceVideoBitrate * profile.maxSourceBitrateRatio);
      sourceCapBitrate = rawCap;

      if (rawCap < MIN_VIDEO_BITRATE) {
        antiBloatFailed = true;
        antiBloatNote =
          rawSourceVideoBitrate <= MIN_VIDEO_BITRATE
            ? '原檔視訊碼率已低於 200 kbps 安全下限，壓縮後體積可能不減反增，建議保留原檔。'
            : '原檔已屬極低碼率影片，重編碼壓縮空間極細（體積可能不減反增），建議保留原檔。';
      }
    }

    targetBitrate = Math.max(
      MIN_VIDEO_BITRATE,
      Math.min(MAX_VIDEO_BITRATE, bppBitrate, sourceCapBitrate)
    );
  }

  const shouldDecimateFps =
    fps > 35 && (rateControlMode === 'target-size' || presetKey !== 'high');
  const targetFps = shouldDecimateFps ? 30 : Math.round(fps);

  const codec = pickAvcCodec(targetWidth, targetHeight, targetFps);

  const estimatedOutputBytes =
    durationSec > 0
      ? Math.round(
          ((targetBitrate + (hasAudio ? DEFAULT_AUDIO_BITRATE : 0)) *
            durationSec *
            (1 + CONTAINER_OVERHEAD_RATIO)) /
            8
        )
      : Math.round(sourceSizeBytes * profile.maxSourceBitrateRatio);

  const risk = assessDeviceRisk({
    sourceSizeBytes,
    estimatedOutputBytes,
    deviceMemoryGB: safeInput.deviceMemoryGB,
    isMobile: Boolean(safeInput.isMobile),
    webCodecsAvailable: safeInput.webCodecsAvailable !== false,
    useStreamTarget: Boolean(safeInput.useStreamTarget),
  });

  const combinedReason = bitrateWarning ? `${risk.reason} ${bitrateWarning}` : risk.reason;

  return {
    preset: presetKey,
    rateControlMode,
    displayWidth,
    displayHeight,
    targetWidth,
    targetHeight,
    rotation,
    fps,
    targetFps,
    targetBitrate,
    crf: profile.crf,
    codec,
    autoDownscaled,
    antiBloatFailed,
    antiBloatNote,
    estimatedOutputBytes,
    estimatedRisk: risk.estimatedRisk,
    blocked: risk.blocked,
    reason: combinedReason,
  };
}
