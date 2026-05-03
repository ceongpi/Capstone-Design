import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');

const ACTION_LABELS = {
  travel_recommendation: '맞춤 이동 추천',
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function buildUserPrompt(action, context) {
  return [
    `작업 유형: ${ACTION_LABELS[action]}`,
    '아래 JSON만 근거로 답변하세요. 데이터에 없는 버스 정보나 외부 실시간 정보는 추정하지 마세요.',
    '사용자 문장을 해석해 가장 적절한 노선과 시간대를 추천하고, 추천 근거를 간결하게 설명하세요.',
    JSON.stringify(context, null, 2),
  ].join('\n\n');
}

function buildSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'summary', 'bullets', 'recommendation', 'caution', 'metrics'],
    properties: {
      headline: { type: 'string' },
      summary: { type: 'string' },
      bullets: {
        type: 'array',
        minItems: 3,
        maxItems: 5,
        items: { type: 'string' },
      },
      recommendation: { type: 'string' },
      caution: { type: 'string' },
      metrics: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'value'],
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
        },
      },
    },
  };
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === 'string' && responseJson.output_text) {
    return responseJson.output_text;
  }

  const collected = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        collected.push(content.text);
      }
    }
  }

  return collected.join('\n');
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const parsed = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadServerEnv(env = process.env) {
  if (env.OPENAI_API_KEY) {
    return env;
  }

  const envBase = parseEnvFile(path.join(FRONTEND_ROOT, '.env'));
  const envLocal = parseEnvFile(path.join(FRONTEND_ROOT, '.env.local'));

  return {
    ...envBase,
    ...envLocal,
    ...env,
  };
}

function formatPercent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function buildMetric(label, value) {
  return { label, value: String(value) };
}

function buildRouteSummary(option) {
  if (!option) {
    return '후보 노선을 찾지 못했습니다.';
  }

  return `${option.routeName}번 ${option.hour}, 출발 혼잡 ${formatPercent(option.originCrowding)}, 노선 평균 ${formatPercent(option.routeCrowding)}`;
}

function createTravelFallback(context, reason) {
  const options = context.routeOptions ?? [];
  const best = options[0] ?? null;
  const second = options[1] ?? null;
  const preferredHour = context.querySignals?.preferredHour?.hour;
  const mentionedStops = context.querySignals?.mentionedStops ?? [];
  const modelName = context.forecast?.model?.name ?? '예측 모델';
  const fallbackNote =
    reason === 'quota'
      ? 'OpenAI API 사용 한도 초과로 규칙 기반 추천으로 전환했습니다.'
      : reason === 'missing_key'
        ? 'OpenAI API 키가 없어 규칙 기반 추천으로 전환했습니다.'
        : 'OpenAI 응답을 사용할 수 없어 규칙 기반 추천으로 전환했습니다.';

  if (!best) {
    return {
      headline: '입력 문장에서 추천 가능한 노선 후보를 찾지 못했습니다.',
      summary: '출발지와 도착지 정류장이 같은 노선 안에서 함께 감지되지 않아 비교를 진행하지 못했습니다.',
      bullets: [
        `감지된 정류장: ${mentionedStops.join(', ') || '없음'}`,
        `희망 시간: ${preferredHour ? `${preferredHour}시대` : '찾지 못함'}`,
        '정류장 이름을 데이터에 있는 표기와 비슷하게 다시 입력하면 후보를 더 잘 찾을 수 있습니다.',
      ],
      recommendation: '출발 정류장과 도착 정류장을 더 구체적으로 적고 다시 추천을 요청하는 편이 좋습니다.',
      caution: `${fallbackNote} 현재 추천은 감지된 정류장 이름과 예측 혼잡도만 기준으로 합니다.`,
      metrics: [
        buildMetric('감지된 정류장 수', mentionedStops.length),
        buildMetric('후보 노선 수', 0),
        buildMetric('모델 기준', modelName),
      ],
    };
  }

  return {
    headline: `${best.routeName}번을 ${best.hour}에 타는 안이 가장 덜 붐비는 후보입니다.`,
    summary: `${best.originStopName}에서 ${best.destinationStopName}까지 이동할 때 현재 계산된 후보 중 ${best.routeName}번 ${best.hour} 조합의 점수가 가장 낮았습니다.`,
    bullets: [
      `최우선 후보: ${buildRouteSummary(best)}`,
      second ? `차선 후보: ${buildRouteSummary(second)}` : '비교 가능한 차선 후보가 충분하지 않았습니다.',
      preferredHour ? `입력 문장에서 감지한 희망 시간은 ${preferredHour}시대이며, 추천 점수에 시간 근접도를 반영했습니다.` : '희망 시간이 명확하지 않아 혼잡도 중심으로 비교했습니다.',
      `감지된 정류장: ${mentionedStops.join(', ') || '없음'}`,
    ],
    recommendation: `${best.originStopName}에서 ${best.hour} 전후에 ${best.routeName}번을 우선 검토하는 편이 좋습니다. 같은 구간에서는 출발 정류장 혼잡도가 더 낮은 후보를 우선했습니다.`,
    caution: `${fallbackNote} 실제 도착 시각, 배차 간격, 환승 시간은 데이터에 포함되지 않았습니다.`,
    metrics: [
      buildMetric('추천 노선', `${best.routeName}번`),
      buildMetric('추천 시간', best.hour),
      buildMetric('출발 정류장 혼잡도', formatPercent(best.originCrowding)),
      buildMetric('노선 평균 혼잡도', formatPercent(best.routeCrowding)),
    ],
  };
}

function createFallbackAnalysis(action, context, reason = 'fallback') {
  if (action === 'travel_recommendation') {
    return createTravelFallback(context, reason);
  }

  throw new Error('지원하지 않는 fallback 분석 요청입니다.');
}

async function callOpenAI({ apiKey, model, action, context }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                '당신은 서울 버스 혼잡 예측 서비스의 추천 에이전트입니다. 사용자의 일정 문장과 후보 노선 데이터를 바탕으로 가장 덜 붐비는 선택지를 추천하고, 예측 데이터라는 한계를 분명히 언급하세요.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildUserPrompt(action, context),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'bus_llm_analysis',
          schema: buildSchema(),
          strict: true,
        },
      },
      max_output_tokens: 900,
    }),
  });

  const json = await response.json();
  if (!response.ok) {
    const message = json.error?.message || 'OpenAI 응답 생성에 실패했습니다.';
    throw new Error(message);
  }

  const text = extractOutputText(json);
  if (!text) {
    throw new Error('OpenAI 응답에서 분석 본문을 찾지 못했습니다.');
  }

  return JSON.parse(text);
}

function shouldUseFallback(error) {
  const message = error?.message || '';
  return /quota|billing|429|rate limit|insufficient_quota|exceeded your current quota|openai_api_key|incorrect api key/i.test(message);
}

export async function handleLlmAnalysis(action, context, env = process.env) {
  const resolvedEnv = loadServerEnv(env);

  if (!ACTION_LABELS[action]) {
    throw new Error('지원하지 않는 LLM 분석 요청입니다.');
  }

  if (!context || typeof context !== 'object') {
    throw new Error('분석 컨텍스트가 비어 있습니다.');
  }

  const apiKey = resolvedEnv.OPENAI_API_KEY;
  const model = resolvedEnv.OPENAI_MODEL || DEFAULT_MODEL;

  if (!apiKey) {
    return {
      mode: action,
      modeLabel: ACTION_LABELS[action],
      model: 'rule-based-fallback',
      fallback: true,
      ...createFallbackAnalysis(action, context, 'missing_key'),
    };
  }

  try {
    const result = await callOpenAI({
      apiKey,
      model,
      action,
      context,
    });

    return {
      mode: action,
      modeLabel: ACTION_LABELS[action],
      model,
      fallback: false,
      ...result,
    };
  } catch (error) {
    if (!shouldUseFallback(error)) {
      throw error;
    }

    return {
      mode: action,
      modeLabel: ACTION_LABELS[action],
      model: 'rule-based-fallback',
      fallback: true,
      ...createFallbackAnalysis(action, context, 'quota'),
    };
  }
}

export async function routeLlmAnalysis(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST만 허용됩니다.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const result = await handleLlmAnalysis(body.action, body.context, process.env);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'LLM 분석 중 오류가 발생했습니다.' });
  }
}
