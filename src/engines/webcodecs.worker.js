/**
 * Dedicated WebCodecs Compression Worker
 */

import { vendorUrl } from '../paths.js';
import { extractRotation, planCompression } from '../core/planner.js';
import {
  PROTOCOL_VERSION,
  MAIN_MSG,
  PIPELINE_STAGE,
  MAX_IN_FLIGHT_STREAM_CHUNKS,
  postWorkerProgress,
  postWorkerLog,
  postWorkerStreamWrite,
  postWorkerDone,
  postWorkerError,
} from '../core/protocol.js';
import {
  scanMp4TopLevelBoxes,
  feedMp4HeadersToMp4Box,
  feedMp4MdatChunks,
  resolveAacAudioConfig,
} from './mp4-scanner.js';

let activeJobId = null;
let activeAbortController = null;
let inFlightWrites = 0;
let ackWakeup = null;

function createStageError(message, stage, code, parsedMeta = null) {
  const err = new Error(message);
  err.stage = stage;
  err.code = code;
  err.parsedMeta = parsedMeta;
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createStageError('壓縮已中止', PIPELINE_STAGE.ABORT, 'ABORTED');
  }
}

function extractVideoDescription(MP4Box, videoTrak) {
  const entries = videoTrak?.mdia?.minf?.stbl?.stsd?.entries || [];
  for (const entry of entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return null;
}

function computeGlobalTimestampOffsetUs(videoTrak, audioTrak, videoTimescale, audioTimescale) {
  let minCtsUs = 0;
  let scannedAny = false;

  const scanTrack = (trak, fallbackTimescale) => {
    const samples = trak?.samples;
    if (!Array.isArray(samples) || samples.length === 0) return;
    scannedAny = true;
    const limit = Math.min(samples.length, 60);
    for (let i = 0; i < limit; i++) {
      const s = samples[i];
      const tsScale = s.timescale || fallbackTimescale;
      if (!tsScale || !Number.isFinite(s.cts)) continue;
      const ctsUs = Math.round((s.cts * 1_000_000) / tsScale);
      if (ctsUs < minCtsUs) minCtsUs = ctsUs;
    }
  };

  scanTrack(videoTrak, videoTimescale);
  scanTrack(audioTrak, audioTimescale);

  return {
    offsetUs: minCtsUs < 0 ? -minCtsUs : 0,
    scannedAny,
  };
}

async function selectEncoderConfig({ codec, width, height, bitrate, framerate }) {
  const base = {
    codec,
    width,
    height,
    bitrate,
    framerate: Math.min(120, Math.max(1, Math.round(framerate || 30))),
  };

  for (const accel of ['prefer-hardware', 'prefer-software']) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        ...base,
        hardwareAcceleration: accel,
      });
      if (res?.supported) {
        return { ...base, hardwareAcceleration: accel };
      }
    } catch (_) {}
  }
  return null;
}

function attachDequeueListener(codecObj, handler) {
  if (!codecObj) return () => {};
  if (typeof codecObj.addEventListener === 'function') {
    codecObj.addEventListener('dequeue', handler, { once: true });
    return () => {
      try {
        codecObj.removeEventListener('dequeue', handler);
      } catch (_) {}
    };
  }
  if ('ondequeue' in codecObj) {
    codecObj.ondequeue = handler;
    return () => {
      if (codecObj.ondequeue === handler) {
        codecObj.ondequeue = null;
      }
    };
  }
  return () => {};
}

async function waitForBackpressure({
  decoder,
  encoder,
  maxDecodeQueue,
  maxEncodeQueue,
  useStreamTarget,
  signal,
  getFatalError,
}) {
  let spins = 0;

  while (true) {
    throwIfAborted(signal);
    const fatal = getFatalError();
    if (fatal) throw fatal;

    const decodeFull =
      decoder && decoder.state === 'configured' && decoder.decodeQueueSize >= maxDecodeQueue;
    const encodeFull =
      encoder && encoder.state === 'configured' && encoder.encodeQueueSize >= maxEncodeQueue;
    const diskFull = useStreamTarget && inFlightWrites >= MAX_IN_FLIGHT_STREAM_CHUNKS;

    if (!decodeFull && !encodeFull && !diskFull) {
      return;
    }

    spins++;
    const pollMs = spins <= 100 ? 5 : spins <= 300 ? 15 : 50;

    await new Promise((resolve) => {
      let settled = false;
      let detachDecode = () => {};
      let detachEncode = () => {};

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachDecode();
        detachEncode();
        if (signal) signal.removeEventListener('abort', done);
        if (ackWakeup === done) ackWakeup = null;
        resolve();
      };

      if (decodeFull && decoder) detachDecode = attachDequeueListener(decoder, done);
      if (encodeFull && encoder) detachEncode = attachDequeueListener(encoder, done);
      if (diskFull) ackWakeup = done;
      if (signal) signal.addEventListener('abort', done, { once: true });

      const timer = setTimeout(done, pollMs);
    });
  }
}

async function runCompressionJob(jobId, { file, plan: userOptions, capabilities, useStreamTarget }) {
  const startTime = performance.now();
  const signal = activeAbortController.signal;

  let stage = PIPELINE_STAGE.INIT;
  let parsedMeta = null;
  let fatalError = null;
  let decoder = null;
  let encoder = null;

  const cleanupCodecs = () => {
    try {
      if (decoder && decoder.state !== 'closed') decoder.close();
    } catch (_) {}
    try {
      if (encoder && encoder.state !== 'closed') encoder.close();
    } catch (_) {}
    decoder = null;
    encoder = null;
  };

  try {
    postWorkerProgress(self, jobId, 1, PIPELINE_STAGE.INIT);

    const [mp4boxModule, muxerModule] = await Promise.all([
      import(vendorUrl('mp4box.esm.js')),
      import(vendorUrl('mp4-muxer.mjs')),
    ]);
    const MP4Box = mp4boxModule.default || mp4boxModule;
    const { Muxer, ArrayBufferTarget, StreamTarget } = muxerModule;

    throwIfAborted(signal);

    stage = PIPELINE_STAGE.DEMUX;
    postWorkerLog(self, jobId, '掃描影片容器結構...');
    const layout = await scanMp4TopLevelBoxes(file, { signal });
    if (!layout.isMp4) {
      throw createStageError(layout.reason, PIPELINE_STAGE.DEMUX, 'NOT_MP4_CONTAINER');
    }

    postWorkerLog(
      self,
      jobId,
      layout.isFastStart
        ? '容器驗證通過（FastStart MP4/MOV）。'
        : '偵測到非 FastStart 檔案（moov 位於檔尾），啟用快速跳躍讀取。'
    );
    postWorkerProgress(self, jobId, 4, PIPELINE_STAGE.DEMUX);

    const mp4boxfile = MP4Box.createFile();
    const pendingVideo = [];
    const pendingAudio = [];

    let videoTrack = null;
    let audioTrack = null;
    let audioDescription = null;
    let normalizedAudioCodec = null;
    let audioMetaSent = false;
    let globalTsOffsetUs = 0;

    let muxer = null;
    let activePlan = null;
    let usedAcceleration = '';
    let maxDecodeQueue = 12;
    let maxEncodeQueue = 6;
    let totalSamples = 0;
    let decodedSamples = 0;
    let encodedSamples = 0;
    let nextStreamSeq = 0;

    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });

    mp4boxfile.onError = (e) => {
      const err = createStageError(`MP4 解封裝失敗: ${e}`, PIPELINE_STAGE.DEMUX, 'DEMUX_ERROR', parsedMeta);
      fatalError = err;
      readyReject(err);
    };

    mp4boxfile.onReady = async (info) => {
      try {
        throwIfAborted(signal);

        videoTrack = info.videoTracks?.[0] || null;
        if (!videoTrack) {
          throw createStageError('檔案中找不到視訊軌道', PIPELINE_STAGE.DEMUX, 'NO_VIDEO_TRACK');
        }

        const allAudioTracks = info.audioTracks || [];
        let resolvedAacTrack = null;
        let resolvedAacInfo = null;

        for (const t of allAudioTracks) {
          if (t.codec === 'mp4a' || (t.codec && t.codec.startsWith('mp4a.40'))) {
            const trak = mp4boxfile.getTrackById(t.id);
            const resolved = resolveAacAudioConfig(trak, {
              codec: t.codec,
              sampleRate: t.audio?.sample_rate,
              channelCount: t.audio?.channel_count,
            });
            if (resolved.isAac && resolved.description) {
              resolvedAacTrack = t;
              resolvedAacInfo = resolved;
              break;
            }
          }
        }

        const apacTrack = allAudioTracks.find((t) => t.codec && t.codec.startsWith('apac')) || null;
        const firstOtherAudio = allAudioTracks[0] || null;

        const rotation = extractRotation(videoTrack.matrix);
        const codedW = videoTrack.video.width;
        const codedH = videoTrack.video.height;
        const isRotated90 = rotation === 90 || rotation === 270;
        const displayW = isRotated90 ? codedH : codedW;
        const displayH = isRotated90 ? codedW : codedH;

        const durationSec =
          videoTrack.duration && videoTrack.timescale
            ? videoTrack.duration / videoTrack.timescale
            : info.duration && info.timescale
              ? info.duration / info.timescale
              : 0;
        const estimatedFps =
          durationSec > 0 && videoTrack.nb_samples > 0
            ? videoTrack.nb_samples / durationSec
            : 30;

        parsedMeta = {
          width: displayW,
          height: displayH,
          duration: durationSec,
          rotation,
          estimatedFps,
          hasAudio: allAudioTracks.length > 0,
          canCopyAudio: Boolean(resolvedAacTrack),
          videoCodec: videoTrack.codec || null,
          audioCodec: (resolvedAacInfo?.codec || firstOtherAudio?.codec) || null,
        };

        if (resolvedAacTrack && resolvedAacInfo) {
          audioTrack = resolvedAacTrack;
          audioDescription = resolvedAacInfo.description;
          normalizedAudioCodec = resolvedAacInfo.codec;
          const sr = audioTrack.audio?.sample_rate;
          const ch = audioTrack.audio?.channel_count;

          if (!audioDescription || !sr || !ch) {
            throw createStageError(
              '無法完整提取 AAC AudioSpecificConfig 或採樣率資訊，轉交 FFmpeg 處理以免無聲',
              PIPELINE_STAGE.DEMUX,
              'MISSING_AUDIO_CONFIG',
              parsedMeta
            );
          }
        } else if (apacTrack) {
          throw createStageError(
            '僅偵測到空間音訊軌道 (apac)，轉交 FFmpeg 處理以保留音效',
            PIPELINE_STAGE.DEMUX,
            'APAC_ONLY_AUDIO',
            parsedMeta
          );
        } else if (firstOtherAudio) {
          throw createStageError(
            `音軌格式 (${firstOtherAudio.codec}) 非 AAC，轉交 FFmpeg 處理以保留音效`,
            PIPELINE_STAGE.DEMUX,
            'NON_AAC_AUDIO',
            parsedMeta
          );
        }

        const videoTrak = mp4boxfile.getTrackById(videoTrack.id);
        const audioTrak = audioTrack ? mp4boxfile.getTrackById(audioTrack.id) : null;
        const { offsetUs, scannedAny } = computeGlobalTimestampOffsetUs(
          videoTrak,
          audioTrak,
          videoTrack.timescale,
          audioTrack?.timescale
        );
        globalTsOffsetUs = offsetUs;

        if (!scannedAny) {
          postWorkerLog(
            self,
            jobId,
            '提示：onReady 階段未取得 trak.samples 樣本表，時間戳偏移採用預設 0ms。'
          );
        } else if (globalTsOffsetUs > 0) {
          postWorkerLog(
            self,
            jobId,
            `偵測到負數時間戳（iPhone elst），已套用全域統一偏移 +${(globalTsOffsetUs / 1000).toFixed(1)}ms。`
          );
        }

        activePlan = planCompression({
          width: codedW,
          height: codedH,
          rotation,
          duration: durationSec,
          fps: estimatedFps,
          sourceSizeBytes: file.size,
          hasAudio: Boolean(audioTrack),
          deviceMemoryGB: capabilities?.deviceMemoryGB ?? null,
          isMobile: Boolean(capabilities?.isMobile),
          webCodecsAvailable: true,
          useStreamTarget,
          options: userOptions || {},
        });

        if (activePlan.antiBloatFailed && activePlan.antiBloatNote) {
          postWorkerLog(self, jobId, `提示：${activePlan.antiBloatNote}`);
        }
        if (activePlan.autoDownscaled) {
          postWorkerLog(
            self,
            jobId,
            `目標碼率較低，已自動降至 ${activePlan.targetWidth}x${activePlan.targetHeight} 以維持畫質。`
          );
        }

        stage = PIPELINE_STAGE.DECODE;
        const videoDescription = extractVideoDescription(MP4Box, videoTrak);
        const decoderConfig = {
          codec: videoTrack.codec,
          codedWidth: codedW,
          codedHeight: codedH,
          ...(videoDescription ? { description: videoDescription } : {}),
        };
        const decSupport = await VideoDecoder.isConfigSupported(decoderConfig);
        if (!decSupport?.supported) {
          throw createStageError(
            `此瀏覽器 WebCodecs 無法直接解碼視訊格式 (${videoTrack.codec})`,
            PIPELINE_STAGE.DECODE,
            'UNSUPPORTED_VIDEO_DECODER',
            parsedMeta
          );
        }

        stage = PIPELINE_STAGE.ENCODE;
        const targetFps = activePlan.targetFps || Math.round(activePlan.fps);
        const encoderConfig = await selectEncoderConfig({
          codec: activePlan.codec,
          width: activePlan.targetWidth,
          height: activePlan.targetHeight,
          bitrate: activePlan.targetBitrate,
          framerate: targetFps,
        });
        if (!encoderConfig) {
          throw createStageError(
            `瀏覽器不支援 ${activePlan.targetWidth}x${activePlan.targetHeight} (${activePlan.codec}) 編碼`,
            PIPELINE_STAGE.ENCODE,
            'UNSUPPORTED_VIDEO_ENCODER',
            parsedMeta
          );
        }

        usedAcceleration = encoderConfig.hardwareAcceleration;

        const isHighResOrMobile = Boolean(capabilities?.isMobile) || codedW * codedH > 1920 * 1080;
        maxDecodeQueue = isHighResOrMobile ? 2 : 12;
        maxEncodeQueue = isHighResOrMobile ? 2 : 6;

        postWorkerLog(
          self,
          jobId,
          `啟動 WebCodecs (${usedAcceleration} | ${activePlan.targetWidth}x${activePlan.targetHeight} @${targetFps}fps | ${(activePlan.targetBitrate / 1_000_000).toFixed(2)} Mbps | 隊列上限 ${maxDecodeQueue}/${maxEncodeQueue})`
        );

        stage = PIPELINE_STAGE.MUX;
        const muxerTarget = useStreamTarget
          ? new StreamTarget({
              onData: (data, position) => {
                inFlightWrites++;
                postWorkerStreamWrite(self, jobId, nextStreamSeq++, position, data);
              },
              chunked: true,
              chunkSize: 4 * 1024 * 1024,
            })
          : new ArrayBufferTarget();

        muxer = new Muxer({
          target: muxerTarget,
          video: {
            codec: 'avc',
            width: activePlan.targetWidth,
            height: activePlan.targetHeight,
          },
          audio: audioTrack
            ? {
                codec: 'aac',
                numberOfChannels: audioTrack.audio.channel_count,
                sampleRate: audioTrack.audio.sample_rate,
              }
            : undefined,
          fastStart: useStreamTarget ? false : 'in-memory',
        });

        encoder = new VideoEncoder({
          output: (chunk, meta) => {
            try {
              muxer.addVideoChunk(chunk, meta);
            } catch (e) {
              fatalError = createStageError(`視訊封裝失敗: ${e.message}`, PIPELINE_STAGE.MUX, 'MUX_VIDEO_ERROR', parsedMeta);
            }
          },
          error: (e) => {
            fatalError = createStageError(`視訊編碼器異常: ${e.message}`, PIPELINE_STAGE.ENCODE, 'ENCODER_ERROR', parsedMeta);
          },
        });
        encoder.configure(encoderConfig);

        const targetW = activePlan.targetWidth;
        const targetH = activePlan.targetHeight;
        const canvas = new OffscreenCanvas(targetW, targetH);
        const ctx = canvas.getContext('2d', { alpha: false });

        let useBitmapTransfer = false;
        const createFrameFromCanvas = (timestamp, duration) => {
          if (!useBitmapTransfer) {
            try {
              return new VideoFrame(canvas, { timestamp, duration });
            } catch (_) {
              useBitmapTransfer = true;
            }
          }
          const bitmap = canvas.transferToImageBitmap();
          try {
            return new VideoFrame(bitmap, { timestamp, duration });
          } finally {
            bitmap.close();
          }
        };

        const shouldDecimate = estimatedFps > targetFps + 5;
        const minFrameGapUs = shouldDecimate ? Math.round((1_000_000 / targetFps) * 0.85) : 0;
        const nominalFrameDurUs = Math.round(1_000_000 / targetFps);
        const keyFrameInterval = Math.max(15, Math.round(targetFps * 2));

        let lastEncodedTsUs = -Infinity;
        let hdrChecked = false;

        decoder = new VideoDecoder({
          output: (frame) => {
            let frameClosed = false;
            const closeSourceFrame = () => {
              if (!frameClosed) {
                frameClosed = true;
                frame.close();
              }
            };

            try {
              decodedSamples++;

              if (!hdrChecked) {
                hdrChecked = true;
                const tr = frame.colorSpace?.transfer;
                if (tr === 'pq' || tr === 'hlg') {
                  postWorkerLog(
                    self,
                    jobId,
                    `偵測到 HDR 影片 (${tr.toUpperCase()})，將轉為相容 SDR 輸出（高光亮度可能略有差異）。`
                  );
                }
              }

              const ts = Math.max(0, frame.timestamp);
              const dur = shouldDecimate ? nominalFrameDurUs : frame.duration || nominalFrameDurUs;

              if (minFrameGapUs > 0 && ts - lastEncodedTsUs < minFrameGapUs) {
                closeSourceFrame();
                return;
              }

              if (rotation === 0) {
                ctx.drawImage(frame, 0, 0, targetW, targetH);
              } else {
                ctx.save();
                ctx.translate(targetW / 2, targetH / 2);
                ctx.rotate((rotation * Math.PI) / 180);
                if (isRotated90) {
                  ctx.drawImage(frame, -targetH / 2, -targetW / 2, targetH, targetW);
                } else {
                  ctx.drawImage(frame, -targetW / 2, -targetH / 2, targetW, targetH);
                }
                ctx.restore();
              }

              closeSourceFrame();

              const resizedFrame = createFrameFromCanvas(ts, dur);
              const keyFrame = encodedSamples % keyFrameInterval === 0;
              encoder.encode(resizedFrame, { keyFrame });
              resizedFrame.close();

              lastEncodedTsUs = ts;
              encodedSamples++;

              if (totalSamples > 0) {
                const pct = 6 + Math.min(89, Math.round((decodedSamples / totalSamples) * 89));
                postWorkerProgress(self, jobId, pct, PIPELINE_STAGE.ENCODE);
              }
            } catch (e) {
              fatalError = createStageError(`畫面處理異常: ${e.message}`, PIPELINE_STAGE.ENCODE, 'FRAME_PROCESS_ERROR', parsedMeta);
            } finally {
              closeSourceFrame();
            }
          },
          error: (e) => {
            fatalError = createStageError(`視訊解碼器異常: ${e.message}`, PIPELINE_STAGE.DECODE, 'DECODER_ERROR', parsedMeta);
          },
        });
        decoder.configure(decoderConfig);

        totalSamples = videoTrack.nb_samples || 0;
        const extractBatch = isHighResOrMobile ? 24 : 60;
        mp4boxfile.setExtractionOptions(videoTrack.id, null, { nbSamples: extractBatch });
        if (audioTrack) {
          mp4boxfile.setExtractionOptions(audioTrack.id, null, { nbSamples: 100 });
        }

        stage = PIPELINE_STAGE.ENCODE;
        mp4boxfile.start();
        readyResolve();
      } catch (err) {
        if (!err.stage) {
          err.stage = stage;
          err.parsedMeta = parsedMeta;
        }
        fatalError = err;
        readyReject(err);
      }
    };

    mp4boxfile.onSamples = (id, user, samples) => {
      if (!samples.length) return;
      const lastSampleNum = samples[samples.length - 1].number;

      if (videoTrack && id === videoTrack.id) {
        for (const s of samples) pendingVideo.push(s);
        mp4boxfile.releaseUsedSamples(videoTrack.id, lastSampleNum);
      } else if (audioTrack && id === audioTrack.id) {
        for (const s of samples) pendingAudio.push(s);
        mp4boxfile.releaseUsedSamples(audioTrack.id, lastSampleNum);
      }
    };

    const drainQueues = async () => {
      while (pendingAudio.length > 0) {
        throwIfAborted(signal);
        if (fatalError) throw fatalError;

        const s = pendingAudio.shift();
        const audioTsScale = s.timescale || audioTrack?.timescale || 1;
        const rawCts = Number.isFinite(s.cts) ? s.cts : (Number.isFinite(s.dts) ? s.dts : 0);
        const rawDur = Number.isFinite(s.duration) && s.duration >= 0 ? s.duration : 0;
        const ts = Math.max(0, Math.round((rawCts * 1_000_000) / audioTsScale) + globalTsOffsetUs);
        const dur = Math.max(0, Math.round((rawDur * 1_000_000) / audioTsScale));

        const meta = !audioMetaSent
          ? {
              decoderConfig: {
                codec: normalizedAudioCodec || audioTrack.codec,
                sampleRate: audioTrack.audio.sample_rate,
                numberOfChannels: audioTrack.audio.channel_count,
                description: audioDescription,
              },
            }
          : undefined;
        audioMetaSent = true;

        muxer.addAudioChunkRaw(s.data, 'key', ts, dur, meta);
      }

      while (pendingVideo.length > 0) {
        await waitForBackpressure({
          decoder,
          encoder,
          maxDecodeQueue,
          maxEncodeQueue,
          useStreamTarget,
          signal,
          getFatalError: () => fatalError,
        });

        const s = pendingVideo.shift();
        const videoTsScale = s.timescale || videoTrack?.timescale || 1;
        const rawCts = Number.isFinite(s.cts) ? s.cts : (Number.isFinite(s.dts) ? s.dts : 0);
        const rawDur = Number.isFinite(s.duration) && s.duration >= 0 ? s.duration : 0;
        const ts = Math.max(0, Math.round((rawCts * 1_000_000) / videoTsScale) + globalTsOffsetUs);
        const dur = Math.max(0, Math.round((rawDur * 1_000_000) / videoTsScale));

        decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: ts,
            duration: dur,
            data: s.data,
          })
        );
      }
    };

    await feedMp4HeadersToMp4Box(file, layout, mp4boxfile, {
      signal,
      onLog: (m) => postWorkerLog(self, jobId, m),
    });

    await readyPromise;

    await feedMp4MdatChunks(file, layout, mp4boxfile, {
      signal,
      onChunkFed: drainQueues,
    });

    throwIfAborted(signal);
    if (fatalError) throw fatalError;

    postWorkerProgress(self, jobId, 96, PIPELINE_STAGE.MUX);
    await decoder.flush();
    await encoder.flush();
    cleanupCodecs();

    if (fatalError) throw fatalError;

    muxer.finalize();
    const elapsedMs = Math.round(performance.now() - startTime);
    const engineLabel = `webcodecs (${usedAcceleration})`;

    if (useStreamTarget) {
      postWorkerProgress(self, jobId, 100, PIPELINE_STAGE.MUX);
      postWorkerDone(self, jobId, {
        streamed: true,
        engine: engineLabel,
        stats: {
          outputBytes: 0,
          elapsedMs,
          width: activePlan.targetWidth,
          height: activePlan.targetHeight,
        },
      });
    } else {
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      postWorkerProgress(self, jobId, 100, PIPELINE_STAGE.MUX);
      postWorkerDone(self, jobId, {
        blob,
        streamed: false,
        engine: engineLabel,
        stats: {
          outputBytes: blob.size,
          elapsedMs,
          width: activePlan.targetWidth,
          height: activePlan.targetHeight,
        },
      });
    }
  } catch (err) {
    cleanupCodecs();
    const errStage =
      err?.name === 'AbortError' || err?.stage === PIPELINE_STAGE.ABORT
        ? PIPELINE_STAGE.ABORT
        : err?.stage || stage;
    postWorkerError(self, jobId, {
      stage: errStage,
      code: err?.code || 'WEBCODECS_FAILED',
      message: err?.message || String(err),
      parsedMeta: err?.parsedMeta || parsedMeta,
    });
  } finally {
    activeJobId = null;
    activeAbortController = null;
    inFlightWrites = 0;
    ackWakeup = null;
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.v !== PROTOCOL_VERSION) return;

  if (msg.type === MAIN_MSG.STREAM_ACK) {
    if (msg.jobId !== activeJobId) return;
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    if (inFlightWrites < MAX_IN_FLIGHT_STREAM_CHUNKS && ackWakeup) {
      const wake = ackWakeup;
      ackWakeup = null;
      wake();
    }
    return;
  }

  if (msg.type === MAIN_MSG.ABORT) {
    if (msg.jobId === activeJobId && activeAbortController) {
      activeAbortController.abort();
      if (ackWakeup) {
        const wake = ackWakeup;
        ackWakeup = null;
        wake();
      }
    }
    return;
  }

  if (msg.type === MAIN_MSG.START) {
    if (activeJobId) {
      postWorkerError(self, msg.jobId, {
        stage: PIPELINE_STAGE.INIT,
        code: 'WORKER_BUSY',
        message: 'Worker 正在處理其他任務',
      });
      return;
    }
    activeJobId = msg.jobId;
    activeAbortController = new AbortController();
    inFlightWrites = 0;
    runCompressionJob(msg.jobId, msg);
  }
});
