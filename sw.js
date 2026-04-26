// MIN-Tube-Pro Service Worker
const CACHE_NAME = 'min-tube-pro-v1';
const PRECACHE = [
  '/public/min-tube-pro.html',
  '/img/min-tube-pro.png',
];

// インストール時: 静的リソースをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// 有効化時: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// フェッチ: キャッシュファースト → ネットワーク → オフラインフォールバック
self.addEventListener('fetch', event => {
  // POST等は無視
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(response => {
          // 正常レスポンスをキャッシュに追加
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // オフライン時: ナビゲーションはトップページを返す
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
        });
    })
  );
});
