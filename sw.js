/* 时间预算 · 离线管家（Service Worker）
 *
 * 它干什么：手机第一次打开时，把应用的那几个文件抄一份存在手机本地；
 *           以后没网（地铁、飞行模式）也能打开，而不是白屏。
 *
 * 策略 = 先联网取最新的，取到了顺手存一份；取不到就用存的那份。
 * 为什么不用「缓存优先」：那样你改了应用、推上新版，手机上还是旧的，
 * 而且很难查——对一个人维护的小项目，这个坑不值得踩。
 */

const CACHE = 'shijian-yusuan-v1';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// 安装：把应用文件抄一份进缓存
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 激活：清掉旧版本的缓存（改了 CACHE 版本号就会走到这里）
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 取文件：先联网 → 成功就存一份并返回；失败 → 用缓存里的
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // 站外请求不掺和

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match('./index.html'))
      )
  );
});
