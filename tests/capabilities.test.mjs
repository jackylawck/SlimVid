import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlatform,
  detectCapabilities,
  clearCapabilitiesCache,
} from '../src/core/capabilities.js';
import { assertSerializable } from '../src/core/protocol.js';

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function withPatchedGlobals(patches, fn) {
  const backup = new Map();
  for (const [key, value] of Object.entries(patches)) {
    backup.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, desc] of backup.entries()) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    });
}

test('detectPlatform 正確區分 Firefox Android、桌面 Firefox 與 iPadOS', () => {
  const ffAndroid = detectPlatform({
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    deviceMemory: 4,
  });
  assert.equal(ffAndroid.isFirefoxAndroid, true);
  assert.equal(ffAndroid.isMobile, true);

  const iPadDesktop = detectPlatform({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  });
  assert.equal(iPadDesktop.isIOS, true);
  assert.equal(iPadDesktop.isSafari, true);
});

test('detectCapabilities 順序探測硬編、支援 HEVC 8/10-bit 與 sessionStorage 快取', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const mockStorage = createMemoryStorage();

  await withPatchedGlobals(
    {
      navigator: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
        platform: 'Win32',
        maxTouchPoints: 0,
        deviceMemory: 8,
      },
      sessionStorage: mockStorage,
      showSaveFilePicker: () => {},
      Worker: function MockWorker() {},
      OffscreenCanvas: function MockOffscreenCanvas() {},
      VideoFrame: function MockVideoFrame() {},
      VideoDecoder: {
        async isConfigSupported({ codec }) {
          return {
            supported:
              codec === 'avc1.42E01E' ||
              codec === 'hvc1.1.6.L93.B0' ||
              codec === 'hvc1.2.4.L120.B0',
          };
        },
      },
      VideoEncoder: {
        async isConfigSupported() {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
          return { supported: true };
        },
      },
    },
    async () => {
      clearCapabilitiesCache();
      const first = await detectCapabilities();
      assert.equal(first.avcDecoderSupported, true);
      assert.equal(first.hevcDecoderSupported, true);
      assert.equal(first.hevc10BitDecoderSupported, true);
      assert.equal(first.preferredEngine, 'webcodecs-hw');
      assert.equal(maxConcurrent, 1);
      assert.doesNotThrow(() => assertSerializable(first, { forceCheck: true }));

      const second = await detectCapabilities();
      assert.equal(second.fromCache, true);
    }
  );
});
