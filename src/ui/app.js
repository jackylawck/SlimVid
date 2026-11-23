/**
 * XSS-Safe Bilingual UI Controller
 * Rule: Strictly NO HTML injection sinks（只用 textContent / createElement）。
 */

import { CompressionOrchestrator } from '../core/orchestrator.js';
import { assessDeviceRisk, PRESET_PROFILES } from '../core/planner.js';
import { t, setLang, applyDomTranslations } from './i18n.js';

const ALLOWED_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
const STREAM_PICKER_OUTPUT_THRESHOLD = 100 * 1024 * 1024;
const PRESET_CHIP_VALUES = new Set(['20', '25', '50', '100']);

const dom = {
  engineBadge: document.getElementById('engineBadge'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  fileLabel: document.getElementById('fileLabel'),
  fileMeta: document.getElementById('fileMeta'),
  iosFilesTip: document.getElementById('iosFilesTip'),
  riskBanner: document.getElementById('riskBanner'),
  quickSizeGroup: document.getElementById('quickSizeGroup'),
  targetSizeSlider: document.getElementById('targetSizeSlider'),
  sliderValueBadge: document.getElementById('sliderValueBadge'),
  sliderMinLabel: document.getElementById('sliderMinLabel'),
  sliderMidLabel: document.getElementById('sliderMidLabel'),
  sliderMaxLabel: document.getElementById('sliderMaxLabel'),
  presetSelect: document.getElementById('presetSelect'),
  targetSizeInput: document.getElementById('targetSizeInput'),
  highPrivacyToggle: document.getElementById('highPrivacyToggle'),
  startBtn: document.getElementById('startBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  wakeLockNotice: document.getElementById('wakeLockNotice'),
  statusText: document.getElementById('statusText'),
  progressPercent: document.getElementById('progressPercent'),
  progressBar: document.getElementById('progressBar'),
  resultSummary: document.getElementById('resultSummary'),
  downloadArea: document.getElementById('downloadArea'),
  logBox: document.getElementById('logBox'),
};

const orchestrator = new CompressionOrchestrator();

let cachedCapabilities = null;
let selectedFile = null;
let currentDownloadUrl = null;
let activeAbortController = null;
let wakeLockSentinel = null;
let isCompressing = false;

function isSupportedVideoFile(file) {
  if (file.type && file.type.startsWith('video/')) return true;
  if (file.type && file.type !== 'application/octet-stream') return false;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ALLOWED_VIDEO_EXTS.has(ext);
}

function sanitizeDownloadName(rawName) {
  const cleaned = rawName
    .replace(/\.[^/.]+$/, '')
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
    .trim();
  const base = Array.from(cleaned).slice(0, 120).join('');
  return `compressed_${base || 'video'}.mp4`;
}

function getParsedTargetSizeMB() {
  const raw = dom.targetSizeInput.value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function estimatePreFlightOutputBytes(file, preset, targetSizeMB) {
  if (targetSizeMB) return Math.round(targetSizeMB * 1024 * 1024);
  const profile = PRESET_PROFILES[preset] || PRESET_PROFILES.balanced;
  return Math.round(file.size * profile.maxSourceBitrateRatio);
}

function appendLog(message) {
  const line = document.createElement('div');
  line.className = 'log-line';
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `[${time}] ${String(message)}`;
  dom.logBox.appendChild(line);
  dom.logBox.scrollTop = dom.logBox.scrollHeight;
}

function clearLogs() {
  dom.logBox.replaceChildren();
}

function setProgress(percent, statusLabel) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  dom.progressBar.value = clamped;
  dom.progressPercent.textContent = `${clamped}%`;
  if (typeof statusLabel === 'string') {
    dom.statusText.textContent = statusLabel;
  }
}

function showBanner(el, level, message) {
  el.className = 'banner';
  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const levelClass =
    level === 'error' ? 'banner-error' : level === 'ok' ? 'banner-ok' : 'banner-warn';
  el.classList.add(levelClass);
  el.textContent = message;
}

function revokeDownloadUrl() {
  if (currentDownloadUrl) {
    URL.revokeObjectURL(currentDownloadUrl);
    currentDownloadUrl = null;
  }
  dom.downloadArea.replaceChildren();
  dom.downloadArea.classList.add('hidden');
  showBanner(dom.resultSummary, null, '');
}

function renderDownloadButton(blob, originalName) {
  revokeDownloadUrl();
  currentDownloadUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.className = 'btn btn-primary';
  link.href = currentDownloadUrl;
  link.download = sanitizeDownloadName(originalName);

  const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
  link.textContent = t('downloadBtn', { sizeMB });

  dom.downloadArea.appendChild(link);
  dom.downloadArea.classList.remove('hidden');
}

function updateActiveChip(sizeMBValue) {
  const targetStr = sizeMBValue ? String(sizeMBValue) : '';
  const isPresetMatch = PRESET_CHIP_VALUES.has(targetStr);
  const isCustomActive = Boolean(targetStr) && !isPresetMatch;

  for (const btn of dom.quickSizeGroup.querySelectorAll('.chip-btn')) {
    if (btn.dataset.customSize) {
      btn.classList.toggle('is-active', isCustomActive);
    } else {
      btn.classList.toggle('is-active', !isCustomActive && btn.dataset.sizeMb === targetStr);
    }
  }
}

/**
 * 依據已選影片大小動態調整滑桿上下限，方便手機單手微調
 */
function syncSliderBoundsForFile(file) {
  if (!dom.targetSizeSlider) return;

  let min = 2;
  let max = 200;
  let step = 1;

  if (file && file.size > 0) {
    const fileMB = file.size / (1024 * 1024);
    if (fileMB <= 10) {
      min = 1;
      max = Math.max(2, Math.ceil(fileMB));
      step = 0.5;
    } else {
      min = 2;
      max = Math.min(2048, Math.max(10, Math.ceil(fileMB)));
      step = 1;
    }
  }

  dom.targetSizeSlider.min = String(min);
  dom.targetSizeSlider.max = String(max);
  dom.targetSizeSlider.step = String(step);

  const currentVal = Number(dom.targetSizeSlider.value) || min;
  const clamped = Math.min(max, Math.max(min, currentVal));
  dom.targetSizeSlider.value = String(clamped);

  const mid = Math.round((min + max) / 2);
  if (dom.sliderMinLabel) dom.sliderMinLabel.textContent = `${min} MB`;
  if (dom.sliderMidLabel) dom.sliderMidLabel.textContent = `${mid} MB`;
  if (dom.sliderMaxLabel) dom.sliderMaxLabel.textContent = `${max} MB`;
}

/**
 * 同步快捷按鈕、滑桿與數字輸入框狀態
 */
function syncSizeControls(targetMB, { source = 'chip' } = {}) {
  if (targetMB && Number.isFinite(targetMB) && targetMB > 0) {
    if (source !== 'input') {
      dom.targetSizeInput.value = String(targetMB);
    }
    if (source !== 'slider' && dom.targetSizeSlider) {
      const min = Number(dom.targetSizeSlider.min) || 1;
      const max = Number(dom.targetSizeSlider.max) || 200;
      const clamped = Math.min(max, Math.max(min, targetMB));
      dom.targetSizeSlider.value = String(clamped);
    }
    if (dom.sliderValueBadge) {
      dom.sliderValueBadge.textContent = t('sliderActive', { sizeMB: targetMB });
    }
    updateActiveChip(targetMB);
  } else {
    if (source !== 'input') {
      dom.targetSizeInput.value = '';
    }
    if (dom.sliderValueBadge) {
      dom.sliderValueBadge.textContent = t('sliderAuto');
    }
    updateActiveChip('');
  }
}

function renderEngineBadge() {
  if (!dom.engineBadge) return;
  if (!cachedCapabilities) {
    dom.engineBadge.textContent = t('engineProbing');
    return;
  }
  const keyMap = {
    'webcodecs-hw': 'engineHw',
    'webcodecs-sw': 'engineSw',
    ffmpeg: 'engineFfmpeg',
    none: 'engineNone',
  };
  const base = t(keyMap[cachedCapabilities.preferredEngine] || 'engineFallback');
  const hevc = cachedCapabilities.hevcDecoderSupported ? t('engineHevcTag') : '';
  dom.engineBadge.textContent = `${base}${hevc}`;
}

function renderSelectedFileMeta() {
  if (!selectedFile) {
    dom.fileLabel.textContent = t('dropzoneTitle');
    dom.fileMeta.textContent = t('dropzoneMeta');
    return;
  }
  const sizeMB = (selectedFile.size / 1024 / 1024).toFixed(2);
  dom.fileLabel.textContent = selectedFile.name;
  dom.fileMeta.textContent = t('fileMetaSelected', {
    sizeMB,
    mime: selectedFile.type || t('fileTypeDefault'),
  });
}

function formatLocalizedError(err) {
  if (!err) return t('errUnknown');
  switch (err.code) {
    case 'NO_ENGINE_SUPPORTED':
      return t('errNoEngine');
    case 'FILE_TOO_LARGE_FOR_FFMPEG':
      return t('errFileTooLarge');
    case 'HEVC_UNSUPPORTED_LARGE_FILE':
      return t('errHevcTooLarge');
    case 'PROTOCOL_VERSION_MISMATCH':
      return t('errProtocolMismatch');
    default:
      return err.message || t('errUnknown');
  }
}

function refreshPreFlightRisk() {
  if (!selectedFile || !cachedCapabilities) {
    showBanner(dom.riskBanner, null, '');
    return;
  }

  const targetSizeMB = getParsedTargetSizeMB();
  const preset = dom.presetSelect.value;
  const estOutBytes = estimatePreFlightOutputBytes(selectedFile, preset, targetSizeMB);
  const srcMB = (selectedFile.size / 1024 / 1024).toFixed(1);
  const outMB = (estOutBytes / 1024 / 1024).toFixed(1);
  const willPromptStream =
    !cachedCapabilities.isMobile &&
    cachedCapabilities.webCodecsAvailable &&
    cachedCapabilities.hasFileSystemAccess &&
    estOutBytes > STREAM_PICKER_OUTPUT_THRESHOLD;

  const risk = assessDeviceRisk({
    sourceSizeBytes: selectedFile.size,
    estimatedOutputBytes: estOutBytes,
    deviceMemoryGB: cachedCapabilities.deviceMemoryGB,
    isMobile: cachedCapabilities.isMobile,
    webCodecsAvailable: cachedCapabilities.webCodecsAvailable,
    useStreamTarget: willPromptStream,
  });

  if (risk.blocked) {
    showBanner(dom.riskBanner, 'error', t('riskBlockedFfmpeg', { srcMB }));
    dom.startBtn.disabled = true;
    return;
  }

  dom.startBtn.disabled = isCompressing;

  if (risk.estimatedRisk === 'high') {
    const msg = cachedCapabilities.isMobile && cachedCapabilities.webCodecsAvailable
      ? t('riskHighMobileOut', { outMB })
      : t('riskHighGeneric', { reason: risk.reason });
    showBanner(dom.riskBanner, 'error', msg);
  } else if (risk.estimatedRisk === 'medium') {
    const msg = cachedCapabilities.isMobile
      ? t('riskMediumMobile', { outMB })
      : t('riskMediumStream', { outMB });
    showBanner(dom.riskBanner, 'warn', msg);
  } else {
    const msg = willPromptStream ? t('riskLowStream') : t('riskLowDefault', { outMB });
    showBanner(dom.riskBanner, 'ok', msg);
  }
}

function handleFileSelection(file) {
  if (!file) return;
  revokeDownloadUrl();

  if (!isSupportedVideoFile(file)) {
    selectedFile = null;
    syncSliderBoundsForFile(null);
    renderSelectedFileMeta();
    dom.startBtn.disabled = true;
    setProgress(0, t('statusWaiting'));
    showBanner(dom.riskBanner, 'warn', t('invalidFileType', { name: file.type || file.name }));
    return;
  }

  selectedFile = file;
  syncSliderBoundsForFile(file);
  renderSelectedFileMeta();
  dom.startBtn.disabled = false;
  setProgress(0, t('statusReady'));
  refreshPreFlightRisk();
}

function requestWakeLockSync() {
  if (!('wakeLock' in navigator) || !navigator.wakeLock?.request) return;
  navigator.wakeLock
    .request('screen')
    .then((sentinel) => {
      if (!isCompressing) {
        sentinel.release().catch(() => {});
        return;
      }
      wakeLockSentinel = sentinel;
      wakeLockSentinel.addEventListener('release', () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
      });
    })
    .catch(() => {});
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isCompressing && !wakeLockSentinel) {
    requestWakeLockSync();
  }
});

// 雙語切換事件
for (const btn of document.querySelectorAll('[data-lang]')) {
  btn.addEventListener('click', () => {
    setLang(btn.getAttribute('data-lang'));
    applyDomTranslations(document);
    renderEngineBadge();
    renderSelectedFileMeta();
    syncSizeControls(getParsedTargetSizeMB(), { source: 'input' });
    if (!isCompressing) {
      dom.statusText.textContent = selectedFile ? t('statusReady') : t('statusWaiting');
    }
    refreshPreFlightRisk();
  });
}

async function initCapabilities() {
  try {
    cachedCapabilities = await orchestrator.getCapabilities();
    renderEngineBadge();
    if (cachedCapabilities.isIOS) {
      dom.iosFilesTip.classList.remove('hidden');
    }
    refreshPreFlightRisk();
  } catch (_) {
    if (dom.engineBadge) dom.engineBadge.textContent = t('engineFallback');
  }
}

dom.quickSizeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-btn');
  if (!btn) return;

  if (btn.dataset.customSize) {
    const val = Number(dom.targetSizeSlider?.value) || 20;
    dom.presetSelect.value = 'compact';
    syncSizeControls(val, { source: 'chip' });
    dom.targetSizeInput.focus();
    refreshPreFlightRisk();
    return;
  }

  const raw = btn.dataset.sizeMb || '';
  if (raw) {
    dom.presetSelect.value = 'compact';
    syncSizeControls(Number(raw), { source: 'chip' });
  } else {
    syncSizeControls(null, { source: 'chip' });
  }
  refreshPreFlightRisk();
});

dom.targetSizeSlider?.addEventListener('input', () => {
  const val = Number(dom.targetSizeSlider.value);
  if (Number.isFinite(val) && val > 0) {
    dom.presetSelect.value = 'compact';
    syncSizeControls(val, { source: 'slider' });
    refreshPreFlightRisk();
  }
});

dom.targetSizeInput.addEventListener('input', () => {
  const parsed = getParsedTargetSizeMB();
  syncSizeControls(parsed, { source: 'input' });
  refreshPreFlightRisk();
});

dom.presetSelect.addEventListener('change', refreshPreFlightRisk);

dom.fileInput.addEventListener('change', () => {
  const file = dom.fileInput.files?.[0] || null;
  dom.fileInput.value = '';
  handleFileSelection(file);
});

dom.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dom.dropzone.classList.add('is-dragover');
});

dom.dropzone.addEventListener('dragleave', (e) => {
  if (!dom.dropzone.contains(e.relatedTarget)) {
    dom.dropzone.classList.remove('is-dragover');
  }
});

dom.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dom.dropzone.classList.remove('is-dragover');
  handleFileSelection(e.dataTransfer?.files?.[0] || null);
});

dom.cancelBtn.addEventListener('click', () => {
  if (activeAbortController) {
    activeAbortController.abort();
    appendLog(t('logAbortSent'));
  }
});

dom.startBtn.addEventListener('click', async () => {
  if (!selectedFile || isCompressing) return;

  isCompressing = true;
  requestWakeLockSync();

  clearLogs();
  revokeDownloadUrl();
  dom.startBtn.disabled = true;
  dom.cancelBtn.classList.remove('hidden');
  if (cachedCapabilities?.isMobile) {
    dom.wakeLockNotice.classList.remove('hidden');
  }

  activeAbortController = new AbortController();
  const file = selectedFile;
  const preset = dom.presetSelect.value;
  const targetSizeMB = getParsedTargetSizeMB();
  const highPrivacyMode = dom.highPrivacyToggle.checked;

  let writableStream = null;
  let streamCommitted = false;

  try {
    const caps = cachedCapabilities || (await orchestrator.getCapabilities());
    const estOutBytes = estimatePreFlightOutputBytes(file, preset, targetSizeMB);

    const shouldPromptStream =
      !caps.isMobile &&
      caps.webCodecsAvailable &&
      caps.hasFileSystemAccess &&
      estOutBytes > STREAM_PICKER_OUTPUT_THRESHOLD;

    if (shouldPromptStream) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: sanitizeDownloadName(file.name),
          types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writableStream = await handle.createWritable();
      } catch (pickerErr) {
        if (pickerErr.name === 'AbortError') {
          setProgress(0, t('statusCancelled'));
          return;
        }
        appendLog(t('logStreamFallback'));
      }
    }

    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    appendLog(
      targetSizeMB
        ? t('logStartTarget', { name: file.name, sizeMB, targetMB: targetSizeMB })
        : t('logStart', { name: file.name, sizeMB })
    );
    setProgress(1, t('statusInit'));

    const stageKeys = {
      init: 'stageInit',
      demux: 'stageDemux',
      decode: 'stageDecode',
      encode: 'stageEncode',
      mux: 'stageMux',
    };

    const result = await orchestrator.compress(file, {
      preset,
      targetSizeMB,
      highPrivacyMode,
      writableStream,
      signal: activeAbortController.signal,
      onProgress: (pct, stage) => {
        setProgress(pct, t(stageKeys[stage] || 'stageEncode'));
      },
      onLog: appendLog,
    });

    const outBytes = result.stats?.outputBytes || result.blob?.size || 0;
    const origMB = (file.size / 1024 / 1024).toFixed(2);
    const outMB = (outBytes / 1024 / 1024).toFixed(2);
    const savedPct = file.size > 0 ? Math.round((1 - outBytes / file.size) * 100) : 0;
    const sec = ((result.stats?.elapsedMs || 0) / 1000).toFixed(1);

    if (result.streamed) {
      streamCommitted = true;
      setProgress(100, t('statusDoneDisk'));
      showBanner(
        dom.resultSummary,
        'ok',
        t('resultStreamed', { origMB, outMB, savedPct, sec, engine: result.engine })
      );
    } else if (result.blob) {
      setProgress(100, t('statusDone'));
      renderDownloadButton(result.blob, file.name);
      if (outBytes >= file.size) {
        showBanner(dom.resultSummary, 'warn', t('resultBloatWarn', { origMB, outMB, sec }));
      } else {
        showBanner(
          dom.resultSummary,
          'ok',
          t('resultSaved', { origMB, outMB, savedPct, sec, engine: result.engine })
        );
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      setProgress(0, t('statusCancelled'));
      showBanner(dom.riskBanner, 'warn', t('bannerCancelled'));
    } else {
      const msg = formatLocalizedError(err);
      setProgress(0, t('statusFailed'));
      showBanner(dom.riskBanner, 'error', msg);
      appendLog(t('logError', { msg }));
    }
  } finally {
    if (writableStream && !streamCommitted) {
      try {
        await writableStream.abort();
      } catch (_) {}
    }
    isCompressing = false;
    activeAbortController = null;
    releaseWakeLock();
    dom.wakeLockNotice.classList.add('hidden');
    dom.cancelBtn.classList.add('hidden');
    dom.startBtn.disabled = !selectedFile;
  }
});

window.addEventListener('beforeunload', () => {
  revokeDownloadUrl();
  releaseWakeLock();
});

applyDomTranslations(document);
syncSliderBoundsForFile(null);
initCapabilities();
