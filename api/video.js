const fetch = require('node-fetch');
const crypto = require('crypto');

/**
 * Vercel Serverless function
 * エンドポイント: /stream/:videoId へルーティングされる想定
 * 使用例: GET /stream/UxxajLWwzqY
 *
 * NOTE: 本番では環境変数に API キーを設定してください。
 */

module.exports = async (req, res) => {
  try {
    const videoId = req.query && req.query.id ? String(req.query.id) : null;

    if (!videoId) {
      res.status(400).json({ error: 'video id is required in the URL (e.g. /stream/UxxajLWwzqY)' });
      return;
    }

    // 環境変数優先。未設定の場合はフォールバックとしてここにデフォルト値を置けます。
    // 本番ではデフォルト値を残さず、必ず環境変数を設定することを推奨します。
    const keys = [
      process.env.RAPIDAPI_KEY_1 || '69e2995a79mshcb657184ba6731cp16f684jsn32054a070ba5',
      process.env.RAPIDAPI_KEY_2 || 'ece95806fdmshe322f47bce30060p1c3411jsn41a3d4820039',
      process.env.RAPIDAPI_KEY_3 || '41c9265bc6msha0fa7dfc1a63eabp18bf7cjsne6ef10b79b38'
    ];

    // 等確率でランダムに選択（必要なら重みづけを追加できます）
    const idx = crypto.randomInt(0, keys.length);
    const RAPIDAPI_KEY = keys[idx];

    const host = 'ytstream-download-youtube-videos.p.rapidapi.com';
    const url = `https://${host}/dl?id=${encodeURIComponent(videoId)}`;

    const options = {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': host
      },
      // タイムアウトやリダイレクト設定が必要ならここで調整できます
    };

    const response = await fetch(url, options);

    const status = response.status || 200;
    const contentType = response.headers.get('content-type') || '';

    const bodyText = await response.text();

    if (contentType.includes('application/json')) {
      try {
        const json = JSON.parse(bodyText);
        res.status(status).json(json);
        return;
      } catch (e) {
        // JSON だがパースに失敗した場合はテキストで返す
      }
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(status).send(bodyText);
  } catch (err) {
    console.error('error in /api/video.js:', err);
    res.status(500).json({ error: 'Internal server error', details: String(err) });
  }
};
