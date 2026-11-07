/* คลังศัพท์ญี่ปุ่น — แอปทบทวนคำศัพท์ ซิงค์กับ Google Sheet ผ่าน Apps Script
 * ข้อมูลเก็บในเครื่อง (IndexedDB) ใช้ได้แม้ไม่มีเน็ต
 * สถานะ: 'pass' = จำได้ (ไม่เอามาทบทวนอีก), 'fail' = จำไม่ได้, '' = ยังไม่ทบทวน
 */
'use strict';

/* ================= IndexedDB ================= */
const DB_NAME = 'jpvocab';
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function dbAll(store) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
async function dbWrite(store, fn) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    fn(t.objectStore(store));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/* ================= สถานะของแอป ================= */
const LS = {
  get url() { return localStorage.getItem('apiUrl') || ''; },
  set url(v) { localStorage.setItem('apiUrl', v); },
  get token() { return localStorage.getItem('apiToken') || ''; },
  set token(v) { localStorage.setItem('apiToken', v); },
  get lesson() { return localStorage.getItem('lesson') || ''; },
  set lesson(v) { localStorage.setItem('lesson', v); },
  get lastSync() { return Number(localStorage.getItem('lastSync') || 0); },
  set lastSync(v) { localStorage.setItem('lastSync', String(v)); },
  get shuffle() { return localStorage.getItem('shuffle') !== '0'; },
  set shuffle(v) { localStorage.setItem('shuffle', v ? '1' : '0'); }
};

let items = [];                 // คำทั้งหมด
let byId = new Map();
let pendingCount = 0;
let queue = [];                 // id ที่รอทบทวน (ตัวแรก = การ์ดปัจจุบัน)
let revealed = false;
let syncing = false;

const $ = id => document.getElementById(id);

/* ================= เริ่มต้น ================= */
init();

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  bindUI();
  items = await dbAll('items');
  pendingCount = (await dbAll('pending')).length;
  indexItems();
  refreshLessonOptions();
  buildQueue();
  renderAll();

  if (!LS.url || !LS.token) {
    showView('settings');
    toast('ใส่ URL และ TOKEN ก่อนเริ่มใช้');
  } else {
    sync();
  }
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - LS.lastSync > 60 * 1000) sync();
  });
}

function indexItems() {
  items.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  byId = new Map(items.map(it => [it.id, it]));
}

/* ================= ซิงค์ ================= */
async function sync() {
  if (syncing) return;
  if (!LS.url || !LS.token) { setSyncLabel('ยังไม่ตั้งค่า'); return; }
  if (!navigator.onLine) { setSyncLabel('ออฟไลน์'); return; }
  syncing = true;
  setSyncLabel('กำลังซิงค์…', true);
  try {
    // 1) ส่งสถานะที่ค้างอยู่ขึ้น Sheet
    const pend = await dbAll('pending');
    if (pend.length) {
      const r = await fetch(LS.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // กัน CORS preflight
        body: JSON.stringify({ token: LS.token, updates: pend })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'ส่งสถานะไม่สำเร็จ');
      // ลบเฉพาะรายการที่ส่งไปแล้วและยังไม่ถูกกดเปลี่ยนระหว่างส่ง
      const now = new Map((await dbAll('pending')).map(p => [p.id, p]));
      await dbWrite('pending', s => pend.forEach(p => {
        const cur = now.get(p.id);
        if (cur && cur.ts === p.ts) s.delete(p.id);
      }));
    }

    // 2) ดึงคำศัพท์ทั้งหมดจาก Sheet
    const sep = LS.url.includes('?') ? '&' : '?';
    const r2 = await fetch(LS.url + sep + 'token=' + encodeURIComponent(LS.token) + '&t=' + Date.now());
    const j2 = await r2.json();
    if (!j2.ok) throw new Error(j2.error || 'ดึงข้อมูลไม่สำเร็จ');

    const still = await dbAll('pending');
    const pm = new Map(still.map(p => [p.id, p]));
    const oldIds = new Set(items.map(i => i.id));
    const fresh = (j2.items || []).filter(it => it.id).map(it =>
      pm.has(it.id) ? Object.assign({}, it, { status: pm.get(it.id).status }) : it);
    const added = fresh.filter(it => !oldIds.has(it.id)).length;

    await dbWrite('items', s => { s.clear(); fresh.forEach(it => s.put(it)); });
    items = fresh;
    pendingCount = still.length;
    indexItems();
    LS.lastSync = Date.now();
    refreshLessonOptions();
    mergeQueue();
    renderAll();
    toast(added ? `ซิงค์แล้ว · คำใหม่ ${added} คำ` : `ซิงค์แล้ว · ${items.length} คำ`);
  } catch (e) {
    toast('ซิงค์ไม่สำเร็จ: ' + (e.message || e));
  } finally {
    syncing = false;
    setSyncLabel();
  }
}

function setSyncLabel(text, busy) {
  const btn = $('syncBtn');
  btn.classList.toggle('busy', !!busy);
  if (text) { $('syncLabel').textContent = text; return; }
  if (!navigator.onLine) { $('syncLabel').textContent = 'ออฟไลน์'; return; }
  $('syncLabel').textContent = pendingCount ? `ซิงค์ (ค้าง ${pendingCount})` : 'ซิงค์';
}

/* ================= เปลี่ยนสถานะ ================= */
async function setStatus(id, status) {
  const it = byId.get(id);
  if (!it) return;
  it.status = status;
  it.reviewed_at = status ? new Date().toISOString() : '';
  const rec = { id, status, ts: Date.now() };
  await dbWrite('items', s => s.put(it));
  await dbWrite('pending', s => s.put(rec));
  pendingCount = (await dbAll('pending')).length;
  setSyncLabel();
  schedulePush();
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { if (navigator.onLine) sync(); }, 4000);
}

/* ================= คิวทบทวน ================= */
function lessonMatch(it, lesson) { return !lesson || it.lesson === lesson; }

function eligible() {
  return items.filter(it => it.status !== 'pass' && lessonMatch(it, LS.lesson));
}

function buildQueue() {
  let list = eligible();
  // คำที่ "จำไม่ได้" มาก่อน แล้วตามด้วยคำที่ยังไม่เคยทบทวน
  const fail = list.filter(i => i.status === 'fail');
  const fresh = list.filter(i => i.status !== 'fail');
  if (LS.shuffle) { shuffle(fail); shuffle(fresh); }
  queue = fail.concat(fresh).map(i => i.id);
  revealed = false;
}

/** หลังซิงค์: เก็บลำดับเดิมไว้ ตัดคำที่ผ่าน/ถูกลบ เติมคำใหม่ต่อท้าย */
function mergeQueue() {
  const ok = new Set(eligible().map(i => i.id));
  const cur = queue[0];
  queue = queue.filter(id => ok.has(id));
  const inQ = new Set(queue);
  const extra = [...ok].filter(id => !inQ.has(id));
  if (LS.shuffle) shuffle(extra);
  queue = queue.concat(extra);
  if (queue[0] !== cur) revealed = false;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function answer(passed) {
  const id = queue[0];
  if (!id) return;
  queue.shift();
  if (passed) {
    await setStatus(id, 'pass');           // จำได้ → ไม่เอามาอีก
  } else {
    await setStatus(id, 'fail');           // จำไม่ได้ → วนกลับมาอีกในอีกไม่กี่ใบ
    const pos = Math.min(queue.length, 4);
    queue.splice(pos, 0, id);
  }
  revealed = false;
  renderReview();
  if ($('view-list').classList.contains('active')) renderList();
}

/* ================= แสดงผล ================= */
function renderAll() { renderReview(); renderList(); renderSettings(); setSyncLabel(); }

function renderReview() {
  const total = items.filter(it => lessonMatch(it, LS.lesson)).length;
  const passed = items.filter(it => lessonMatch(it, LS.lesson) && it.status === 'pass').length;
  $('progress').textContent = total
    ? `เหลือ ${queue.length} คำ · ผ่านแล้ว ${passed}/${total}`
    : '';

  const id = queue[0];
  const it = id && byId.get(id);
  const hasCard = !!it;
  $('card').classList.toggle('hidden', !hasCard);
  $('answerRow').classList.toggle('hidden', !hasCard);
  $('emptyState').classList.toggle('hidden', hasCard);

  if (!hasCard) {
    $('emptyState').innerHTML = items.length
      ? `<div class="big">ผ่านครบทุกคำแล้ว</div>ถ้าอยากทบทวนคำไหนอีก ไปที่แท็บ "คำศัพท์" แล้วกด "ล้างสถานะ"`
      : `<div class="big">ยังไม่มีคำศัพท์</div>ตั้งค่า URL/TOKEN แล้วกดซิงค์`;
    return;
  }

  const front = it.kanji || it.reading;
  $('cardLesson').textContent = it.lesson + (it.status === 'fail' ? ' · เคยจำไม่ได้' : '');
  $('cardFront').textContent = front;
  $('cardFront').classList.toggle('long', front.length > 5);
  $('cardReading').textContent = it.kanji ? it.reading : '';
  $('cardMeaning').textContent = it.meaning;
  $('cardExJp').textContent = it.example_jp;
  $('cardExTh').textContent = it.example_th;
  $('cardExample').classList.toggle('hidden', !it.example_jp && !it.example_th);
  $('speakEx').classList.toggle('hidden', !it.example_jp);
  $('cardBack').classList.toggle('hidden', !revealed);
  $('revealBtn').classList.toggle('hidden', revealed);
}

const PAGE = 200;
let listLimit = PAGE;

function renderList() {
  const q = $('searchBox').value.trim().toLowerCase();
  const lesson = $('lessonSelect2').value;
  const st = $('statusSelect').value;
  const rows = items.filter(it => {
    if (lesson && it.lesson !== lesson) return false;
    if (st === 'pass' && it.status !== 'pass') return false;
    if (st === 'fail' && it.status !== 'fail') return false;
    if (st === 'new' && it.status) return false;
    if (st === 'todo' && it.status === 'pass') return false;
    if (!q) return true;
    return [it.kanji, it.reading, it.meaning, it.example_jp, it.example_th]
      .some(v => (v || '').toLowerCase().includes(q));
  });
  $('listCount').textContent = `${rows.length} คำ`;
  const box = $('list');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  rows.slice(0, listLimit).forEach(it => frag.appendChild(rowEl(it)));
  box.appendChild(frag);
  $('moreBtn').classList.toggle('hidden', rows.length <= listLimit);
}

function badge(status) {
  if (status === 'pass') return '<span class="badge pass">ผ่าน</span>';
  if (status === 'fail') return '<span class="badge fail">ไม่ผ่าน</span>';
  return '<span class="badge">ยังไม่ทบทวน</span>';
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rowEl(it) {
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `
    <div class="row-main">
      <div class="row-word jp">${esc(it.kanji || it.reading)}</div>
      <div class="row-text">
        <div class="row-reading jp">${it.kanji ? esc(it.reading) : ''}</div>
        <div class="row-meaning">${esc(it.meaning)}</div>
      </div>
      ${badge(it.status)}
    </div>
    <div class="row-detail hidden">
      ${it.example_jp || it.example_th ? `<div class="example"><div class="ex-jp jp">${esc(it.example_jp)}</div><div class="ex-th">${esc(it.example_th)}</div></div>` : ''}
      <div class="row-actions">
        <button type="button" class="chip" data-act="say">ฟังคำ</button>
        ${it.example_jp ? '<button type="button" class="chip" data-act="sayex">ฟังประโยค</button>' : ''}
        <button type="button" class="chip pass" data-act="pass">ผ่าน</button>
        <button type="button" class="chip fail" data-act="fail">ไม่ผ่าน</button>
        <button type="button" class="chip" data-act="clear">ล้างสถานะ</button>
      </div>
    </div>`;
  d.querySelector('.row-main').addEventListener('click', () =>
    d.querySelector('.row-detail').classList.toggle('hidden'));
  d.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async ev => {
    ev.stopPropagation();
    const act = b.dataset.act;
    if (act === 'say') return playWord(it);
    if (act === 'sayex') return speak(it.example_jp);
    await setStatus(it.id, act === 'clear' ? '' : act);
    mergeQueue();
    renderReview();
    const fresh = rowEl(it);
    fresh.querySelector('.row-detail').classList.remove('hidden');   // เปิดค้างไว้เหมือนเดิม
    d.replaceWith(fresh);
  }));
  return d;
}

function refreshLessonOptions() {
  const lessons = [...new Set(items.map(i => i.lesson).filter(Boolean))].sort();
  [['lessonSelect', LS.lesson], ['lessonSelect2', $('lessonSelect2').value]].forEach(([sid, val]) => {
    const sel = $(sid);
    sel.innerHTML = '<option value="">ทุกบท</option>' +
      lessons.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    sel.value = lessons.includes(val) ? val : '';
  });
  if (LS.lesson && !lessons.includes(LS.lesson)) LS.lesson = '';
}

function renderSettings() {
  $('apiUrl').value = LS.url;
  $('apiToken').value = LS.token;
  const last = LS.lastSync ? new Date(LS.lastSync).toLocaleString('th-TH') : 'ยังไม่เคย';
  const p = items.filter(i => i.status === 'pass').length;
  const f = items.filter(i => i.status === 'fail').length;
  $('syncInfo').textContent =
    `ซิงค์ล่าสุด: ${last}\nคำทั้งหมด ${items.length} · ผ่าน ${p} · ไม่ผ่าน ${f} · ยังไม่ทบทวน ${items.length - p - f}\nสถานะที่ยังไม่ได้ส่งขึ้น Sheet: ${pendingCount}`;
}

/* ================= เสียง ================= */
let jaVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  jaVoice = vs.find(v => /^ja(-|_|$)/i.test(v.lang)) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text) {
  if (!text) return;
  if (!('speechSynthesis' in window)) { toast('เครื่องนี้ไม่รองรับเสียงอ่าน'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  if (jaVoice) u.voice = jaVoice;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

function driveDirect(url) {
  const m = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  return m && /drive\.google\.com/.test(url)
    ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}

function playWord(it) {
  const text = it.reading || it.kanji;
  if (it.audio_url) {
    const a = new Audio(driveDirect(it.audio_url));
    a.play().catch(() => speak(text));   // เล่นไฟล์ไม่ได้ (เช่น ออฟไลน์) → ใช้ TTS
  } else {
    speak(text);
  }
}

/* ================= UI ================= */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'list') renderList();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function bindUI() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
  $('syncBtn').addEventListener('click', () => sync());

  $('revealBtn').addEventListener('click', () => { revealed = true; renderReview(); });
  $('cardFront').addEventListener('click', () => { revealed = !revealed; renderReview(); });
  $('passBtn').addEventListener('click', () => answer(true));
  $('failBtn').addEventListener('click', () => answer(false));
  $('speakWord').addEventListener('click', () => { const it = byId.get(queue[0]); if (it) playWord(it); });
  $('speakEx').addEventListener('click', () => { const it = byId.get(queue[0]); if (it) speak(it.example_jp); });

  $('lessonSelect').addEventListener('change', e => { LS.lesson = e.target.value; buildQueue(); renderReview(); });
  $('shuffleChk').checked = LS.shuffle;
  $('shuffleChk').addEventListener('change', e => { LS.shuffle = e.target.checked; buildQueue(); renderReview(); });

  let t = null;
  $('searchBox').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { listLimit = PAGE; renderList(); }, 150); });
  $('lessonSelect2').addEventListener('change', () => { listLimit = PAGE; renderList(); });
  $('statusSelect').addEventListener('change', () => { listLimit = PAGE; renderList(); });
  $('moreBtn').addEventListener('click', () => { listLimit += PAGE; renderList(); });

  $('saveSettings').addEventListener('click', () => {
    LS.url = $('apiUrl').value.trim();
    LS.token = $('apiToken').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(LS.url)) {
      toast('URL ควรขึ้นต้นด้วย https://script.google.com/');
    }
    sync();
  });
  $('testTts').addEventListener('click', () => speak('こんにちは'));
  $('clearLocal').addEventListener('click', async () => {
    if (!confirm('ล้างข้อมูลในเครื่องแล้วดึงใหม่จาก Sheet?')) return;
    await dbWrite('items', s => s.clear());
    await dbWrite('pending', s => s.clear());
    items = []; pendingCount = 0; indexItems(); queue = [];
    renderAll();
    sync();
  });

  window.addEventListener('offline', () => setSyncLabel());
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
