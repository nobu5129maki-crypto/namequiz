export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "APIキーがVercel上で設定されていません。" });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.message || data?.error || "APIエラー";
      console.error("Gemini API Error:", data);
      return res.status(response.status).json({ error: msg });
    }

    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      console.error("Gemini API Error Response:", data);
      const msg = data?.error?.message || "AIからの応答が不正です。";
      return res.status(500).json({ error: msg });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error("Quiz API Error:", error);
    return res.status(500).json({ error: error.message || "サーバー通信エラーが発生しました。" });
  }
}