/**
 * Google Apps Script Web App: Gemini meal estimation proxy.
 *
 * Required Script Property:
 *   GEMINI_API_KEY = your Gemini API key
 *
 * Deploy as a Web App and paste the /exec URL into APPS_SCRIPT_WEB_APP_URL
 * in index.html. The frontend sends JSON as text/plain to avoid browser CORS
 * preflight requests; this doPost still parses the body as JSON.
 */
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CONFIDENCE_VALUES = ['high', 'medium', 'low'];
const REQUIRED_FIELDS = ['name', 'calories', 'protein', 'carbs', 'fat', 'confidence', 'servingDescription', 'reason', 'warnings'];
const NUTRITION_LABEL_REQUIRED_FIELDS = ['name', 'calories', 'protein', 'carbs', 'fat'];


function doGet() {
  return json_({
    ok: true,
    service: 'gemini-proxy',
    message: 'Web App is reachable. Use POST with text/plain JSON body.'
  });
}

function doPost(e) {
  try {
    const body = parseRequestBody_(e);
    if (body.mode !== 'nutrition_label_image' && (!body.text || typeof body.text !== 'string' || !body.text.trim())) {
      return json_({ ok: false, error: '缺少餐點描述 text。' }, 400);
    }
    if (body.mode === 'nutrition_label_image' && (!body.imageDataUrl || typeof body.imageDataUrl !== 'string')) {
      return json_({ ok: false, error: '缺少營養標示圖片 imageDataUrl。' }, 400);
    }

    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
      return json_({ ok: false, error: 'Apps Script 尚未設定 GEMINI_API_KEY。' }, 500);
    }

    const estimate = body.mode === 'nutrition_label_image'
      ? parseNutritionLabelWithGemini_(apiKey, body)
      : callGemini_(apiKey, body);
    const validationError = body.mode === 'nutrition_label_image'
      ? validateNutritionLabelEstimate_(estimate)
      : validateEstimate_(estimate);
    if (validationError) {
      return json_({ ok: false, error: validationError }, 502);
    }

    return json_({ ok: true, result: estimate });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) }, 500);
  }
}

function parseRequestBody_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
  if (!raw) throw new Error('缺少 JSON request body。');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('JSON request body 解析失敗。');
  }
}

function callGemini_(apiKey, body) {
  const payload = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt_() }]
    },
    contents: [{
      role: 'user',
      parts: [{ text: JSON.stringify({
        text: body.text,
        date: body.date || '',
        targets: body.targets || {},
        todayTotals: body.todayTotals || {}
      }) }]
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          calories: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
          confidence: { type: 'string', enum: CONFIDENCE_VALUES },
          servingDescription: { type: 'string' },
          reason: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } }
        },
        required: REQUIRED_FIELDS
      }
    }
  };

  const response = UrlFetchApp.fetch(GEMINI_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`Gemini API 呼叫失敗（HTTP ${status}）：${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text);
  const candidateText = data && data.candidates && data.candidates[0]
    && data.candidates[0].content && data.candidates[0].content.parts
    && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!candidateText) throw new Error('Gemini API 未回傳可解析的文字結果。');

  try {
    return JSON.parse(candidateText);
  } catch (err) {
    throw new Error('Gemini 回傳內容不是有效 JSON。');
  }
}


function parseNutritionLabelWithGemini_(apiKey, body) {
  const parsed = parseDataUrl_(body.imageDataUrl);
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: buildNutritionLabelPrompt_() },
        {
          inlineData: {
            mimeType: parsed.mimeType,
            data: parsed.base64
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          calories: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' }
        },
        required: NUTRITION_LABEL_REQUIRED_FIELDS
      }
    }
  };

  const response = UrlFetchApp.fetch(GEMINI_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) throw new Error(`Gemini API 呼叫失敗（HTTP ${status}）：${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) throw new Error('Gemini API 未回傳可解析的文字結果。');
  return JSON.parse(candidateText);
}

function parseDataUrl_(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('imageDataUrl 格式錯誤，必須是 base64 Data URL。');
  return { mimeType: match[1], base64: match[2] };
}

function buildNutritionLabelPrompt_() {
  return [
    '請辨識圖片中的商品營養成分表（Nutrition Facts 或營養標示）。',
    '回傳每份（per serving）數值。若同時有每100公克與每份，優先每份。',
    '只回傳 JSON，欄位固定為：name, calories, protein, carbs, fat。',
    '單位：calories(kcal), protein/carbs/fat(g)。無法判讀時估算最合理值且不得為負數。'
  ].join('\n');
}

function validateNutritionLabelEstimate_(estimate) {
  if (!estimate || typeof estimate !== 'object' || Array.isArray(estimate)) return 'Gemini 回傳不是 JSON object。';
  for (const field of NUTRITION_LABEL_REQUIRED_FIELDS) {
    if (!(field in estimate)) return `Gemini 回傳缺少欄位：${field}。`;
  }
  for (const field of ['calories', 'protein', 'carbs', 'fat']) {
    if (typeof estimate[field] !== 'number' || !isFinite(estimate[field]) || estimate[field] < 0) return `${field} 必須是非負數。`;
  }
  if (typeof estimate.name !== 'string') return 'name 必須是字串。';
  return '';
}

function buildSystemPrompt_() {
  return [
    '你是台灣外食營養估算助手。',
    '根據使用者描述估算熱量與三大營養素。',
    '以台灣常見便當、超商、火鍋、酒局份量為基準。',
    '不要假裝精準。資訊不足時 confidence 設為 low。',
    '只回傳 JSON，不要 markdown，不要額外說明。',
    '熱量單位 kcal；蛋白質、碳水、脂肪單位 g。',
    '半碗飯、少飯、無醬汁、去皮、炸物、飲酒等條件都要反映在估算中。',
    '必須回傳欄位：name, calories, protein, carbs, fat, confidence, servingDescription, reason, warnings。',
    'confidence 只能是 high、medium、low。calories/protein/carbs/fat 必須是非負數。',
    'warnings 應列出不確定因素或需要使用者確認的事項；沒有提醒時回傳空陣列。'
  ].join('\n');
}

function validateEstimate_(estimate) {
  if (!estimate || typeof estimate !== 'object' || Array.isArray(estimate)) {
    return 'Gemini 回傳不是 JSON object。';
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in estimate)) return `Gemini 回傳缺少欄位：${field}。`;
  }

  for (const field of ['calories', 'protein', 'carbs', 'fat']) {
    if (typeof estimate[field] !== 'number' || !isFinite(estimate[field]) || estimate[field] < 0) {
      return `${field} 必須是非負數。`;
    }
  }

  if (!CONFIDENCE_VALUES.includes(estimate.confidence)) {
    return 'confidence 只能是 high、medium 或 low。';
  }

  for (const field of ['name', 'servingDescription', 'reason']) {
    if (typeof estimate[field] !== 'string') return `${field} 必須是字串。`;
  }

  if (!Array.isArray(estimate.warnings) || estimate.warnings.some(w => typeof w !== 'string')) {
    return 'warnings 必須是字串陣列。';
  }

  return '';
}

function json_(payload, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
