/**
 * MP4/MOV Top-Level Box Scanner & Gap-Safe Feeder
 */

const VALID_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);
const PADDING_BOXES = new Set(['free', 'skip', 'wide']);
const MAX_TOP_LEVEL_BOXES = 2000;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const DEFAULT_MOOV_CHUNK_SIZE = 2 * 1024 * 1024;
const DEFAULT_MDAT_CHUNK_SIZE = 4 * 1024 * 1024;

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
