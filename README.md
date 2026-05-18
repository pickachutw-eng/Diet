# Diet

Firebase Auth + Realtime Database 飲食紀錄頁面，並透過 Firebase Cloud Functions 安全呼叫 Gemini 進行「AI 餐點估算」。

## AI 餐點估算設定

Gemini API key 不應放在 `index.html` 或 `firebaseConfig`。請將 key 設定到 Cloud Functions secret：

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

部署 Functions 與 Hosting：

```bash
firebase deploy --only functions,hosting
```

預設 Gemini model 是 `gemini-1.5-flash`。如需調整模型，可在 Functions 環境設定 `GEMINI_MODEL`，或修改 `functions/index.js` 的預設值。

前端只會呼叫 callable function `estimateMealFromText`；使用者必須先以 Firebase Auth 登入，Cloud Function 會檢查 `request.auth`，未登入會回傳 `unauthenticated`。
