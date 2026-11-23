import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRotation,
  pickAvcCodec,
  assessDeviceRisk,
  planCompression,
  FFMPEG_MAX_SAFE_BYTES,
} from '../src/core/planner.js';
import { assertSerializable } from '../src/core/protocol.js';

test('extractRotation 正確解析 MP4 tkhd 旋轉矩陣與非法輸入兜底', () => {
  assert.equal(extractRotation([65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824]), 0);
  assert.equal(extractRotation([0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]), 90);
  assert.equal(extractRotation([-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824]), 180);
  assert.equal(extractRotation([0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824]), 270);
  assert.equal(extractRotation(null), 0);
  assert.equal(extractRotation([0, 0, 0, 0]), 0);
});

test('pickAvcCodec 鎖死 H.264 Level 4.2 / 5.1 / 5.2 邊界', () => {
  assert.equal(pickAvcCodec(1920, 1080, 60), 'avc1.4d002a');
  assert.equal(pickAvcCodec(1920, 1080, 64), 'avc1.4d002a');
  assert.equal(pickAvcCodec(1920, 1080, 65), 'avc1.4d0033');
  assert.equal(pickAvcCodec(3840, 2160, 30), 'avc1.4d0033');
  assert.equal(pickAvcCodec(3840, 2160, 60), 'avc1.4d0034');
});

test('手機豎屏旋轉（90°）與 60fps 轉 30fps 抽幀規劃正確', () => {
  const plan = planCompression({
    width: 1920,
    height: 1080,
    rotation: 90,
    duration: 30,
    fps: 60,
    sourceSizeBytes: 120 * 1024 * 1024,
    options: { preset: 'compact', targetSizeMB: 20 },
  });

  assert.equal(plan.displayWidth, 1080);
  assert.equal(plan.displayHeight, 1920);
  assert.equal(plan.targetWidth, 720);
  assert.equal(plan.targetHeight, 1280);
  assert.equal(plan.targetFps, 30);
});

test('500MB Apple 片喺手機壓至 20MB 輸出時正確判為低 OOM 風險', () => {
  const plan = planCompression({
    width: 3840,
    height: 2160,
    rotation: 0,
    duration: 60,
    fps: 60,
    sourceSizeBytes: 500 * 1024 * 1024,
    deviceMemoryGB: 4,
    isMobile: true,
    webCodecsAvailable: true,
    useStreamTarget: false,
    options: { preset: 'compact', targetSizeMB: 20 },
  });

  assert.equal(plan.estimatedRisk, 'low');
  assert.equal(plan.blocked, false);
  assert.ok(plan.estimatedOutputBytes < 25 * 1024 * 1024);
});

test('防膨脹失敗偵測：極低碼率原檔標記 antiBloatFailed', () => {
  const plan = planCompression({
    width: 640,
    height: 360,
    duration: 10,
    fps: 30,
    sourceSizeBytes: 300 * 1024,
    hasAudio: false,
    options: { preset: 'balanced' },
  });
  assert.equal(plan.antiBloatFailed, true);
  assert.equal(plan.targetBitrate, 200_000);
  assert.match(plan.antiBloatNote, /不減反增/);
});

test('assessDeviceRisk 正確封鎖超過 150MB 嘅 FFmpeg 兜底', () => {
  const blocked = assessDeviceRisk({
    sourceSizeBytes: FFMPEG_MAX_SAFE_BYTES + 1,
    webCodecsAvailable: false,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.estimatedRisk, 'high');
});

test('畸形輸入永不拋錯且輸出可安全序列化', () => {
  for (const bad of [undefined, null, {}, { width: -10, height: Number.NaN, fps: Infinity }]) {
    let res;
    assert.doesNotThrow(() => {
      res = planCompression(bad);
    });
    assert.ok(res.targetWidth >= 32 && res.targetWidth % 2 === 0);
    assert.doesNotThrow(() => assertSerializable(res, { forceCheck: true }));
  }
});
