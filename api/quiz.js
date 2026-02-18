export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "APIキーがVercel上で設定されていません。" });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  let lastError = null;

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body)
        }
      );

      const data = await response.json();

      if (!response.ok) {
        lastError = data?.error?.message || data?.error || "APIエラー";
        if ((response.status === 429 || lastError.includes('quota') || lastError.includes('Quota')) && model === models[0]) {
          continue;
        }
        console.error("Gemini API Error:", data);
        return res.status(response.status).json({ error: lastError });
      }

      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        lastError = data?.error?.message || "AIからの応答が不正です。";
        return res.status(500).json({ error: lastError });
      }

      return res.status(200).json(data);
    } catch (error) {
      lastError = error.message;
      if (model === models[0]) continue;
      break;
    }
  }

  console.error("Quiz API Error (all models failed):", lastError);
  return res.status(500).json({ error: lastError || "サーバー通信エラーが発生しました。" });
}