/* Service worker — ทำให้แอปเปิดได้แม้ไม่มีเน็ต
 * แก้ไฟล์แอปแล้วให้เปลี่ยนเลข VERSION เพื่อให้มือถือโหลดของใหม่ */
const VERSION = 'v2';
const SHELL = 'shell-' + VERSION;
const FONTS = 'fonts-v1';
const FILES = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API ของ Google Sheet: ใช้เน็ตเสมอ ไม่เก็บแคช
  if (/script\.google(usercontent)?\.com$/.test(url.hostname) || url.hostname.endsWith('googleusercontent.com')) return;

  // ฟอนต์: เก็บไว้ครั้งแรก แล้วใช้จากเครื่อง
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // ไฟล์ของแอป: ใช้จากเครื่องก่อน แล้วอัปเดตเบื้องหลัง
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async c => {
      const key = req.mode === 'navigate' ? './index.html' : req;
      const hit = await c.match(key);
      const net = fetch(req).then(res => {
        if (res.ok && req.mode !== 'navigate') c.put(req, res.clone());
        if (res.ok && req.mode === 'navigate') c.put('./index.html', res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
  }
});
