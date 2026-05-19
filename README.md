# Diet

單一 HTML 飲食紀錄工具，使用 Firebase Google 登入與 Firebase Realtime Database 儲存 `users/{uid}/calorieApp`。

## AI 餐點估算：Google Apps Script Gemini 代理層

此專案不使用 Firebase Cloud Functions，也不需要 Node 或 Firebase CLI。前端不保存 Gemini API key；前端只呼叫 Google Apps Script Web App，Apps Script 從 Script Properties 讀取 `GEMINI_API_KEY` 後，再用 `UrlFetchApp` 呼叫 Gemini API。

### 1. 設定 `GEMINI_API_KEY`

1. 開啟 [Google Apps Script](https://script.google.com/) 並建立新專案。
2. 將 `apps-script-gemini-proxy.gs` 的內容貼到 Apps Script 專案中。
3. 在 Apps Script 編輯器左側進入「專案設定」。
4. 找到「指令碼屬性」，新增屬性：
   - 屬性：`GEMINI_API_KEY`
   - 值：你的 Gemini API key
5. 儲存設定。

### 2. 部署 Apps Script Web App

1. 在 Apps Script 編輯器右上角按「部署」→「新增部署作業」。
2. 類型選「網路應用程式」。
3. 「執行身分」選「我」。
4. 「誰可以存取」依你的需求選擇；若此 HTML 會由瀏覽器直接呼叫，通常需要選可讓登入使用者或知道連結者呼叫的選項。
5. 按「部署」，授權 `UrlFetchApp` 與 Script Properties 權限。
6. 複製部署後的 Web App `/exec` URL。

### 3. 前端填入 Apps Script Web App URL

在 `index.html` 找到：

```js
const APPS_SCRIPT_WEB_APP_URL = '';
```

將空字串換成 Apps Script 部署後的 `/exec` URL，例如：

```js
const APPS_SCRIPT_WEB_APP_URL = 'https://script.google.com/macros/s/你的部署ID/exec';
```

### 4. CORS 與 `fetch` 注意事項

前端用 `fetch` 呼叫 Apps Script 時，刻意使用 `Content-Type: text/plain;charset=utf-8` 傳送 JSON 字串，避免 `application/json` 在跨網域 POST 時觸發瀏覽器 CORS preflight。Apps Script 的 `doPost(e)` 仍會把 body 內容用 `JSON.parse` 解析為 JSON。

前端送出的資料包含：

```json
{
  "idToken": "Firebase Auth currentUser.getIdToken()",
  "text": "使用者輸入的餐點描述",
  "date": "目前查看日期",
  "targets": "目前每日目標",
  "todayTotals": "所選日期已攝取總量"
}
```

Apps Script 只回傳 JSON；AI 估算結果只會帶入新增餐點表單，必須由使用者自行按「新增餐點」後才會寫入 Firebase Database。


### 5. 若開啟 `/exec` 顯示「找不到以下指令碼函式：doGet」

這通常不是 API key 問題，而是 **部署版本不是最新**（或 `index.html` 指到舊的 Web App URL）。

請依序檢查：

1. Apps Script 專案內確實有 `doGet()` 與 `doPost()`。
2. 在 Apps Script 按「部署」→「管理部署作業」，對目前部署按「編輯」並建立**新版本**。
3. 重新複製該部署的 `/exec` URL，更新 `index.html` 的 `APPS_SCRIPT_WEB_APP_URL`。
4. 等待 1–2 分鐘再重試（Google 端偶爾有快取延遲）。
5. 用瀏覽器直接開 `/exec`，應看到 JSON（例如 `ok: true`），而不是錯誤頁。

