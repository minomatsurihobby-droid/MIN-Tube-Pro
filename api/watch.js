// api/watch.js
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  try {
    const videoId = req.query && req.query.id ? String(req.query.id) : null;
    if (!videoId) {
      res.status(400).send('video id required (use /watch?id=VIDEO_ID)');
      return;
    }

    const host = req.headers.host || 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http') || 'https';
    const streamInfoUrl = `${proto}://${host}/stream/${encodeURIComponent(videoId)}`;

    const streamResp = await fetch(streamInfoUrl);
    if (!streamResp.ok) {
      const txt = await streamResp.text().catch(() => '');
      res.status(502).send(`Failed to fetch stream info: ${streamResp.status} ${txt}`);
      return;
    }
    const streamJson = await streamResp.json();

    const formats = Array.isArray(streamJson.formats) ? streamJson.formats : [];
    const adaptive = Array.isArray(streamJson.adaptiveFormats) ? streamJson.adaptiveFormats : [];
    const all = [...formats, ...adaptive].filter(Boolean);

    const muxed = [];
    const videoOnly = [];
    const audioOnly = [];

    for (const f of all) {
      if (!f || !f.url) continue;
      const mt = (f.mimeType || '').toLowerCase();
      const isAudio = mt.startsWith('audio/');
      const isVideo = mt.startsWith('video/');
      const hasAudio = isAudio || !!f.audioChannels || /audio/i.test(mt);
      const hasVideo = isVideo || /video/i.test(mt) || !!f.width || !!f.height;
      const item = {
        url: f.url,
        mimeType: f.mimeType || '',
        itag: f.itag || '',
        bitrate: f.bitrate || 0,
        qualityLabel: f.qualityLabel || f.quality || '',
        width: f.width || 0,
        height: f.height || 0,
        audioChannels: f.audioChannels || 0,
        hasVideo,
        hasAudio
      };
      if (item.hasVideo && item.hasAudio) muxed.push(item);
      else if (item.hasVideo) videoOnly.push(item);
      else if (item.hasAudio) audioOnly.push(item);
    }

    muxed.sort((a,b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
    videoOnly.sort((a,b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
    audioOnly.sort((a,b) => (b.bitrate || 0) - (a.bitrate || 0));

    const choices = [];

    for (const m of muxed) {
      choices.push({
        type: 'muxed',
        label: m.qualityLabel || (m.height ? `${m.height}p` : m.itag) || 'muxed',
        videoUrl: m.url,
        audioUrl: null,
        mimeType: m.mimeType || 'video/mp4',
        height: m.height || 0,
        itag: m.itag,
        hasAudio: true
      });
    }

    for (const v of videoOnly) {
      const bestAudio = audioOnly[0] || null;
      choices.push({
        type: 'separate',
        label: v.qualityLabel || (v.height ? `${v.height}p` : v.itag) || `${Math.round((v.bitrate||0)/1000)}kbps`,
        videoUrl: v.url,
        audioUrl: bestAudio ? bestAudio.url : null,
        mimeType: v.mimeType || 'video/mp4',
        height: v.height || 0,
        itag: v.itag,
        hasAudio: !!bestAudio
      });
    }

    if (choices.length === 0) {
      const nf = `<!doctype html><html><head><meta charset="utf-8"><title>No streams</title></head><body style="margin:0;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;"><div>No playable streams found for ${escapeHtml(videoId)}</div></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(404).send(nf);
      return;
    }

    // Choose initial index so that the default loaded stream includes audio if possible.
    // Prefer highest-resolution muxed (contains audio). If none, choose highest-res video-only paired with best audio.
    let initialIndex = -1;
    for (let i = 0; i < choices.length; i++) {
      if (choices[i].hasAudio) { initialIndex = i; break; }
    }
    if (initialIndex < 0) initialIndex = 0; // fallback

    const pageTitle = streamJson.title ? escapeHtml(String(streamJson.title)) : `Video ${escapeHtml(videoId)}`;
    const clientChoices = choices.map(c => ({
      type: c.type,
      label: c.label,
      videoUrl: c.videoUrl,
      audioUrl: c.audioUrl,
      mimeType: c.mimeType,
      height: c.height,
      itag: c.itag,
      hasAudio: c.hasAudio
    }));

    const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<title>${pageTitle}</title>
<style>
  :root{
    --bg:#000; --glass: rgba(255,255,255,0.04); --accent:#00d4ff; --accent2:#6ef0c5; --muted:#9fb3bb;
  }
  html,body{height:100%;margin:0;background:var(--bg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;color:#fff;overflow:hidden}
  #root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:black}
  video#player{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;transition:opacity 240ms ease}
  video#preloadTarget{position:fixed;left:-9999px;top:-9999px;width:320px;height:180px;visibility:hidden}
  audio#preloadAudio{position:fixed;left:-9999px;top:-9999px;visibility:hidden}
  audio#audioTrack{position:fixed;left:-9999px;top:-9999px;visibility:hidden}
  .overlay{position:absolute;left:12px;right:12px;bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:50;pointer-events:auto;background:linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.06));padding:10px;border-radius:12px}
  .left,.center,.right{display:flex;align-items:center;gap:10px}
  .btn{background:var(--glass);border:1px solid rgba(255,255,255,0.04);color:#e7fbff;padding:8px 12px;border-radius:10px;font-size:14px;cursor:pointer}
  .big{padding:10px 14px;font-weight:600}
  .select{background:rgba(0,0,0,0.5);color:#e7fbff;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.03)}
  .title{position:absolute;left:14px;top:12px;color:#fff;font-weight:600;font-size:15px;text-shadow:0 6px 20px rgba(0,0,0,0.8);max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:52}
  .time{font-size:13px;color:var(--muted)}
  .progress{width:420px;height:8px;background:rgba(255,255,255,0.03);border-radius:6px;overflow:hidden;cursor:pointer}
  .bar{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));width:0%}
  .pill{background:rgba(255,255,255,0.03);padding:6px 10px;border-radius:999px;color:#def7f5;font-size:13px}
  .status{font-size:13px;color:var(--muted)}
  .center-play{
    position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;display:flex;align-items:center;justify-content:center;
    width:72px;height:72px;border-radius:50%;background:linear-gradient(180deg, rgba(0,0,0,0.32), rgba(0,0,0,0.45));backdrop-filter:blur(6px);
    cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,0.6);transition:transform 160ms ease,opacity 160ms ease;
  }
  .center-play.hidden{opacity:0;transform:translate(-50%,-50%) scale(0.96);pointer-events:none}
  .play-icon{width:36px;height:36px;fill:#fff;filter:drop-shadow(0 6px 18px rgba(0,0,0,0.6))}
  .pause-icon{width:36px;height:36px;fill:#fff;filter:drop-shadow(0 6px 18px rgba(0,0,0,0.6))}
  .spinner{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:70;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45)}
  .spinner svg{width:36px;height:36px;animation:spin 1s linear infinite;opacity:0.95}
  @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
  @media (max-width:860px){ .progress{width:220px} .center-play{width:64px;height:64px} .play-icon{width:30px;height:30px} }
  @media (max-width:480px){ .overlay{left:8px;right:8px;bottom:10px;padding:8px} .title{left:10px;top:8px;font-size:13px} }
</style>
</head>
<body>
  <div id="root" role="application" aria-label="${pageTitle}">
    <div class="title" id="pageTitle">${pageTitle}</div>

    <video id="player" playsinline preload="metadata">
      <source id="videoSource" src="${escapeAttr(clientChoices[initialIndex].videoUrl)}" type="video/mp4">
      Your browser does not support HTML5 video.
    </video>

    <video id="preloadTarget" playsinline preload="metadata"></video>
    <audio id="preloadAudio"></audio>
    <audio id="audioTrack" preload="auto"></audio>

    <div id="spinner" class="spinner" aria-hidden="true" style="display:none">
      <svg viewBox="0 0 50 50" aria-hidden="true">
        <circle cx="25" cy="25" r="20" stroke="white" stroke-width="4" stroke-linecap="round" stroke-dasharray="31.4 31.4" fill="none"></circle>
      </svg>
    </div>

    <div id="centerPlay" class="center-play" role="button" aria-label="Play">
      <svg id="centerPlayIcon" class="play-icon" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M34 24 L78 50 L34 76 z"></path>
      </svg>
    </div>

    <div class="overlay" role="group" aria-label="player controls">
      <div class="left">
        <button id="playPause" class="btn big" aria-label="Play or pause" title="Play">
          <svg id="playPauseIcon" class="play-icon" viewBox="0 0 100 100" aria-hidden="true">
            <path d="M34 24 L78 50 L34 76 z"></path>
          </svg>
        </button>

        <div class="pill" id="qualityLabel">--</div>
        <div class="status" id="syncStatus">sync: --</div>
      </div>

      <div class="center" style="flex:1;justify-content:center">
        <div class="progress" id="progress" title="Seek">
          <div class="bar" id="progressBar"></div>
        </div>
        <div style="width:12px"></div>
        <div class="time"><span id="current">0:00</span> / <span id="duration">0:00</span></div>
      </div>

      <div class="right">
        <select id="quality" class="select" aria-label="Quality selector"></select>
        <button id="pip" class="btn" title="Picture-in-Picture">PiP</button>
        <button id="open" class="btn" title="Open raw stream">Open</button>
        <label style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;margin-left:6px">
          <input id="muteToggle" type="checkbox" /> Mute video
        </label>
      </div>
    </div>
  </div>

<script>
(() => {
  const choices = ${JSON.stringify(clientChoices)};
  const player = document.getElementById('player');
  const preloadTarget = document.getElementById('preloadTarget');
  const preloadAudio = document.getElementById('preloadAudio');
  const audioTrack = document.getElementById('audioTrack');
  const qualitySelect = document.getElementById('quality');
  const playPauseBtn = document.getElementById('playPause');
  const playPauseIcon = document.getElementById('playPauseIcon');
  const pipBtn = document.getElementById('pip');
  const openBtn = document.getElementById('open');
  const qualityLabel = document.getElementById('qualityLabel');
  const syncStatus = document.getElementById('syncStatus');
  const currentLabel = document.getElementById('current');
  const durationLabel = document.getElementById('duration');
  const progress = document.getElementById('progress');
  const progressBar = document.getElementById('progressBar');
  const muteToggle = document.getElementById('muteToggle');
  const centerPlay = document.getElementById('centerPlay');
  const centerPlayIcon = document.getElementById('centerPlayIcon');
  const spinner = document.getElementById('spinner');

  let selectedIndex = ${initialIndex};
  let syncInterval = null;
  let userSeeking = false;
  let restoring = false;
  let autoplaySucceeded = false;
  let switching = false;
  let userPaused = false;

  function setPlayIcon(isPlaying){
    if (isPlaying) {
      playPauseIcon.innerHTML = '<rect x="32" y="24" width="10" height="52" rx="2"></rect><rect x="58" y="24" width="10" height="52" rx="2"></rect>';
      centerPlayIcon.innerHTML = '<rect x="32" y="24" width="10" height="52" rx="2"></rect><rect x="58" y="24" width="10" height="52" rx="2"></rect>';
      playPauseBtn.title = 'Pause';
      playPauseBtn.setAttribute('aria-label','Pause');
      centerPlay.setAttribute('aria-label','Pause');
    } else {
      playPauseIcon.innerHTML = '<path d="M34 24 L78 50 L34 76 z"></path>';
      centerPlayIcon.innerHTML = '<path d="M34 24 L78 50 L34 76 z"></path>';
      playPauseBtn.title = 'Play';
      playPauseBtn.setAttribute('aria-label','Play');
      centerPlay.setAttribute('aria-label','Play');
    }
  }
  setPlayIcon(false);

  choices.forEach((c, i) => {
    const label = c.height ? (c.height + 'p') : c.label;
    const desc = c.type === 'separate' ? (c.audioUrl ? ' (separate audio)' : ' (video-only)') : '';
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = label + desc;
    qualitySelect.appendChild(opt);
  });
  qualitySelect.value = selectedIndex;
  updateQualityLabel();

  function updateQualityLabel(){
    const c = choices[selectedIndex];
    qualityLabel.textContent = c.height ? (c.height + 'p') : c.label;
  }

  function formatTime(t){
    if (!isFinite(t) || t < 0) return '0:00';
    t = Math.floor(t);
    const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = t%60;
    if (h>0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    return m + ':' + String(s).padStart(2,'0');
  }

  player.addEventListener('timeupdate', () => {
    if (!userSeeking) {
      const pct = (player.currentTime && player.duration) ? (player.currentTime / player.duration) * 100 : 0;
      progressBar.style.width = pct + '%';
    }
    currentLabel.textContent = formatTime(player.currentTime);
  });
  player.addEventListener('loadedmetadata', () => {
    durationLabel.textContent = formatTime(player.duration);
  });

  function updatePlayButton(){ setPlayIcon(!player.paused && !player.ended); }

  playPauseBtn.addEventListener('click', async () => {
    if (player.paused) {
      userPaused = false;
      try {
        // If selected choice has separate audio and audio exists, ensure audioTrack is set and will play on user gesture.
        if (choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) {
          audioTrack.src = choices[selectedIndex].audioUrl;
          audioTrack.load();
        }
        await player.play();
        if (choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) {
          try { await audioTrack.play(); } catch(e){ console.warn('audio play failed', e); }
        }
      } catch(e){ console.warn('play error', e); }
    } else {
      userPaused = true;
      player.pause();
      try { audioTrack.pause(); } catch(e){}
    }
    updatePlayButton();
    if (!player.paused) hideCenterPlay(); else showCenterPlay();
  });

  player.addEventListener('play', () => { updatePlayButton(); hideCenterPlay(); });
  player.addEventListener('pause', () => { updatePlayButton(); showCenterPlay(); });

  centerPlay.addEventListener('click', async () => {
    if (player.paused) {
      userPaused = false;
      try {
        if (choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) {
          audioTrack.src = choices[selectedIndex].audioUrl;
          audioTrack.load();
        } else {
          player.muted = false;
        }
        await player.play();
        if (choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) {
          try { await audioTrack.play(); } catch(e){ console.warn('audio play failed', e); }
        } else {
          player.muted = false;
        }
        hideCenterPlay();
      } catch(e){ console.warn('center play failed', e); }
    } else {
      userPaused = true;
      player.pause();
    }
    updatePlayButton();
  });

  function showCenterPlay(){ centerPlay.classList.remove('hidden'); }
  function hideCenterPlay(){ centerPlay.classList.add('hidden'); }

  let progressRect = null;
  progress.addEventListener('pointerdown', (ev) => {
    progressRect = progress.getBoundingClientRect();
    userSeeking = true;
    seekFromPointer(ev);
    const onMove = (e) => seekFromPointer(e);
    const onUp = (e) => { seekFromPointer(e); userSeeking = false; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  function seekFromPointer(ev){
    if (!progressRect) progressRect = progress.getBoundingClientRect();
    const x = (ev.clientX || (ev.touches && ev.touches[0] && ev.touches[0].clientX) || 0) - progressRect.left;
    const pct = Math.max(0, Math.min(1, x / progressRect.width));
    if (player.duration) {
      const t = player.duration * pct;
      try { player.currentTime = t; } catch(e){ console.warn(e); }
      if (choices[selectedIndex] && choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) {
        try { audioTrack.currentTime = t; } catch(e){}
      }
      progressBar.style.width = (pct*100) + '%';
    }
  }

  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (player.requestPictureInPicture) await player.requestPictureInPicture();
    } catch(e){ console.warn('PiP error', e); }
  });

  openBtn.addEventListener('click', () => {
    const c = choices[selectedIndex];
    if (c) window.open(c.videoUrl, '_blank', 'noopener');
  });

  qualitySelect.addEventListener('change', () => {
    const newIndex = Number(qualitySelect.value);
    if (newIndex === selectedIndex) return;
    seamlessSwitch(newIndex).catch(e => console.warn('seamless switch error', e));
  });

  muteToggle.addEventListener('change', () => {
    player.muted = muteToggle.checked;
  });

  function shouldUseSeparateAudioIndex(idx){
    const c = choices[idx];
    return c && c.type === 'separate' && c.audioUrl;
  }
  function shouldUseSeparateAudio(){ return shouldUseSeparateAudioIndex(selectedIndex); }

  function showSpinner(){ spinner.style.display = ''; spinner.setAttribute('aria-hidden','false'); }
  function hideSpinner(){ spinner.style.display = 'none'; spinner.setAttribute('aria-hidden','true'); }

  async function switchStreamBasic(index){
    const c = choices[index];
    if (!c) return;
    selectedIndex = index;
    updateQualityLabel();
    const wasPlaying = !player.paused && !player.ended;
    const currTime = player.currentTime || 0;
    const vidSource = document.getElementById('videoSource');
    vidSource.src = c.videoUrl;
    vidSource.type = 'video/mp4';
    while (player.firstChild) player.removeChild(player.firstChild);
    player.appendChild(vidSource);

    if (c.type === 'separate' && c.audioUrl) {
      audioTrack.src = c.audioUrl;
    } else {
      audioTrack.removeAttribute('src');
      audioTrack.load();
    }
    restoring = true;
    player.load();

    await new Promise(resolve => {
      const onVideoMeta = () => {
        try { player.currentTime = Math.max(0, Math.min(currTime, player.duration || currTime)); } catch(e){}
        player.removeEventListener('loadedmetadata', onVideoMeta);
        resolve();
      };
      player.addEventListener('loadedmetadata', onVideoMeta);
      setTimeout(resolve, 4000);
    });

    if (c.type === 'separate' && c.audioUrl) {
      audioTrack.load();
      await new Promise(resolve => {
        const onAudioMeta = () => { try { audioTrack.currentTime = player.currentTime || 0; } catch(e){}; audioTrack.removeEventListener('loadedmetadata', onAudioMeta); resolve(); };
        audioTrack.addEventListener('loadedmetadata', onAudioMeta);
        setTimeout(resolve, 4000);
      });
    }

    if (wasPlaying) {
      try { await Promise.allSettled([player.play(), shouldUseSeparateAudio() ? audioTrack.play() : Promise.resolve()]); } catch(e){}
    }
    restoring = false;
    startSyncLoop();
  }

  async function seamlessSwitch(newIndex){
    if (switching) return;
    switching = true;
    showSpinner();
    const prevIndex = selectedIndex;
    const prevTime = player.currentTime || 0;
    const wasPlaying = !player.paused && !player.ended;
    const newChoice = choices[newIndex];
    if (!newChoice) { switching = false; hideSpinner(); return; }

    preloadTarget.pause();
    preloadTarget.removeAttribute('src');
    preloadTarget.src = newChoice.videoUrl;
    preloadTarget.load();

    if (newChoice.type === 'separate' && newChoice.audioUrl) {
      preloadAudio.pause();
      preloadAudio.removeAttribute('src');
      preloadAudio.src = newChoice.audioUrl;
      preloadAudio.load();
    } else {
      preloadAudio.pause();
      preloadAudio.removeAttribute('src');
    }

    const waitForPlayableBoth = () => new Promise(resolve => {
      let videoReady = false;
      let audioReady = !shouldUseSeparateAudioIndex(newIndex);
      let resolved = false;

      const checkResolve = () => { if (videoReady && audioReady && !resolved) { resolved = true; cleanup(); resolve(true); } };

      const onVideoCan = () => { videoReady = true; checkResolve(); };
      const onVideoErr = () => { if (!resolved) { resolved = true; cleanup(); resolve(false); } };

      const onAudioMeta = () => { audioReady = true; checkResolve(); };
      const onAudioErr = () => { if (!resolved) { resolved = true; cleanup(); resolve(false); } };

      const cleanup = () => {
        preloadTarget.removeEventListener('canplay', onVideoCan);
        preloadTarget.removeEventListener('canplaythrough', onVideoCan);
        preloadTarget.removeEventListener('error', onVideoErr);
        preloadAudio.removeEventListener('loadedmetadata', onAudioMeta);
        preloadAudio.removeEventListener('error', onAudioErr);
      };

      preloadTarget.addEventListener('canplay', onVideoCan);
      preloadTarget.addEventListener('canplaythrough', onVideoCan);
      preloadTarget.addEventListener('error', onVideoErr);

      if (shouldUseSeparateAudioIndex(newIndex)) {
        preloadAudio.addEventListener('loadedmetadata', onAudioMeta);
        preloadAudio.addEventListener('error', onAudioErr);
      }

      setTimeout(() => { if (!resolved) { resolved = true; cleanup(); resolve(false); } }, 8000);
    });

    const playable = await waitForPlayableBoth();
    if (!playable) {
      await switchStreamBasic(newIndex);
      switching = false;
      hideSpinner();
      return;
    }

    try { if (isFinite(preloadTarget.duration)) preloadTarget.currentTime = Math.max(0, Math.min(prevTime, preloadTarget.duration)); } catch(e){}
    if (shouldUseSeparateAudioIndex(newIndex)) {
      try { if (isFinite(preloadAudio.duration)) preloadAudio.currentTime = Math.max(0, Math.min(prevTime, preloadAudio.duration)); } catch(e){}
    }

    const vidSource = document.getElementById('videoSource');
    vidSource.src = newChoice.videoUrl;
    vidSource.type = 'video/mp4';
    while (player.firstChild) player.removeChild(player.firstChild);
    player.appendChild(vidSource);

    if (newChoice.type === 'separate' && newChoice.audioUrl) {
      audioTrack.pause();
      audioTrack.removeAttribute('src');
      audioTrack.src = newChoice.audioUrl;
    } else {
      audioTrack.pause();
      audioTrack.removeAttribute('src');
    }

    player.load();
    await new Promise(resolve => {
      const onMeta = () => {
        try { player.currentTime = Math.max(0, Math.min(preloadTarget.currentTime || prevTime, player.duration || preloadTarget.currentTime || prevTime)); } catch(e){}
        player.removeEventListener('loadedmetadata', onMeta);
        resolve();
      };
      player.addEventListener('loadedmetadata', onMeta);
      setTimeout(resolve, 4000);
    });

    if (newChoice.type === 'separate' && newChoice.audioUrl) {
      audioTrack.load();
      await new Promise(resolve => {
        const onAudioMeta = () => { try { audioTrack.currentTime = player.currentTime || 0; } catch(e){}; audioTrack.removeEventListener('loadedmetadata', onAudioMeta); resolve(); };
        audioTrack.addEventListener('loadedmetadata', onAudioMeta);
        setTimeout(resolve, 4000);
      });
    }

    if (wasPlaying) {
      try {
        const playPromises = [player.play()];
        if (newChoice.type === 'separate' && newChoice.audioUrl) playPromises.push(audioTrack.play());
        await Promise.allSettled(playPromises);
      } catch(e){ console.warn('resume after switch failed', e); }
    }

    selectedIndex = newIndex;
    updateQualityLabel();
    startSyncLoop();
    switching = false;
    hideSpinner();

    try { preloadTarget.pause(); preloadTarget.removeAttribute('src'); preloadTarget.load(); } catch(e){}
    try { preloadAudio.pause(); preloadAudio.removeAttribute('src'); preloadAudio.load(); } catch(e){}
  }

  function startSyncLoop(){
    stopSyncLoop();
    const c = choices[selectedIndex];
    if (!c || !(c.type === 'separate' && c.audioUrl)) {
      syncStatus.textContent = 'sync: muxed';
      return;
    }
    syncStatus.textContent = 'sync: active';
    syncInterval = setInterval(() => {
      try {
        if (player.paused && audioTrack.paused) return;
        const vt = player.currentTime || 0;
        const at = audioTrack.currentTime || 0;
        const drift = at - vt;
        if (Math.abs(drift) > 0.25) {
          try { audioTrack.currentTime = vt; } catch(e){}
          audioTrack.playbackRate = 1;
        } else if (Math.abs(drift) > 0.03) {
          const adjust = 1 - drift * 0.12;
          const ar = Math.max(0.95, Math.min(1.05, adjust));
          audioTrack.playbackRate = ar;
          player.playbackRate = 1;
        } else {
          if (audioTrack.playbackRate !== 1) audioTrack.playbackRate = 1;
        }
        syncStatus.textContent = 'sync: ' + (drift).toFixed(2) + 's';
      } catch(e){ console.warn('sync error', e); }
    }, 300);
  }
  function stopSyncLoop(){ if (syncInterval) { clearInterval(syncInterval); syncInterval = null; } }

  player.addEventListener('play', async () => {
    if (choices[selectedIndex] && choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) {
      try { await audioTrack.play(); } catch(e){ console.warn('audio play fail', e); }
    }
    startSyncLoop();
  });
  player.addEventListener('pause', () => {
    if (choices[selectedIndex] && choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) try { audioTrack.pause(); } catch(e){}
    stopSyncLoop();
  });
  audioTrack.addEventListener('play', () => { if (player.paused) player.play().catch(()=>{}); });
  audioTrack.addEventListener('pause', () => { if (!player.paused) player.pause(); });

  audioTrack.addEventListener('ended', () => { syncStatus.textContent = 'sync: audio ended'; });
  player.addEventListener('ended', () => { syncStatus.textContent = 'sync: video ended'; stopSyncLoop(); showCenterPlay(); });

  // Visibility handling: do not auto-pause on tab switch; attempt gentle resume on return if playback unexpectedly stopped
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(() => {
        if (!userPaused && player.paused && !player.ended) {
          player.play().catch(()=>{});
          if (shouldUseSeparateAudio()) audioTrack.play().catch(()=>{});
        }
      }, 150);
    }
  });

  // Recover from short stalls
  let lastWaitingAt = 0;
  player.addEventListener('waiting', () => {
    lastWaitingAt = Date.now();
    showSpinner();
    setTimeout(() => {
      if (Date.now() - lastWaitingAt >= 500) {
        player.play().catch(()=>{});
        if (shouldUseSeparateAudio()) audioTrack.play().catch(()=>{});
      }
    }, 600);
  });
  player.addEventListener('playing', () => { hideSpinner(); });
  player.addEventListener('canplay', () => { hideSpinner(); });

  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') { ev.preventDefault(); if (player.paused) player.play(); else player.pause(); }
    if (ev.code === 'ArrowRight') { player.currentTime = Math.min(player.duration || 0, player.currentTime + 5); if (choices[selectedIndex] && choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) audioTrack.currentTime = player.currentTime; }
    if (ev.code === 'ArrowLeft') { player.currentTime = Math.max(0, player.currentTime - 5); if (choices[selectedIndex] && choices[selectedIndex].type === 'separate' && choices[selectedIndex].audioUrl) audioTrack.currentTime = player.currentTime; }
  });

  // initial load: ensure default selectedIndex points to choice with audio when possible
  player.muted = false; // default unmuted so audio will play when user starts playback
  // Set initial media sources to selectedIndex, ensuring audio source if separate
  (async () => {
    try {
      const c = choices[selectedIndex];
      if (!c) return;
      // set main video src
      const vidSource = document.getElementById('videoSource');
      vidSource.src = c.videoUrl;
      vidSource.type = 'video/mp4';
      while (player.firstChild) player.removeChild(player.firstChild);
      player.appendChild(vidSource);

      // set audio if separate
      if (c.type === 'separate' && c.audioUrl) {
        audioTrack.src = c.audioUrl;
        audioTrack.load();
      } else {
        audioTrack.removeAttribute('src');
      }

      // load metadata for both to update UI quickly
      player.load();
      player.addEventListener('loadedmetadata', () => {
        durationLabel.textContent = formatTime(player.duration);
      });

      if (c.type === 'separate' && c.audioUrl) {
        audioTrack.addEventListener('loadedmetadata', () => {
          // ensure audio time synced display after metadata
          try { audioTrack.currentTime = player.currentTime || 0; } catch(e){}
        });
      }

      // Do not force autoplay; show center play for user to start playback with sound
      showCenterPlay();
      updateQualityLabel();
    } catch (e) {
      console.warn('initial setup error', e);
    }
  })();

  window.addEventListener('beforeunload', () => { stopSyncLoop(); try { player.pause(); audioTrack.pause(); } catch(e){} });

})();
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    console.error('api/watch error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal server error', details: String(err) });
  }
};

// helpers
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function escapeAttr(s){ return escapeHtml(String(s)).replace(/\n/g,'').replace(/\r/g,''); }
