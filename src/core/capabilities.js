/**
 * Main-Thread Browser Capability Probing & Session Cache
 */

const CACHE_KEY = 'ztvc_capabilities_v1';
const CACHE_SCHEMA_VERSION = 2;

const AVC_DECODER_CODECS = Object.freeze([
  'avc1.4d002a',
  'avc1.42E01E',
  'avc1.640028',
]);

const HEVC_8BIT_CODECS = Object.freeze([
  'hvc1.1.6.L93.B0',
  'hev1.1.6.L93.B0',
]);

const HEVC_10BIT_CODECS = Object.freeze([
  'hvc1.2.4.L120.B0',
  'hev1.2.4.L120.B0',
]);

const PROBE_VIDEO_CONFIG_1080P = Object.freeze({
  codec: 'avc1.4d002a',
  width: 1920,
  height: 1080,
  bitrate: 3_000_000,
  framerate: 30,
});

const PROBE_VIDEO_CONFIG_4K = Object.freeze({
  codec: 'avc1.4d0033',
  width: 3840,
  height: 2160,
  bitrate: 10_000_000,
  framerate: 30,
});

export function detectPlatform(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  const platform = String(nav?.platform || '');
  const maxTouchPoints = Number(nav?.maxTouchPoints || 0);

  const isAndroid = /Android/i.test(ua);
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && maxTouchPoints > 1);
  const isMobile = isAndroid || isIOS || /Mobi/i.test(ua);

  const isFirefox = /Firefox\//i.test(ua) && !/Seamonkey\//i.test(ua);
  const isFirefoxAndroid = isFirefox && isAndroid;
  const isSafari =
    /Safari\//i.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//i.test(ua);

  const rawMem = nav?.deviceMemory;
  const deviceMemoryGB =
    typeof rawMem === 'number' && Number.isFinite(rawMem) && rawMem > 0 ? rawMem : null;

  return {
    ua,
    platform,
    isAndroid,
    isIOS,
    isMobile,
    isFirefox,
    isFirefoxAndroid,
    isSafari,
    deviceMemoryGB,
  };
}

function readCachedCapabilities(fingerprint) {
  try {
    if (typeof globalThis.sessionStorage === 'undefined') return null;
    const raw = globalThis.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.fingerprint !== fingerprint
    ) {
      return null;
    }
    return parsed.data || null;
  } catch (_) {
    return null;
  }
}

function writeCachedCapabilities(fingerprint, data) {
  try {
    if (typeof globalThis.sessionStorage === 'undefined') return;
    globalThis.sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        fingerprint,
        data,
      })
    );
  } catch (_) {}
}

export function clearCapabilitiesCache() {
  try {
    globalThis.sessionStorage?.removeItem(CACHE_KEY);
  } catch (_) {}
}

async function probeEncoderSupport(config, acceleration) {
  try {
    const res = await globalThis.VideoEncoder.isConfigSupported({
      ...config,
      hardwareAcceleration: acceleration,
    });
    return Boolean(res?.supported);
  } catch (_) {
    return false;
  }
}

async function probeDecoderCodecs(codecs) {
  for (const codec of codecs) {
    try {
      const res = await globalThis.VideoDecoder.isConfigSupported({ codec });
      if (res?.supported) return true;
    } catch (_) {}
  }
  return false;
}

export async function detectCapabilities({ forceRefresh = false } = {}) {
  const plat = detectPlatform(globalThis.navigator);
  const hasFileSystemAccess = typeof globalThis.showSaveFilePicker === 'function';
  const fingerprint = `${plat.ua}|${plat.deviceMemoryGB ?? 'na'}|${hasFileSystemAccess ? 1 : 0}`;

  if (!forceRefresh) {
    const cached = readCachedCapabilities(fingerprint);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const hasWasm =
    typeof globalThis.WebAssembly === 'object' &&
    typeof globalThis.WebAssembly.instantiate === 'function';
  const hasWorker = typeof globalThis.Worker === 'function';
  const hasOffscreenCanvas = typeof globalThis.OffscreenCanvas === 'function';
  const hasWebCodecsAPI =
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoDecoder === 'function' &&
    typeof globalThis.VideoFrame === 'function';

  let webCodecsHardware = false;
  let webCodecsSoftware = false;
  let webCodecs4KHardware = false;
  let avcDecoderSupported = false;
  let hevcDecoderSupported = false;
  let hevc10BitDecoderSupported = false;
  let webCodecsNote = '';

  if (plat.isFirefoxAndroid) {
    webCodecsNote = 'Firefox Android 預設路由至 FFmpeg.wasm 兜底以確保穩定性。';
  } else if (!hasWebCodecsAPI || !hasOffscreenCanvas || !hasWorker) {
    webCodecsNote = '瀏覽器缺少 WebCodecs / OffscreenCanvas / Worker 原生介面。';
  } else {
    avcDecoderSupported = await probeDecoderCodecs(AVC_DECODER_CODECS);
    hevcDecoderSupported = await probeDecoderCodecs(HEVC_8BIT_CODECS);
    hevc10BitDecoderSupported = hevcDecoderSupported
      ? await probeDecoderCodecs(HEVC_10BIT_CODECS)
      : false;

    if (avcDecoderSupported) {
      webCodecsHardware = await probeEncoderSupport(PROBE_VIDEO_CONFIG_1080P, 'prefer-hardware');
      webCodecsSoftware = await probeEncoderSupport(PROBE_VIDEO_CONFIG_1080P, 'prefer-software');
      webCodecs4KHardware = webCodecsHardware
        ? await probeEncoderSupport(PROBE_VIDEO_CONFIG_4K, 'prefer-hardware')
        : false;

      webCodecsNote = webCodecsHardware
        ? '支援 WebCodecs 硬件加速編碼。'
        : webCodecsSoftware
          ? '硬件編碼不可用，支援 WebCodecs 軟件編碼。'
          : 'WebCodecs H.264 編碼配置不受支援。';
    } else {
      webCodecsNote = '瀏覽器不支援 WebCodecs H.264 解碼。';
    }
  }

  const webCodecsAvailable = webCodecsHardware || webCodecsSoftware;
  const preferredEngine = webCodecsHardware
    ? 'webcodecs-hw'
    : webCodecsSoftware
      ? 'webcodecs-sw'
      : hasWasm
        ? 'ffmpeg'
        : 'none';

  const result = {
    preferredEngine,
    webCodecsAvailable,
    webCodecsHardware,
    webCodecsSoftware,
    webCodecs4KHardware,
    avcDecoderSupported,
    hevcDecoderSupported,
    hevc10BitDecoderSupported,
    hasWasm,
    hasWorker,
    hasOffscreenCanvas,
    hasFileSystemAccess,
    isMobile: plat.isMobile,
    isAndroid: plat.isAndroid,
    isIOS: plat.isIOS,
    isFirefox: plat.isFirefox,
    isFirefoxAndroid: plat.isFirefoxAndroid,
    isSafari: plat.isSafari,
    deviceMemoryGB: plat.deviceMemoryGB,
    webCodecsNote,
    fromCache: false,
  };

  writeCachedCapabilities(fingerprint, result);
  return result;
}
