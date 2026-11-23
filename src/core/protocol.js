/**
 * Main <-> WebCodecs Worker Bidirectional Message Protocol (Hardened)
 */

export const PROTOCOL_VERSION = 1;
export const MAX_IN_FLIGHT_STREAM_CHUNKS = 4;

export const MAIN_MSG = Object.freeze({
  START: 'start',
  ABORT: 'abort',
  STREAM_ACK: 'stream-ack',
});

export const WORKER_MSG = Object.freeze({
  PROGRESS: 'progress',
  LOG: 'log',
  STREAM_WRITE: 'stream-write',
  DONE: 'done',
  ERROR: 'error',
});

export const PIPELINE_STAGE = Object.freeze({
  INIT: 'init',
  DEMUX: 'demux',
  DECODE: 'decode',
  ENCODE: 'encode',
  MUX: 'mux',
  STREAM: 'stream',
  ABORT: 'abort',
});

const VALID_STAGES = new Set(Object.values(PIPELINE_STAGE));

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

function createAbortError(message = '壓縮已中止') {
  return new DOMException(message, 'AbortError');
}

export function assertSerializable(
  value,
  { path = 'payload', allowBlob = false, forceCheck = false } = {},
  ancestors = new WeakSet()
) {
  if (!IS_DEV_MODE && !forceCheck) return;

  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }

  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`[Protocol] 禁止跨線程傳送 ${typeof value}（位置: ${path}）`);
  }

  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    return;
  }

  if (allowBlob && typeof Blob !== 'undefined' && value instanceof Blob) {
    return;
  }

  if (ancestors.has(value)) {
    throw new TypeError(`[Protocol] 偵測到循環引用物件（位置: ${path}），禁止跨線程傳送`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        assertSerializable(value[i], { path: `${path}[${i}]`, allowBlob, forceCheck }, ancestors);
      }
      return;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ctorName = value?.constructor?.name || 'UnknownClass';
      throw new TypeError(
        `[Protocol] 禁止傳送非純物件實例 ${ctorName}（位置: ${path}），只允許 primitive / plain object / Uint8Array`
      );
    }

    for (const key of Object.keys(value)) {
      assertSerializable(value[key], { path: `${path}.${key}`, allowBlob, forceCheck }, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeParsedMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;

  const numOrZero = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const strOrNull = (v) => (typeof v === 'string' && v.length <= 64 ? v : null);
  const rawFps = meta.estimatedFps;
  const safeFps =
    typeof rawFps === 'number' && Number.isFinite(rawFps) && rawFps > 0
      ? Math.min(240, Math.max(1, rawFps))
      : 30;

  return {
    width: Math.round(numOrZero(meta.width)),
    height: Math.round(numOrZero(meta.height)),
    duration: numOrZero(meta.duration),
    rotation: [0, 90, 180, 270].includes(meta.rotation) ? meta.rotation : 0,
    estimatedFps: safeFps,
    hasAudio: Boolean(meta.hasAudio),
    canCopyAudio: Boolean(meta.canCopyAudio),
    videoCodec: strOrNull(meta.videoCodec),
    audioCodec: strOrNull(meta.audioCodec),
  };
}

export function postWorkerProgress(port, jobId, percent, stage = PIPELINE_STAGE.ENCODE) {
  const msg = {
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.PROGRESS,
    jobId,
    percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
    stage: VALID_STAGES.has(stage) ? stage : PIPELINE_STAGE.ENCODE,
  };
  assertSerializable(msg);
  port.postMessage(msg);
}

export function postWorkerLog(port, jobId, message) {
  const msg = {
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.LOG,
    jobId,
    message: String(message),
  };
  assertSerializable(msg);
  port.postMessage(msg);
}

export function postWorkerStreamWrite(port, jobId, seq, position, uint8Data) {
  if (!(uint8Data instanceof Uint8Array)) {
    throw new TypeError('[Protocol] stream-write data 必須為 Uint8Array');
  }
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RangeError(`[Protocol] 無效的檔案偏移 position: ${position}`);
  }

  const chunkCopy = uint8Data.slice();
  const msg = {
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.STREAM_WRITE,
    jobId,
    seq,
    position,
    buffer: chunkCopy.buffer,
  };
  assertSerializable(msg);
  port.postMessage(msg, [chunkCopy.buffer]);
}

export function postWorkerDone(
  port,
  jobId,
  { blob = null, streamed = false, engine = '', stats = null }
) {
  const msg = {
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.DONE,
    jobId,
    streamed: Boolean(streamed),
    blob: streamed ? null : blob,
    engine: String(engine),
    stats: stats
      ? {
          outputBytes: Number(stats.outputBytes) || 0,
          elapsedMs: Math.round(Number(stats.elapsedMs) || 0),
          width: Number(stats.width) || 0,
          height: Number(stats.height) || 0,
        }
      : null,
  };
  assertSerializable(msg, { allowBlob: true });
  port.postMessage(msg);
}

export function postWorkerError(
  port,
  jobId,
  { stage = PIPELINE_STAGE.INIT, code = 'WORKER_ERROR', message = '未知錯誤', parsedMeta = null }
) {
  const msg = {
    v: PROTOCOL_VERSION,
    type: WORKER_MSG.ERROR,
    jobId,
    stage: VALID_STAGES.has(stage) ? stage : PIPELINE_STAGE.INIT,
    code: String(code),
    message: String(message),
    parsedMeta: sanitizeParsedMeta(parsedMeta),
  };
  assertSerializable(msg);
  port.postMessage(msg);
}

export function postMainStart(worker, jobId, { file, plan, capabilities, useStreamTarget }) {
  const msg = {
    v: PROTOCOL_VERSION,
    type: MAIN_MSG.START,
    jobId,
    file,
    plan,
    capabilities,
    useStreamTarget: Boolean(useStreamTarget),
  };
  assertSerializable(msg, { allowBlob: true });
  worker.postMessage(msg);
}

export function postMainAbort(worker, jobId) {
  const msg = { v: PROTOCOL_VERSION, type: MAIN_MSG.ABORT, jobId };
  assertSerializable(msg);
  worker.postMessage(msg);
}

export function postMainStreamAck(worker, jobId, seq) {
  const msg = { v: PROTOCOL_VERSION, type: MAIN_MSG.STREAM_ACK, jobId, seq };
  assertSerializable(msg);
  worker.postMessage(msg);
}

export function createStreamWriteBridge(
  writableStream,
  { onAck = () => {}, onError = () => {} } = {}
) {
  let writeChain = Promise.resolve();
  let failedError = null;
  let closed = false;
  let aborted = false;
  let bytesWritten = 0;

  return {
    enqueue(position, buffer, seq) {
      if (closed || aborted || failedError) return;

      const data = new Uint8Array(buffer);
      writeChain = writeChain
        .then(async () => {
          if (closed || aborted || failedError) return;
          await writableStream.write({ type: 'write', position, data });
          bytesWritten = Math.max(bytesWritten, position + data.byteLength);
          try {
            onAck(seq);
          } catch (_) {}
        })
        .catch((err) => {
          if (!failedError && !aborted) {
            failedError = err;
            queueMicrotask(() => onError(err));
          }
        });
    },

    async finalize() {
      if (aborted) throw createAbortError();
      await writeChain;
      if (failedError) throw failedError;
      if (!closed) {
        await writableStream.close();
        closed = true;
      }
      return bytesWritten;
    },

    async abort() {
      if (closed || aborted) return;
      aborted = true;
      try {
        await writableStream.abort();
      } catch (_) {}
      await writeChain.catch(() => {});
    },
  };
}

export function runWorkerJob({
  worker,
  jobId,
  file,
  plan,
  capabilities = null,
  writableStream = null,
  signal = null,
  abortGraceMs = 400,
  onProgress = () => {},
  onLog = () => {},
}) {
  if (signal?.aborted) {
    if (writableStream) {
      writableStream.abort().catch(() => {});
    }
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortTimer = null;
    let streamBridge = null;

    const cleanup = () => {
      if (abortTimer) {
        clearTimeout(abortTimer);
        abortTimer = null;
      }
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleWorkerError);
      worker.removeEventListener('messageerror', handleMessageError);
      if (signal) {
        signal.removeEventListener('abort', handleAbort);
      }
    };

    const failJob = async (err, { terminateWorker = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (terminateWorker) {
        try {
          worker.terminate();
        } catch (_) {}
      }

      if (streamBridge) {
        await streamBridge.abort();
      }

      reject(err);
    };

    streamBridge = writableStream
      ? createStreamWriteBridge(writableStream, {
          onAck: (seq) => {
            if (settled) return;
            try {
              postMainStreamAck(worker, jobId, seq);
            } catch (_) {}
          },
          onError: (ioErr) => {
            const err = new Error(`磁碟流式寫入失敗：${ioErr.message || ioErr}`);
            err.stage = PIPELINE_STAGE.STREAM;
            err.code = 'STREAM_WRITE_FAILED';
            err.parsedMeta = null;
            queueMicrotask(() => failJob(err, { terminateWorker: true }));
          },
        })
      : null;

    const handleMessage = async (event) => {
      const msg = event.data;
      if (!msg || msg.jobId !== jobId) return;

      if (msg.v !== PROTOCOL_VERSION) {
        const err = new Error(
          `Worker 協議版本不符（收到 v${msg.v}，預期 v${PROTOCOL_VERSION}），請重新整理頁面載入最新版本。`
        );
        err.stage = PIPELINE_STAGE.INIT;
        err.code = 'PROTOCOL_VERSION_MISMATCH';
        err.parsedMeta = null;
        failJob(err, { terminateWorker: true });
        return;
      }

      switch (msg.type) {
        case WORKER_MSG.PROGRESS:
          onProgress(msg.percent, msg.stage);
          break;

        case WORKER_MSG.LOG:
          onLog(msg.message);
          break;

        case WORKER_MSG.STREAM_WRITE:
          if (!streamBridge) {
            const err = new Error('協議異常：主線程未開啟流式寫盤但收到 stream-write');
            err.stage = PIPELINE_STAGE.STREAM;
            err.code = 'UNEXPECTED_STREAM_WRITE';
            err.parsedMeta = null;
            failJob(err, { terminateWorker: true });
            return;
          }
          streamBridge.enqueue(msg.position, msg.buffer, msg.seq);
          break;

        case WORKER_MSG.DONE: {
          if (settled) return;
          settled = true;
          cleanup();

          try {
            let finalBytes = msg.stats?.outputBytes || 0;
            if (msg.streamed && streamBridge) {
              finalBytes = await streamBridge.finalize();
            }
            resolve({
              blob: msg.streamed ? null : msg.blob,
              streamed: Boolean(msg.streamed),
              engine: msg.engine,
              stats: msg.stats
                ? { ...msg.stats, outputBytes: finalBytes }
                : { outputBytes: finalBytes },
            });
          } catch (finalizeErr) {
            const err = new Error(`磁碟檔案封裝關閉失敗：${finalizeErr.message || finalizeErr}`);
            err.stage = PIPELINE_STAGE.STREAM;
            err.code = 'STREAM_FINALIZE_FAILED';
            err.parsedMeta = null;
            await streamBridge?.abort();
            reject(err);
          }
          break;
        }

        case WORKER_MSG.ERROR: {
          if (msg.stage === PIPELINE_STAGE.ABORT) {
            failJob(createAbortError(msg.message), { terminateWorker: true });
            return;
          }
          const err = new Error(msg.message || 'WebCodecs Worker 執行失敗');
          err.stage = VALID_STAGES.has(msg.stage) ? msg.stage : PIPELINE_STAGE.INIT;
          err.code = msg.code || 'WORKER_ERROR';
          err.parsedMeta = sanitizeParsedMeta(msg.parsedMeta);
          failJob(err, { terminateWorker: false });
          break;
        }

        default:
          break;
      }
    };

    const handleWorkerError = (event) => {
      const err = new Error(`WebCodecs Worker 崩潰：${event.message || '未捕捉異常'}`);
      err.stage = PIPELINE_STAGE.INIT;
      err.code = 'WORKER_CRASH';
      err.parsedMeta = null;
      failJob(err, { terminateWorker: true });
    };

    const handleMessageError = () => {
      const err = new Error('Worker 訊息反序列化失敗（MessageError）');
      err.stage = PIPELINE_STAGE.INIT;
      err.code = 'WORKER_MESSAGE_ERROR';
      err.parsedMeta = null;
      failJob(err, { terminateWorker: true });
    };

    const handleAbort = () => {
      if (settled) return;
      try {
        postMainAbort(worker, jobId);
      } catch (_) {}

      abortTimer = setTimeout(() => {
        failJob(createAbortError('壓縮已強制中止並釋放記憶體'), { terminateWorker: true });
      }, abortGraceMs);
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleWorkerError);
    worker.addEventListener('messageerror', handleMessageError);
    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true });
    }

    try {
      postMainStart(worker, jobId, {
        file,
        plan,
        capabilities,
        useStreamTarget: Boolean(streamBridge),
      });
    } catch (startErr) {
      startErr.stage = PIPELINE_STAGE.INIT;
      failJob(startErr, { terminateWorker: true });
    }
  });
}
