export default async function handler(req, res) {
  // Vercelのダッシュボードで設定した GEMINI_API_KEY を取得
  //const apiKey = process.env.GEMINI_API_KEY;
// テスト用：直接キーを書き込んで動くか確認する（※確認後は必ず元に戻すこと！）
const apiKey = "あなたの本物のAPIキーをここに直接貼る";
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
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "AIへのリクエスト中にエラーが発生しました。" });
  }
}