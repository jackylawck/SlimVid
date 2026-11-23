/**
 * MP4/MOV Top-Level Box Scanner, Gap-Safe Feeder & QuickTime AAC Config Extractor
 * Worker-safe (pure File.slice + DataView + Uint8Array, zero DOM dependency).
 */

const VALID_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);
const PADDING_BOXES = new Set(['free', 'skip', 'wide']);
const MAX_TOP_LEVEL_BOXES = 2000;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const DEFAULT_MOOV_CHUNK_SIZE = 2 * 1024 * 1024;
const DEFAULT_MDAT_CHUNK_SIZE = 4 * 1024 * 1024;

const AAC_SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025, 8000, 7350,
]);

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('壓縮已中止', 'AbortError');
  }
}

function createSkipHeader(offset, boxSize) {
  const is64Bit = boxSize > 0xffffffff;
  const buf = new ArrayBuffer(is64Bit ? 16 : 8);
  const view = new DataView(buf);

  if (is64Bit) {
    view.setUint32(0, 1, false);
    view.setUint32(4, 0x6d646174, false);
    view.setBigUint64(8, BigInt(boxSize), false);
  } else {
    view.setUint32(0, boxSize, false);
    view.setUint32(4, 0x6d646174, false);
  }

  buf.fileStart = offset;
  return buf;
}

function findDescriptorByTag(node, tag, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (node.tag === tag) return node;
  if (Array.isArray(node.descs)) {
    for (const child of node.descs) {
      const found = findDescriptorByTag(child, tag, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findParsedEsd(node, visited = new WeakSet(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6 || visited.has(node)) return null;
  visited.add(node);

  if (node.esds?.esd) return node.esds.esd;
  if (node.esd && typeof node.esd === 'object') return node.esd;

  if (node.wave) {
    const inWave = findParsedEsd(node.wave, visited, depth + 1);
    if (inWave) return inWave;
  }
  if (Array.isArray(node.boxes)) {
    for (const child of node.boxes) {
      const inChild = findParsedEsd(child, visited, depth + 1);
      if (inChild) return inChild;
    }
  }
  return null;
}

function readIsoDescriptorLength(bytes, state) {
  let length = 0;
  let count = 0;
  while (state.offset < bytes.length && count < 4) {
    const b = bytes[state.offset++];
    length = (length << 7) | (b & 0x7f);
    count++;
    if ((b & 0x80) === 0) break;
  }
  return length;
}

function parseEsdsPayload(bytes, start, end) {
  const state = { offset: start + 4 };
  let oti = null;

  while (state.offset < end) {
    const tag = bytes[state.offset++];
    const len = readIsoDescriptorLength(bytes, state);
    const bodyEnd = Math.min(end, state.offset + len);

    if (tag === 0x03) {
      if (state.offset + 3 > bodyEnd) break;
      const flags = bytes[state.offset + 2];
      state.offset += 3;
      if (flags & 0x80) state.offset += 2;
      if (flags & 0x40) {
        if (state.offset >= bodyEnd) break;
        const urlLen = bytes[state.offset++];
        state.offset += urlLen;
      }
      if (flags & 0x20) state.offset += 2;
      continue;
    }

    if (tag === 0x04) {
      if (state.offset + 13 > bodyEnd) break;
      oti = bytes[state.offset];
      state.offset += 13;
      continue;
    }

    if (tag === 0x05) {
      if (bodyEnd - state.offset >= 2) {
        return { oti, asc: bytes.slice(state.offset, bodyEnd) };
      }
      break;
    }

    state.offset = bodyEnd;
  }

  return { oti, asc: null };
}

function scanBytesForEsds(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 4; i + 8 <= bytes.length; i++) {
    // 'esds' = 0x65 0x73 0x64 0x73
    if (
      bytes[i] === 0x65 &&
      bytes[i + 1] === 0x73 &&
      bytes[i + 2] === 0x64 &&
      bytes[i + 3] === 0x73
    ) {
      const boxSize = view.getUint32(i - 4, false);
      const boxEnd = i - 4 + boxSize;
      if (boxSize >= 16 && boxEnd <= bytes.length) {
        const parsed = parseEsdsPayload(bytes, i + 4, boxEnd);
        if (parsed.oti !== null || parsed.asc !== null) {
          return parsed;
        }
      }
    }
  }
  return null;
}

export function buildAacLcAudioSpecificConfig(sampleRate, channelCount) {
  const sr = Number(sampleRate);
  const ch = Number(channelCount);
  if (!Number.isFinite(sr) || sr <= 0 || !Number.isFinite(ch) || ch < 1 || ch > 7) {
    return null;
  }

  let freqIdx = AAC_SAMPLE_RATES.indexOf(Math.round(sr));
  if (freqIdx === -1) {
    let bestIdx = 3; // 預設 48000 Hz
    let bestDiff = Infinity;
    for (let i = 0; i < AAC_SAMPLE_RATES.length; i++) {
      const diff = Math.abs(AAC_SAMPLE_RATES[i] - sr);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    freqIdx = bestIdx;
  }

  const audioObjectType = 2; // AAC-LC
  const byte0 = (audioObjectType << 3) | (freqIdx >> 1);
  const byte1 = ((freqIdx & 1) << 7) | (ch << 3);
  return new Uint8Array([byte0, byte1]);
}

/**
 * 解析 MP4 / Apple QuickTime .MOV 的 AAC 音軌配置（支援標準 esds 與 QuickTime wave->esds）
 */
export function resolveAacAudioConfig(audioTrak, { codec = '', sampleRate = 0, channelCount = 0 } = {}) {
  const isCandidate = codec === 'mp4a' || codec.startsWith('mp4a.40');
  if (!isCandidate) {
    return { isAac: false, codec, description: null };
  }

  const entries = audioTrak?.mdia?.minf?.stbl?.stsd?.entries || [];
  let detectedOti = null;

  for (const entry of entries) {
    const esd = findParsedEsd(entry);
    if (esd) {
      const decCfg = findDescriptorByTag(esd, 0x04);
      if (typeof decCfg?.oti === 'number') {
        detectedOti = decCfg.oti;
      }
      const decSpecific = findDescriptorByTag(esd, 0x05);
      const raw = decSpecific?.data;
      if (raw && raw.length >= 2) {
        if (detectedOti !== null && detectedOti !== 0x40) {
          return { isAac: false, codec, description: null };
        }
        const asc = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        return {
          isAac: true,
          codec: codec === 'mp4a' ? 'mp4a.40.2' : codec,
          description: asc,
        };
      }
    }

    for (const rawSource of [entry?.wave?.data, entry?.data]) {
      if (!rawSource) continue;
      const bytes = rawSource instanceof Uint8Array ? rawSource : new Uint8Array(rawSource);
      const scanned = scanBytesForEsds(bytes);
      if (scanned) {
        if (scanned.oti !== null) detectedOti = scanned.oti;
        if (scanned.oti !== null && scanned.oti !== 0x40) {
          return { isAac: false, codec, description: null };
        }
        if (scanned.asc && scanned.asc.length >= 2) {
          return {
            isAac: true,
            codec: codec === 'mp4a' ? 'mp4a.40.2' : codec,
            description: scanned.asc,
          };
        }
      }
    }
  }

  // 若 QuickTime .MOV 的 mp4a 未攜帶完整 esds 原子，依據採樣率與聲道合成標準 AAC-LC AudioSpecificConfig
  if (codec === 'mp4a' && (detectedOti === null || detectedOti === 0x40)) {
    const fallbackAsc = buildAacLcAudioSpecificConfig(sampleRate, channelCount);
    if (fallbackAsc) {
      return {
        isAac: true,
        codec: 'mp4a.40.2',
        description: fallbackAsc,
      };
    }
  }

  return { isAac: false, codec, description: null };
}

export async function scanMp4TopLevelBoxes(file, { signal } = {}) {
  let offset = 0;
  let boxCount = 0;

  let ftyp = null;
  let moov = null;
  const mdatList = [];
  const boxes = [];

  while (offset + 8 <= file.size) {
    throwIfAborted(signal);

    if (++boxCount > MAX_TOP_LEVEL_BOXES) {
      return { isMp4: false, reason: '頂層 Box 數量異常，疑為畸形檔案' };
    }

    const headerEnd = Math.min(offset + 16, file.size);
    const headerBuf = await file.slice(offset, headerEnd).arrayBuffer();
    if (headerBuf.byteLength < 8) break;

    const view = new DataView(headerBuf);
    const size32 = view.getUint32(0, false);
    const type = String.fromCharCode(
      view.getUint8(4),
      view.getUint8(5),
      view.getUint8(6),
      view.getUint8(7)
    );

    if (offset === 0 && !VALID_FIRST_BOXES.has(type)) {
      return { isMp4: false, reason: `非 MP4/MOV 容器（首個標記為 ${type}）` };
    }

    let boxSize;
    let headerSize = 8;

    if (size32 === 1) {
      if (headerBuf.byteLength < 16) {
        return { isMp4: false, reason: '64-bit Box Header 截斷' };
      }
      const bigSize = view.getBigUint64(8, false);
      if (bigSize < 16n || bigSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { isMp4: false, reason: '64-bit Box 長度無效' };
      }
      boxSize = Number(bigSize);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = file.size - offset;
    } else if (size32 < 8) {
      return { isMp4: false, reason: `Box (${type}) 長度異常：${size32}` };
    } else {
      boxSize = size32;
    }

    const clampedSize = Math.min(boxSize, file.size - offset);
    const boxEntry = { type, offset, size: clampedSize, headerSize };
    boxes.push(boxEntry);

    if (type === 'ftyp' && !ftyp) {
      ftyp = boxEntry;
    } else if (type === 'moov' && !moov) {
      moov = boxEntry;
    } else if (type === 'mdat') {
      mdatList.push(boxEntry);
    }

    offset += clampedSize;
    if (size32 === 0) break;
  }

  if (!moov) {
    return { isMp4: false, reason: '找不到 moov metadata（檔案可能損毀或非標準 MP4）' };
  }
  if (moov.size > MAX_MOOV_BYTES) {
    return { isMp4: false, reason: `moov 體積過大 (${Math.round(moov.size / 1024 / 1024)} MB)` };
  }
  if (mdatList.length === 0) {
    return { isMp4: false, reason: '找不到 mdat 媒體數據區' };
  }

  const isFastStart = moov.offset < mdatList[0].offset;
  return { isMp4: true, isFastStart, ftyp, moov, mdatList, boxes };
}

export async function feedMp4HeadersToMp4Box(
  file,
  layout,
  mp4boxfile,
  { moovChunkSize = DEFAULT_MOOV_CHUNK_SIZE, signal, onLog = () => {} } = {}
) {
  let nextStart = 0;

  for (const box of layout.boxes) {
    throwIfAborted(signal);
    if (box.offset >= layout.moov.offset) break;

    if (box.type === 'mdat') {
      const hdrBuf = await file.slice(box.offset, box.offset + box.headerSize).arrayBuffer();
      hdrBuf.fileStart = box.offset;
      nextStart = mp4boxfile.appendBuffer(hdrBuf);
      continue;
    }

    if (PADDING_BOXES.has(box.type) && box.size > moovChunkSize) {
      onLog(
        `偵測到巨型 ${box.type} gap (${(box.size / 1024 / 1024).toFixed(1)} MB)，啟用零記憶體跳躍`
      );
      const skipBuf = createSkipHeader(box.offset, box.size);
      nextStart = mp4boxfile.appendBuffer(skipBuf);
      continue;
    }

    let cursor = box.offset;
    const end = box.offset + box.size;
    while (cursor < end) {
      throwIfAborted(signal);
      const nextCursor = Math.min(cursor + moovChunkSize, end);
      const buf = await file.slice(cursor, nextCursor).arrayBuffer();
      buf.fileStart = cursor;
      nextStart = mp4boxfile.appendBuffer(buf);
      cursor = nextCursor;
    }
  }

  let moovCursor = layout.moov.offset;
  const moovEnd = layout.moov.offset + layout.moov.size;
  while (moovCursor < moovEnd) {
    throwIfAborted(signal);
    const nextCursor = Math.min(moovCursor + moovChunkSize, moovEnd);
    const buf = await file.slice(moovCursor, nextCursor).arrayBuffer();
    buf.fileStart = moovCursor;
    nextStart = mp4boxfile.appendBuffer(buf);
    moovCursor = nextCursor;
  }

  if (typeof nextStart === 'number' && nextStart < layout.moov.offset) {
    onLog(`警告：mp4box 尚未越過前置區段 (nextStart=${nextStart}, moov=${layout.moov.offset})`);
  }

  return nextStart;
}

export async function feedMp4MdatChunks(
  file,
  layout,
  mp4boxfile,
  {
    mdatChunkSize = DEFAULT_MDAT_CHUNK_SIZE,
    signal,
    onChunkFed = async () => {},
  } = {}
) {
  for (const mdat of layout.mdatList) {
    let cursor = mdat.offset;
    const end = mdat.offset + mdat.size;

    while (cursor < end) {
      throwIfAborted(signal);
      const nextCursor = Math.min(cursor + mdatChunkSize, end);
      const buf = await file.slice(cursor, nextCursor).arrayBuffer();
      buf.fileStart = cursor;
      mp4boxfile.appendBuffer(buf);
      cursor = nextCursor;

      await onChunkFed();
    }
  }

  mp4boxfile.flush();
  await onChunkFed();
}
