/**
 * 有名人クイズの問題を Gemini で1問生成する API。
 *
 * - プロンプトはサーバー側で組み立てる（以前はクライアントから任意のリクエスト本文を
 *   そのまま Gemini に転送していたため、API キーを使った自由なプロキシになっていた）
 * - 新しいモデルから順に試し、429（無料枠上限）/ 503（混雑）/ 404（提供終了）/ 500 のときは次のモデルへ
 * - 返す JSON は { name, reading, aliases, hint1, hint2, hint3, model }
 */

// 利用するモデルの優先順（2026-09 時点で利用可能なもの）。先頭が上限・混雑なら次へ。
// 2番目は応答が速い lite 系にして、先頭が混雑しているときの待ち時間を短くする。
const MODEL_CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
];

// 1モデルあたりの待ち時間と、関数全体の時間予算（vercel.json の maxDuration より短く）
const PER_MODEL_TIMEOUT_MS = 10000;
const TOTAL_BUDGET_MS = 24000;

const AGE_LABEL = {
  20: '20代（Z世代）',
  30: '30代',
  40: '40代',
  50: '50代以上',
};

const AGE_GUIDE = {
  20: '2010年代後半〜現在に活躍し、20代がよく知っている人（アーティスト、俳優、アイドル、スポーツ選手、YouTuber など）。',
  30: '2000年代〜2010年代に人気の頂点にいた人。ドラマ・音楽・スポーツで30代が青春時代に見ていた人。',
  40: '1990年代〜2000年代に活躍し、40代が学生時代〜社会人初期に見ていた人（ドラマ、J-POP、スポーツ、お笑い）。',
  50: '昭和〜平成初期に活躍した国民的スター（歌謡曲、映画、テレビ、スポーツ、お笑い）。故人でも構いません。',
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: '一般的に使われる表記のフルネーム（芸名可）' },
    reading: { type: 'STRING', description: 'name のひらがな読み（スペースなし）' },
    aliases: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: '別表記・旧姓・本名・カタカナ表記など、正解として認めるべき表記（最大4つ、なければ空配列）',
    },
    hint1: { type: 'STRING', description: '職業や実績。名前を含めない' },
    hint2: { type: 'STRING', description: '代表作・有名なエピソード。名前を含めない' },
    hint3: { type: 'STRING', description: '「『○』から始まる名前です」の形。○は reading の最初の1文字' },
  },
  required: ['name', 'reading', 'hint1', 'hint2', 'hint3'],
};

function buildPrompt(age, exclude) {
  const excluded = exclude.length
    ? `次の人物はすでに出題済みなので選ばないでください：${exclude.join('、')}。`
    : '';
  return [
    `日本の有名人の名前当てクイズを1問作ってください。対象は${AGE_LABEL[age]}向けです。`,
    `人物の選び方：${AGE_GUIDE[age]}`,
    '毎回違う人物になるよう、ジャンル（音楽・俳優・お笑い・スポーツ・文化人）をランダムに選んでください。',
    excluded,
    '条件：',
    '- name は世間で最も使われる表記（漢字・カタカナ・芸名）。',
    '- reading は name のひらがな読み。スペースや記号は入れない。',
    '- aliases には、別の漢字表記・本名・旧姓・カタカナ表記など、正解として認めるべき表記を入れる（なければ空配列）。',
    '- hint1 は職業やジャンルと実績。hint2 は代表作や有名なエピソード。どちらにも本人の名前（姓・名・芸名）を絶対に含めない。',
    '- hint3 は「『あ』から始まる名前です」の形式。「あ」は reading の最初の1文字。',
    '- 事実に正確であること。不確かな情報は書かない。',
  ]
    .filter(Boolean)
    .join('\n');
}

function statusOf(res, data) {
  if (res && typeof res.status === 'number') return res.status;
  const code = data?.error?.code;
  return typeof code === 'number' ? code : 0;
}

function errorMessage(data, fallback) {
  const e = data?.error;
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;
  return fallback;
}

/** 生成結果を検証・整形。おかしければ null */
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? raw['名前'] ?? '').trim();
  if (!name || name.length > 30) return null;
  const reading = String(raw.reading ?? raw['よみ'] ?? '').replace(/\s+/g, '').trim();
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.map((a) => String(a).trim()).filter((a) => a && a !== name).slice(0, 6)
    : [];
  const hint1 = String(raw.hint1 ?? raw['ヒント1'] ?? '').trim();
  const hint2 = String(raw.hint2 ?? raw['ヒント2'] ?? '').trim();
  let hint3 = String(raw.hint3 ?? raw['ヒント3'] ?? '').trim();
  if (!hint1 || !hint2) return null;
  const first = (reading || name).charAt(0);
  if (!hint3 || !hint3.includes(first)) hint3 = `『${first}』から始まる名前です`;

  // ヒントに名前がそのまま出ていたら伏せる（姓・名の分割も試す）
  const parts = [name, ...aliases, reading]
    .flatMap((s) => [s, ...s.split(/[\s　・･]+/)])
    .filter((s) => s && s.length >= 2);
  const mask = (text) =>
    parts.reduce((t, p) => t.split(p).join('○○'), text);

  return { name, reading, aliases, hint1: mask(hint1), hint2: mask(hint2), hint3 };
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'APIキーがVercel上で設定されていません。' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const age = [20, 30, 40, 50].includes(Number(body.age)) ? Number(body.age) : 20;
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.map((s) => String(s).slice(0, 30)).filter(Boolean).slice(0, 30)
    : [];

  const geminiBody = {
    contents: [{ parts: [{ text: buildPrompt(age, exclude) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 1.1,
    },
  };

  let lastStatus = 0;
  let lastError = '';
  const startedAt = Date.now();

  for (const model of MODEL_CANDIDATES) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 3000) break; // 残り時間がなければ打ち切る
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(PER_MODEL_TIMEOUT_MS, remaining));
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody),
          signal: ctrl.signal,
        }
      );
      clearTimeout(timer);

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }

      if (!response.ok) {
        lastStatus = statusOf(response, data);
        lastError = errorMessage(data, `APIエラー (${lastStatus})`);
        const retryable = [429, 503, 500, 404].includes(lastStatus);
        console.warn(`[quiz] model=${model} status=${lastStatus}${retryable ? ' -> 次のモデルで再試行' : ''}`);
        if (retryable) continue;
        return res.status(lastStatus || 502).json({ error: lastError });
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        lastStatus = 502;
        lastError = 'AIからの応答が空でした。';
        console.warn(`[quiz] model=${model} empty response -> 次のモデルで再試行`);
        continue;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      } catch (_) {
        parsed = null;
      }
      const q = normalizeQuestion(parsed);
      if (!q) {
        lastStatus = 502;
        lastError = 'AIの応答を問題として解釈できませんでした。';
        console.warn(`[quiz] model=${model} invalid json -> 次のモデルで再試行`);
        continue;
      }

      return res.status(200).json({ ...q, model });
    } catch (error) {
      lastStatus = error?.name === 'AbortError' ? 504 : 500;
      lastError = error?.name === 'AbortError' ? 'AIの応答がタイムアウトしました。' : error.message;
      console.warn(`[quiz] model=${model} error=${lastError} -> 次のモデルで再試行`);
    }
  }

  console.error('[quiz] all models failed:', lastStatus, lastError);
  if (lastStatus === 429) {
    return res.status(429).json({
      error: 'AIの無料利用枠の上限に達しました。しばらく時間をおいてからもう一度お試しください。',
      code: 'quota',
      raw: lastError,
    });
  }
  if (lastStatus === 503) {
    return res.status(503).json({ error: 'AIが混み合っています。少し待ってからもう一度お試しください。', code: 'overloaded' });
  }
  return res.status(502).json({ error: lastError || 'AIとの通信に失敗しました。', code: 'other' });
}
