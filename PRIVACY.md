# Privacy Policy & Regulatory Compliance Notice | 私隱政策及合規聲明

**Last Updated / 最後更新日期：** 2026-11-23  
**Project / 項目名稱：** SlimVid · 片纖瘦 (`jackylawck/SlimVid`)

---

## 1. Zero-Upload Architecture ("Privacy by Design") | 零上傳架構（「設計即私隱」）

**English:**  
SlimVid is a 100% client-side, serverless web application. All video demuxing, decoding, scaling, and encoding execute strictly within your local browser sandbox using WebCodecs or single-threaded WebAssembly (FFmpeg.wasm). **Your video files, audio tracks, thumbnails, and file metadata are never transmitted to, stored on, or inspected by any server operated by the developer.**

**繁體中文：**  
「SlimVid · 片纖瘦」為 100% 客戶端本地運行、無後端伺服器之網頁工具。所有影片解封裝、解碼、縮放及重新編碼均完全在閣下裝置的瀏覽器沙盒內（透過 WebCodecs 或單線程 WebAssembly）執行。**閣下的影片檔案、音軌、畫面截圖及檔案元數據絕不會被上傳、儲存或傳送至開發者營運的任何伺服器。**

---

## 2. Technical Enforcement (Content Security Policy) | 技術層面強制鎖死外部連線

**English:**  
To provide verifiable technical assurance rather than policy promises alone, this application enforces a strict Content Security Policy (`default-src 'none'; connect-src 'self'; form-action 'none'`) and self-hosts all third-party libraries locally with SHA-256 integrity verification. The browser itself blocks any unauthorized outbound network connection.

**繁體中文：**  
為提供可被技術驗證的私隱保障，本網站強制實施嚴格的內容安全政策（`default-src 'none'; connect-src 'self'; form-action 'none'`），並將所有依賴套件自託管於同源目錄且附帶 SHA-256 校驗。瀏覽器底層會直接攔截任何未經授權的對外網絡連線。

---

## 3. Statutory Privacy Compliance (HK PDPO, EU GDPR, China PIPL) | 法定個人資料私隱合規說明

* **Hong Kong Personal Data (Privacy) Ordinance (Cap. 486) / 香港《個人資料（私隱）條例》（第 486 章）：**  
  The developer does not collect, hold, process, or use any "personal data" as defined under Cap. 486. Because video processing occurs solely on the user's device, no cross-border data transfer occurs.  
  開發者不會收集、持有、處理或使用條例所界定之任何「個人資料」。由於所有影片處理均於用戶本機完成，不涉及任何跨境資料傳輸。

* **EU General Data Protection Regulation (GDPR) / 歐盟《通用數據保障條例》：**  
  Under GDPR principles of Data Minimization (Article 5(1)(c)) and Data Protection by Design (Article 25), the developer acts neither as a Data Controller nor a Data Processor with respect to user media files.  
  依據 GDPR 資料最小化（第 5(1)(c) 條）及設計即私隱（第 25 條）原則，開發者就用戶媒體檔案而言既非資料控制者（Data Controller），亦非資料處理者（Data Processor）。

* **Personal Information Protection Law of the PRC (PIPL) & CAC Regulations / 中國《個人信息保護法》及網信辦相關規範：**  
  SlimVid collects zero personal information, requires no account registration, and conducts no data collection, profiling, or outbound data transmission.  
  本工具不設帳戶註冊、不收集任何個人信息、不進行用戶畫像分析，亦無任何數據出境行為。

---

## 4. Local Browser Storage & Cookies | 本機瀏覽器儲存與 Cookies 說明

**English:**  
SlimVid uses **zero tracking cookies, advertising pixels, or third-party analytics**. It stores only two strictly functional items inside your own browser storage, which never leave your device:
1. `slimvid_lang_v1` (`localStorage`): Remembers your chosen interface language (`zh-HK` or `en`).
2. `ztvc_capabilities_v1` (`sessionStorage`): Caches hardware codec probe results for the current browser tab session to improve startup speed.

**繁體中文：**  
本網站**完全不使用追蹤 Cookies、廣告像素或第三方流量統計工具**。系統僅於閣下的瀏覽器本機儲存兩項純功能性資料，且永不傳離閣下裝置：
1. `slimvid_lang_v1`（`localStorage`）：記住閣下選擇的介面語言（繁體中文或英文）。
2. `ztvc_capabilities_v1`（`sessionStorage`）：暫存當前分頁的瀏覽器硬件編解碼能力探測結果，以加快啟動速度。

---

## 5. Third-Party Static Hosting Infrastructure | 第三方靜態託管基礎設施

**English:**  
This static website is hosted via **GitHub Pages** (GitHub, Inc.). When your browser downloads the static HTML, CSS, and JavaScript assets, GitHub's edge servers may process standard HTTP connection logs (such as IP addresses) strictly for infrastructure delivery and DDoS protection in accordance with the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

**繁體中文：**  
本靜態網頁託管於 **GitHub Pages**（GitHub, Inc.）。當閣下的瀏覽器下載網頁程式碼資源時，GitHub 邊緣伺服器會依其《[GitHub 私隱聲明](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)》處理標準 HTTP 連線日誌（如 IP 位址），僅用於靜態資源分發及網絡防護。

---

## 6. Non-AI & Deterministic Processing Declaration | 非人工智能及確定性運算聲明

**English:**  
SlimVid **does not incorporate, train, deploy, or interface with any Artificial Intelligence (AI), Machine Learning (ML), neural network, generative AI, or algorithmic recommendation system**. Video scaling and bitrate calculation rely exclusively on deterministic mathematical formulas and standardized international multimedia codecs (ISO/IEC 14496-10 H.264 / AAC). Consequently, AI-specific regulatory frameworks—including the **EU AI Act**, **ISO/IEC 42001**, and **CAC Generative AI / Algorithm Recommendation Regulations**—are not applicable to this software.

**繁體中文：**  
「SlimVid · 片纖瘦」**不包含、不訓練、不部署亦不串接任何人工智能（AI）、機器學習（ML）、神經網絡、生成式 AI 或演算法推薦系統**。影片尺寸縮放與碼率計算完全基於確定性數學公式及國際標準多媒體編解碼器（ISO/IEC 14496-10 H.264 / AAC）。因此，針對人工智能之專門監管框架（包括 **EU AI Act 歐盟人工智能法案**、**ISO/IEC 42001** 及**國家網信辦生成式人工智能／算法推薦管理規定**）均不適用於本項目。
