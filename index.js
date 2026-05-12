const express = require("express");
const path = require("path");
const yts = require("youtube-search-api");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const https = require("https");
const fs = require('fs');
const { fetch, Agent } = require('undici');

const app = express();
const port = process.env.PORT || 3000;

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

const API_HEALTH_CHECKER = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const TEMP_API_LIST = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const RAPID_API_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';
const videoCache = new Map();
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0"
];

const keys = [
  process.env.RAPIDAPI_KEY_1 || '69e2995a79mshcb657184ba6731cp16f684jsn32054a070ba5',
  process.env.RAPIDAPI_KEY_2 || 'ece95806fdmshe322f47bce30060p1c3411jsn41a3d4820039',
  process.env.RAPIDAPI_KEY_3 || '41c9265bc6msha0fa7dfc1a63eabp18bf7cjsne6ef10b79b38'
];

const PROXY_DIR = path.join(__dirname, 'proxy');


app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

let apiListCache = [];

async function updateApiListCache() {
  try {
    const response = await fetch(API_HEALTH_CHECKER);
    if (response.ok) {
      const mainApiList = await response.json();
      if (Array.isArray(mainApiList) && mainApiList.length > 0) {
        apiListCache = mainApiList;
        console.log("API List updated.");
      }
    }
  } catch (err) {
    console.error("API update failed.");
  }
}

updateApiListCache();
setInterval(updateApiListCache, 1000 * 60 * 10);

function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
    )
  ]);
}

setInterval(() => {
    const now = Date.now();
    for (const [videoId, cachedItem] of videoCache.entries()) {
        if (cachedItem.expiry < now) {
            videoCache.delete(videoId);
        }
    }
}, 300000);

// ミドルウェア: 人間確認,
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/video") || req.path === "/") {
    if (!req.cookies || req.cookies.humanVerified !== "true") {
      const pages = [
        'https://raw.githubusercontent.com/mino-hobby-pro/memo/refs/heads/main/min-tube-pro-main-loading.txt',
        'https://raw.githubusercontent.com/mino-hobby-pro/memo/refs/heads/main/min-tube-pro-sub-roading-like-command-loader-local.txt'
      ];
      const randomPage = pages[Math.floor(Math.random() * pages.length)];
      try {
        const response = await fetch(randomPage);
        const htmlContent = await response.text();
        return res.render("robots", { content: htmlContent });
      } catch (err) {
        return res.render("robots", { content: "<p>Verification Required</p>" });
      }
    }
  }
  next();
});

// --- API ENDPOINTS ---

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.get("/api/trending", async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  try {
    const trendingSeeds = [
      "人気急上昇", "最新 ニュース", "Music Video Official", 
      "ゲーム実況 人気", "話題の動画", "トレンド", 
      "Breaking News Japan", "Top Hits", "いま話題"
    ];

    const seed1 = trendingSeeds[(page * 2) % trendingSeeds.length];
    const seed2 = trendingSeeds[(page * 2 + 1) % trendingSeeds.length];

    const [res1, res2] = await Promise.all([
      yts.GetListByKeyword(seed1, false, 25),
      yts.GetListByKeyword(seed2, false, 25)
    ]);

    let combined = [...(res1.items || []), ...(res2.items || [])];
    const finalItems = [];
    const seenIdsServer = new Set();

    for (const item of combined) {
      if (item.type === 'video' && !seenIdsServer.has(item.id)) {
        if (item.viewCountText) {
          seenIdsServer.add(item.id);
          finalItems.push(item);
        }
      }
    }

    const result = finalItems.sort(() => 0.5 - Math.random());
    res.json({ items: result });
    
  } catch (err) {
    console.error("Trending API Error:", err);
    res.json({ items: [] });
  }
});


app.get("/api/search", async (req, res, next) => {
  const query = req.query.q;
  const page = req.query.page || 0;
  if (!query) return res.status(400).json({ error: "Query required" });
  try {
    const results = await yts.GetListByKeyword(query, false, 20, page);
    res.json(results);
  } catch (err) { next(err); }
});


app.get("/api/recommendations", async (req, res) => {
  const { title, channel, id } = req.query;
  try {
    const cleanKwd = title
      .replace(/[【】「」()!！?？\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = cleanKwd.split(' ').filter(w => w.length >= 2);
    const mainTopic = words.length > 0 ? words.slice(0, 2).join(' ') : cleanKwd;

    const [topicRes, channelRes, relatedRes] = await Promise.all([
      yts.GetListByKeyword(`${mainTopic}`, false, 12),
      yts.GetListByKeyword(`${channel}`, false, 8),
      yts.GetListByKeyword(`${mainTopic} 関連`, false, 8)
    ]);

    let rawList = [
      ...(topicRes.items || []),
      ...(channelRes.items || []),
      ...(relatedRes.items || [])
    ];

    const seenIds = new Set([id]); 
    const seenNormalizedTitles = new Set();
    const finalItems = [];

    for (const item of rawList) {
      if (!item.id || item.type !== 'video') continue;
      if (seenIds.has(item.id)) continue;

      // タイトルの正規化による「重複内容」の排除
      const normalized = item.title.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/official|lyrics|mv|musicvideo|video|公式|実況|解説/g, '');

      const titleSig = normalized.substring(0, 12);
      if (seenNormalizedTitles.has(titleSig)) continue;

      seenIds.add(item.id);
      seenNormalizedTitles.add(titleSig);
      finalItems.push(item);

      if (finalItems.length >= 24) break; 
    }

    const result = finalItems.sort(() => 0.5 - Math.random());
    res.json({ items: result });
  } catch (err) {
    console.error("Rec Engine Error:", err);
    res.json({ items: [] });
  }
});

app.get("/video/:id", async (req, res, next) => {
const videoId = req.params.id;
try {
let videoData = null;
let commentsData = { commentCount: 0, comments: [] };
let successfulApi = null;

const protocol = req.headers['x-forwarded-proto'] || 'http';
const host = req.headers.host;

for (const apiBase of apiListCache) {
  try {
    videoData = await Promise.any([
      fetchWithTimeout(`${apiBase}/api/video/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject()),
      fetchWithTimeout(`${protocol}://${host}/sia-dl/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject()),

      new Promise((resolve, reject) => {
        setTimeout(() => {
          fetchWithTimeout(`${protocol}://${host}/ai-fetch/${videoId}`, {}, 5000)
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(data => data.stream_url ? resolve(data) : reject())
            .catch(reject);
        }, 2000);
      })
    ]);


    try {
      const cRes = await fetchWithTimeout(`${apiBase}/api/comments/${videoId}`, {}, 3000);
      if (cRes.ok) commentsData = await cRes.json();
    } catch (e) {}

    successfulApi = apiBase;
    break;

  } catch (e) {
    try {
      const rapidRes = await fetchWithTimeout(`${protocol}://${host}/rapid/${videoId}`, {}, 5000);
      if (rapidRes.ok) {
        const rapidData = await rapidRes.json();
        if (rapidData.stream_url) {
          videoData = rapidData;
          
          try {
            const cRes = await fetchWithTimeout(`${apiBase}/api/comments/${videoId}`, {}, 3000);
            if (cRes.ok) commentsData = await cRes.json();
          } catch (e) {}

          successfulApi = apiBase; 
          break; 
        }
      }
    } catch (rapidErr) {}
    continue;
  }
}

if (!videoData) {
  videoData = { videoTitle: "再生できない動画", stream_url: "youtube-nocookie" };
}

console.log(commentsData)
    const isShortForm = videoData.videoTitle.includes('#');

    if (isShortForm) {
const shortsHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${videoData.videoTitle}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; color: #fff; font-family: "Roboto", sans-serif; overflow: hidden; }
        .shorts-wrapper { position: relative; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; background: #000; }
        .video-container { position: relative; height: 94vh; aspect-ratio: 9/16; background: #000; border-radius: 12px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10; }
        @media (max-width: 600px) { .video-container { height: 100%; width: 100%; border-radius: 0; } }
        /* 動画を常に最前面へ */
        video, iframe { width: 100%; height: 100%; object-fit: cover; border: none; position: relative; z-index: 11; visibility: hidden; }
        .progress-container { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 25; }
        .progress-bar { height: 100%; background: #ff0000; width: 0%; transition: width 0.1s linear; }
        .bottom-overlay { position: absolute; bottom: 0; left: 0; width: 100%; padding: 100px 16px 24px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); z-index: 20; pointer-events: none; }
        .bottom-overlay * { pointer-events: auto; }
        .channel-info { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .channel-info img { width: 32px; height: 32px; border-radius: 50%; }
        .channel-name { font-weight: 500; font-size: 15px; }
        .subscribe-btn { background: #fff; color: #000; border: none; padding: 6px 12px; border-radius: 18px; font-size: 12px; font-weight: bold; cursor: pointer; margin-left: 8px; }
        .video-title { font-size: 14px; line-height: 1.4; margin-bottom: 8px; font-weight: 400; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .side-bar { position: absolute; right: 8px; bottom: 80px; display: flex; flex-direction: column; gap: 16px; align-items: center; z-index: 30; }
        .action-btn { display: flex; flex-direction: column; align-items: center; cursor: pointer; }
        .btn-icon { width: 44px; height: 44px; background: rgba(255,255,255,0.12); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: 0.2s; margin-bottom: 4px; }
        .btn-icon:active { transform: scale(0.9); background: rgba(255,255,255,0.25); }
        .action-btn span { font-size: 11px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); font-weight: 400; }
        .swipe-hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.6); padding: 12px 20px; border-radius: 30px; display: flex; align-items: center; gap: 10px; z-index: 50; opacity: 0; pointer-events: none; transition: opacity 0.5s; border: 1px solid rgba(255,255,255,0.2); }
        .swipe-hint.show { opacity: 1; animation: bounce 2s infinite; }
        @keyframes bounce { 0%, 100% { transform: translate(-50%, -50%); } 50% { transform: translate(-50%, -60%); } }
        .comments-panel { position: absolute; bottom: 0; left: 0; width: 100%; height: 70%; background: #181818; border-radius: 16px 16px 0 0; z-index: 40; transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; }
        .comments-panel.open { transform: translateY(0); }
        .comments-header { padding: 16px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
        .comments-body { flex: 1; overflow-y: auto; padding: 16px; }
        .comment-item { display: flex; gap: 12px; margin-bottom: 18px; }
        .comment-avatar { width: 32px; height: 32px; border-radius: 50%; }
        .top-nav { position: absolute; top: 16px; left: 16px; z-index: 35; display: flex; align-items: center; color: white; text-decoration: none; }
        .top-nav i { font-size: 20px; filter: drop-shadow(0 0 4px rgba(0,0,0,0.5)); }
        .loading-screen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 100; display: flex; align-items: center; justify-content: center; opacity: 1; transition: 0.3s; }
        .loading-screen.fade { opacity: 0; pointer-events: none; }
    </style>
</head>
<body>
    <div id="loader" class="loading-screen"><i class="fas fa-circle-notch fa-spin fa-2x"></i></div>
    <div class="shorts-wrapper">
        <div class="video-container">
            <a href="/" class="top-nav"><i class="fas fa-arrow-left"></i></a>
            <div id="swipeHint" class="swipe-hint"><i class="fas fa-hand-pointer"></i><span>下にスワイプして次の動画へ移動</span></div>
            
            ${videoData.stream_url !== "youtube-nocookie" 
                ? `<video id="videoPlayer" data-src="${videoData.stream_url}" loop playsinline></video>` 
                : `<iframe id="videoIframe" data-src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&modestbranding=1&rel=0" allow="autoplay"></iframe>`}
            
            <div class="progress-container"><div id="progressBar" class="progress-bar"></div></div>
            <div class="side-bar">
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-thumbs-up"></i></div><span>${videoData.likeCount || '評価'}</span></div>
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-thumbs-down"></i></div><span>低評価</span></div>
                <div class="action-btn" onclick="toggleComments()"><div class="btn-icon"><i class="fas fa-comment-dots"></i></div><span>${commentsData.commentCount || 0}</span></div>
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-share"></i></div><span>共有</span></div>
                <div class="action-btn"><div class="btn-icon" style="background:none;"><img src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=64&bold=true`}" style="width:30px; height:30px; border-radius:4px; border:2px solid #fff;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=64&bold=true'"></div></div>
            </div>
            <div class="bottom-overlay">
                <div class="channel-info"><img src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=64&bold=true`}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=64&bold=true'"><a href="/channel/${encodeURIComponent(videoData.channelName)}" style="text-decoration:none;color:inherit;"><span class="channel-name">@${videoData.channelName}</span></a><button id="shortSubBtn" class="subscribe-btn" onclick="toggleShortSub()">登録</button></div>
                <div class="video-title">${videoData.videoTitle}</div>
            </div>
            <div id="commentsPanel" class="comments-panel">
                <div class="comments-header"><h3 style="margin:0; font-size:16px;">コメント</h3><i class="fas fa-times" style="cursor:pointer;" onclick="toggleComments()"></i></div>
                <div class="comments-body">
                    ${commentsData.comments.length > 0 ? commentsData.comments.map(c => `<div class="comment-item"><img class="comment-avatar" src="${c.authorThumbnails?.[0]?.url || 'https://via.placeholder.com/32'}"><div><div style="font-size:12px; color:#aaa; font-weight:bold;">${c.author}</div><div style="font-size:14px; margin-top:2px;">${c.content}</div></div></div>`).join('') : '<p style="text-align:center; color:#888;">コメントはありません</p>'}
                </div>
            </div>
        </div>
    </div>
    <script>
        let startY = 0;
        const loader = document.getElementById('loader');
        const commentsPanel = document.getElementById('commentsPanel');
        const swipeHint = document.getElementById('swipeHint');
        const progressBar = document.getElementById('progressBar');

        window.onload = async () => {
            // 設定から保存された再生方法を取得
            const savedMode = localStorage.getItem('playbackMode') || 'googlevideo';

            async function initShortsPlayer() {
                const videoEl = document.getElementById('videoPlayer');
                const iframeEl = document.getElementById('videoIframe');

                if (savedMode === 'youtube-nocookie') {
                    // youtube-nocookie: video要素があればiframeに差し替え
                    const targetIframe = iframeEl || document.createElement('iframe');
                    if (!iframeEl) {
                        targetIframe.id = 'videoIframe';
                        targetIframe.setAttribute('allow', 'autoplay');
                        targetIframe.setAttribute('allowfullscreen', '');
                        targetIframe.style.cssText = 'width:100%; height:100%; object-fit:cover; border:none; position:relative; z-index:11;';
                        if (videoEl) videoEl.replaceWith(targetIframe);
                        else document.querySelector('.video-container').insertBefore(targetIframe, document.querySelector('.progress-container'));
                    }
                    targetIframe.src = \`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&modestbranding=1&rel=0\`;
                    targetIframe.style.visibility = 'visible';

                } else if (savedMode !== 'googlevideo' && videoEl) {
                    // DL-Pro などその他のモード: エンドポイントからURLを取得して再生
                    const endpointMap = { 'DL-Pro': '/360/${videoId}' };
                    const endpoint = endpointMap[savedMode];
                    if (endpoint) {
                        try {
                            const res = await fetch(endpoint);
                            if (res.ok) {
                                const url = await res.text();
                                videoEl.src = url;
                                videoEl.style.visibility = 'visible';
                                videoEl.play().catch(() => {});
                                videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                                return;
                            }
                        } catch (e) {
                            console.warn('ショート: エンドポイント取得失敗、googlevideoにフォールバック', e);
                        }
                    }
                    // フォールバック: googlevideo
                    if (videoEl.dataset.src) {
                        videoEl.src = videoEl.dataset.src;
                        videoEl.style.visibility = 'visible';
                        videoEl.play().catch(() => {});
                        videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                    }

                } else {
                    // デフォルト: googlevideo (またはサーバーがnocookieを返した場合はiframe)
                    if (videoEl && videoEl.dataset.src) {
                        videoEl.src = videoEl.dataset.src;
                        videoEl.style.visibility = 'visible';
                        videoEl.play().catch(() => {});
                        videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                    }
                    if (iframeEl && iframeEl.dataset.src) {
                        iframeEl.src = iframeEl.dataset.src;
                        iframeEl.style.visibility = 'visible';
                    }
                }
            }

            await initShortsPlayer();
            loader.classList.add('fade');
            swipeHint.classList.add('show');
            setTimeout(() => { swipeHint.classList.remove('show'); }, 1500);
        };

        function toggleComments() { commentsPanel.classList.toggle('open'); }
        // チャンネル登録機能（ショート）
        const SHORT_CHANNEL = "${videoData.channelName || ''}";
        const SHORT_SUB_KEY = 'subscribed_' + SHORT_CHANNEL;
        const shortSubBtn = document.getElementById('shortSubBtn');
        function updateShortSubBtn() {
          const isSub = localStorage.getItem(SHORT_SUB_KEY) === 'true';
          shortSubBtn.textContent = isSub ? '登録済み' : '登録';
          shortSubBtn.style.background = isSub ? 'rgba(255,255,255,0.3)' : '#fff';
          shortSubBtn.style.color = isSub ? '#fff' : '#000';
        }
        function toggleShortSub() {
          const isSub = localStorage.getItem(SHORT_SUB_KEY) === 'true';
          if (isSub) localStorage.removeItem(SHORT_SUB_KEY);
          else localStorage.setItem(SHORT_SUB_KEY, 'true');
          updateShortSubBtn();
        }
        updateShortSubBtn();
        async function loadNextShort() {
            if (commentsPanel.classList.contains('open')) return;
            loader.classList.remove('fade');
            try {
                const params = new URLSearchParams({ title: "${videoData.videoTitle}", channel: "${videoData.channelName}", id: "${videoId}" });
                const res = await fetch(\`/api/recommendations?\${params.toString()}\`);
                const data = await res.json();
                const nextShort = data.items.find(item => item.title.includes('#')) || data.items[0];
                if (nextShort) { window.location.href = '/video/' + nextShort.id; } else { window.location.href = '/'; }
            } catch (e) { window.location.href = '/'; }
        }
        window.addEventListener('touchstart', e => startY = e.touches[0].pageY);
        window.addEventListener('touchend', e => { const endY = e.changedTouches[0].pageY; if (startY - endY > 100) loadNextShort(); });
        window.addEventListener('wheel', e => { if (e.deltaY > 50) loadNextShort(); }, { passive: true });
        document.addEventListener('click', (e) => { if (commentsPanel.classList.contains('open') && !commentsPanel.contains(e.target) && !e.target.closest('.action-btn')) { toggleComments(); } });
    </script>
</body>
</html>`;
      return res.send(shortsHtml);
    }

    // --- STANDARD VIDEO MODE HTML ---
    // playerWrapper は空にして、クライアント側JSが localStorage.playbackMode に基づいて初期化する
const streamEmbedPlaceholder = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;"><div class="spinner"></div></div>`;

    const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${videoData.videoTitle} - YouTube Pro</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        :root { --bg-main: #0f0f0f; --bg-secondary: #272727; --bg-hover: #3f3f3f; --text-main: #f1f1f1; --text-sub: #aaaaaa; --yt-red: #ff0000; }
        body { margin: 0; padding: 0; background: var(--bg-main); color: var(--text-main); font-family: "Roboto", "Arial", sans-serif; overflow-x: hidden; }
        .navbar { position: fixed; top: 0; width: 100%; height: 56px; background: var(--bg-main); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; box-sizing: border-box; z-index: 1000; border-bottom: 1px solid #222; }
        .nav-left { display: flex; align-items: center; gap: 16px; }
        .logo { display: flex; align-items: center; color: white; text-decoration: none; font-weight: bold; font-size: 18px; }
        .logo i { color: var(--yt-red); font-size: 24px; margin-right: 4px; }
        .nav-center { flex: 0 1 600px; display: flex; position: relative; }
        .search-bar { display: flex; width: 100%; background: #121212; border: 1px solid #303030; border-radius: 40px 0 0 40px; padding: 0 16px; }
        .search-bar input { width: 100%; background: transparent; border: none; color: white; height: 38px; font-size: 16px; outline: none; }
        .search-btn { background: #222; border: 1px solid #303030; border-left: none; border-radius: 0 40px 40px 0; width: 64px; height: 40px; color: white; cursor: pointer; }
        .autocomplete-dropdown { position: absolute; top: calc(100% + 4px); left: 0; width: calc(100% - 64px); background: #212121; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); z-index: 2000; overflow: hidden; display: none; padding: 12px 0; border: 1px solid #303030; }
        .autocomplete-item { padding: 8px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; color: white; font-size: 16px; }
        .autocomplete-item:hover { background: #3f3f3f; }
        .autocomplete-item i { color: #aaa; font-size: 14px; }
        .container { margin-top: 56px; display: flex; justify-content: center; padding: 24px; gap: 24px; max-width: 1700px; margin-left: auto; margin-right: auto; }
        .main-content { flex: 1; min-width: 0; position: relative; }
        .sidebar { width: 400px; flex-shrink: 0; }
        .player-container { width: 100%; aspect-ratio: 16 / 9; background: black; border-radius: 12px; overflow: hidden; position: relative; z-index: 100; box-shadow: 0 4px 30px rgba(0,0,0,0.7); }
        .video-title { font-size: 20px; font-weight: bold; margin: 12px 0; line-height: 28px; }
        .owner-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .owner-info { display: flex; align-items: center; gap: 12px; }
        .owner-info img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
        .channel-name { font-weight: bold; font-size: 16px; }
        .btn-sub { background: white; color: black; border: none; padding: 0 16px; height: 36px; border-radius: 18px; font-weight: bold; cursor: pointer; }
        .action-btn { background: var(--bg-secondary); border: none; color: white; padding: 0 16px; height: 36px; border-radius: 18px; cursor: pointer; font-size: 14px; }
        .description-box { background: var(--bg-secondary); border-radius: 12px; padding: 12px; font-size: 14px; margin-bottom: 24px; cursor: pointer; transition: background 0.2s; }
        .description-box:hover { background: var(--bg-hover); }
        .description-content { max-height: 60px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; margin-top: 8px; line-height: 1.5; }
        .description-box.expanded .description-content { max-height: none; -webkit-line-clamp: unset; display: block; }
        .description-show-more { font-weight: bold; margin-top: 8px; font-size: 14px; }
        .comment-item { display: flex; gap: 16px; margin-bottom: 20px; }
        .comment-avatar { width: 40px; height: 40px; border-radius: 50%; }
        .comment-author { font-weight: bold; font-size: 13px; margin-bottom: 4px; display: block; }
        .rec-item { display: flex; gap: 8px; margin-bottom: 12px; cursor: pointer; text-decoration: none; color: inherit; }
        .rec-thumb { width: 160px; height: 90px; flex-shrink: 0; border-radius: 8px; overflow: hidden; background: #222; }
        .rec-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .rec-info { display: flex; flex-direction: column; justify-content: flex-start; }
        .rec-title { font-size: 14px; font-weight: bold; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
        .rec-meta { font-size: 12px; color: var(--text-sub); margin-top: 2px; }
        .shorts-shelf-container { margin-top: 24px; border-top: 4px solid var(--bg-secondary); padding-top: 20px; margin-bottom: 24px; }
        .shorts-shelf-title { display: flex; align-items: center; font-size: 18px; font-weight: bold; margin-bottom: 16px; color: white; }
        .shorts-shelf-title svg { margin-right: 8px; width: 24px; height: 24px; }
        .shorts-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .short-card { text-decoration: none; color: inherit; display: block; }
        .short-thumb { aspect-ratio: 9/16; border-radius: 8px; overflow: hidden; background: #222; }
        .short-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .short-info { margin-top: 8px; }
        .short-title { font-size: 14px; font-weight: 500; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .short-views { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
        .server-dropdown-container { position: relative; display: inline-block; margin-left: 12px; }
        .btn-server { background: var(--bg-secondary); color: var(--text-main); border: none; padding: 0 16px; height: 36px; border-radius: 18px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 14px; transition: background 0.2s; }
        .btn-server:hover { background: var(--bg-hover); }
        .server-menu { display: none; position: absolute; top: 100%; left: 0; margin-top: 8px; background: var(--bg-secondary); border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 200; min-width: 220px; border: 1px solid #333; }
        .server-menu.show { display: block; }
        .server-option { padding: 12px 16px; cursor: pointer; font-size: 14px; transition: background 0.2s; display: flex; align-items: center; }
        .server-option:hover { background: var(--bg-hover); }
        .server-option.active { background: #333; border-left: 4px solid var(--yt-red); padding-left: 12px; }
        .video-loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); z-index: 150; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; backdrop-filter: blur(2px); }
        .video-loading-overlay.active { opacity: 1; pointer-events: auto; }
        .spinner { border: 4px solid rgba(255, 255, 255, 0.1); width: 50px; height: 50px; border-radius: 50%; border-top-color: var(--yt-red); animation: spin 1s ease-in-out infinite; margin-bottom: 16px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @media (max-width: 1000px) { .container { flex-direction: column; padding: 0; } .sidebar { width: 100%; padding: 16px; box-sizing: border-box; } .player-container { border-radius: 0; } .main-content { padding: 16px; } }
    </style>
</head>
<body>
<nav class="navbar">
    <div class="nav-left"><a href="/" class="logo"><i class="fab fa-youtube"></i>YouTube Pro</a></div>
    <div class="nav-center">
        <form class="search-bar" action="/nothing/search">
            <input type="text" name="q" id="searchInput" placeholder="検索" autocomplete="off">
            <button type="submit" class="search-btn"><i class="fas fa-search"></i></button>
        </form>
        <div id="autocompleteDropdown" class="autocomplete-dropdown"></div>
    </div>
    <div style="width:100px;"></div>
</nav>

<div class="container">
    <div class="main-content">
        <div class="player-container">
            <div id="playerWrapper" style="width:100%; height:100%;">
                ${streamEmbedPlaceholder}
            </div>
            <div id="videoLoadingOverlay" class="video-loading-overlay">
                <div class="spinner"></div>
                <div style="font-weight: bold; font-size: 16px;">動画サーバーに接続中...</div>
            </div>
        </div>
        <h1 class="video-title">${videoData.videoTitle}</h1>
        <div class="owner-row">
            <div class="owner-info">
                <a href="/channel/${encodeURIComponent(videoData.channelName)}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;">
                  <img id="ownerAvatar" src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=80&bold=true`}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=80&bold=true'">
                  <div class="channel-name">${videoData.channelName}</div>
                </a>
                <button id="subBtn" class="btn-sub" onclick="toggleSubscribeVideo()">チャンネル登録</button>
                <div class="server-dropdown-container">
                    <button class="btn-server" onclick="toggleServerMenu()">
                        <i class="fas fa-server"></i> 動画サーバー <i class="fas fa-chevron-down" style="font-size: 12px; margin-left: 2px;"></i>
                    </button>
                    <div id="serverMenu" class="server-menu">
                        <div class="server-option active" onclick="changeServer('googlevideo', '', event)">Googlevideo</div>
                        <div class="server-option" onclick="changeServer('youtube-nocookie', '/nocookie/${videoId}', event)">Youtube-nocookie</div>
                        <div class="server-option" onclick="changeServer('DL-Pro', '/360/${videoId}', event)">DL-Pro</div>
                        <div class="server-option" onclick="changeServer('YoutubeEdu-Kahoot', '/kahoot-edu/${videoId}', event)">YoutubeEdu-Kahoot</div>
                        <div class="server-option" onclick="changeServer('YoutubeEdu-Scratch', '/scratch-edu/${videoId}', event)">YoutubeEdu-Scratch</div>
                        <div class="server-option" onclick="changeServer('Youtube-Pro', '/pro-stream/${videoId}', event)">Youtube-Pro</div>
                        <div class="server-option" onclick="changeServer('Elixir-Network', '/stream-network/${videoId}', event)">Elixir-Network</div>
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:8px;"><button class="action-btn">👍 ${videoData.likeCount || 0}</button><button class="action-btn">共有</button></div>
        </div>
        <div class="description-box" id="descriptionBox" onclick="toggleDescription(event)">
            <b>${videoData.videoViews || '0'} 回視聴</b>
            <div class="description-content" id="descriptionContent">
                ${(videoData.videoDes || '').replace(/\r\n|\n|\r/g, '<br>')}
            </div>
            <div class="description-show-more" id="descriptionToggleBtn">全文を表示</div>
        </div>
        <div class="comments-section">
            <h3>コメント ${commentsData.commentCount} 件</h3>
            ${commentsData.comments.map(c => `<div class="comment-item"><img class="comment-avatar" src="${c.authorThumbnails?.[0]?.url || ''}"><div><span class="comment-author">${c.author}</span><div style="font-size:14px;">${c.content}</div></div></div>`).join('')}
        </div>
    </div>
    <div class="sidebar">
        <div id="recommendations"></div>
        <div id="shortsShelf" class="shorts-shelf-container" style="display:none;">
            <div class="shorts-shelf-title">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red">
                    <path d="M17.77,10.32l-1.2-.5L18,9.06a3.74,3.74,0,0,0-3.5-6.62L6,6.94a3.74,3.74,0,0,0,.23,6.74l1.2.49L6,14.93a3.75,3.75,0,0,0,3.5,6.63l8.5-4.5a3.74,3.74,0,0,0-.23-6.74Z"/>
                    <polygon points="10 14.65 15 12 10 9.35 10 14.65" fill="#fff"/>
                </svg>
                Shorts
            </div>
            <div id="shortsGrid" class="shorts-grid"></div>
        </div>
    </div>
</div>

<script>
    function toggleServerMenu() { document.getElementById('serverMenu').classList.toggle('show'); }
    window.addEventListener('click', function(e) { if (!e.target.closest('.server-dropdown-container')) { const menu = document.getElementById('serverMenu'); if (menu && menu.classList.contains('show')) menu.classList.remove('show'); } });

    const VIDEO_CHANNEL = ${JSON.stringify(videoData.channelName || '')};
    const SUB_KEY_VIDEO = 'subscribed_' + VIDEO_CHANNEL;
    const subBtn = document.getElementById('subBtn');
    function updateSubBtnUI() {
      const isSub = localStorage.getItem(SUB_KEY_VIDEO) === 'true';
      if (isSub) {
        subBtn.textContent = '登録済み';
        subBtn.style.background = '#272727';
        subBtn.style.color = '#aaa';
      } else {
        subBtn.textContent = 'チャンネル登録';
        subBtn.style.background = 'white';
        subBtn.style.color = 'black';
      }
    }
    function toggleSubscribeVideo() {
      const isSub = localStorage.getItem(SUB_KEY_VIDEO) === 'true';
      if (isSub) {
        localStorage.removeItem(SUB_KEY_VIDEO);
      } else {
        localStorage.setItem(SUB_KEY_VIDEO, 'true');
      }
      updateSubBtnUI();
    }
    updateSubBtnUI();

    async function changeServer(serverName, endpointPath, event) {
        // --- 修正箇所：サーバー名を localStorage に保存 ---
        localStorage.setItem('playbackMode', serverName);

        document.getElementById('serverMenu').classList.remove('show');
        const options = document.querySelectorAll('.server-option');
        options.forEach(opt => opt.classList.remove('active'));
        
        // メニュー上の active 状態を同期
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        } else {
            // 自動起動時などは文字列検索で active を付与
            options.forEach(opt => {
               if (opt.getAttribute('onclick').includes("'" + serverName + "'")) opt.classList.add('active');
            });
        }

        const overlay = document.getElementById('videoLoadingOverlay');
        overlay.classList.add('active');

        try {
            let newUrl = '';
            if (serverName === 'googlevideo') {
                newUrl = "${videoData.stream_url}" === "youtube-nocookie" ? \`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1\` : "${videoData.stream_url}";
            } else if (serverName === 'Youtube-Pro') {
                newUrl = endpointPath;
            } else {
                const res = await fetch(endpointPath);
                if (!res.ok) throw new Error("サーバーエラー");
                newUrl = await res.text();
            }

            const playerContainer = document.getElementById('playerWrapper');
            const forceIframe = ['YoutubeEdu-Kahoot', 'YoutubeEdu-Scratch', 'Youtube-Pro', 'youtube-nocookie', 'Elixir-Network'].includes(serverName);
            const isIframe = forceIframe || newUrl.includes('embed');

            let playerHtml = '';
            if (isIframe) {
                playerHtml = \`<iframe id="mainIframe" src="\${newUrl}" frameborder="0" allowfullscreen style="width:100%; height:100%; position:relative; z-index:10;"></iframe>\`;
            } else {
                playerHtml = \`<video id="mainPlayer" controls autoplay style="width:100%; height:100%; position:relative; z-index:10; background:#000;"><source src="\${newUrl}" type="video/mp4"></video>\`;
            }
            playerContainer.innerHTML = playerHtml;
            const newVideo = document.getElementById('mainPlayer');
            if (newVideo) { 
                newVideo.load(); 
                newVideo.play().catch(e => console.log("Auto")); 

                if (serverName === 'googlevideo' && !window.googlevideoReloaded) {
                    window.googlevideoReloaded = true;
                    setTimeout(() => {
                        const vid = document.getElementById('mainPlayer');
                        if (vid) {
                            const currentTime = vid.currentTime;
                            const isPlaying = !vid.paused;
                            vid.load();
                            vid.currentTime = currentTime;
                            if (isPlaying) vid.play().catch(e => {});
                        }
                    }, 2000);
                }
            }
        } catch (error) { console.error(error); } finally { overlay.classList.remove('active'); }
    }

    async function loadRecommendations() {
        const params = new URLSearchParams({ title: "${videoData.videoTitle}", channel: "${videoData.channelName}", id: "${videoId}" });
        const res = await fetch(\`/api/recommendations?\${params.toString()}\`);
        const data = await res.json();
        const shorts = data.items.filter(item => item.title.includes('#'));
        const regulars = data.items.filter(item => !item.title.includes('#'));
        document.getElementById('recommendations').innerHTML = regulars.map(item => \`
            <a href="/video/\${item.id}" class="rec-item">
                <div class="rec-thumb"><img src="https://i.ytimg.com/vi/\${item.id}/mqdefault.jpg"></div>
                <div class="rec-info">
                    <div class="rec-title">\${item.title}</div>
                    <div class="rec-meta">\${item.channelTitle}</div>
                    <div class="rec-meta">\${item.viewCountText || ''}</div>
                </div>
            </a>
        \`).join('');
        if (shorts.length > 0) {
            const shelf = document.getElementById('shortsShelf');
            const grid = document.getElementById('shortsGrid');
            shelf.style.display = 'block';
            grid.innerHTML = shorts.slice(0, 4).map(item => \`
                <a href="/video/\${item.id}" class="short-card">
                    <div class="short-thumb"><img src="https://i.ytimg.com/vi/\${item.id}/hq720.jpg"></div>
                    <div class="short-info">
                        <div class="short-title">\${item.title}</div>
                        <div class="short-views">\${item.viewCountText || ''}</div>
                    </div>
                </a>
            \`).join('');
        }
    }
    window.onload = () => {
        loadRecommendations();

        // --- 修正箇所：保存された再生方法を即座に反映 ---
        const savedMode = localStorage.getItem('playbackMode') || 'googlevideo';
        const serverEndpoints = {
            'googlevideo':        '',
            'youtube-nocookie':   '/nocookie/${videoId}',
            'DL-Pro':             '/360/${videoId}',
            'YoutubeEdu-Kahoot':  '/kahoot-edu/${videoId}',
            'YoutubeEdu-Scratch': '/scratch-edu/${videoId}',
            'Youtube-Pro':        '/pro-stream/${videoId}',
            'Elixir-Network': '/elixir-stream/${videoId}'
        };
        const serverName = serverEndpoints.hasOwnProperty(savedMode) ? savedMode : 'googlevideo';
        const endpointPath = serverEndpoints[serverName];

        // 初期サーバー選択で起動
        changeServer(serverName, endpointPath, null);
    };

    const searchInput = document.getElementById('searchInput');
    const autocompleteDropdown = document.getElementById('autocompleteDropdown');
    let searchTimeout = null;

    if(searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            if (!query) {
                autocompleteDropdown.style.display = 'none';
                return;
            }
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                const script = document.createElement('script');
                script.src = 'https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=' + encodeURIComponent(query) + '&jsonp=handleAutocomplete';
                document.body.appendChild(script);
            }, 200);
        });
    }

    window.handleAutocomplete = function(data) {
        const suggestions = data[1];
        if (!suggestions || suggestions.length === 0) {
            autocompleteDropdown.style.display = 'none';
            return;
        }
        autocompleteDropdown.innerHTML = suggestions.map(function(s) {
            return '<div class="autocomplete-item" data-query="' + encodeURIComponent(s[0]) + '" onclick="selectSuggestion(this)">' +
                   '<i class="fas fa-search"></i><span>' + s[0] + '</span>' +
                   '</div>';
        }).join('');
        autocompleteDropdown.style.display = 'block';
    };

    window.selectSuggestion = function(el) {
        searchInput.value = decodeURIComponent(el.getAttribute('data-query'));
        autocompleteDropdown.style.display = 'none';
        searchInput.closest('form').submit();
    };

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.nav-center')) {
            if(autocompleteDropdown) autocompleteDropdown.style.display = 'none';
        }
    });

    function toggleDescription(e) {
        if(e && e.target.tagName === 'A') return;
        const box = document.getElementById('descriptionBox');
        const btn = document.getElementById('descriptionToggleBtn');
        if (box.classList.contains('expanded')) {
            box.classList.remove('expanded');
            btn.textContent = '全文を表示';
        } else {
            box.classList.add('expanded');
            btn.textContent = '一部を表示';
        }
    }
</script>
</body>
</html>
    `;
    res.send(html);
  } catch (err) { next(err); }
});

app.get("/nothing/*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.post("/api/save-history", express.json(), (req, res) => {
  res.json({ success: true });
});
app.get('/rapid/:id', async (req, res) => {
  const videoId = req.params.id;
  const selectedKey = keys[Math.floor(Math.random() * keys.length)];

  const url = `https://${RAPID_API_HOST}/dl?id=${videoId}`;
  const options = {
    method: 'GET',
    headers: {
      'x-rapidapi-key': selectedKey,
      'x-rapidapi-host': RAPID_API_HOST,
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (data.status !== "OK") {
      return res.status(400).json({ error: "Failed to fetch video data" });
    }

    // --- 多分取得できないから消してもいい ---
    let channelImageUrl = data.channelThumbnail?.[0]?.url || data.author?.thumbnails?.[0]?.url;

    // 2. アバターURLを作成
    if (!channelImageUrl) {
      const name = encodeURIComponent(data.channelTitle || 'Youtube Channel');
      // UI Avatars を使用
      channelImageUrl = `https://ui-avatars.com/api/?name=${name}&background=random&color=fff&size=128`;
    }

    const highResStream = data.adaptiveFormats?.find(f => f.qualityLabel === '1080p') || data.adaptiveFormats?.[0];
    const audioStream = data.adaptiveFormats?.find(f => f.mimeType.includes('audio')) || data.adaptiveFormats?.[data.adaptiveFormats?.length - 1];

    const formattedResponse = {
      stream_url: data.formats?.[0]?.url || "",
      highstreamUrl: highResStream?.url || "",
      audioUrl: audioStream?.url || "",
      videoId: data.id,
      channelId: data.channelId,
      channelName: data.channelTitle,
      channelImage: channelImageUrl, 
      videoTitle: data.title,
      videoDes: data.description,
      videoViews: parseInt(data.viewCount) || 0,
      likeCount: data.likeCount || 0
    };

    res.json(formattedResponse);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


app.get('/streams', (req, res) => {
    const cacheData = Object.fromEntries(videoCache);
    res.json(cacheData);
});
app.get('/360/:videoId',async(req,res)=>{const videoId=req.params.videoId;const now=Date.now();const cachedItem=videoCache.get(videoId);if(cachedItem&&cachedItem.expiry>now){return res.type('text/plain').send(cachedItem.url);}const _0x1a=[0x79,0x85,0x85,0x81,0x84,0x4b,0x40,0x40,0x78,0x76,0x85,0x7d,0x72,0x85,0x76,0x3f,0x75,0x76,0x87,0x40,0x72,0x81,0x7a,0x40,0x85,0x80,0x80,0x7d,0x84,0x40,0x8a,0x80,0x86,0x85,0x86,0x73,0x76,0x3e,0x7d,0x7a,0x87,0x76,0x3e,0x75,0x80,0x88,0x7f,0x7d,0x80,0x72,0x75,0x76,0x83,0x50,0x86,0x83,0x7d,0x4e,0x79,0x85,0x85,0x81,0x84,0x36,0x44,0x52,0x36,0x43,0x57,0x36,0x43,0x57,0x88,0x88,0x88,0x3f,0x8a,0x80,0x86,0x85,0x86,0x73,0x76,0x3f,0x74,0x80,0x7e,0x36,0x43,0x57,0x88,0x72,0x85,0x74,0x79,0x36,0x44,0x57,0x87,0x36,0x44,0x55];const _0x2b=[0x37,0x77,0x80,0x83,0x7e,0x72,0x85,0x5a,0x75,0x4e,0x43];const _0x11=['\x6d\x61\x70','\x66\x72\x6f\x6d\x43\x68\x61\x72\x43\x6f\x64\x65','\x6a\x6f\x69\x6e'];const _0x4d=_0x1a[_0x11[0]](_0x5e=>String[_0x11[1]](_0x5e-0x11))[_0x11[2]]('');const _0x5e=_0x2b[_0x11[0]](_0x6f=>String[_0x11[1]](_0x6f-0x11))[_0x11[2]]('');const targetUrl=_0x4d+videoId+_0x5e;try{const response=await fetch(targetUrl,{method:'GET',headers:{"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"},redirect:'follow'});const finalUrl=response.url;videoCache.set(videoId,{url:finalUrl,expiry:now+60000});res.type('text/plain').send(finalUrl);}catch(error){console.error('Error:',error);res.status(500).send('Internal Server Error');}});
app.get('/scratch-edu/:id', async (req, res) => {
  const id = req.params.id;

  const configUrl = 'https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json';
  const configRes = await fetch(configUrl);
  const configJson = await configRes.json();
  const params = configJson.params; 

  const url = `https://www.youtubeeducation.com/embed/${id}${params}`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});


app.get('/kahoot-edu/:id', async (req, res) => {
  const id = req.params.id;

  const paramUrl = 'https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/1.txt';
  const response = await fetch(paramUrl);
  const params = await response.text(); 

  const url = `https://www.youtubeeducation.com/embed/${id}${params}`;

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});


app.get('/nocookie/:id', (req, res) => {
  const id = req.params.id;
  const url = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});

app.get('/pro-stream/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pro Stream — ${videoId}</title>
<style>
  :root{--bg:#000814;--accent:#00e5ff;--muted:#9fb6c8}
  html,body{height:100%;margin:0;background:radial-gradient(ellipse at center, rgba(0,8,20,1) 0%, rgba(0,4,10,1) 70%);font-family:Inter,system-ui,Roboto,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif;color:#e6f7ff}
  .stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .frame{position:relative;width:100%;height:100%;background:#000;overflow:hidden}
  .layer{position:absolute;inset:0;transition:opacity .8s cubic-bezier(.2,.9,.2,1), transform .8s;display:flex;align-items:center;justify-content:center}
  .layer iframe{width:100%;height:100%;border:0;display:block}
  .layer.inactive{opacity:0;transform:scale(1.02);pointer-events:none}
  .layer.active{opacity:1;transform:scale(1);pointer-events:auto}
  .hud{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:80;display:flex;flex-direction:column;align-items:center;gap:14px;backdrop-filter:blur(6px)}
  .card{min-width:360px;max-width:88vw;padding:18px 20px;border-radius:14px;background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.35));box-shadow:0 10px 40px rgba(0,0,0,0.6);color:#dff9ff}
  .title{font-size:18px;font-weight:700;color:var(--accent);letter-spacing:0.6px}
  .status{margin-top:8px;font-size:14px;font-weight:600}
  .sub{margin-top:6px;font-size:13px;color:var(--muted);line-height:1.4}
  .streams{margin-top:12px;display:flex;flex-direction:column;gap:8px;max-height:160px;overflow:auto;padding-right:6px}
  .stream-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);font-size:13px}
  .stream-item.ok{border-left:4px solid #2ee6a7}
  .stream-item.fail{opacity:0.6;border-left:4px solid #ff6b6b}
  .progress{height:6px;background:rgba(255,255,255,0.04);border-radius:6px;overflow:hidden;margin-top:10px}
  .bar{height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#2ee6a7)}
  .btn{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#dff9ff;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600}
  .btn.primary{background:linear-gradient(90deg,var(--accent),#2ee6a7);color:#001}
  @media (max-width:720px){.card{min-width:300px;padding:14px}.title{font-size:16px}}
</style>
</head>
<body>
<div class="stage">
  <div class="frame" id="frame"></div>

  <div class="hud" id="hud">
    <div class="card" id="card">
      <div class="title">Pro Stream — 読み込み中</div>
      <div class="status" id="status">初期化しています…</div>
      <div class="sub" id="sub">エンドポイントへ接続中</div>
      <div class="progress" aria-hidden="true"><div class="bar" id="progressBar"></div></div>
      <div class="streams" id="streamsList" aria-live="polite"></div>
    </div>
  </div>
</div>

<script>
const VIDEO_ID = ${JSON.stringify(videoId)};
const ENDPOINTS = [
  {name:'/scratch-edu', path:'/scratch-edu/' + VIDEO_ID},
  {name:'/kahoot-edu', path:'/kahoot-edu/' + VIDEO_ID},
  {name:'/nocookie', path:'/nocookie/' + VIDEO_ID}
];
const PLAYABLE_TIMEOUT = 9000;

const frame = document.getElementById('frame');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');
const subEl = document.getElementById('sub');
const streamsList = document.getElementById('streamsList');
const progressBar = document.getElementById('progressBar');

let layers = [];
let activeIndex = 0;
let globalMuted = true;

function setStatus(main, sub){ statusEl.textContent = main; subEl.textContent = sub || ''; }
function setProgress(p){ progressBar.style.width = Math.max(0, Math.min(1,p)) * 100 + '%'; }
function upsertStreamRow(name, url, state, note){
  let el = document.querySelector('[data-stream="'+name+'"]');
  if(!el){
    el = document.createElement('div');
    el.className = 'stream-item';
    el.dataset.stream = name;
    el.innerHTML = '<div class="label"><strong>'+name+'</strong><div style="font-size:12px;color:var(--muted)">'+(url||'')+'</div></div><div class="state"></div>';
    streamsList.appendChild(el);
  }
  el.querySelector('.state').textContent = note || (state === 'ok' ? '取得済' : '失敗');
  el.classList.toggle('ok', state === 'ok');
  el.classList.toggle('fail', state !== 'ok');
}

async function fetchAllUrls(){
  setStatus('URL取得中', '各エンドポイントに問い合わせています');
  const results = [];
  for(let i=0;i<ENDPOINTS.length;i++){
    const ep = ENDPOINTS[i];
    upsertStreamRow(ep.name, '', 'pending', '問い合わせ中');
    try{
      const res = await fetch(ep.path, {cache:'no-store'});
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const text = (await res.text()).trim();
      if(text){
        results.push({name:ep.name, url:text, ok:true});
        upsertStreamRow(ep.name, text, 'ok', 'URL取得');
      } else {
        results.push({name:ep.name, url:null, ok:false});
        upsertStreamRow(ep.name, '', 'fail', '空のレスポンス');
      }
    }catch(err){
      results.push({name:ep.name, url:null, ok:false});
      upsertStreamRow(ep.name, '', 'fail', err.message || '取得失敗');
    }
    setProgress((i+1)/ENDPOINTS.length * 0.4);
  }
  return results;
}

function createLayer(name, url, idx){
  const layer = document.createElement('div');
  layer.className = 'layer inactive';
  layer.style.zIndex = 10 + idx;
  layer.dataset.name = name;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('allow','autoplay; fullscreen; picture-in-picture');
  iframe.setAttribute('allowfullscreen','');

  try {
    const u = new URL(url, location.href);
    if(!u.searchParams.has('autoplay')) u.searchParams.set('autoplay','1');
    if(!u.searchParams.has('mute')) u.searchParams.set('mute','1');
    iframe.src = u.toString();
  } catch(e) {
    iframe.src = url + (url.includes('?') ? '&' : '?') + 'autoplay=1&mute=1';
  }

  layer.appendChild(iframe);
  frame.appendChild(layer);
  return {name, url, el:layer, iframe, state:'init', ok:false};
}

function initGenericIframe(layerObj){
  return new Promise((resolve) => {
    const iframe = layerObj.iframe;
    let resolved = false;
    const onLoad = () => {
      if(resolved) return;
      resolved = true;
      layerObj.state = 'loaded';
      layerObj.ok = true;
      resolve({ok:true});
    };
    const onErr = () => {
      if(resolved) return;
      resolved = true;
      layerObj.state = 'error';
      layerObj.ok = false;
      resolve({ok:false});
    };
    iframe.addEventListener('load', onLoad, {once:true});
    setTimeout(()=>{ if(!resolved) onErr(); }, PLAYABLE_TIMEOUT);
  });
}

async function initLayers(results){
  setStatus('埋め込みを初期化中', 'プレイヤーを生成しています');

  const valid = results.filter(r => r.ok && r.url);

  if(valid.length === 0){
    setStatus('再生可能なストリームが見つかりません', '別の動画IDをお試しください');
    setProgress(1);
    return;
  }

  setStatus('埋め込み候補を検査中', '最初に再生可能なストリームを一つだけ選択します');
  setProgress(0.4);

  let chosen = null;
  for(let i=0;i<valid.length;i++){
    const r = valid[i];
    upsertStreamRow(r.name, r.url, 'pending', '埋め込み生成（試行）');
    const obj = createLayer(r.name, r.url, 0);
    const check = await initGenericIframe(obj);
    if(check && check.ok){
      chosen = obj;
      upsertStreamRow(r.name, r.url, 'ok', 'ロード完了（採用）');
      break;
    } else {
      try{ obj.el.remove(); }catch(e){}
      upsertStreamRow(r.name, r.url, 'fail', '埋め込み失敗');
    }
    setProgress(0.4 + (i+1)/valid.length * 0.2);
  }

  if(!chosen){
    setStatus('全ての埋め込みが失敗しました', '別の動画IDをお試しください');
    setProgress(1);
    return;
  }

  valid.forEach(v => {
    const el = document.querySelector('[data-stream="'+v.name+'"]');
    if(el && el.classList.contains('ok') === false){
      el.querySelector('.state').textContent = '未採用';
      el.classList.remove('ok');
      el.classList.add('fail');
    }
  });

  layers = [chosen];
  activeIndex = 0;
  updateLayerVisibility();
  setProgress(0.85);
  setStatus('自動再生を試行中', 'ミュートで再生を開始します');

  try{ chosen.iframe.focus(); }catch(e){}

  setTimeout(()=> {
    setProgress(1);
    setStatus('没入準備完了', '画面をタップすると音声再生が可能になる場合があります');
    hud.style.transition = 'opacity .8s ease';
    hud.style.opacity = '0';
    setTimeout(()=> { hud.style.display = 'none'; }, 900);
  }, 900);
}

function updateLayerVisibility(){
  layers.forEach((l,i) => {
    if(i === activeIndex){ l.el.classList.remove('inactive'); l.el.classList.add('active'); }
    else { l.el.classList.remove('active'); l.el.classList.add('inactive'); }
  });
}

function showNext(){
  if(layers.length <= 1) return;
  activeIndex = (activeIndex + 1) % layers.length;
  updateLayerVisibility();
}

function toggleMute(){
  globalMuted = !globalMuted;
  layers.forEach(l => {
    try{ l.iframe.contentWindow.postMessage(JSON.stringify({event:'command',func: globalMuted ? 'mute' : 'unMute', args:[]}), '*'); }catch(e){}
    try{ l.iframe.muted = globalMuted; }catch(e){}
  });
}

function enterImmersive(){
  const el = document.documentElement;
  if(el.requestFullscreen) el.requestFullscreen();
  else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

(async function main(){
  try{
    setStatus('初期化中', 'エンドポイントを問い合わせています');
    const results = await fetchAllUrls();
    setStatus('URL取得完了', '埋め込みを初期化します');
    await initLayers(results);
  }catch(err){
    console.error(err);
    setStatus('エラーが発生しました', String(err));
  }
})();

frame.addEventListener('click', ()=> {
  if(hud.style.display !== 'none'){
    hud.style.display = 'none';
    layers.forEach(l => { try{ l.iframe.focus(); }catch(e){} });
  } else {
    showNext();
  }
});
</script>
</body>
</html>`);
});

app.get('/sia-dl/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const protocol = req.protocol;
    const host = req.get('host');

    try {
        const metadataUrl = `https://siawaseok.duckdns.org/api/video2/${videoId}?depth=1`;
        const metaResponse = await fetch(metadataUrl);
        if (!metaResponse.ok) throw new Error('Metadata API response was not ok');
        const data = await metaResponse.json();

        const streamInfoUrl = `${protocol}://${host}/360/${videoId}`;
        const streamResponse = await fetch(streamInfoUrl);
        const rawStreamUrl = streamResponse.ok ? await streamResponse.text() : "";

        const parseCount = (str) => {
            if (!str) return 0;
            return parseInt(str.replace(/[^0-9]/g, '')) || 0;
        };

        const formattedResponse = {
            stream_url: rawStreamUrl.trim(),
            highstreamUrl: rawStreamUrl.trim(), 
            audioUrl: "", 
            
            videoId: data.id,
            channelId: data.author?.id || "",
            channelName: data.author?.name || "",
            channelImage: data.author?.thumbnail || "",
            videoTitle: data.title,
            videoDes: data.description?.text || "",
            
            videoViews: parseCount(data.views || data.extended_stats?.views_original),
            
            likeCount: parseCount(data.likes)
        };

        res.json(formattedResponse);

    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

app.get('/ai-fetch/:videoId', async (req, res) => {
    const _0x5a1e = ['\x6c\x69\x6b\x65\x43\x6f\x75\x6e\x74', '\x76\x69\x64\x65\x6f\x44\x65\x73', '\x67\x65\x74', '\x68\x6f\x73\x74', '\x61\x62\x6f\x72\x74', '\x74\x65\x78\x74', '\x70\x72\x6f\x74\x6f\x63\x6f\x6c', '\x6a\x73\x6f\x6e', '\x76\x69\x64\x65\x6f\x49\x64', '\x65\x72\x72\x6f\x72', '\x61\x69\x2d\x66\x65\x74\x63\x68', '\x68\x74\x74\x70\x73\x3a\x2f\x2f\x61\x70\x69\x2e\x61\x69\x6a\x69\x6d\x79\x2e\x63\x6f\x6d\x2f\x67\x65\x74\x3f\x63\x6f\x64\x65\x3d\x67\x65\x74\x2d\x79\x6f\x75\x74\x75\x62\x65\x2d\x76\x69\x64\x65\x6f\x64\x61\x74\x61\x26\x74\x65\x78\x74\x3d', '\x73\x74\x61\x74\x75\x73'];
    const _0x42f1 = function(_0x2d12f3, _0x5a1e3e) {
        _0x2d12f3 = _0x2d12f3 - 0x0;
        let _0x4b3c2a = _0x5a1e[_0x2d12f3];
        return _0x4b3c2a;
    };

    const videoId = req.params[_0x42f1('0x8')];
    
    const _0x1f22a1 = (function(_0x33e1a) {
        return _0x33e1a.split('').reverse().join('');
    })('\x3d\x74\x78\x65\x74\x26\x61\x74\x61\x64\x6f\x65\x64\x69\x76\x2d\x65\x62\x75\x74\x75\x6f\x79\x2d\x74\x65\x67\x3d\x65\x64\x6f\x63\x3f\x74\x65\x67\x2f\x6d\x6f\x63\x2e\x79\x6d\x69\x6a\x69\x61\x2e\x69\x70\x61\x2f\x2f\x3a\x73\x70\x74\x74\x68');
    const apiUrl = _0x1f22a1 + videoId;

    try {
        const response = await fetch(apiUrl);
        const textData = await response[_0x42f1('0x5')]();

        const descriptionMatch = textData.match(/概要欄:\s*([\s\S]*?)\s*公開日:/);
        const viewsMatch = textData.match(/再生回数:\s*(\d+)/);
        const likesMatch = textData.match(/高評価数:\s*(\d+)/);

        const videoDes = descriptionMatch ? descriptionMatch[1].trim() : "";
        const videoViews = viewsMatch ? parseInt(viewsMatch[1]) : 0;
        const likeCount = likesMatch ? parseInt(likesMatch[1]) : 0;

        let videoTitle = videoId; 
        let channelName = videoId;
        let found = false;

        try {
            const noEmbedRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            if (noEmbedRes.ok) {
                const noEmbedData = await noEmbedRes.json();
                if (noEmbedData && !noEmbedData.error) {
                    videoTitle = noEmbedData.title || videoId;
                    channelName = noEmbedData.author_name || videoId;
                    found = true;
                }
            }
        } catch (noEmbedErr) {

        }

        if (!found) {
            try {
                let page = 0;
                while (page < 10 && !found) {
                    const searchResults = await yts.GetListByKeyword(videoId, false, 20, page);
                    if (searchResults && searchResults.items && searchResults.items.length > 0) {
                        const matchedVideo = searchResults.items.find(item => item.id === videoId);
                        if (matchedVideo) {
                            videoTitle = matchedVideo.title || videoId;
                            channelName = (matchedVideo.author && matchedVideo.author.name) ? matchedVideo.author.name : videoId;
                            found = true;
                        }
                    } else {
                        break;
                    }
                    page++;
                }
            } catch (searchErr) {
                console.error("Search API Error:", searchErr);
            }
        }

        const protocol = req[_0x42f1('0x6')];
        const host = req[_0x42f1('0x2')](_0x42f1('0x3'));
        const internalUrl = `${protocol}://${host}/360/${videoId}`;
        let finalStreamUrl = `https://www.youtube-nocookie.com/embed/${videoId}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller[_0x42f1('0x4')](), 3000); 

            const internalRes = await fetch(internalUrl, { signal: controller.signal });
            if (internalRes.ok) {
                const rawText = await internalRes[_0x42f1('0x5')]();
                if (rawText && rawText.trim() !== "") {
                    finalStreamUrl = rawText.trim(); 
                }
            }
            clearTimeout(timeoutId);
        } catch (err) {
        }

        const formattedResponse = {
            stream_url: finalStreamUrl,
            highstreamUrl: finalStreamUrl,
            audioUrl: finalStreamUrl,
            videoId: videoId,
            channelId: "", 
            channelName: channelName, 
            channelImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(channelName)}&background=random&color=fff&size=128`,
            videoTitle: videoTitle, 
            videoDes: videoDes,
            videoViews: videoViews,
            likeCount: likeCount
        };

        res[_0x42f1('0x7')](formattedResponse);

    } catch (error) {
        console.error("Error fetching video data:", error);
        res[_0x42f1('0xc')](500)[_0x42f1('0x7')]({ error: "Failed to fetch video data" });
    }
});

app.get("/youtube-pro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "min-tube-pro.html"));
});

app.get("/min-img.png", (req, res) => {
  const filePath = path.join(__dirname, "img", "min-tube-pro.png");
  res.sendFile(filePath);
});

app.get("/helios", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/helios.html"));
});

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat/chat.html"));
});

app.get("/nautilus-os", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/NautilusOS.html"));
});

app.get("/unblockers", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/search.html"));
});

app.get("/labo5", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/html-tube.html"));
});

app.get("/ai", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/ai.html"));
});

app.get("/dl-pro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/study2525.html"));
});

app.get("/update", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/blog", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/game", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});
app.get("/minecraft", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/fun/Minecraft.html"));
});

app.get("/play", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/play.html"));
});
app.get("/anime", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/anime.html"));
});

app.get("/movie", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/check", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/check.html"));
});

app.get("/use-api", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/version", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "raw/version.json"));
});
app.get("/ai", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/aibot.html"));
});
app.get("/code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/Code.html"));
});
app.get("/games.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/game.json"));
});
app.get("/gust", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/GUST.html"));
});
app.get("/easy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/easy.html"));
});

app.get("/urls", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/public-url.html"));
});

app.get("/own", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/own.html"));
});

app.get("/wista", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wista.html"));
});

app.get("/sia", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sia/index.html"));
});

app.get("/k-tube", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/k-tube.html"));
});

app.get("/science", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/science.html"));
});


app.get("/api/channel", async (req, res) => {
  const channelName = req.query.name || req.query.id;
  const page = parseInt(req.query.page) || 0;
  if (!channelName) return res.status(400).json({ error: "name required" });
  try {
    // 取得件数を20に設定
    const results = await yts.GetListByKeyword(channelName, false, 20, page);
    const videos = (results.items || []).filter(item => item.type === 'video');
    res.json({ channelName, videos, nextPage: page + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inv/channel/:name', async (req, res) => {
  const channelName = req.params.name;

  const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(
    channelName
  )}&type=channel`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Upstream error: ${response.statusText}` });
    }

    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/channel/:channelName", (req, res) => {
  const channelName = decodeURIComponent(req.params.channelName);
  const initial = channelName.charAt(0).toUpperCase();
  // チャンネルごとにアバター背景色を決定（固定色・フォールバック用）
  const colors = ['#ff0000','#ff6d00','#ffd600','#00c853','#00b0ff','#651fff','#d500f9','#f50057'];
  const colorIndex = channelName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
  const avatarBg = colors[colorIndex];

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channelName} - MIN-Tube-Pro</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#0f0f0f; --surface:#212121; --card:#272727; --hover:#3f3f3f;
      --text:#f1f1f1; --text-sub:#aaaaaa; --text-sec:#717171;
      --red:#ff0000; --border:#3f3f3f;
      --avatar-bg: ${avatarBg};
      --nav-h: 56px;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:var(--bg); color:var(--text); font-family:'Roboto',Arial,sans-serif; -webkit-font-smoothing:antialiased; }

    /* ===== NAVBAR ===== */
    .navbar {
      position:fixed; top:0; width:100%; height:var(--nav-h);
      background:var(--bg); display:flex; align-items:center;
      padding:0 16px; z-index:1000; gap:8px;
      border-bottom:1px solid transparent;
    }
    .nav-left { display:flex; align-items:center; gap:8px; flex-shrink:0; }
    .icon-btn {
      background:none; border:none; color:var(--text); cursor:pointer;
      width:40px; height:40px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      transition:background .15s; flex-shrink:0;
    }
    .icon-btn:hover { background:rgba(255,255,255,0.1); }
    .icon-btn svg { width:24px; height:24px; fill:var(--text); }
    .nav-logo { display:flex; align-items:center; gap:2px; text-decoration:none; color:var(--text); }
    .nav-logo-icon { background:var(--red); border-radius:6px; width:34px; height:24px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .nav-logo-icon svg { width:16px; height:16px; fill:white; }
    .nav-logo-text { font-size:18px; font-weight:700; letter-spacing:-0.5px; margin-left:4px; }
    .nav-logo-sub { font-size:10px; color:var(--text-sub); font-weight:500; margin-left:1px; align-self:flex-end; margin-bottom:4px; }
    .nav-center {
      flex:1; display:flex; align-items:center; justify-content:center;
      max-width:640px; margin:0 auto;
    }
    .search-form {
      display:flex; width:100%; height:40px;
      border:1px solid var(--border); border-radius:0; overflow:hidden;
    }
    .search-form:focus-within { border-color:#1c62b9; }
    .search-form input {
      flex:1; background:var(--bg); border:none; color:var(--text);
      padding:0 16px; outline:none; font-size:16px;
      font-family:'Roboto',Arial,sans-serif;
    }
    .search-btn {
      background:var(--surface); border:none; border-left:1px solid var(--border);
      color:var(--text-sub); width:64px; height:100%;
      display:flex; align-items:center; justify-content:center;
      cursor:pointer; font-size:18px; transition:background .1s;
    }
    .search-btn:hover { background:var(--hover); }
    .search-btn svg { width:20px; height:20px; fill:currentColor; }
    .nav-right { display:flex; align-items:center; gap:4px; margin-left:auto; flex-shrink:0; }

    /* ===== BANNER ===== */
    .channel-banner {
      margin-top:var(--nav-h); width:100%;
      height:clamp(100px, 18vw, 200px);
      background:linear-gradient(135deg, #1c1c2e 0%, #2d1b4e 40%, #1a2a4a 100%);
      position:relative; overflow:hidden;
    }
    .channel-banner::before {
      content:''; position:absolute; inset:0;
      background:radial-gradient(ellipse at 20% 60%, ${avatarBg}44 0%, transparent 60%);
    }
    .channel-banner::after {
      content:''; position:absolute; inset:0;
      background:radial-gradient(ellipse at 80% 30%, rgba(255,255,255,0.05) 0%, transparent 50%);
    }

    /* ===== CHANNEL HEADER ===== */
    .channel-header-wrap {
      max-width:1284px; margin:0 auto; padding:0 24px 0;
    }
    .channel-header {
      display:flex; align-items:center; gap:24px;
      padding:20px 0 16px;
    }
    .channel-avatar {
      width:80px; height:80px; border-radius:50%;
      background:var(--avatar-bg);
      display:flex; align-items:center; justify-content:center;
      font-size:36px; font-weight:700; color:#fff;
      flex-shrink:0; overflow:hidden; position:relative;
      border:3px solid var(--bg);
    }
    @media (min-width:600px) {
      .channel-avatar { width:160px; height:160px; font-size:64px; }
    }
    .channel-avatar img {
      width:100%; height:100%; object-fit:cover;
      display:none; position:absolute; inset:0;
    }
    .channel-avatar img.loaded { display:block; }
    .avatar-initial { position:relative; z-index:1; }

    .channel-info { flex:1; min-width:0; }
    .channel-title-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
    .channel-title {
      font-size:clamp(18px, 4vw, 36px); font-weight:700; line-height:1.2;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .verified-badge { fill:var(--text-sub); width:16px; height:16px; display:none; flex-shrink:0; }
    .verified-badge.show { display:block; }
    .channel-meta {
      font-size:14px; color:var(--text-sub); line-height:1.6;
      margin-bottom:12px;
    }
    .channel-meta span + span::before { content:' • '; }
    .channel-description {
      font-size:14px; color:var(--text-sub); line-height:1.5;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden; max-width:600px; margin-bottom:16px;
    }
    .channel-actions { display:flex; align-items:center; gap:8px; }
    .btn-subscribe {
      background:var(--text); color:#0f0f0f;
      border:none; border-radius:20px;
      padding:0 16px; height:36px; font-size:14px; font-weight:500;
      cursor:pointer; transition:opacity .15s;
      font-family:'Roboto',Arial,sans-serif; white-space:nowrap;
      display:flex; align-items:center;
    }
    .btn-subscribe:hover { opacity:0.9; }
    .btn-subscribe.subscribed { background:var(--card); color:var(--text); }
    .btn-subscribe.subscribed:hover { background:var(--hover); }
    .btn-notify {
      background:var(--card); border:none; color:var(--text);
      width:36px; height:36px; border-radius:50%;
      display:none; align-items:center; justify-content:center;
      cursor:pointer; transition:background .15s;
    }
    .btn-notify.show { display:flex; }
    .btn-notify:hover { background:var(--hover); }
    .btn-notify svg { width:20px; height:20px; fill:var(--text); }

    /* ===== TABS ===== */
    .channel-tabs-wrap {
      max-width:1284px; margin:0 auto; padding:0 24px;
      border-bottom:1px solid var(--border);
    }
    .channel-tabs { display:flex; overflow-x:auto; scrollbar-width:none; }
    .channel-tabs::-webkit-scrollbar { display:none; }
    .tab {
      padding:0 16px; height:48px; cursor:pointer;
      font-size:14px; font-weight:500; letter-spacing:0.3px;
      color:var(--text-sub); border-bottom:2px solid transparent;
      transition:color .15s, border-color .15s; white-space:nowrap;
      display:flex; align-items:center;
    }
    .tab:hover { color:var(--text); background:rgba(255,255,255,0.05); }
    .tab.active { color:var(--text); border-bottom-color:var(--text); }

    /* ===== CONTENT ===== */
    .content { max-width:1284px; margin:0 auto; padding:20px 24px 60px; }
    .video-grid {
      display:grid;
      grid-template-columns:repeat(auto-fill, minmax(240px,1fr));
      gap:16px; row-gap:40px;
    }
    .video-card { text-decoration:none; color:inherit; display:flex; flex-direction:column; }
    .thumb {
      width:100%; aspect-ratio:16/9; border-radius:12px;
      overflow:hidden; background:#1a1a1a; position:relative;
      margin-bottom:12px;
    }
    .thumb img { width:100%; height:100%; object-fit:cover; display:block; transition:border-radius .2s; }
    .video-card:hover .thumb img { border-radius:0; }
    .duration-badge {
      position:absolute; bottom:6px; right:6px;
      background:rgba(0,0,0,0.85); color:#fff;
      font-size:12px; font-weight:700; padding:2px 5px; border-radius:4px;
    }
    .card-meta { display:flex; gap:12px; align-items:flex-start; }
    .card-ch-avatar {
      width:36px; height:36px; border-radius:50%;
      background:var(--avatar-bg); flex-shrink:0;
      display:flex; align-items:center; justify-content:center;
      font-size:14px; font-weight:700; color:#fff; overflow:hidden;
    }
    .card-ch-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .card-info { flex:1; min-width:0; }
    .video-title {
      font-size:14px; font-weight:500; line-height:1.4;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden; color:var(--text); margin-bottom:4px;
    }
    .video-ch-name { font-size:13px; color:var(--text-sub); margin-bottom:2px; }
    .video-sub { font-size:13px; color:var(--text-sub); }

    /* ===== LOADING / EMPTY ===== */
    .loading { display:flex; justify-content:center; padding:60px; }
    .spinner {
      border:3px solid #333; border-top-color:var(--red);
      border-radius:50%; width:40px; height:40px;
      animation:spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }
    .load-more {
      display:block; margin:32px auto; padding:0 24px; height:36px;
      background:var(--card); border:none; color:var(--text);
      border-radius:18px; font-size:14px; font-weight:500;
      cursor:pointer; transition:background .15s;
      font-family:'Roboto',Arial,sans-serif;
    }
    .load-more:hover { background:var(--hover); }
    .empty { text-align:center; padding:60px; color:var(--text-sub); font-size:15px; }

    /* ===== RESPONSIVE ===== */
    @media (max-width:600px) {
      .channel-header-wrap { padding:0 16px; }
      .channel-header { gap:16px; padding:16px 0 12px; }
      .channel-description { display:none; }
      .content { padding:16px 16px 80px; }
      .video-grid { grid-template-columns:repeat(2,1fr); gap:8px; row-gap:24px; }
      .channel-tabs-wrap { padding:0 16px; }
      .nav-center { display:none; }
    }
  </style>
</head>
<body>

<nav class="navbar">
  <div class="nav-left">
    <button class="icon-btn" onclick="history.back()" aria-label="戻る">
      <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <a href="/" class="nav-logo">
      <div class="nav-logo-icon">
        <svg viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#FF0000"/><path d="M45 24 27 14v20" fill="white"/></svg>
      </div>
      <span class="nav-logo-text">YouTube</span><span class="nav-logo-sub">Pro</span>
    </a>
  </div>
  <div class="nav-center">
    <form class="search-form" action="/nothing/search" onsubmit="event.preventDefault(); const q=this.querySelector('input').value.trim(); if(q) window.location.href='/?q='+encodeURIComponent(q);">
      <input type="text" placeholder="検索" name="q">
      <button type="submit" class="search-btn">
        <svg viewBox="0 0 24 24"><path d="M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>
      </button>
    </form>
  </div>
  <div class="nav-right">
    <a href="/" class="icon-btn" title="ホーム">
      <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    </a>
  </div>
</nav>

<div class="channel-banner"></div>

<div class="channel-header-wrap">
  <div class="channel-header">
    <div class="channel-avatar" id="channelAvatar">
      <img id="channelAvatarImg" src="" alt="">
      <span class="avatar-initial" id="avatarInitial">${initial}</span>
    </div>
    <div class="channel-info">
      <div class="channel-title-row">
        <div class="channel-title" id="channelTitle">${channelName}</div>
        <svg class="verified-badge" id="verifiedBadge" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM10 17l-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9z"/></svg>
      </div>
      <div class="channel-meta">
        <span id="channelHandle">@${channelName.toLowerCase().replace(/\s+/g, '')}</span>
        <span id="subCount"></span>
        <span id="videoCountDisplay"></span>
      </div>
      <div class="channel-description" id="channelDescription"></div>
      <div class="channel-actions">
        <button class="btn-subscribe" id="subscribeBtn" onclick="toggleSubscribe()">チャンネル登録</button>
        <button class="btn-notify" id="notifyBtn" aria-label="通知">
          <svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<div class="channel-tabs-wrap">
  <div class="channel-tabs">
    <div class="tab active">動画</div>
    <div class="tab" onclick="alert('近日公開予定')">再生リスト</div>
    <div class="tab" onclick="alert('近日公開予定')">コミュニティ</div>
  </div>
</div>

<div class="content">
  <div id="videoGrid" class="video-grid"></div>
  <div id="loading" class="loading"><div class="spinner"></div></div>
  <button id="loadMoreBtn" class="load-more" style="display:none;" onclick="loadMore()">もっと見る</button>
</div>

<script>
  const CHANNEL_NAME = ${JSON.stringify(channelName)};
  const initial = ${JSON.stringify(initial)};
  let currentPage = 0;
  let isLoading = false;
  let isEnd = false;
  let totalLoaded = 0;
  let channelAvatarUrl = ''; // fetchChannelInfo後に設定される

  // 既存：チャンネル登録管理
  const SUB_KEY = 'subscribed_' + CHANNEL_NAME;
  function updateSubscribeUI() {
    const isSub = localStorage.getItem(SUB_KEY) === 'true';
    const btn = document.getElementById('subscribeBtn');
    const notifyBtn = document.getElementById('notifyBtn');
    if (isSub) {
      btn.textContent = '登録済み';
      btn.classList.add('subscribed');
      if(notifyBtn) notifyBtn.classList.add('show');
    } else {
      btn.textContent = 'チャンネル登録';
      btn.classList.remove('subscribed');
      if(notifyBtn) notifyBtn.classList.remove('show');
    }
  }
  function toggleSubscribe() {
    localStorage.setItem(SUB_KEY, localStorage.getItem(SUB_KEY) !== 'true');
    updateSubscribeUI();
  }

  // 既存：フォーマット関数
  function formatViews(v) {
    if (!v) return '';
    return v.replace('views', '回視聴').replace('ago', '前');
  }
  function formatSubscribers(n) {
    if (!n) return 'チャンネル';
    return n;
  }

  // 動画描画
  function renderVideos(videos) {
    const grid = document.getElementById('videoGrid');
    if (videos.length === 0 && totalLoaded === 0) {
      grid.innerHTML = '<div class="empty">動画が見つかりませんでした</div>';
      return;
    }
    const html = videos.map(v => \`
      <a href="/video/\${v.id}" class="video-card">
        <div class="thumb">
          <img src="https://i.ytimg.com/vi/\${v.id}/mqdefault.jpg" loading="lazy">
          \${v.lengthText ? \`<div class="duration-badge">\${v.lengthText}</div>\` : ''}
        </div>
        <div class="card-meta">
          <div class="card-ch-avatar" style="position:relative;overflow:hidden;">
            <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:inherit;">\${initial}</span>
            \${channelAvatarUrl ? \`<img src="\${channelAvatarUrl}" alt="\${CHANNEL_NAME}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.remove()">\` : ''}
          </div>
          <div class="card-info">
            <div class="video-title">\${v.title || ''}</div>
            <div class="video-ch-name">\${CHANNEL_NAME}</div>
            <div class="video-sub">\${formatViews(v.viewCountText) || ''}</div>
          </div>
        </div>
      </a>
    \`).join('');
    grid.insertAdjacentHTML('beforeend', html);
    totalLoaded += videos.length;
    const countDisp = document.getElementById('videoCountDisplay');
    if (countDisp) countDisp.textContent = '動画 ' + totalLoaded + ' 本';
  }

  // 動画取得コア関数
  async function loadVideos() {
    if (isLoading || isEnd) return;
    isLoading = true;
    document.getElementById('loading').style.display = 'flex';
    
    try {
      const res = await fetch(\`/api/channel?name=\${encodeURIComponent(CHANNEL_NAME)}&page=\${currentPage}\`);
      const data = await res.json();
      if (!data.videos || data.videos.length === 0) {
        isEnd = true;
        document.getElementById('loading').innerHTML = '<p style="color:var(--text-sub);padding:20px;">すべての動画を読み込みました</p>';
      } else {
        renderVideos(data.videos);
        currentPage = data.nextPage;
      }
    } catch (e) {
      isEnd = true;
    } finally {
      isLoading = false;
      if (!isEnd) document.getElementById('loading').style.display = 'none';
    }
  }

  // 追加：無限スクロール監視 (Intersection Observer)
  function initInfiniteScroll() {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadVideos();
    }, { rootMargin: '400px' });
    observer.observe(document.getElementById('loading'));
  }

  // 既存：チャンネル情報取得
  async function fetchChannelInfo() {
    try {
      const res = await fetch(\`/api/inv/channel/\${encodeURIComponent(CHANNEL_NAME)}\`);
      const data = await res.json();
      const c = Array.isArray(data) ? data[0] : data;
      if (c) {
        if (c.authorThumbnails?.length) {
          const avatarSrc = c.authorThumbnails[c.authorThumbnails.length-1].url;
          channelAvatarUrl = avatarSrc; // renderVideos で使用
          const img = document.getElementById('channelAvatarImg');
          img.src = avatarSrc;
          img.onload = () => { img.classList.add('loaded'); document.getElementById('avatarInitial').style.display='none'; };
        }
        if (c.description) document.getElementById('channelDescription').textContent = c.description;
        if (c.subCount) document.getElementById('subCount').textContent = c.subCount + ' 人の登録者';
      }
    } catch(e) {}
  }

  // 初期化
  async function init() {
    updateSubscribeUI();
    await fetchChannelInfo();
    await loadVideos(); // 初回20件
    initInfiniteScroll(); // 以降自動
  }
  init();
</script>
</body>
</html>`;
  res.send(html);
});


app.get('/stream/inv/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const now = Date.now();

    if (videoCache.has(videoId)) {
        const cached = videoCache.get(videoId);
        if (now < cached.expiry) {
            return res.type('text/plain').send(cached.url);
        }
    }

    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    
    try {
        const configRes = await fetch("https://raw.githubusercontent.com/mino-hobby-pro/min-tube-pro-local-txt/refs/heads/main/inv-check.txt");
        const extraParams = (await configRes.text()).trim(); 
        
        const targetUrl = `https://yt-comp5.chocolatemoo53.com/companion/latest_version?id=${videoId}${extraParams}`;

        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                "User-Agent": randomUA,
                "Accept": "*/*"
            },
            redirect: 'follow'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const finalUrl = response.url;


        videoCache.set(videoId, {
            url: finalUrl,
            expiry: now + 60000
        });

        res.type('text/plain').send(finalUrl);

    } catch (error) {
        console.error('Error fetching the URL:', error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.get("/img/:videoId", (req, res) => {
    const { videoId } = req.params;

    const url = `https://i3.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    https.get(url, (ytRes) => {
        if (ytRes.statusCode !== 200) {
            res.status(ytRes.statusCode).send("Failed to fetch image");
            return;
        }

        res.setHeader("Content-Type", "image/jpeg");

        // サーバー負荷を軽減するためそのままデータを転送してます
        ytRes.pipe(res);

    }).on("error", (err) => {
        console.error("Image proxy error:", err);
        res.status(500).send("Proxy error");
    });
});

app.get('/stream-network/:videoId', (req, res) => {
    const videoId = req.params.videoId;
    
    const host = req.get('host');
    
    // 強制的にhttpsURLスキームを返すためhttpしか対応していないとエラーを返します。。
    const baseUrl = `https://${host}`;
    
    const responseText = `${baseUrl}/proxy/embed.html#https://www.youtube-nocookie.com/embed/${videoId}`;
    
    res.send(responseText);
});

app.get("/abyss.png", (req, res) => {
  const filePath = path.join(__dirname, "img", "abyss.png");
  res.sendFile(filePath);
});

/**
 * PROXY_DIR/
 * ├── uv/ (sw.js, uv.bundle.js, etc.)
 * └── prxy/
 *     ├── baremux/ (index.js, worker.js, etc.)
 *     ├── epoxy/ (index.js, etc.)
 *     ├── libcurl/ (index.js, etc.)
 *     └── register-sw.mjs
 */
app.use('/proxy', express.static(PROXY_DIR));
app.use((req, res, next) => {
    if (res.headersSent) return next();

    const targetPath = path.join(PROXY_DIR, req.path);
    const normalizedPath = path.normalize(targetPath);

    if (!normalizedPath.startsWith(PROXY_DIR)) {
        return next();
    }

    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
        return res.sendFile(targetPath);
    }

    next();
});

// API提供toka-kun様　siawaseok様　sennen様　xeroxyt様　woolisbest様に感謝します
const MAX_API_WAIT_TIME = 5000; 
const MAX_TIME = 10000;      
const MAX_TIME_SLOW = 20000;  

let cache = {
    invidious: null,
    xerox: null
};

function shuffleArray(array) {
    const newArr = [...array];
    for (let i = newArr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
    }
    return newArr;
}

async function updateInstanceLists() {
    try {
        const fetchWithTimeout = (url) => fetch(url, { timeout: 5000 }).then(r => r.json());
        
        const results = await Promise.allSettled([
            fetchWithTimeout('https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/apis/Invidious/yes.json'),
            fetchWithTimeout('https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/apis/XeroxYT-NT/yes.json')
        ]);

        if (results[0].status === 'fulfilled') cache.invidious = results[0].value;
        if (results[1].status === 'fulfilled') cache.xerox = results[1].value;
    } catch (e) {
        console.error("インスタンスリストの更新に一部失敗しました");
    }
}

updateInstanceLists();


const apiHandlers = {
    invidious: async (videoId) => {
        if (!cache.invidious) await updateInstanceLists();
        if (!cache.invidious) throw new Error("List empty");
        
        const instances = shuffleArray(cache.invidious);
        for (const instance of instances) {
            try {
                const apiUrl = `${instance}/api/v1/videos/${videoId}`;
                const response = await fetch(apiUrl, { timeout: MAX_API_WAIT_TIME });
                const data = await response.json();
                
                if (data && data.formatStreams) {
                    const formats = data.formatStreams || [];
                    const adaptive = data.adaptiveFormats || [];
                    
                    const streamUrl = formats.find(s => String(s.itag) === '18' && s.url)?.url || 
                                     formats.find(s => String(s.itag) === '22' && s.url)?.url || 
                                     data.hlsUrl || '';

                    const audioUrls = adaptive
                        .filter(s => !s.resolution && (s.container === 'webm' || s.container === 'm4a') && s.url)
                        .map(s => ({
                            url: s.url,
                            name: s.audioQuality ? s.audioQuality.replace('AUDIO_QUALITY_', '') : `${s.audioBitrate}kbps`,
                            container: s.container
                        }));

                    const streamUrls = adaptive
                        .filter(s => s.resolution && s.url)
                        .map(s => ({ url: s.url, resolution: s.resolution, container: s.container, fps: s.fps }));

                    return { stream_url: streamUrl, audioUrl: adaptive.find(s => String(s.itag) === '251')?.url || '', audioUrls, streamUrls };
                }
            } catch (e) { continue; }
        }
        throw new Error("All Invidious nodes failed");
    },

    // SiaTube
    siawaseok: async (videoId) => {
        const res = await fetch(`https://siawaseok.f5.si/api/streams/${videoId}`, { timeout: MAX_TIME });
        const data = await res.json();
        const streams = Array.isArray(data) ? data : (data.formats || []);
        const audio = streams.find(s => String(s.itag) === '251' || s.vcodec === 'none');
        const combined = streams.find(s => String(s.itag) === '18');
        return {
            stream_url: combined?.url || '',
            audioUrl: audio?.url || '',
            audioUrls: streams.filter(s => s.vcodec === 'none').map(s => ({ url: s.url, name: `${s.abr}kbps`, container: s.ext })),
            streamUrls: streams.filter(s => s.vcodec !== 'none').map(s => ({ url: s.url, resolution: s.resolution, container: s.ext, fps: s.fps }))
        };
    },

    // YuZuTube
    yudlp: async (videoId) => {
        const res = await fetch(`https://yudlp.vercel.app/stream/${videoId}`, { timeout: MAX_TIME });
        const data = await res.json();
        const formats = data.formats || [];
        return {
            stream_url: formats.find(s => String(s.itag) === '18')?.url || '',
            audioUrl: formats.find(s => String(s.itag) === '251')?.url || '',
            audioUrls: formats.filter(s => s.resolution === 'audio only').map(s => ({ url: s.url, name: s.ext, container: s.ext })),
            streamUrls: formats.filter(s => s.resolution !== 'audio only' && s.vcodec !== 'none').map(s => ({ url: s.url, resolution: s.resolution, container: s.ext }))
        };
    },

    // KatuoTube
    katuo: async (videoId) => {
        const res = await fetch(`https://ytdlpinstance-vercel.vercel.app/stream/${videoId}`, { timeout: MAX_TIME });
        const data = await res.json();
        const formats = data.formats || [];
        return {
            stream_url: formats.find(s => String(s.itag) === '18')?.url || '',
            audioUrl: formats.find(s => String(s.itag) === '251')?.url || '',
            audioUrls: formats.filter(s => s.vcodec === 'none').map(s => ({ url: s.url, name: s.ext, container: s.ext })),
            streamUrls: formats.filter(s => s.vcodec !== 'none').map(s => ({ url: s.url, resolution: s.resolution, container: s.ext }))
        };
    },

    // SenninTube
    sennin: async (videoId) => {
        const res = await fetch(`https://senninytdlp-42jz.vercel.app/stream/${videoId}`, { timeout: MAX_TIME });
        const data = await res.json();
        const formats = data.formats || [];
        return {
            stream_url: formats.find(s => String(s.itag) === '18')?.url || '',
            audioUrl: formats.find(s => String(s.itag) === '251')?.url || '',
            audioUrls: formats.filter(s => s.vcodec === 'none').map(s => ({ url: s.url, name: s.ext, container: s.ext })),
            streamUrls: formats.filter(s => s.vcodec !== 'none').map(s => ({ url: s.url, resolution: s.resolution, container: s.ext }))
        };
    },

    // XeroxYT-NT
    xerox: async (videoId) => {
        if (!cache.xerox) await updateInstanceLists();
        const instances = shuffleArray(cache.xerox || []);
        for (const instance of instances) {
            try {
                const res = await fetch(`${instance}/stream?id=${videoId}`, { timeout: MAX_TIME_SLOW });
                const data = await res.json();
                if (data?.streamingUrl) {
                    return {
                        stream_url: data.streamingUrl,
                        audioUrl: data.audioUrl || '',
                        audioUrls: [],
                        streamUrls: (data.formats || []).map(f => ({ url: f.url, resolution: f.quality || 'Auto', container: f.container || 'mp4' }))
                    };
                }
            } catch (e) { continue; }
        }
        throw new Error("Xerox failed");
    },

    // Wista Stream
    wista: async (videoId) => {
        const res = await fetch(`https://simple-yt-stream.onrender.com/api/video/${videoId}`, { timeout: MAX_TIME_SLOW });
        const data = await res.json();
        const streams = data.streams || [];
        return {
            stream_url: streams.find(s => String(s.format_id) === '18')?.url || '',
            audioUrl: streams.find(s => s.fps === null)?.url || '',
            audioUrls: streams.filter(s => s.fps === null).map(s => ({ url: s.url, name: s.quality, container: s.ext })),
            streamUrls: streams.filter(s => s.fps !== null).map(s => ({ url: s.url, resolution: s.quality, container: s.ext, fps: s.fps }))
        };
    }
};

app.get('/get-other/:videoId', async (req, res) => {
    const { videoId } = req.params;
    
    const apiOrder = shuffleArray(Object.keys(apiHandlers));
    
    let result = null;
    let errors = [];

    for (const apiName of apiOrder) {
        try {
            console.log(`Trying API: ${apiName}`);
            result = await apiHandlers[apiName](videoId);
            if (result) {
                result.provider = apiName;
                break; 
            }
        } catch (error) {
            console.error(`❌ ${apiName} failed: ${error.message}`);
            errors.push({ api: apiName, error: error.message });
        }
    }

    if (!result) {
        return res.status(500).json({
            success: false,
            message: "えらー",
            details: errors
        });
    }

    try {
        const seenUrls = new Set();
        if (result.stream_url) seenUrls.add(result.stream_url);

        result.streamUrls = (result.streamUrls || []).filter(s => {
            if (!s.url || seenUrls.has(s.url)) return false;
            seenUrls.add(s.url);
            
            if (s.resolution) {
                s.resolution = String(s.resolution).replace(/ \(.+\)/g, '').trim();
                if (s.fps && s.resolution.endsWith(String(s.fps))) {
                    s.resolution = s.resolution.slice(0, -String(s.fps).length).trim();
                }
            }
            
            if (s.url.includes('.m3u8') || s.url.includes('manifest')) {
                s.container = 'm3u8';
            }
            return true;
        });

        const isInvalid = (url) => !url || url.includes('manifest') || url.includes('.m3u8');
        if (isInvalid(result.audioUrl)) {
            result.audioUrl = '';
            result.audioUrls = [];
        } else {
            result.audioUrls = (result.audioUrls || []).filter(s => !isInvalid(s.url));
        }

        return res.json({
            success: true,
            data: result
        });

    } catch (cleanError) {
        return res.json({
            success: true,
            data: result,
            note: "Cleaning process partially failed"
        });
    }
});

const VERSION = '5.0.0';

// すべてInnertube
const INNERTUBE_KEYS = [
  'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',  // WEB
  'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',  // iOS
  'AIzaSyA8eiZmM1fanX44Xqp1Gg9mGKL0r2GzUQw',  // Android
];

const CLIENTS = {
  WEB_EMBEDDED: {
    name: 'WEB_EMBEDDED_PLAYER',
    version: '2.20210721.00.00',
    key: INNERTUBE_KEYS[0],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    clientName: '56',
    embedUrl: 'https://www.youtube.com/embed/',
    referer: 'https://www.youtube.com/',
  },

  TV_EMBEDDED: {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    version: '2.0',
    key: INNERTUBE_KEYS[0],
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
    clientName: '85',
    embedUrl: 'https://www.youtube.com',
    referer: 'https://www.youtube.com/',
  },
  WEB: {
    name: 'WEB',
    version: '2.20241121.01.00',
    key: INNERTUBE_KEYS[0],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    clientName: '1',
    referer: 'https://www.youtube.com/',
  },
  IOS: {
    name: 'iOS',
    version: '19.45.4',
    key: INNERTUBE_KEYS[1],
    userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
    clientName: '5',
    deviceMake: 'Apple',
    deviceModel: 'iPhone16,2',
    osName: 'iPhone',
    osVersion: '18.1.0.22B83',
    referer: 'https://www.youtube.com/',
  },
  ANDROID: {
    name: 'ANDROID',
    version: '19.44.38',
    key: INNERTUBE_KEYS[2],
    userAgent: 'com.google.android.youtube/19.44.38(Linux; U; Android 14; en_US; Pixel 9 Pro; Build/AP3A.241005.015) gzip',
    clientName: '3',
    androidSdkVersion: 34,
    referer: 'https://www.youtube.com/',
  },
  MWEB: {
    name: 'MWEB',
    version: '2.20241121.01.00',
    key: INNERTUBE_KEYS[0],
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    clientName: '2',
    referer: 'https://www.youtube.com/',
  },
};

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

let _uaIdx = 0;
const getUA = () => UA_POOL[(_uaIdx++) % UA_POOL.length];



const AGENT = new Agent({
  connect: { timeout: 25000 },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 60000,
  maxRedirections: 5,
});


async function httpGet(url, headers = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'DNT': '1',
        ...headers,
      },
      redirect: 'follow',
      dispatcher: AGENT,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(url, body, headers = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://www.youtube.com',
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: 'follow',
      dispatcher: AGENT,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}



const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch { return null; }
}


function dig(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[k] : cur[k];
  }
  return cur;
}


function getText(obj) {
  if (obj == null) return null;
  if (typeof obj === 'string') return obj || null;
  if (typeof obj === 'number') return String(obj);
  if (obj.simpleText != null) return String(obj.simpleText) || null;
  if (Array.isArray(obj.runs)) {
    const text = obj.runs.map(r => r?.text ?? '').join('');
    return text || null;
  }
  if (obj.content != null) return String(obj.content) || null;
  if (obj.accessibility?.accessibilityData?.label) return obj.accessibility.accessibilityData.label;
  return null;
}


function parseCount(text) {
  if (text == null) return null;
  const str = String(text).trim();
  if (!str) return null;

  const direct = parseInt(str.replace(/[^0-9]/g, ''), 10);

  // 動画のサイズを読み取り、それに合ったソースで動画を取得する。サーバーの負荷を下げるためにInnerから取得
  const abbrevMatch = str.match(/^([\d,.]+)\s*([KMBkmb])/);
  if (abbrevMatch) {
    const num = parseFloat(abbrevMatch[1].replace(/,/g, ''));
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[abbrevMatch[2].toLowerCase()] || 1;
    return Math.round(num * mult);
  }

  return isNaN(direct) ? null : direct;
}


function getNavUrl(endpoint) {
  if (!endpoint) return null;
  const web = endpoint?.commandMetadata?.webCommandMetadata?.url;
  if (web) return web.startsWith('http') ? web : `https://www.youtube.com${web}`;
  const browseId = endpoint?.browseEndpoint?.browseId;
  if (browseId) {
    const canonical = endpoint?.browseEndpoint?.canonicalBaseUrl;
    if (canonical) return `https://www.youtube.com${canonical}`;
    return `https://www.youtube.com/channel/${browseId}`;
  }
  const watchId = endpoint?.watchEndpoint?.videoId;
  if (watchId) return `https://www.youtube.com/watch?v=${watchId}`;
  const urlEndpoint = endpoint?.urlEndpoint?.url;
  if (urlEndpoint) return urlEndpoint;
  return null;
}


function normalizeThumbs(obj) {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj
    : Array.isArray(obj.thumbnails) ? obj.thumbnails
    : [];
  return list
    .filter(t => t?.url)
    .map(t => ({
      url: t.url,
      width: t.width  ? parseInt(t.width,  10) : null,
      height: t.height ? parseInt(t.height, 10) : null,
    }))
    .sort((a, b) => (b.width || 0) - (a.width || 0));
}


function buildVideoThumbs(id) {
  return [
    { id: 'maxres',  url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,  width: 1280, height: 720  },
    { id: 'sd',      url: `https://i.ytimg.com/vi/${id}/sddefault.jpg`,      width: 640,  height: 480  },
    { id: 'hq',      url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,      width: 480,  height: 360  },
    { id: 'mq',      url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,      width: 320,  height: 180  },
    { id: 'default', url: `https://i.ytimg.com/vi/${id}/default.jpg`,        width: 120,  height: 90   },
  ];
}


function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return null;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${m}:${String(ss).padStart(2,'0')}`;
}


function cleanRedirectUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'www.youtube.com' && u.pathname === '/redirect') {
      const q = u.searchParams.get('q');
      if (q) return decodeURIComponent(q);
    }
    return url;
  } catch { return url; }
}


function extractJsonBlock(html, varName) {
  if (!html || !varName) return null;

  const searchPatterns = [
    `var ${varName} = `,
    `var ${varName}=`,
    `window["${varName}"] = `,
    `window['${varName}'] = `,
    `"${varName}":`,
    `'${varName}':`,
    `${varName} = `,
    `${varName}=`,
  ];

  for (const pattern of searchPatterns) {
    const patternIdx = html.indexOf(pattern);
    if (patternIdx === -1) continue;

    const jsonStart = html.indexOf('{', patternIdx + pattern.length - 1);
    if (jsonStart === -1 || jsonStart > patternIdx + pattern.length + 5) continue;

    const result = extractBracketBlock(html, jsonStart);
    if (result) return result;
  }

  return null;
}

function extractBracketBlock(html, startIdx) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';

  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }

    if (!inString) {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
        continue;
      }
      if (ch === '{') { depth++; continue; }
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = html.substring(startIdx, i + 1);
          const parsed = safeJSON(candidate);
          if (parsed && typeof parsed === 'object') return parsed;
          return null;
        }
      }
    } else {
      if (ch === quoteChar) { inString = false; }
    }
  }
  return null;
}


function extractArrayBlock(html, startIdx) {
  const actualStart = html.indexOf('[', startIdx);
  if (actualStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';

  for (let i = actualStart; i < html.length; i++) {
    const ch = html[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }

    if (!inString) {
      if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; continue; }
      if (ch === '[') { depth++; continue; }
      if (ch === ']') {
        depth--;
        if (depth === 0) {
          const candidate = html.substring(actualStart, i + 1);
          return safeJSON(candidate);
        }
      }
    } else {
      if (ch === quoteChar) inString = false;
    }
  }
  return null;
}



function extractVisitorData(html) {
  const patterns = [
    /"visitorData"\s*:\s*"(C[a-zA-Z0-9+/=%_-]{20,})"/,
    /visitorData["']?\s*:\s*["'](C[a-zA-Z0-9+/=%_-]{20,})["']/,
    /"VISITOR_DATA"\s*:\s*"([^"]{20,})"/,
    /visitor_data["']?\s*=\s*["']([^"']{20,})["']/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1];
  }
  return '';
}

function extractApiKey(html) {
  const patterns = [
    /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/,
    /"innertubeApiKey"\s*:\s*"([^"]+)"/,
    /innertubeApiKey["']?\s*:\s*["']([^"']+)["']/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1];
  }
  return INNERTUBE_KEYS[0];
}

function extractClientVersion(html) {
  const patterns = [
    /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
    /"innertubeClientVersion"\s*:\s*"([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1];
  }
  return CLIENTS.WEB.version;
}

function extractPageBuildLabel(html) {
  const m = html.match(/"CLIENT_PAGE_BUILD_LABEL"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}


async function fetchWatchPage(videoId) {
  const strategies = [
    async () => {
      const res = await httpGet(
        `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&persist_gl=1&has_verified=1`,
        { 'User-Agent': getUA(), 'Cookie': 'CONSENT=YES+cb; YSC=fake; VISITOR_INFO1_LIVE=fake' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    // フォーマットを直接読み（暗号化されてるから表示しない）
    async () => {
      const res = await httpGet(
        `https://www.youtube.com/watch?v=${videoId}&hl=en`,
        { 'User-Agent': getUA() }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    // ボット回避できないから消してもいい
    async () => {
      const res = await httpGet(
        `https://www.youtube.com/watch?v=${videoId}`,
        { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },

    async () => {
      const res = await httpGet(
        `https://www.youtube.com/watch?v=${videoId}`,
        { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
  ];

  let lastError = null;
  for (let i = 0; i < strategies.length; i++) {
    try {
      const text = await strategies[i]();
      if (text && (text.includes('ytInitialData') || text.includes('ytInitialPlayerResponse'))) {
        return text;
      }
    } catch (e) {
      lastError = e;
      if (i < strategies.length - 1) await sleep(300 * (i + 1));
    }
  }
  throw lastError || new Error('All watch page strategies failed');
}


function buildInnertubeContext(clientKey, videoId, visitorData, extraParams = {}) {
  const client = CLIENTS[clientKey];
  if (!client) throw new Error(`Unknown client: ${clientKey}`);

  const ctx = {
    client: {
      clientName: client.name,
      clientVersion: client.version,
      hl: 'en',
      gl: 'US',
      visitorData: visitorData || '',
      userAgent: client.userAgent,
      ...( client.deviceMake        ? { deviceMake: client.deviceMake }               : {} ),
      ...( client.deviceModel       ? { deviceModel: client.deviceModel }             : {} ),
      ...( client.osName            ? { osName: client.osName }                       : {} ),
      ...( client.osVersion         ? { osVersion: client.osVersion }                 : {} ),
      ...( client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {} ),
    },
  };

  const payload = {
    context: ctx,
    videoId,
    racyCheckOk: true,
    contentCheckOk: true,
    ...extraParams,
  };

  if (client.embedUrl) {
    payload.context.thirdParty = { embedUrl: client.embedUrl };
  }

  return {
    payload,
    url: `https://www.youtube.com/youtubei/v1`,
    headers: {
      'User-Agent': client.userAgent,
      'X-YouTube-Client-Name': client.clientName,
      'X-YouTube-Client-Version': client.version,
      'X-Goog-Api-Format-Version': '1',
      'Referer': client.referer || 'https://www.youtube.com/',
      ...(client.embedUrl ? { 'Origin': 'https://www.youtube.com' } : {}),
    },
    key: client.key,
  };
}

async function callPlayer(clientKey, videoId, visitorData) {
  const { payload, headers, key } = buildInnertubeContext(clientKey, videoId, visitorData);
  const url = `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`;
  const res = await httpPost(url, payload, headers);
  if (!res.ok) throw new Error(`player[${clientKey}] HTTP ${res.status}`);
  return res.json();
}


async function callNext(videoId, visitorData, apiKey, clientVersion) {
  const payload = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: clientVersion || CLIENTS.WEB.version,
        hl: 'en',
        gl: 'US',
        visitorData: visitorData || '',
        userAgent: CLIENTS.WEB.userAgent,
      },
    },
    videoId,
    racyCheckOk: true,
    contentCheckOk: true,
  };
  const res = await httpPost(
    `https://www.youtube.com/youtubei/v1/next?key=${apiKey || INNERTUBE_KEYS[0]}&prettyPrint=false`,
    payload,
    {
      'User-Agent': CLIENTS.WEB.userAgent,
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': clientVersion || CLIENTS.WEB.version,
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
    }
  );
  if (!res.ok) throw new Error(`next HTTP ${res.status}`);
  return res.json();
}

async function callBrowse(browseId, params, apiKey, clientVersion) {
  const payload = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: clientVersion || CLIENTS.WEB.version,
        hl: 'en',
        gl: 'US',
        userAgent: CLIENTS.WEB.userAgent,
      },
    },
    browseId,
    params: params || '',
  };
  const res = await httpPost(
    `https://www.youtube.com/youtubei/v1/browse?key=${apiKey || INNERTUBE_KEYS[0]}&prettyPrint=false`,
    payload,
    {
      'User-Agent': CLIENTS.WEB.userAgent,
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': clientVersion || CLIENTS.WEB.version,
    }
  );
  if (!res.ok) throw new Error(`browse HTTP ${res.status}`);
  return res.json();
}


function parsePlayerResponse(pr) {
  if (!pr || typeof pr !== 'object') return {};

  const vd = pr.videoDetails                     || {};
  const mf = pr.microformat?.playerMicroformatRenderer || {};
  const ps = pr.playabilityStatus                || {};
  const sd = pr.streamingData                    || {};

  // 今のところ5個のソース
  let duration = null;
  const durationCandidates = [
    vd.lengthSeconds ? parseInt(vd.lengthSeconds, 10) : null,
    mf.lengthSeconds ? parseInt(mf.lengthSeconds, 10) : null,
    sd.formats?.[0]?.approxDurationMs ? Math.round(parseInt(sd.formats[0].approxDurationMs, 10) / 1000) : null,
    sd.adaptiveFormats?.[0]?.approxDurationMs ? Math.round(parseInt(sd.adaptiveFormats[0].approxDurationMs, 10) / 1000) : null,
  ];
  for (const d of durationCandidates) {
    if (d && d > 0) { duration = d; break; }
  }

  const kwSet = new Set();
  (Array.isArray(vd.keywords) ? vd.keywords : []).forEach(k => k && kwSet.add(k));
  (Array.isArray(mf.tags) ? mf.tags : []).forEach(k => k && kwSet.add(k));

  let viewCount = null;
  if (vd.viewCount) {
    const n = parseInt(vd.viewCount, 10);
    if (!isNaN(n)) viewCount = n;
  }

  const channelId = vd.channelId || mf.externalChannelId || null;

  // ライブ判定
  const isLive = !!(vd.isLiveContent && vd.isLive);


  const availableCountries = Array.isArray(mf.availableCountries)
    ? mf.availableCountries : [];


  const embed = mf.embed ? {
    iframe_url:        mf.embed.iframeUrl        || null,
    width:             mf.embed.width            || null,
    height:            mf.embed.height           || null,
    flash_secure_url:  mf.embed.flashSecureUrl   || null,
  } : null;


  const storyboards = [];
  try {
    const spec = pr.storyboards?.playerStoryboardSpecRenderer?.spec;
    if (spec) {
      spec.split('|').filter(Boolean).forEach((s, i) => storyboards.push({ index: i, spec: s }));
    }
  } catch {}


  const captions = [];
  try {
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    tracks.forEach(t => captions.push({
      language:          t.languageCode   || null,
      language_name:     getText(t.name)  || null,
      url:               t.baseUrl        || null,
      is_translatable:   !!t.isTranslatable,
      kind:              t.kind           || null,
      vss_id:            t.vssId          || null,
    }));
  } catch {}


  const playability = {
    status:         ps.status         || null,
    reason:         ps.reason         || null,
    error_code:     ps.errorCode      || null,
    messages:       ps.messages       || [],
    plays_anywhere: !!ps.playsAnyway,
  };

  return {
    videoId:           vd.videoId            || null,
    title:             vd.title              || getText(mf.title)       || null,
    description:       vd.shortDescription   || getText(mf.description) || null,
    duration,
    viewCount,
    author:            vd.author             || null,
    channelId,
    externalChannelId: mf.externalChannelId  || null,
    isLive,
    isLiveContent:     !!vd.isLiveContent,
    isPrivate:         !!vd.isPrivate,
    isUnlisted:        !!mf.isUnlisted,
    isAgeRestricted:   mf.isFamilySafe === false,
    isFamilySafe:      mf.isFamilySafe !== false,
    isUpcoming:        ps.status === 'LIVE_STREAM_OFFLINE',
    allowRatings:      !!vd.allowRatings,
    category:          mf.category           || null,
    uploadDate:        mf.uploadDate         || null,
    publishDate:       mf.publishDate        || null,
    availableCountries,
    keywords:          [...kwSet],
    embed,
    playability,
    captions,
    storyboards,
    hasStreamingData:  !!(sd.formats?.length || sd.adaptiveFormats?.length),
  };
}



function parsePrimaryInfo(initialData) {
  if (!initialData || typeof initialData !== 'object') return {};

  const result = {
    title: null, viewCount: null, dateText: null, likeCount: null,
    channelName: null, channelUrl: null, channelId: null,
    channelVerified: false, subscriberText: null, channelThumbs: [],
    description: null, descLinks: [], hashtags: [],
  };

  try {
    const contents = dig(initialData, 'contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents') || [];
    let primary   = null;
    let secondary = null;

    for (const c of contents) {
      if (c?.videoPrimaryInfoRenderer)   primary   = c.videoPrimaryInfoRenderer;
      if (c?.videoSecondaryInfoRenderer) secondary = c.videoSecondaryInfoRenderer;
    }

    if (!primary && !secondary) {
      // モバイル版（slim）
      const mContents = dig(initialData, 'contents', 'singleColumnWatchNextResults', 'results', 'results', 'contents') || [];
      for (const c of mContents) {
        const slim = c?.slimVideoMetadataSectionRenderer?.contents || [];
        for (const s of slim) {
          if (s?.slimVideoMetadataRenderer) primary = s.slimVideoMetadataRenderer;
        }
      }
    }

    result.title = getText(primary?.title) || null;

    const vcr = primary?.viewCount?.videoViewCountRenderer;
    const vcText = getText(vcr?.viewCount) || getText(vcr?.shortViewCount);
    if (vcText) result.viewCount = parseCount(vcText);


    result.dateText = getText(primary?.dateText) || null;


    result.likeCount = extractLikeCount(primary);

    const ownerR = secondary?.owner?.videoOwnerRenderer;
    if (ownerR) {
      result.channelName    = getText(ownerR.title) || null;
      result.channelUrl     = getNavUrl(ownerR.navigationEndpoint) || null;
      result.channelId      = ownerR.navigationEndpoint?.browseEndpoint?.browseId || null;
      result.channelVerified = extractVerified(ownerR.badges);
      result.subscriberText = getText(ownerR.subscriberCountText) || null;
      result.channelThumbs  = normalizeThumbs(ownerR.thumbnail);
    }

    result.description = extractDescription(secondary);
    result.descLinks   = extractDescriptionLinks(secondary, result.description);

    result.hashtags = extractHashtags(primary, secondary);

  } catch (e) {
  }

  return result;
}


function extractLikeCount(primary) {
  if (!primary) return null;

  try {
    const buttons = primary?.videoActions?.menuRenderer?.topLevelButtons || [];

    for (const btn of buttons) {
      const sldvm = btn?.segmentedLikeDislikeButtonViewModel;
      if (sldvm) {
        const likeVM = sldvm.likeButtonViewModel?.likeButtonViewModel
          ?.toggleButtonViewModel?.toggleButtonViewModel;
        if (likeVM) {
          for (const textKey of ['defaultText', 'toggledText', 'accessibilityText']) {
            const txt = getText(likeVM[textKey]);
            if (txt) {
              const n = parseCount(txt);
              if (n && n > 0) return n;
            }
          }
        }
      }

      const bvm = btn?.buttonViewModel;
      if (bvm?.iconName === 'LIKE' || bvm?.accessibilityText?.includes('like')) {
        const txt = getText(bvm.title) || getText(bvm.accessibilityText);
        if (txt) {
          const n = parseCount(txt);
          if (n && n > 0) return n;
        }
      }

      const tbr = btn?.toggleButtonRenderer;
      if (tbr) {
        const txt = getText(tbr.defaultText) || getText(tbr.toggledText);
        if (txt) {
          const n = parseCount(txt);
          if (n && n > 0) return n;
        }
      }

     
      const sldbr = btn?.segmentedLikeDislikeButtonRenderer;
      if (sldbr) {
        const likeBtn = sldbr.likeButton?.toggleButtonRenderer;
        if (likeBtn) {
          const accLabel = likeBtn.accessibilityData?.accessibilityData?.label || '';
          const m = accLabel.match(/([\d,]+)\s+like/i);
          if (m) return parseInt(m[1].replace(/,/g, ''), 10);
          const txt = getText(likeBtn.defaultText);
          if (txt) {
            const n = parseCount(txt);
            if (n && n > 0) return n;
          }
        }
      }
    }
  } catch {}

  return null;
}


function extractVerified(badges) {
  if (!Array.isArray(badges)) return false;
  return badges.some(b => {
    const mbr = b?.metadataBadgeRenderer;
    return mbr?.style?.includes('VERIFIED') || mbr?.icon?.iconType === 'CHECK_CIRCLE_THICK';
  });
}


function extractDescription(secondary) {
  if (!secondary) return null;
  try {
    // 最も完全
    const attrDesc = secondary.attributedDescription;
    if (attrDesc?.content) return attrDesc.content;


    const desc = secondary.description;
    if (desc) return getText(desc);


    const expandable = secondary.expandableVideoDescriptionBodyRenderer;
    if (expandable) {
      return getText(expandable.descriptionBodyText) || getText(expandable.attributedDescriptionBodyText);
    }
  } catch {}
  return null;
}


function extractDescriptionLinks(secondary, descriptionText) {
  const links = [];
  if (!secondary) return links;

  try {
    const attrDesc = secondary.attributedDescription;
    if (attrDesc?.commandRuns) {
      for (const run of attrDesc.commandRuns) {
        const url = run?.onTap?.innertubeCommand?.urlEndpoint?.url
          || run?.onTap?.innertubeCommand?.commandMetadata?.webCommandMetadata?.url;
        if (url) {
          const text = descriptionText
            ? descriptionText.substring(run.startIndex || 0, (run.startIndex || 0) + (run.length || 0))
            : null;
          links.push({
            text: text || null,
            url: cleanRedirectUrl(url),
            raw_url: url,
          });
        }
      }
    }

    // runs内のURLナビ
    if (links.length === 0 && secondary.description?.runs) {
      for (const run of secondary.description.runs) {
        const url = run?.navigationEndpoint?.urlEndpoint?.url
          || run?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
        if (url) {
          links.push({
            text: run.text || null,
            url: cleanRedirectUrl(url),
            raw_url: url,
          });
        }
      }
    }
  } catch {}

  return links;
}


function extractHashtags(primary, secondary) {
  const tags = new Set();
  try {
    const superRuns = primary?.superTitleLink?.runs || [];
    superRuns.filter(r => r?.text?.startsWith('#')).forEach(r => tags.add(r.text));

    const headerLinks = primary?.headerLinks?.runs || [];
    headerLinks.filter(r => r?.text?.startsWith('#')).forEach(r => tags.add(r.text));

    if (secondary?.description?.runs) {
      let count = 0;
      for (const run of secondary.description.runs) {
        if (run?.text?.startsWith('#') && count < 3) {
          const endpoint = run?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
          if (endpoint?.includes('/hashtag/')) {
            tags.add(run.text);
            count++;
          }
        }
      }
    }
  } catch {}
  return [...tags];
}


function parseRelatedVideos(initialData, nextData, limit = 30) {
  const videos = [];
  const seen = new Set();

  const addVideo = (item) => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    videos.push(item);
  };

  if (initialData) {
    const results1 = dig(initialData, 'contents', 'twoColumnWatchNextResults', 'secondaryResults', 'secondaryResults', 'results') || [];
    const results2 = dig(initialData, 'contents', 'twoColumnWatchNextResults', 'secondaryResults', 'results') || [];
    const results = results1.length > 0 ? results1 : results2;

    for (const item of results) {
      if (videos.length >= limit) break;
      extractRelatedItem(item, addVideo);
    }
  }

  if (videos.length < limit && nextData) {
    const results = dig(nextData, 'contents', 'twoColumnWatchNextResults', 'secondaryResults', 'secondaryResults', 'results') || [];
    for (const item of results) {
      if (videos.length >= limit) break;
      extractRelatedItem(item, addVideo);
    }
  }

  return videos;
}

function extractRelatedItem(item, addVideo) {
  if (!item) return;

  const cvr = item?.compactVideoRenderer;
  if (cvr?.videoId) {
    addVideo(buildVideoItem(cvr, false));
    return;
  }


  const auto = item?.compactAutoplayRenderer?.contents;
  if (auto) {
    for (const c of auto) {
      if (c?.compactVideoRenderer?.videoId) {
        addVideo(buildVideoItem(c.compactVideoRenderer, false));
      }
    }
    return;
  }

  const reel = item?.reelItemRenderer;
  if (reel?.videoId) {
    addVideo({
      id:         reel.videoId,
      title:      getText(reel.headline) || null,
      url:        `https://www.youtube.com/shorts/${reel.videoId}`,
      short_url:  `https://youtu.be/${reel.videoId}`,
      duration:   null,
      view_count: parseCount(getText(reel.viewCountText)) || null,
      view_count_text: getText(reel.viewCountText) || null,
      published:  null,
      thumbnail:  normalizeThumbs(reel.thumbnail)[0]?.url || `https://i.ytimg.com/vi/${reel.videoId}/hqdefault.jpg`,
      thumbnails: normalizeThumbs(reel.thumbnail),
      channel:    { name: null, id: null, url: null, thumbnail: null },
      is_live:    false,
      is_short:   true,
      badges:     [],
    });
    return;
  }

  const lockup = item?.lockupViewModel;
  if (lockup) {
    const vid = lockup?.contentId || lockup?.rendererContext?.commandContext?.onTap?.watchEndpoint?.videoId;
    if (vid) {
      const title = getText(lockup?.metadata?.lockupMetadataViewModel?.title?.content) || null;
      addVideo({
        id:         vid,
        title,
        url:        `https://www.youtube.com/watch?v=${vid}`,
        short_url:  `https://youtu.be/${vid}`,
        duration:   null,
        view_count: null,
        view_count_text: null,
        published:  null,
        thumbnail:  `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        thumbnails: buildVideoThumbs(vid),
        channel:    { name: null, id: null, url: null, thumbnail: null },
        is_live:    false,
        is_short:   false,
        badges:     [],
      });
    }
  }
}

function buildVideoItem(r, isShort) {
  const channelRuns = r.shortBylineText?.runs || r.longBylineText?.runs || [];
  const channelRun  = channelRuns[0];
  const vcText      = getText(r.viewCountText);
  const thumbs      = normalizeThumbs(r.thumbnail);

  return {
    id:              r.videoId,
    title:           getText(r.title) || null,
    url:             `https://www.youtube.com/watch?v=${r.videoId}`,
    short_url:       `https://youtu.be/${r.videoId}`,
    duration:        getText(r.lengthText) || null,
    duration_secs:   parseDurationText(getText(r.lengthText)),
    view_count:      parseCount(vcText) || null,
    view_count_text: vcText || null,
    published:       getText(r.publishedTimeText) || null,
    thumbnail:       thumbs[0]?.url || `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
    thumbnails:      thumbs,
    channel: {
      name:      getText(r.shortBylineText) || getText(r.longBylineText) || null,
      id:        channelRun?.navigationEndpoint?.browseEndpoint?.browseId || null,
      url:       getNavUrl(channelRun?.navigationEndpoint) || null,
      thumbnail: null,
    },
    is_live:  !!(r.badges?.find(b => b?.liveBadgeRenderer || b?.metadataBadgeRenderer?.style?.includes('LIVE'))),
    is_short: !!isShort,
    badges:   (r.badges || []).map(b => getText(b?.liveBadgeRenderer?.label || b?.metadataBadgeRenderer?.label)).filter(Boolean),
  };
}


function parseDurationText(text) {
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}



function parseChapters(initialData) {
  if (!initialData) return [];

  try {
    const markersMap = dig(
      initialData,
      'playerOverlays', 'playerOverlayRenderer',
      'decoratedPlayerBarRenderer', 'decoratedPlayerBarRenderer',
      'playerBar', 'multiMarkersPlayerBarRenderer', 'markersMap'
    ) || [];

    for (const entry of markersMap) {
      const chapters = entry?.value?.chapters;
      if (Array.isArray(chapters) && chapters.length > 0) {
        return chapters.map(c => {
          const ch = c?.chapterRenderer;
          return {
            title:      getText(ch?.title)    || null,
            start_time: ch?.timeRangeStartMillis != null ? ch.timeRangeStartMillis / 1000 : null,
            thumbnail:  normalizeThumbs(ch?.thumbnail)[0]?.url || null,
          };
        });
      }
    }
  } catch {}


  try {
    const panels = initialData?.engagementPanels || [];
    for (const panel of panels) {
      const contents = dig(panel, 'engagementPanelSectionListRenderer', 'content', 'macroMarkersListRenderer', 'contents') || [];
      if (contents.length > 0) {
        return contents.map(i => {
          const m = i?.macroMarkersListItemRenderer;
          if (!m) return null;
          return {
            title:      getText(m.title)            || null,
            start_time: getText(m.timeDescription)  || null,
            thumbnail:  normalizeThumbs(m.thumbnail)[0]?.url || null,
          };
        }).filter(Boolean);
      }
    }
  } catch {}

  return [];
}


function parsePlaylist(initialData) {
  if (!initialData) return null;
  try {
    const pl = dig(initialData, 'contents', 'twoColumnWatchNextResults', 'playlist', 'playlist');
    if (!pl) return null;

    const items = (pl.contents || []).map(c => {
      const r = c?.playlistPanelVideoRenderer || c?.playlistPanelVideoWrapperRenderer?.primaryPlaylistPanelVideoRenderer;
      if (!r) return null;
      return {
        id:          r.videoId || null,
        title:       getText(r.title) || null,
        duration:    getText(r.lengthText) || null,
        url:         r.videoId ? `https://www.youtube.com/watch?v=${r.videoId}` : null,
        thumbnail:   normalizeThumbs(r.thumbnail)[0]?.url || null,
        is_selected: !!r.selected,
        index:       r.index?.simpleText ? parseInt(r.index.simpleText, 10) : null,
      };
    }).filter(Boolean);

    return {
      id:            pl.playlistId   || null,
      title:         getText(pl.title) || null,
      total:         parseCount(getText(pl.totalVideos)) || null,
      current_index: pl.currentIndex ?? null,
      items,
    };
  } catch { return null; }
}


function parseChannelBrowse(browseData) {
  if (!browseData || typeof browseData !== 'object') return null;

  try {
    const header = browseData?.header?.c4TabbedHeaderRenderer
      || browseData?.header?.pageHeaderRenderer
      || browseData?.header?.carouselHeaderRenderer?.contents?.[0]?.topicChannelDetailsRenderer
      || browseData?.header?.interactiveTabbedHeaderRenderer
      || null;

    if (!header) return null;

    const name = getText(header?.title) || null;


    let handle = null;
    const handleText = getText(header?.channelHandleText);
    if (handleText) handle = handleText.startsWith('@') ? handleText : `@${handleText}`;
    if (!handle) {
      const canonicalUrl = header?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
      if (canonicalUrl?.startsWith('/@')) handle = canonicalUrl.substring(1);
    }

    const verified    = extractVerified(header?.badges);
    const subText     = getText(header?.subscriberCountText) || null;
    const videosText  = getText(header?.videosCountText) || null;
    
    const avatar = normalizeThumbs(header?.avatar || header?.thumbnail || header?.channelAvatarImageUrl);

    const banner    = normalizeThumbs(header?.banner);
    const tvBanner  = normalizeThumbs(header?.tvBanner);
    const mobBanner = normalizeThumbs(header?.mobileBanner);

    let description = null;
    try {
      const tabs = browseData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      outer: for (const tab of tabs) {
        const sections = dig(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents') || [];
        for (const sec of sections) {
          const items = sec?.itemSectionRenderer?.contents || [];
          for (const item of items) {
            const d = item?.channelAboutFullMetadataRenderer?.description
              || item?.structuredDescriptionContentRenderer?.items?.[0]?.expandableVideoDescriptionBodyRenderer?.attributedDescriptionBodyText;
            if (d) { description = getText(d); break outer; }
          }
        }
      }
    } catch {}


    let country = null;
    try {
      const tabs = browseData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      for (const tab of tabs) {
        const items = dig(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents', 0, 'itemSectionRenderer', 'contents') || [];
        for (const item of items) {
          const meta = item?.channelAboutFullMetadataRenderer;
          if (meta) {
            country = getText(meta.country) || null;
            break;
          }
        }
      }
    } catch {}

    return {
      name, handle, verified,
      subscriber_count: subText,
      videos_count:     videosText,
      description,
      country,
      avatar, banner, tv_banner: tvBanner, mobile_banner: mobBanner,
    };
  } catch { return null; }
}

async function resolvePlayerData(videoId, visitorData) {
  const clientOrder = ['TV_EMBEDDED', 'WEB_EMBEDDED', 'IOS', 'ANDROID', 'MWEB', 'WEB'];
  const results = {};

  const settled = await Promise.allSettled(
    clientOrder.map(async key => {
      const data = await callPlayer(key, videoId, visitorData);
      return { key, data };
    })
  );

  for (const r of settled) {
    if (r.status === 'fulfilled') {
      results[r.value.key] = r.value.data;
    }
  }

  let bestPR   = null;
  let bestKey  = null;

  for (const key of clientOrder) {
    const pr = results[key];
    if (!pr) continue;
    const status = pr?.playabilityStatus?.status;
    if (status === 'OK') {
      bestPR  = pr;
      bestKey = key;
      break;
    }
    if (!bestPR && pr?.videoDetails?.videoId) {
      bestPR  = pr;
      bestKey = key;
    }
  }

  return { bestPR, bestKey, allResults: results };
}



async function scrapeYouTubeMeta(videoId) {
  const debug = {
    html_fetched:    false,
    initial_data:    false,
    player_response: false,
    best_client:     null,
    client_statuses: {},
    next_api:        false,
    channel_browse:  false,
    errors:          [],
  };


  let html = '';
  try {
    html = await fetchWatchPage(videoId);
    debug.html_fetched = true;
  } catch (e) {
    debug.errors.push(`watch_page: ${e.message}`);
    throw new Error(`Watch page unavailable: ${e.message}`);
  }

  const visitorData    = extractVisitorData(html);
  const dynamicApiKey  = extractApiKey(html);
  const dynamicVersion = extractClientVersion(html);


  const initialData    = extractJsonBlock(html, 'ytInitialData');
  const embeddedPR     = extractJsonBlock(html, 'ytInitialPlayerResponse');

  debug.initial_data    = !!initialData;
  debug.player_response = !!embeddedPR;


  let earlyChannelId = null;
  try {
    earlyChannelId = embeddedPR?.videoDetails?.channelId
      || (() => {
        const contents = dig(initialData, 'contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents') || [];
        for (const c of contents) {
          const id = c?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
          if (id) return id;
        }
        return null;
      })();
  } catch {}


  const [playerResult, nextResult, browseResult] = await Promise.allSettled([
    resolvePlayerData(videoId, visitorData),
    callNext(videoId, visitorData, dynamicApiKey, dynamicVersion),
    earlyChannelId
      ? callBrowse(earlyChannelId, 'EgVhYm91dA%3D%3D', dynamicApiKey, dynamicVersion)
      : Promise.resolve(null),
  ]);


  let bestPR  = null;
  let bestKey = null;
  if (playerResult.status === 'fulfilled') {
    bestPR  = playerResult.value.bestPR;
    bestKey = playerResult.value.bestKey;
    debug.best_client = bestKey;
    for (const [k, v] of Object.entries(playerResult.value.allResults || {})) {
      debug.client_statuses[k] = {
        status:    v?.playabilityStatus?.status || 'ERROR',
        reason:    v?.playabilityStatus?.reason || null,
        has_video: !!v?.videoDetails?.videoId,
      };
    }
  } else {
    debug.errors.push(`player: ${playerResult.reason?.message}`);
  }


  const finalPR = bestPR || embeddedPR;

  let nextData = null;
  if (nextResult.status === 'fulfilled') {
    nextData = nextResult.value;
    debug.next_api = true;
  } else {
    debug.errors.push(`next: ${nextResult.reason?.message}`);
  }

  let browseData = null;
  if (browseResult.status === 'fulfilled' && browseResult.value) {
    browseData = browseResult.value;
    debug.channel_browse = true;
  } else if (browseResult.status === 'rejected') {
    debug.errors.push(`browse: ${browseResult.reason?.message}`);
  }


  const prParsed    = parsePlayerResponse(finalPR);
  const primary     = parsePrimaryInfo(initialData);
  const channelEx   = parseChannelBrowse(browseData);
  const chapters    = parseChapters(initialData);
  const playlist    = parsePlaylist(initialData);
  const related     = parseRelatedVideos(initialData, nextData, 30);


  let nextKeywords = [];
  try {
    const engagements = nextData?.engagementPanels || [];
    for (const ep of engagements) {
      const kws = dig(ep, 'engagementPanelSectionListRenderer', 'content', 'structuredDescriptionContentRenderer', 'items');
      if (kws) {

      }
    }
  } catch {}



  const title       = prParsed.title       || primary.title       || null;
  const description = primary.description  || prParsed.description || null;
  const duration    = prParsed.duration    || null;
  const viewCount   = prParsed.viewCount   || primary.viewCount   || null;
  const uploadDate  = prParsed.uploadDate  || primary.dateText    || null;
  const publishDate = prParsed.publishDate || null;
  const category    = prParsed.category    || null;


  const kwSet = new Set([
    ...prParsed.keywords,
    ...nextKeywords,
  ]);
  const keywords = [...kwSet];

  const chId       = prParsed.channelId || primary.channelId || earlyChannelId || null;
  const chName     = primary.channelName  || prParsed.author   || channelEx?.name     || null;
  const chUrl      = primary.channelUrl   || (chId ? `https://www.youtube.com/channel/${chId}` : null);
  const chVerified = primary.channelVerified || channelEx?.verified || false;
  const chSubs     = primary.subscriberText  || channelEx?.subscriber_count || null;

  const chThumbs   = primary.channelThumbs?.length > 0
    ? primary.channelThumbs
    : (channelEx?.avatar || []);

  const videoThumbs = buildVideoThumbs(videoId);


  const captions = prParsed.captions.length > 0
    ? prParsed.captions
    : (embeddedPR ? parsePlayerResponse(embeddedPR).captions : []);



  return {
    success:           true,
    extractor:         'youtube',
    extractor_version: VERSION,


    id:                videoId,
    title,
    description,
    duration,
    duration_string:   formatDuration(duration),


    view_count:        viewCount,
    like_count:        primary.likeCount    || null,
    upload_date:       uploadDate,
    publish_date:      publishDate,
    category,


    is_live:           prParsed.isLive        || false,
    is_live_content:   prParsed.isLiveContent || false,
    is_private:        prParsed.isPrivate     || false,
    is_unlisted:       prParsed.isUnlisted    || false,
    is_upcoming:       prParsed.isUpcoming    || false,
    is_age_restricted: prParsed.isAgeRestricted || false,
    is_family_safe:    prParsed.isFamilySafe  !== false,
    allow_ratings:     prParsed.allowRatings  ?? null,


    available_countries: prParsed.availableCountries || [],

    keywords,
    tags:              keywords,
    hashtags:          primary.hashtags || [],


    channel: {
      id:               chId,
      external_id:      prParsed.externalChannelId || null,
      name:             chName,
      url:              chUrl,
      verified:         chVerified,
      subscriber_count: chSubs,
      description:      channelEx?.description   || null,
      handle:           channelEx?.handle         || null,
      country:          channelEx?.country        || null,
      videos_count:     channelEx?.videos_count   || null,
      thumbnail:        chThumbs[0]?.url          || null,
      thumbnails:       chThumbs,
      banner:           channelEx?.banner         || [],
      tv_banner:        channelEx?.tv_banner      || [],
      mobile_banner:    channelEx?.mobile_banner  || [],
    },


    thumbnails:         videoThumbs,
    thumbnail:          videoThumbs[0]?.url || null,


    webpage_url:        `https://www.youtube.com/watch?v=${videoId}`,
    embed_url:          `https://www.youtube.com/embed/${videoId}`,
    short_url:          `https://youtu.be/${videoId}`,
    embed_info:         prParsed.embed || null,


    captions,
    subtitles:          captions,


    chapters,


    storyboards:        prParsed.storyboards || [],


    related_videos:     related,
    related_count:      related.length,


    playlist,


    description_links:  primary.descLinks || [],


    playability:        prParsed.playability || { status: null, reason: null },


    _debug: debug,
  };
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/yt-sc/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({
      success: false,
      error:   'Invalid YouTube video ID (must be exactly 11 characters)',
    });
  }

  try {
    const data = await scrapeYouTubeMeta(videoId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   err.message,
      videoId,
    });
  }
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "public", "error.html")));
app.use((err, req, res, next) => {
  res.status(500).sendFile(path.join(__dirname, "public", "error.html"));
});

app.listen(port, () => console.log(`Server is running on port \${port}`));
