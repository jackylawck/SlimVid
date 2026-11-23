# Security Policy & Technical Controls | 資訊安全政策與技術控制說明

## 1. Security Architecture Overview | 安全架構概覽

**English:**  
SlimVid is engineered under a Zero-Trust client-side security model designed to eliminate server-side breach risks, supply-chain tampering, and Cross-Site Scripting (XSS):
* **Strict Content Security Policy (CSP):** Enforces `default-src 'none'` at the top of `<head>`, blocking external scripts, unauthorized network requests, iframes, and `blob:` Workers.
* **Self-Hosted Supply Chain with SHA-256 Integrity:** All third-party dependencies (`mp4box.js`, `mp4-muxer`, `@ffmpeg/ffmpeg`, `@ffmpeg/core`) are bundled locally under `vendor/` and verified against `vendor/CHECKSUMS.sha256` on every CI run.
* **DOM XSS Elimination:** Dynamic UI updates strictly use `textContent` and `createElement`. Static CI scans block `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval()`, `new Function()`, and inline event attributes.
* **Ephemeral Memory Hygiene:** WebCodecs workers terminate immediately after job completion; the optional High-Privacy Mode force-terminates the FFmpeg.wasm worker to wipe the WebAssembly linear memory heap.

**繁體中文：**  
「SlimVid · 片纖瘦」採用零信任（Zero-Trust）純前端安全模型，從架構層面消除伺服器外洩、第三方供應鏈篡改及跨站腳本（XSS）風險：
* **嚴格內容安全政策（CSP）：** 於 `<head>` 首行強制執行 `default-src 'none'`，全面封鎖外部腳本、未授權連線、內嵌框架及 `blob:` Worker。
* **自託管依賴與 SHA-256 完整性校驗：** 所有第三方套件均自託管於同源 `vendor/` 目錄，每次 CI 自動化流程均會比對 `vendor/CHECKSUMS.sha256` 雜湊值並攔截未登記檔案。
* **杜絕 DOM XSS 注入：** 所有介面文字均嚴格透過 `textContent` 與 `createElement` 渲染，CI 靜態掃描會自動阻斷任何 `innerHTML`、`eval()`、`new Function()` 及內聯事件屬性。
* **記憶體即時清理機制：** WebCodecs Worker 於任務完成後即時終止；啟用「高私隱記憶體清理模式」時，FFmpeg.wasm 兜底完成後亦會強制終止 Worker 以清空 Wasm 記憶體堆。

---

## 2. Alignment with ISO/IEC 27001 & ISO/IEC 27701 Principles | 與 ISO/IEC 27001 及 27701 原則之對齊說明

**English:**  
*Disclaimer: SlimVid is an open-source software project and does not hold formal third-party accreditation under ISO/IEC 27001 or ISO/IEC 27701.*  
However, its technical architecture implements controls aligned with key **ISO/IEC 27001:2022 Annex A** and **ISO/IEC 27701** engineering practices:

**繁體中文：**  
*聲明：「SlimVid · 片纖瘦」為開源軟件項目，並未申請或持有任何第三方機構頒發之 ISO/IEC 27001 或 ISO/IEC 27701 正式組織認證。*  
惟本項目在工程設計上直接落實了多項符合 **ISO/IEC 27001:2022 附錄 A** 與 **ISO/IEC 27701** 精神之技術控制措施：

| Control Domain / 控制領域 | Reference / 參考標準條款 | Concrete Implementation / 本項目具體技術落實 |
| :--- | :--- | :--- |
| **Secure Development & Coding**<br>安全開發與安全編碼 | ISO/IEC 27001 A.8.25, A.8.28 | Automated CI static analysis scanning for XSS sinks, inline scripts, and syntax integrity on every commit.<br>每次提交均經 CI 自動掃描 XSS 危險寫法、內聯腳本及語法完整性。 |
| **Supplier & Dependency Integrity**<br>供應鏈與依賴組件完整性 | ISO/IEC 27001 A.5.19, A.5.21 | Exact version pinning in `package.json`, zero external CDN runtime calls, and SHA-256 checksum verification.<br>`package.json` 鎖死精確版本、執行期零外部 CDN 請求及 SHA-256 校驗。 |
| **Data Minimization & Isolation**<br>資料最小化與隔離處理 | ISO/IEC 27701 Clause 7.4 | Client-side sandbox processing with zero server storage; isolated virtual filesystem (`/tmp`) cleanup per job.<br>客戶端沙盒運算且零伺服器留存；每次任務後清理隔離虛擬檔案系統。 |

---

## 3. Reporting a Vulnerability | 安全漏洞回報機制

**English:**  
If you discover a security vulnerability (such as a CSP bypass, XSS vector, or dependency integrity issue), please report it privately via **GitHub Security Advisories** (`Security` tab -> `Report a vulnerability`) rather than opening a public issue. We aim to acknowledge reports within 72 hours.

**繁體中文：**  
如閣下發現任何安全漏洞（例如 CSP 繞過、XSS 風險或依賴組件完整性問題），請透過本倉庫上方 **Security 分頁 → Report a vulnerability** 作私密回報，切勿直接公開張貼於 Issues。我們將於 72 小時內確認並跟進處理。
