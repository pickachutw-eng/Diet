import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_ENDPOINT = model => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

const round = value => Math.round((Number(value) || 0) * 10) / 10;
const cleanText = value => String(value || '').trim();
const cleanNumber = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return round(n);
};

function normalizeMetricObject(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    calories: cleanNumber(input.calories) ?? 0,
    protein: cleanNumber(input.protein) ?? 0,
    carbs: cleanNumber(input.carbs) ?? 0,
    fat: cleanNumber(input.fat) ?? 0
  };
}

function extractJsonText(apiResponse) {
  const text = apiResponse?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim();
  if (!text) {
    throw new HttpsError('internal', 'Gemini 未回傳可解析的估算內容。');
  }
  return text;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpsError('internal', 'Gemini 回傳格式不是有效 JSON。');
  }
}

function sanitizeEstimate(raw) {
  const requiredTextFields = ['name', 'servingDescription', 'reason'];
  const missingText = requiredTextFields.filter(field => !cleanText(raw?.[field]));
  const metrics = {
    calories: cleanNumber(raw?.calories),
    protein: cleanNumber(raw?.protein),
    carbs: cleanNumber(raw?.carbs),
    fat: cleanNumber(raw?.fat)
  };
  const missingMetrics = Object.entries(metrics)
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  const confidence = cleanText(raw?.confidence).toLowerCase();

  if (missingText.length || missingMetrics.length || !CONFIDENCE_LEVELS.has(confidence)) {
    throw new HttpsError('internal', 'Gemini 回傳內容不完整，無法安全填入餐點表單。');
  }

  return {
    name: cleanText(raw.name).slice(0, 80),
    calories: metrics.calories,
    protein: metrics.protein,
    carbs: metrics.carbs,
    fat: metrics.fat,
    confidence,
    servingDescription: cleanText(raw.servingDescription).slice(0, 300),
    reason: cleanText(raw.reason).slice(0, 800),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map(warning => cleanText(warning).slice(0, 240)).filter(Boolean).slice(0, 6)
      : []
  };
}

function buildSystemInstruction() {
  return `你是營養估算助手。
你的任務是根據使用者提供的餐點描述，估算熱量與三大營養素。
估算以台灣常見外食份量為基準。
不要假裝精準；如果資訊不足，應回傳 warnings 說明資訊不足。
回傳 JSON，不要 markdown，不要額外文字。
蛋白質、碳水、脂肪單位為 gram。
熱量單位為 kcal。
如果使用者提到「半碗飯」「少飯」「無醬汁」「去皮」「炸物」「飲酒」等，應該反映在估算中。
如果描述太模糊，例如「吃了一點東西」，應回傳 warnings 說明資訊不足。

請嚴格回傳以下 JSON schema，所有欄位都必須存在：
{
  "name": "string",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "confidence": "high" | "medium" | "low",
  "servingDescription": "string",
  "reason": "string",
  "warnings": ["string"]
}`;
}

function buildUserPrompt({ text, date, targets, todayTotals }) {
  return `目前記錄日期：${date}
使用者每日目標：${JSON.stringify(targets)}
該日期已攝取總量：${JSON.stringify(todayTotals)}
使用者餐點描述：${text}`;
}

export const estimateMealFromText = onCall({ secrets: [geminiApiKey], timeoutSeconds: 30 }, async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '請先登入後再使用 AI 餐點估算。');
  }

  const text = cleanText(request.data?.text);
  if (!text) {
    throw new HttpsError('invalid-argument', '請提供餐點描述。');
  }
  if (text.length > 1000) {
    throw new HttpsError('invalid-argument', '餐點描述過長，請縮短到 1000 字以內。');
  }

  const apiKey = geminiApiKey.value() || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new HttpsError('failed-precondition', '尚未設定 GEMINI_API_KEY。');
  }

  const date = cleanText(request.data?.date) || new Date().toISOString().slice(0, 10);
  const targets = normalizeMetricObject(request.data?.targets);
  const todayTotals = normalizeMetricObject(request.data?.todayTotals);

  const payload = {
    systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt({ text, date, targets, todayTotals }) }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          calories: { type: 'NUMBER' },
          protein: { type: 'NUMBER' },
          carbs: { type: 'NUMBER' },
          fat: { type: 'NUMBER' },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          servingDescription: { type: 'STRING' },
          reason: { type: 'STRING' },
          warnings: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['name', 'calories', 'protein', 'carbs', 'fat', 'confidence', 'servingDescription', 'reason', 'warnings']
      }
    }
  };

  const response = await fetch(`${GEMINI_ENDPOINT(MODEL)}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini API error', response.status, errorText.slice(0, 500));
    throw new HttpsError('internal', 'Gemini 估算服務暫時無法使用，請稍後再試。');
  }

  const apiResponse = await response.json();
  const parsed = parseJson(extractJsonText(apiResponse));
  return sanitizeEstimate(parsed);
});
