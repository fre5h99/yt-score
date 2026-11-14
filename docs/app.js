const $ = id => document.getElementById(id);
const FPS = 4, KEEP = 16, MAX_W = 1600, SMALL_W = 320;
const REASON = { transition: '전환 구간', empty: '악보 없음', duplicate: '중복' };

let W = 0, H = 0, region = null, lines = [], sel = -1;
let source = null;  // { kind: 'file' | 'stream', name?, duration?, stop }
let rec = null;     // 녹화(추출) 중 분할 상태
let grays = [];     // 영역 감지용 그레이 프레임
let queue = Promise.resolve();

const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const busy = (on, msg = '') => { $('spin').classList.toggle('hidden', !on); $('status').textContent = msg; };
const fail = e => { busy(false); $('err').textContent = e.message || String(e); };
const notice = msg => { $('notice').textContent = msg; $('notice').classList.toggle('hidden', !msg); };
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });
const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const full = canvas(1, 1), fctx = ctx2d(full);

// ---------- 영상 처리 (core.py 이식) ----------

// RGBA → 그레이. 기본은 RGB 평균, 영역 감지는 휘도(ffmpeg gray 와 같게)
function gray(d, wr = 1 / 3, wg = 1 / 3, wb = 1 / 3) {
  const g = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i] * wr + d[i + 1] * wg + d[i + 2] * wb;
  return g;
}

// 작은 배열 삽입 정렬 (픽셀마다 프레임 값 정렬용)
function sortSmall(a, n) {
  for (let i = 1; i < n; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
    a[j + 1] = v;
  }
}

// numpy.percentile 과 같은 선형 보간
function percentile(a, n, q) {
  const pos = q * (n - 1), i = Math.floor(pos);
  return i + 1 < n ? a[i] + (a[i + 1] - a[i]) * (pos - i) : a[i];
}

// 가로 직선(오선) 행이 몰린 가장 큰 덩어리를 찾아 위아래 여백을 붙인다
function detectRegion(gs, W, H, contrast = 30) {
  const even = v => Math.floor(v / 2) * 2;
  if (!gs.length) return { top: even(H * 0.7), bottom: even(H) };
  const line = new Uint16Array(H), edge = new Uint16Array(H), n = gs.length;  // 프레임 수 카운트
  for (const g of gs) {
    for (let y = 2; y < H - 2; y++) {
      let thin = 0, ed = 0;
      for (let x = 0, c0 = y * W; x < W; x++) {
        const c = g[c0 + x], u = g[c0 - 2 * W + x], d = g[c0 + 2 * W + x];
        // 얇은 선: 위아래 양쪽보다 같은 방향으로 크게 다름. 한쪽만 다르면 경계(edge)
        if (Math.min(u - c, d - c) > contrast || Math.min(c - u, c - d) > contrast) thin++;
        if (Math.abs(u - d) > contrast) ed++;
      }
      if (thin >= W / 2) line[y]++;
      if (ed >= W / 2) edge[y]++;
    }
  }
  const rows = [];
  for (let y = 0; y < H; y++) if (line[y] / n >= 0.1) rows.push(y);
  if (!rows.length) return { top: even(H * 0.7), bottom: even(H) };

  // 간격 0.05H 이하로 이어진 행 묶음 중 점수 합이 가장 큰 것
  const groups = [[rows[0]]];
  for (const y of rows.slice(1)) {
    if (y - groups.at(-1).at(-1) > H * 0.05) groups.push([]);
    groups.at(-1).push(y);
  }
  const score = grp => grp.reduce((s, y) => s + line[y], 0);
  const best = groups.reduce((a, b) => (score(b) > score(a) ? b : a));
  const y0 = best[0], y1 = best.at(-1);

  // 위는 코드명이 들어가도록 넉넉히. 단 패널 경계 같은 edge 행은 넘지 않음
  let top = Math.max(0, Math.floor(y0 - H * 0.08)), bottom = Math.min(H, Math.floor(y1 + H * 0.07));
  const edges = [];
  for (let y = 0; y < H; y++) if (edge[y] / n >= 0.5) edges.push(y);
  const above = edges.filter(y => y > top && y < y0 - 4), below = edges.filter(y => y < bottom && y > y1 + 4);
  if (above.length) top = Math.max(...above) + 3;
  if (below.length) bottom = Math.min(...below) - 2;
  return { top: even(top), bottom: even(bottom) };
}

// 배경 제거: 잉크 픽셀 1. 여러 프레임에서 유지되는 무채색 글자/선만 남긴다
function inkMask(imgs) {
  const n = imgs.length, len = imgs[0].width * imgs[0].height, ds = imgs.map(m => m.data);
  let sum = 0;
  for (const d of ds) for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  const dark = sum / 3 / len / n < 128;  // 어두운 배경 + 밝은 잉크
  const mask = new Uint8Array(len), buf = new Float32Array(n);
  for (let p = 0; p < len; p++) {
    for (let k = 0; k < n; k++) {
      const d = ds[k], i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      buf[k] = sat < 60 ? (r + g + b) / 3 : dark ? 0 : 255;
    }
    sortSmall(buf, n);
    mask[p] = dark ? percentile(buf, n, 0.2) > 150 : percentile(buf, n, 0.5) < 170;
  }
  return mask;
}

// 픽셀별 중앙값 이미지
function median(imgs) {
  const n = imgs.length, { width, height } = imgs[0], out = new ImageData(width, height);
  const ds = imgs.map(m => m.data), buf = new Uint8Array(n);
  for (let i = 0; i < out.data.length; i++) {
    if (i % 4 === 3) { out.data[i] = 255; continue; }
    for (let k = 0; k < n; k++) buf[k] = ds[k][i];
    sortSmall(buf, n);
    out.data[i] = n % 2 ? buf[(n - 1) / 2] : (buf[n / 2 - 1] + buf[n / 2]) / 2;
  }
  return out;
}

function maskImage(mask, w, h) {
  const out = new ImageData(w, h);
  for (let p = 0; p < mask.length; p++) {
    const v = mask[p] ? 0 : 255;
    out.data.set([v, v, v, 255], p * 4);
  }
  return out;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const mismatch = (a, b) => { let c = 0; for (let i = 0; i < a.length; i++) c += a[i] !== b[i]; return c / a.length; };

async function toBlob(img, type = 'image/png') {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c.convertToBlob({ type, quality: 0.92 });
}

async function decode(blob) {
  const b = await createImageBitmap(blob), c = new OffscreenCanvas(b.width, b.height), x = ctx2d(c);
  x.drawImage(b, 0, 0);
  b.close();
  return x.getImageData(0, 0, c.width, c.height);
}

// ---------- 온라인 줄 분할 ----------

function startRec() {
  const h = region.bottom - region.top, cw = Math.min(W, MAX_W), ch = Math.round(h * cw / W);
  const sw = SMALL_W, sh = Math.max(1, Math.round(h * sw / W));
  const crop = canvas(cw, ch), small = canvas(sw, sh);
  rec = { crop, cctx: ctx2d(crop), small, sctx: ctx2d(small), cur: null, prev: null, prevMask: null, t0: null, lastT: 0 };
  lines = []; sel = -1;
  $('editor').classList.add('hidden');
  renderCards();
  setRecUI(true);
}

async function addSample(t) {
  const r = rec, { width: cw, height: ch } = r.crop, { width: sw, height: sh } = r.small;
  r.cctx.drawImage(full, 0, region.top, W, region.bottom - region.top, 0, 0, cw, ch);
  const img = r.cctx.getImageData(0, 0, cw, ch);
  r.sctx.drawImage(r.crop, 0, 0, sw, sh);
  const g = gray(r.sctx.getImageData(0, 0, sw, sh).data);
  if (r.cur) {
    // 구간 첫 프레임 대비 변화율이 4% 를 넘으면 새 줄
    let changed = 0;
    for (let i = 0; i < g.length; i++) changed += Math.abs(g[i] - r.cur.ref[i]) > 40;
    if (changed / g.length > 0.04) await closeSeg(t);
  }
  if (!r.cur) r.cur = { ref: g, start: t, n: 0, stride: 1, kept: [] };
  // 구간마다 최대 KEEP 장만 고르게 남긴다: 넘치면 하나 걸러 버리고 간격을 두 배로
  const c = r.cur;
  if (c.n++ % c.stride === 0) c.kept.push({ t, img });
  if (c.kept.length > KEEP) { c.kept = c.kept.filter((_, i) => i % 2 === 0); c.stride *= 2; }
  r.lastT = t;
}

async function closeSeg(end) {
  const c = rec.cur, imgs = c.kept.map(k => k.img);
  rec.cur = null;
  const mask = inkMask(imgs);
  const line = { start: c.start, end, include: false, reason: null, frames: [], lo: 0, hi: imgs.length - 1 };
  judge(line, mask);
  lines.push(line);
  line.frames = await Promise.all(c.kept.map(async k => ({ t: k.t, blob: await toBlob(k.img, 'image/jpeg') })));
  await setImages(line, imgs, mask);
}

// 자동 해제 규칙
function judge(line, mask) {
  const dur = line.end - line.start, ink = mean(mask);
  if (dur < 1) line.reason = 'transition';
  // 잉크가 거의 없거나(검은/빈 화면) 너무 많으면(로고·실사 화면) 악보가 아님
  else if (ink < 0.005 || ink > 0.1) line.reason = 'empty';
  else if (rec.prev && mismatch(mask, rec.prevMask) < 0.02) {
    // 같은 줄이면 더 긴 구간(페이드가 아닌 쪽)을 남긴다
    if (dur <= rec.prev.end - rec.prev.start) line.reason = 'duplicate';
    else Object.assign(rec.prev, { include: false, reason: 'duplicate' });
  }
  if (!line.reason) { line.include = true; rec.prev = line; rec.prevMask = mask; }
}

async function setImages(line, imgs, mask = inkMask(imgs)) {
  const { width, height } = imgs[0];
  const [m, k] = await Promise.all([toBlob(median(imgs)), toBlob(maskImage(mask, width, height))]);
  for (const u of [line.medianUrl, line.maskUrl]) if (u) URL.revokeObjectURL(u);
  line.medianUrl = URL.createObjectURL(m);
  line.maskUrl = URL.createObjectURL(k);
}

// 편집 뒤 보관된 프레임 범위 [lo, hi] 로 다시 계산
async function rerender(line) {
  await setImages(line, await Promise.all(line.frames.slice(line.lo, line.hi + 1).map(f => decode(f.blob))));
}

async function finishRec(r) {
  if (rec !== r) return;
  if (r.cur) await closeSeg(r.lastT + 1 / FPS);
  rec = null;
  setRecUI(false);
  renderCards();
  $('pdfBtn').disabled = !lines.length;
  busy(false, `${lines.length}개 구간, ${lines.filter(l => l.include).length}줄 선택됨`);
}

function setRecUI(on) {
  const stream = source?.kind === 'stream';
  $('recBtn').classList.toggle('hidden', on && stream);
  $('stopBtn').classList.toggle('hidden', !(on && stream));
  for (const id of ['recBtn', 'detectBtn', 'shareBtn', 'fileBtn', 't']) $(id).disabled = on;
}

// ---------- 프레임 입력 ----------

function setSize(w, h) {
  if (w === W && h === H) return;
  W = w; H = h;
  full.width = $('frame').width = w;
  full.height = $('frame').height = h;
  grays = []; region = null;
}

function draw(img) {
  fctx.drawImage(img, 0, 0, W, H);
  $('frame').getContext('2d').drawImage(full, 0, 0);
}

const frameGray = () => gray(fctx.getImageData(0, 0, W, H).data, 0.299, 0.587, 0.114);

function autoDetect() {
  region = detectRegion(grays.map(x => x.g), W, H);
  $('regionSec').classList.remove('hidden');
  drawBox();
}

function stopSource() {
  rec = null;
  setRecUI(false);
  source?.stop();
  source = null;
  notice('');
  $('err').textContent = '';
}

// 탭 캡처 (테스트에서는 video.captureStream() 을 넣는다)
function startStream(stream) {
  stopSource();
  const track = stream.getVideoTracks()[0];
  let stop;
  if (window.MediaStreamTrackProcessor && window.Worker) {
    const worker = new Worker('worker.js');
    const readable = new MediaStreamTrackProcessor({ track }).readable;
    worker.onmessage = ({ data }) => data.bitmap && onFrame(data.bitmap, data.t);
    worker.postMessage({ readable, fps: FPS }, [readable]);
    stop = () => worker.terminate();
  } else {
    notice('이 브라우저는 백그라운드 탭 캡처를 지원하지 않습니다. 유튜브를 별도 창으로 띄워 이 창과 나란히 두세요.');
    const v = $('vid');
    v.srcObject = stream;
    v.play();
    const id = setInterval(() => v.videoWidth && onFrame(v, performance.now() / 1000), 1000 / FPS);
    stop = () => { clearInterval(id); v.srcObject = null; };
  }
  track.addEventListener('ended', stopRec);
  source = { kind: 'stream', name: 'score', stop: () => { stop(); stream.getTracks().forEach(t => t.stop()); } };
  W = H = 0;
  $('tRow').classList.add('hidden');
  $('recNote').classList.remove('hidden');
  $('recBtn').textContent = '녹화 시작';
  busy(false, '탭 공유 중');
}

function onFrame(img, t) {
  queue = queue.then(async () => {
    if (!rec) setSize(img.videoWidth || img.width, img.videoHeight || img.height);
    draw(img);
    img.close?.();
    if (rec) {
      rec.t0 ??= t;
      await addSample(t - rec.t0);
      busy(true, `녹화 중 ${fmt(rec.lastT)}, ${lines.length}개 구간`);
      return;
    }
    // 최근 20장(0.5초 간격)으로 영역 감지. 처음 4장이 모이면 한 번 자동 감지
    if (!grays.length || t - grays.at(-1).t >= 0.5) {
      grays.push({ t, g: frameGray() });
      if (grays.length > 20) grays.shift();
    }
    if (!region && grays.length >= 4) autoDetect();
  }).catch(fail);
}

function stopRec() {
  const r = rec;
  if (r) queue = queue.then(() => finishRec(r)).catch(fail);
}

// 영상 파일: 0.25초씩 seek 해 같은 샘플을 결정적으로 만든다
const seek = t => new Promise(ok => { const v = $('vid'); v.onseeked = ok; v.currentTime = t; });

async function openFile(file) {
  stopSource();
  const v = $('vid');
  v.srcObject = null;
  v.src = URL.createObjectURL(file);
  await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error('영상을 열 수 없습니다')); });
  source = { kind: 'file', name: file.name.replace(/\.[^.]+$/, ''), duration: v.duration, stop: () => URL.revokeObjectURL(v.src) };
  setSize(v.videoWidth, v.videoHeight);
  grays = [];
  busy(true, '영역 감지 중...');
  for (let k = 0; k < 20; k++) {
    await seek(v.duration * (k + 0.5) / 20);
    draw(v);
    grays.push({ g: frameGray() });
  }
  autoDetect();
  $('t').max = Math.floor(v.duration);
  $('t').value = Math.floor(v.duration / 3);
  $('tRow').classList.remove('hidden');
  $('recNote').classList.add('hidden');
  $('recBtn').textContent = '추출';
  await showAt();
  busy(false, `${W}x${H}, ${fmt(v.duration)}`);
}

async function showAt() {
  await seek(+$('t').value);
  draw($('vid'));
  $('tLabel').textContent = fmt(+$('t').value);
}

async function extractFile() {
  startRec();
  const r = rec, n = Math.ceil(source.duration * FPS);
  for (let i = 0; i < n && rec === r; i++) {
    await seek(i / FPS);
    draw($('vid'));
    await addSample(i / FPS);
    if (i % 20 === 0) busy(true, `추출 중... ${Math.round(i / n * 100)}%, ${lines.length}개 구간`);
  }
  await finishRec(r);
}

// ---------- UI ----------

if (!navigator.mediaDevices?.getDisplayMedia) {
  $('shareBtn').disabled = true;
  notice('이 브라우저는 탭 공유를 지원하지 않습니다(Safari·모바일 미지원). Chrome·Edge 데스크톱을 쓰거나 영상 파일을 여세요.');
}

$('shareBtn').onclick = async () => {
  try { startStream(await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })); } catch (e) { fail(e); }
};
$('fileBtn').onclick = () => $('file').click();
$('file').onchange = () => $('file').files[0] && openFile($('file').files[0]).catch(fail);
$('t').oninput = () => $('tLabel').textContent = fmt(+$('t').value);
$('t').onchange = () => showAt().catch(fail);
$('detectBtn').onclick = autoDetect;
$('recBtn').onclick = () => {
  $('err').textContent = '';
  if (source.kind === 'file') extractFile().catch(fail);
  else { startRec(); busy(true, '녹화 중... 유튜브를 처음부터 재생하세요'); }
};
$('stopBtn').onclick = stopRec;

function drawBox() {
  $('box').style.top = region.top / H * 100 + '%';
  $('box').style.height = (region.bottom - region.top) / H * 100 + '%';
}

document.querySelectorAll('.handle').forEach(h => h.onpointerdown = e => {
  e.preventDefault();
  if (rec) return;
  const edge = h.classList.contains('top') ? 'top' : 'bottom';
  const move = ev => {
    const rect = $('frame').getBoundingClientRect();
    let y = Math.round((ev.clientY - rect.top) / rect.height * H / 2) * 2;
    y = Math.max(0, Math.min(H, y));
    if (edge === 'top') region.top = Math.min(y, region.bottom - 20);
    else region.bottom = Math.max(y, region.top + 20);
    drawBox();
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

const lineStart = l => l.frames[l.lo].t;
const lineEnd = l => (l.hi === l.frames.length - 1 ? l.end : l.frames[l.hi + 1].t);
const lineUrl = l => ($('mask').checked ? l.maskUrl : l.medianUrl);
const lineText = (l, i) => `${i + 1}. ${fmt(lineStart(l))} ~ ${fmt(lineEnd(l))}`;

function renderCards() {
  $('cardSec').classList.toggle('hidden', !lines.length);
  $('cards').innerHTML = '';
  lines.forEach((l, i) => {
    const c = document.createElement('div');
    c.className = 'card' + (l.include ? '' : ' off') + (i === sel ? ' sel' : '');
    c.innerHTML = `<input type="checkbox" ${l.include ? 'checked' : ''}><img src="${lineUrl(l)}">
      <div>${lineText(l, i)}<br>${l.reason ? `<span class="badge">${REASON[l.reason]}</span>` : ''}</div>`;
    const cb = c.querySelector('input');
    cb.onclick = e => e.stopPropagation();
    cb.onchange = () => { l.include = cb.checked; c.classList.toggle('off', !l.include); };
    c.onclick = () => openEditor(i);
    $('cards').appendChild(c);
  });
}

$('mask').onchange = () => { renderCards(); if (sel >= 0) preview(); };

// 편집 패널: 슬라이더는 보관된 프레임 번호
function openEditor(i) {
  sel = i;
  const l = lines[i], n = l.frames.length - 1;
  for (const id of ['edStart', 'edEnd']) { $(id).min = 0; $(id).max = n; }
  $('edStart').value = l.lo; $('edEnd').value = l.hi;
  $('edSplit').min = 1; $('edSplit').max = Math.max(1, n); $('edSplit').value = Math.ceil(n / 2) || 1;
  $('splitBtn').disabled = n < 1;
  $('mergeBtn').disabled = i === lines.length - 1;
  $('edTitle').textContent = `${i + 1}번 줄 편집 (보관 프레임 ${n + 1}장)`;
  $('editor').classList.remove('hidden');
  updateLabels(); preview(); renderCards();
}

function updateLabels() {
  const l = lines[sel];
  $('edStartL').textContent = fmt(lineStart(l));
  $('edEndL').textContent = fmt(lineEnd(l));
  $('edSplitL').textContent = fmt(l.frames[Math.min(+$('edSplit').value, l.frames.length - 1)].t);
}

function preview() { $('edImg').src = lineUrl(lines[sel]); }

let timer;
function onRange() {
  const l = lines[sel];
  let lo = +$('edStart').value, hi = +$('edEnd').value;
  if (lo > hi) { if (this === $('edStart')) lo = hi; else hi = lo; }
  l.lo = lo; l.hi = hi;
  $('edStart').value = lo; $('edEnd').value = hi;
  updateLabels();
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await rerender(l);
    const i = lines.indexOf(l), card = $('cards').children[i];
    if (i === sel) preview();
    card.querySelector('img').src = lineUrl(l);
    card.querySelector('div').firstChild.textContent = lineText(l, i);
  }, 250);
}
$('edStart').oninput = onRange;
$('edEnd').oninput = onRange;
$('edSplit').oninput = updateLabels;

$('splitBtn').onclick = async () => {
  const l = lines[sel], k = +$('edSplit').value;
  if (k < 1 || k >= l.frames.length) return;
  const b = { start: l.frames[k].t, end: l.end, include: l.include, reason: null, frames: l.frames.slice(k), lo: 0, hi: l.frames.length - k - 1 };
  Object.assign(l, { frames: l.frames.slice(0, k), end: l.frames[k].t, lo: 0, hi: k - 1 });
  lines.splice(sel + 1, 0, b);
  await Promise.all([rerender(l), rerender(b)]);
  openEditor(sel);
};

$('mergeBtn').onclick = async () => {
  const l = lines[sel], next = lines[sel + 1];
  if (!next) return;
  Object.assign(l, { frames: l.frames.concat(next.frames), end: next.end, lo: 0 });
  l.hi = l.frames.length - 1;
  for (const u of [next.medianUrl, next.maskUrl]) URL.revokeObjectURL(u);
  lines.splice(sel + 1, 1);
  await rerender(l);
  openEditor(sel);
};

$('edClose').onclick = () => { sel = -1; $('editor').classList.add('hidden'); renderCards(); };

// PDF: 체크된 줄을 A4 페이지에 위에서부터 쌓는다 (여백·간격은 영상 폭 대비 core.py 와 같은 비율)
$('pdfBtn').onclick = async () => {
  const chosen = lines.filter(l => l.include);
  if (!chosen.length) return alert('체크된 줄이 없습니다');
  busy(true, 'PDF 만드는 중...');
  try {
    const doc = new jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
    const margin = 40 * PW / W, gap = 20 * PW / W, inner = PW - 2 * margin;
    let y = margin, first = true;
    for (const l of chosen) {
      const data = new Uint8Array(await (await fetch(lineUrl(l))).arrayBuffer());
      const p = doc.getImageProperties(data), h = p.height * inner / p.width;
      if (!first && y + h > PH - margin) { doc.addPage(); y = margin; }
      doc.addImage(data, 'PNG', margin, y, inner, h, undefined, 'FAST');
      y += h + gap;
      first = false;
    }
    const name = $('pdfName').value.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
    doc.save(`${name || source?.name || 'score'}.pdf`);
    busy(false, `${chosen.length}줄 PDF 저장 완료`);
  } catch (e) { fail(e); }
};
