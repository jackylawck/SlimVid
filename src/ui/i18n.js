/**
 * Bilingual i18n Module (zh-HK / en)
 * Security: Strictly textContent / setAttribute only, zero HTML tags allowed.
 */

const STORAGE_KEY = 'slimvid_lang_v1';
export const SUPPORTED_LANGS = Object.freeze(['zh-HK', 'en']);

export const DICTIONARY = Object.freeze({
  'zh-HK': Object.freeze({
    pageTitle: 'SlimVid · 片纖瘦 — 100% 本地零上傳影片壓縮器',
    appTitle: 'SlimVid · 片纖瘦',
    appSubtitle: '100% 瀏覽器本地運算，CSP 技術鎖死外部連線，影片絕不上傳任何伺服器。',
    engineProbing: '正在探測瀏覽器加速能力...',
    engineHw: '就緒：WebCodecs 硬件加速 (GPU)',
    engineSw: '就緒：WebCodecs 瀏覽器原生引擎',
    engineFfmpeg: '就緒：FFmpeg.wasm 本地軟件兜底 (上限 150MB)',
    engineNone: '警告：此瀏覽器不支援本地轉碼',
    engineHevcTag: ' · 支援 iPhone HEVC 直解',
    engineFallback: '能力探測完成（預設標準模式）',

    step1Title: '1. 選擇影片',
    dropzoneTitle: '點擊選擇或拖放影片到此處',
    dropzoneMeta: '支援 iPhone MOV / MP4 / WebM / MKV（全程本地處理）',
    iosFilesTip: 'iPhone 貼士：壓縮幾百 MB 大片時，建議先將影片儲存到「檔案 (Files)」App 再選取，可避開相簿系統預轉檔並加快速度。',
    fileMetaSelected: '{sizeMB} MB · {mime}',
    fileTypeDefault: '影片檔案',
    invalidFileType: '不支援的檔案類型（{name}），請選擇影片檔案。',

    step2Title: '2. 壓縮設定（學校 / 平台上限）',
    quickLimitsLabel: '學校 / 常用上限快捷設定：',
    chip20: '20 MB（學校常用）',
    chip25: '25 MB（電郵上限）',
    chip50: '50 MB（eClass）',
    chip100: '100 MB',
    chipUnlimited: '不限（按畫質）',
    presetLabel: '壓縮模式',
    presetHigh: '高畫質（體積約減 30–40%）',
    presetBalanced: '平衡模式（體積約減 50–60%）',
    presetCompact: '極限壓縮（適合功課上傳 / 720p 上限）',
    targetSizeLabel: '目標大小（MB，選填）',
    targetSizePlaceholder: '留空按模式自動壓縮',
    highPrivacyTitle: '高私隱記憶體清理模式',
    highPrivacyDesc: '（FFmpeg 兜底完成後強制終止 Worker 釋放 Wasm Heap，下次壓縮需重載約 10MB 核心）',
    startBtn: '開始壓縮',
    cancelBtn: '中止並釋放記憶體',

    step3Title: '3. 處理進度',
    wakeLockNotice: '壓縮進行中：請保持手機畫面開啟並留在此頁面，切走背景會中斷硬件編碼。',
    statusWaiting: '等待選擇影片',
    statusReady: '準備就緒',
    statusInit: '初始化引擎中...',
    statusCancelled: '已取消',
    statusFailed: '處理失敗',
    statusDoneDisk: '完成（已直接寫入磁碟）',
    statusDone: '壓縮完成',
    stageInit: '初始化中...',
    stageDemux: '解析影片容器...',
    stageDecode: '初始化解碼器...',
    stageEncode: '正在壓縮影片...',
    stageMux: '封裝 MP4 檔案...',
    logTitle: '執行日誌',

    riskBlockedFfmpeg: '檔案大小 ({srcMB} MB) 超過 FFmpeg 兜底安全上限 (150 MB)，建議改用桌面版 Chrome 或 Edge 啟用硬件加速。',
    riskHighMobileOut: '高記憶體風險：預計輸出約 {outMB} MB，行動裝置緩衝有 OOM 風險，建議設定較細目標大小（如 50 MB 以下）。',
    riskHighGeneric: '高記憶體風險：{reason}',
    riskMediumStream: '檔案較大（預計輸出約 {outMB} MB），建議允許選擇存檔位置以啟用零記憶體流式寫盤。',
    riskMediumMobile: '預計輸出約 {outMB} MB，建議壓縮期間保持畫面開啟及留在此頁面。',
    riskLowStream: '已就緒：將使用 WebCodecs 與磁碟流式寫入，記憶體佔用極低。',
    riskLowDefault: '已就緒：預計輸出約 {outMB} MB，本地流式拆包記憶體安全。',

    downloadBtn: '下載壓縮影片 ({sizeMB} MB)',
    resultStreamed: '完成！已流式寫入磁碟：{origMB} MB → {outMB} MB（減少 {savedPct}%，耗時 {sec} 秒，引擎：{engine}）',
    resultSaved: '完成！{origMB} MB → {outMB} MB（節省 {savedPct}%，耗時 {sec} 秒，引擎：{engine}）',
    resultBloatWarn: '完成，但輸出體積 ({outMB} MB) 未比原檔 ({origMB} MB) 更細；原檔可能已高度壓縮，建議保留原檔（耗時 {sec} 秒）。',
    bannerCancelled: '壓縮已中止並釋放記憶體。',

    logAbortSent: '已發送中止指令...',
    logStreamFallback: '未啟用流式寫盤，改以瀏覽器記憶體緩衝輸出。',
    logStart: '開始壓縮：{name} ({sizeMB} MB)',
    logStartTarget: '開始壓縮：{name} ({sizeMB} MB) → 目標 {targetMB} MB',
    logError: '錯誤：{msg}',

    errNoEngine: '此瀏覽器同時不支援 WebCodecs 與 WebAssembly，無法於本地進行影片壓縮。',
    errFileTooLarge: '檔案大小超過 FFmpeg 兜底安全上限 (150 MB)，請改用桌面版 Chrome 或 Edge。',
    errHevcTooLarge: '此裝置無法直接硬件解碼 iPhone HEVC 影片，且檔案超過 150 MB 兜底上限；請改用桌面版 Chrome/Edge 或新款 iPhone Safari。',
    errProtocolMismatch: '頁面版本已更新，請重新整理瀏覽器後再試。',
    errUnknown: '壓縮發生未知錯誤',
  }),

  en: Object.freeze({
    pageTitle: 'SlimVid — 100% Local Zero-Upload Video Compressor',
    appTitle: 'SlimVid',
    appSubtitle: '100% in-browser local compression. Strict CSP blocks external requests so your video never leaves your device.',
    engineProbing: 'Probing browser acceleration capabilities...',
    engineHw: 'Ready: WebCodecs Hardware Acceleration (GPU)',
    engineSw: 'Ready: WebCodecs Native Browser Engine',
    engineFfmpeg: 'Ready: FFmpeg.wasm Local Fallback (150 MB limit)',
    engineNone: 'Warning: This browser does not support local transcoding',
    engineHevcTag: ' · iPhone HEVC Direct Decode',
    engineFallback: 'Capability check complete (Standard Mode)',

    step1Title: '1. Select Video',
    dropzoneTitle: 'Click to choose or drop a video here',
    dropzoneMeta: 'Supports iPhone MOV / MP4 / WebM / MKV (100% local)',
    iosFilesTip: 'iPhone tip: For large videos (hundreds of MB), save to the Files app first to skip Photos pre-conversion and speed up loading.',
    fileMetaSelected: '{sizeMB} MB · {mime}',
    fileTypeDefault: 'Video file',
    invalidFileType: 'Unsupported file type ({name}). Please select a video file.',

    step2Title: '2. Compression Settings (School / Platform Limits)',
    quickLimitsLabel: 'Quick target size presets:',
    chip20: '20 MB (School)',
    chip25: '25 MB (Email)',
    chip50: '50 MB (eClass)',
    chip100: '100 MB',
    chipUnlimited: 'Auto (By Quality)',
    presetLabel: 'Compression Preset',
    presetHigh: 'High Quality (~30-40% smaller)',
    presetBalanced: 'Balanced (~50-60% smaller)',
    presetCompact: 'Compact (Homework upload / 720p cap)',
    targetSizeLabel: 'Target Size (MB, optional)',
    targetSizePlaceholder: 'Leave empty to use preset',
    highPrivacyTitle: 'High-Privacy Memory Wipe Mode',
    highPrivacyDesc: '(Terminates the FFmpeg Worker after fallback to wipe Wasm heap; reloads ~10 MB core next time)',
    startBtn: 'Compress Video',
    cancelBtn: 'Cancel & Free Memory',

    step3Title: '3. Progress',
    wakeLockNotice: 'Compressing: Keep your screen on and stay on this tab. Switching apps pauses hardware encoding.',
    statusWaiting: 'Waiting for video',
    statusReady: 'Ready',
    statusInit: 'Initializing engine...',
    statusCancelled: 'Cancelled',
    statusFailed: 'Failed',
    statusDoneDisk: 'Done (Saved directly to disk)',
    statusDone: 'Compression complete',
    stageInit: 'Initializing...',
    stageDemux: 'Parsing container...',
    stageDecode: 'Configuring decoder...',
    stageEncode: 'Compressing video...',
    stageMux: 'Finalizing MP4...',
    logTitle: 'Activity Log',

    riskBlockedFfmpeg: 'File size ({srcMB} MB) exceeds the 150 MB FFmpeg fallback limit. Please use desktop Chrome or Edge for hardware acceleration.',
    riskHighMobileOut: 'High memory risk: Estimated output is ~{outMB} MB. Consider setting a smaller target size (e.g. under 50 MB) on mobile.',
    riskHighGeneric: 'High memory risk: {reason}',
    riskMediumStream: 'Large output (~{outMB} MB). Allow the save picker when prompted to stream directly to disk with minimal RAM.',
    riskMediumMobile: 'Estimated output is ~{outMB} MB. Keep your screen awake and stay on this tab while compressing.',
    riskLowStream: 'Ready: WebCodecs with direct disk streaming (minimal RAM usage).',
    riskLowDefault: 'Ready: Estimated output ~{outMB} MB via chunked WebCodecs streaming.',

    downloadBtn: 'Download Compressed Video ({sizeMB} MB)',
    resultStreamed: 'Done! Streamed to disk: {origMB} MB → {outMB} MB ({savedPct}% smaller, {sec}s, engine: {engine})',
    resultSaved: 'Done! {origMB} MB → {outMB} MB ({savedPct}% smaller, {sec}s, engine: {engine})',
    resultBloatWarn: 'Done, but output ({outMB} MB) is not smaller than original ({origMB} MB). Your video may already be tightly compressed ({sec}s).',
    bannerCancelled: 'Compression cancelled and memory released.',

    logAbortSent: 'Abort signal sent...',
    logStreamFallback: 'Disk streaming skipped; using in-memory output buffer.',
    logStart: 'Starting: {name} ({sizeMB} MB)',
    logStartTarget: 'Starting: {name} ({sizeMB} MB) → target {targetMB} MB',
    logError: 'Error: {msg}',

    errNoEngine: 'This browser supports neither WebCodecs nor WebAssembly for local compression.',
    errFileTooLarge: 'File exceeds the 150 MB FFmpeg fallback limit. Please use desktop Chrome or Edge.',
    errHevcTooLarge: 'This device cannot hardware-decode iPhone HEVC directly and the file exceeds the 150 MB fallback limit. Use desktop Chrome/Edge or a newer iPhone.',
    errProtocolMismatch: 'App updated in background. Please reload this page and try again.',
    errUnknown: 'An unknown error occurred during compression.',
  }),
});

let currentLang = detectInitialLang();

function detectInitialLang() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (SUPPORTED_LANGS.includes(saved)) return saved;
  } catch (_) {}

  const browserLang = String(globalThis.navigator?.language || '').toLowerCase();
  return browserLang.startsWith('zh') ? 'zh-HK' : 'en';
}

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return currentLang;
  currentLang = lang;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch (_) {}
  return currentLang;
}

export function t(key, vars = null, lang = currentLang) {
  const dict = DICTIONARY[lang] || DICTIONARY['zh-HK'];
  let text = dict[key] ?? DICTIONARY['zh-HK'][key] ?? key;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export function applyDomTranslations(root = document) {
  if (!root) return;
  if (root === document) {
    document.documentElement.lang = currentLang;
    document.title = t('pageTitle');
  }

  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }

  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  }

  for (const btn of root.querySelectorAll('[data-lang]')) {
    const active = btn.getAttribute('data-lang') === currentLang;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}
