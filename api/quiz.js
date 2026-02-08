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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      }
    );

    const data = await response.json();

    // デバッグ用：構造が違う場合にエラーを特定しやすくする
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      console.error("Gemini API Error Response:", data);
      return res.status(500).json({ error: "AIからの応答が不正です。APIキーの権限やモデル名を確認してください。" });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "サーバー通信エラーが発生しました。" });
  }
}