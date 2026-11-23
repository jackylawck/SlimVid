import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  WORKER_MSG,
  PIPELINE_STAGE,
  assertSerializable,
  sanitizeParsedMeta,
  createStreamWriteBridge,
  runWorkerJob,
} from '../src/core/protocol.js';

class MockWorker extends EventTarget {
  constructor() {
    super();
    this.posted = [];
    this.terminated = false;
  }
  postMessage(msg) {
    if (this.terminated) throw new Error('Worker already terminated');
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  emitFromWorker(data) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

test('assertSerializable 容許合法共享引用，攔截真循環引用與非 plain 類別', () => {
  const shared = { codec: 'avc1.4d002a', bitrate: 1_500_000 };
  assert.doesNotThrow(() => {
    assertSerializable({ a: shared, b: shared, list: [shared, shared] }, { forceCheck: true });
  });

  const cyclic = { name: 'trak' };
  cyclic.self = cyclic;
  assert.throws(() => assertSerializable(cyclic, { forceCheck: true }), /循環引用/);

  class FakeMp4Trak {}
  assert.throws(() => assertSerializable({ trak: new FakeMp4Trak() }, { forceCheck: true }), /FakeMp4Trak/);
});

test('sanitizeParsedMeta 兜底 estimatedFps 為 30 並過濾非法欄位', () => {
  const clean = sanitizeParsedMeta({
    width: 1920.4,
    height: 1080,
    duration: 12.5,
    rotation: 90,
    estimatedFps: 0,
    hasAudio: 1,
    canCopyAudio: false,
    extraJunk: { bad: true },
  });

  assert.deepEqual(clean, {
    width: 1920,
    height: 1080,
    duration: 12.5,
    rotation: 90,
    estimatedFps: 30,
    hasAudio: true,
    canCopyAudio: false,
    videoCodec: null,
    audioCodec: null,
  });
});

test('createStreamWriteBridge 嚴格串行化、支援 finalize 倒跳 seek、隔離 onAck 異常', async () => {
  const writes = [];
  let inFlight = 0;

  const mockStream = {
    async write({ position, data }) {
      inFlight++;
      assert.equal(inFlight, 1);
      await new Promise((r) => setTimeout(r, 5));
      writes.push({ position, len: data.byteLength });
      inFlight--;
    },
    async close() {},
    async abort() {},
  };

  const bridge = createStreamWriteBridge(mockStream, {
    onAck: () => {
      throw new Error('模擬已終止 Worker 拋錯');
    },
    onError: () => assert.fail('onAck 異常不應觸發磁碟 onError'),
  });

  bridge.enqueue(1000, new Uint8Array(50).buffer, 0);
  bridge.enqueue(24, new Uint8Array(8).buffer, 1);

  const totalBytes = await bridge.finalize();
  assert.equal(totalBytes, 1050);
  assert.deepEqual(writes, [
    { position: 1000, len: 50 },
    { position: 24, len: 8 },
  ]);
});

test('磁碟寫入失敗即時 reject 唔死鎖', async () => {
  const worker = new MockWorker();
  let streamAborted = false;

  const failingStream = {
    async write() {
      throw new DOMException('Disk full', 'QuotaExceededError');
    },
    async close() {},
    async abort() {
      streamAborted = true;
    },
  };

  const jobPromise = runWorkerJob({
    worker,
    jobId: 'job-disk-full',
    file: new Blob(['fake']),
    plan: { targetWidth: 720 },
    writableStream: failingStream,
  });

  worker.emitFromWorker({
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.STREAM_WRITE,
    jobId: 'job-disk-full',
    seq: 0,
    position: 0,
    buffer: new Uint8Array([1, 2, 3]).buffer,
  });

  await assert.rejects(jobPromise, (err) => {
    assert.equal(err.stage, PIPELINE_STAGE.STREAM);
    assert.equal(err.code, 'STREAM_WRITE_FAILED');
    return true;
  });

  assert.equal(worker.terminated, true);
  assert.equal(streamAborted, true);
});

test('慢速寫盤時 AbortController 即時打斷底層流唔掛起', async () => {
  const worker = new MockWorker();
  const ac = new AbortController();
  let rejectHungWrite;
  let streamAborted = false;

  const slowStream = {
    write() {
      return new Promise((_, reject) => {
        rejectHungWrite = reject;
      });
    },
    async close() {},
    async abort() {
      streamAborted = true;
      rejectHungWrite?.(new Error('Stream aborted'));
    },
  };

  const jobPromise = runWorkerJob({
    worker,
    jobId: 'job-slow',
    file: new Blob(['fake']),
    plan: { targetWidth: 720 },
    writableStream: slowStream,
    signal: ac.signal,
    abortGraceMs: 30,
  });

  worker.emitFromWorker({
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.STREAM_WRITE,
    jobId: 'job-slow',
    seq: 0,
    position: 0,
    buffer: new Uint8Array([1, 2, 3]).buffer,
  });

  ac.abort();

  await assert.rejects(jobPromise, (err) => err.name === 'AbortError');
  assert.equal(worker.terminated, true);
  assert.equal(streamAborted, true);
});

test('協議版本不符時立即失敗', async () => {
  const worker = new MockWorker();
  const jobPromise = runWorkerJob({
    worker,
    jobId: 'job-old',
    file: new Blob(['fake']),
    plan: { targetWidth: 720 },
  });

  worker.emitFromWorker({
    v: 999,
    type: WORKER_MSG.PROGRESS,
    jobId: 'job-old',
    percent: 10,
  });

  await assert.rejects(jobPromise, (err) => err.code === 'PROTOCOL_VERSION_MISMATCH');
  assert.equal(worker.terminated, true);
});
