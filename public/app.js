/* 쇼츠레이더 — YouTube Data API v3 기반 쇼츠 채널 발굴 도구 (모든 기능 무료·무제한) */
'use strict';

// ───────────────────────── 저장소 ─────────────────────────
const LS_KEY = 'sr.db.v1';
const DEFAULT_SETTINGS = {
  apiKey: '', region: 'KR', shortMax: 180, rpm: 150, autoCollect: true, collectHours: 6, minDailyViews: 100000,
};
const DB = Object.assign({
  settings: { ...DEFAULT_SETTINGS },
  channels: {},   // id → {id,t,h,th,pub,c,up,s:[[ts,subs,views,videos]]}
  favorites: {},  // id → {at,subs,views}
  bookmarks: {},  // videoId → video
  memos: {},      // id → {text,at}
  recent: [],     // channel ids
  bench: [],      // channel ids
  myChannel: null,
  lastCollect: 0,
  lastDaily: null, // {at, region, videos:[...]}
  quota: { day: '', used: 0 },
}, load());
DB.settings = { ...DEFAULT_SETTINGS, ...DB.settings };

function load() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } }
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); }
    catch (e) { toast('브라우저 저장 공간이 부족합니다. 설정에서 백업 후 추적 DB를 정리하세요.'); }
  }, 250);
}

// ───────────────────────── 유틸 ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const H = 3600e3, D = 864e5;
function fmt(n) {
  if (n == null || isNaN(n)) return '-';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e8) return s + (a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억';
  if (a >= 1e4) return s + (a / 1e4).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '만';
  return s + Math.round(a).toLocaleString('ko-KR');
}
const sign = n => (n > 0 ? '+' : '') + fmt(n);
const won = n => '₩' + fmt(Math.round(n));
function ago(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 3600) return Math.max(1, Math.floor(d / 60)) + '분 전';
  if (d < 86400) return Math.floor(d / 3600) + '시간 전';
  if (d < 86400 * 30) return Math.floor(d / 86400) + '일 전';
  if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + '개월 전';
  return Math.floor(d / 86400 / 365) + '년 전';
}
function ageDays(pub) { return Math.max((Date.now() - pub) / D, 1); }
function ageLabel(pub) { const d = ageDays(pub); return d < 60 ? Math.floor(d) + '일차' : d < 730 ? Math.floor(d / 30) + '개월차' : Math.floor(d / 365) + '년차'; }
function parseDur(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const durLabel = s => s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms); }
const ptDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

const REGIONS = { KR: '한국', US: '미국', JP: '일본', GB: '영국', IN: '인도', BR: '브라질', ID: '인도네시아', VN: '베트남', TH: '태국', TW: '대만', DE: '독일', FR: '프랑스' };
const LANGS = { KR: 'ko', US: 'en', JP: 'ja', GB: 'en', IN: 'hi', BR: 'pt', ID: 'id', VN: 'vi', TH: 'th', TW: 'zh-Hant', DE: 'de', FR: 'fr' };
const CATS = { '': '전체 카테고리', 1: '영화/애니메이션', 2: '자동차', 10: '음악', 15: '동물', 17: '스포츠', 19: '여행/이벤트', 20: '게임', 22: '인물/블로그', 23: '코미디', 24: '엔터테인먼트', 25: '뉴스/정치', 26: '노하우/스타일', 27: '교육', 28: '과학기술', 29: '비영리/사회운동' };
const opts = (map, sel) => Object.entries(map).map(([k, v]) => `<option value="${k}"${String(k) === String(sel) ? ' selected' : ''}>${esc(v)}</option>`).join('');

// ───────────────────────── YouTube API ─────────────────────────
const COST = { search: 100 };
const memCache = new Map();
async function yt(endpoint, params, { ttl = 0 } = {}) {
  const key = DB.settings.apiKey;
  if (!key) throw Object.assign(new Error('API 키가 없습니다. 설정에서 YouTube Data API 키를 입력하세요.'), { code: 'NO_KEY' });
  const u = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  const ck = u.toString();
  if (ttl && memCache.has(ck)) { const c = memCache.get(ck); if (Date.now() - c.t < ttl) return c.v; }
  u.searchParams.set('key', key);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  const day = ptDay();
  if (DB.quota.day !== day) DB.quota = { day, used: 0 };
  DB.quota.used += COST[endpoint] || 1; save(); renderFoot();
  if (!r.ok || j.error) {
    const reason = j.error?.errors?.[0]?.reason || '';
    let msg = j.error?.message || `요청 실패 (${r.status})`;
    if (reason === 'quotaExceeded') msg = '오늘 API 할당량(10,000)을 모두 사용했습니다. 태평양 시간 자정에 초기화됩니다.';
    if (reason === 'keyInvalid' || /API key not valid/i.test(msg)) msg = 'API 키가 올바르지 않습니다. 설정에서 다시 확인하세요.';
    throw new Error(msg);
  }
  if (ttl) memCache.set(ck, { t: Date.now(), v: j });
  return j;
}

function normVideo(v) {
  const sn = v.snippet || {}, st = v.statistics || {};
  return {
    id: v.id, t: sn.title, chId: sn.channelId, ch: sn.channelTitle, pub: Date.parse(sn.publishedAt),
    views: +st.viewCount || 0, likes: +st.likeCount || 0, comments: +st.commentCount || 0,
    dur: parseDur(v.contentDetails?.duration), cat: sn.categoryId,
    th: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
  };
}
const isShort = v => v.dur > 0 && v.dur <= DB.settings.shortMax;

async function videosByIds(ids) {
  const out = [];
  for (const c of chunk([...new Set(ids)], 50)) {
    const j = await yt('videos', { part: 'snippet,statistics,contentDetails', id: c.join(','), maxResults: 50 });
    out.push(...(j.items || []).map(normVideo));
  }
  return out;
}

function upsertChannels(items) {
  const now = Date.now();
  for (const it of items) {
    const sn = it.snippet, st = it.statistics || {};
    const c = DB.channels[it.id] || (DB.channels[it.id] = { id: it.id, s: [] });
    if (sn) {
      c.t = sn.title; c.h = sn.customUrl || c.h; c.c = sn.country || c.c;
      c.th = sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || c.th;
      c.pub = Date.parse(sn.publishedAt) || c.pub;
    }
    if (it.contentDetails?.relatedPlaylists?.uploads) c.up = it.contentDetails.relatedPlaylists.uploads;
    if (st.viewCount != null) {
      c.hid = !!st.hiddenSubscriberCount;
      const snap = [now, +st.subscriberCount || 0, +st.viewCount || 0, +st.videoCount || 0];
      const last = c.s[c.s.length - 1];
      if (last && now - last[0] < H) c.s[c.s.length - 1] = snap; else c.s.push(snap);
      if (c.s.length > 400) c.s.splice(0, c.s.length - 400);
    }
  }
  save(); renderFoot();
}

async function fetchChannels(ids, { force = false } = {}) {
  const need = [...new Set(ids)].filter(id => {
    const c = DB.channels[id];
    return force || !c || !c.t || !c.s.length || Date.now() - c.s[c.s.length - 1][0] > H;
  });
  for (const c of chunk(need, 50)) {
    const j = await yt('channels', { part: 'snippet,statistics,contentDetails', id: c.join(','), maxResults: 50 });
    upsertChannels(j.items || []);
  }
}

// 쇼츠 검색: search.list → videos.list → channels.list
async function searchShorts({ q, region, after, order = 'viewCount', cat, pageToken }) {
  const j = await yt('search', {
    part: 'id', type: 'video', videoDuration: 'short', maxResults: 50, order, q,
    regionCode: region, relevanceLanguage: LANGS[region], publishedAfter: after ? new Date(after).toISOString() : undefined,
    videoCategoryId: cat, pageToken,
  }, { ttl: 30 * 60e3 });
  const ids = (j.items || []).map(i => i.id.videoId).filter(Boolean);
  const vids = (await videosByIds(ids)).filter(isShort);
  await fetchChannels(vids.map(v => v.chId));
  return { vids, next: j.nextPageToken };
}

// 전체 추적 채널 통계 재수집 (50개당 1 유닛)
let collecting = false;
async function collectAll({ silent = false } = {}) {
  if (collecting || !DB.settings.apiKey) return;
  const ids = Object.keys(DB.channels);
  if (!ids.length) return;
  collecting = true; renderFoot();
  try {
    for (const c of chunk(ids, 50)) {
      const j = await yt('channels', { part: 'statistics', id: c.join(','), maxResults: 50 });
      upsertChannels(j.items || []);
    }
    DB.lastCollect = Date.now(); save();
    if (!silent) toast(`${ids.length}개 채널 수집 완료`);
  } catch (e) { if (!silent) toast(e.message); }
  finally { collecting = false; renderFoot(); }
}
function maybeAutoCollect() {
  if (DB.settings.autoCollect && DB.settings.apiKey && Date.now() - DB.lastCollect > DB.settings.collectHours * H)
    collectAll({ silent: true }).then(() => { if (route().name === 'dashboard') render(); });
}

// ───────────────────────── 지표 ─────────────────────────
const lastSnap = c => c.s[c.s.length - 1] || [0, 0, 0, 0];
function growth(c, hours) {
  const s = c.s; if (!s || s.length < 2) return null;
  const last = s[s.length - 1], target = last[0] - hours * H;
  let base = null;
  for (let i = s.length - 2; i >= 0; i--) if (s[i][0] <= target + hours * H * 0.25) { base = s[i]; break; }
  if (!base) return null;
  const span = (last[0] - base[0]) / H;
  if (span < hours * 0.5) return null;
  return { subs: last[1] - base[1], views: last[2] - base[2], span, vpd: (last[2] - base[2]) / span * 24, spd: (last[1] - base[1]) / span * 24 };
}
function viewsPerDay(c) { const g = growth(c, 72) || growth(c, 24) || growth(c, 168); return g ? g.vpd : lastSnap(c)[2] / ageDays(c.pub); }
// 꿀통 지수(0~100): 구독자 대비 조회수 · 일 조회 속도 · 업로드 빈도 · 채널 나이
function honey(c) {
  const [, subs0, views, vids0] = lastSnap(c);
  const subs = Math.max(subs0, 100), vids = Math.max(vids0, 1), age = ageDays(c.pub);
  const a = clamp((Math.log10(views / vids / subs) + 1) / 3, 0, 1);
  const b = clamp(Math.log10(Math.max(viewsPerDay(c), 1)) / 6.5, 0, 1);
  const cc = clamp(vids / (age / 7) / 10, 0, 1);
  const d = age < 90 ? 1 : age < 180 ? .7 : age < 365 ? .45 : .2;
  return Math.round(100 * (.35 * a + .35 * b + .15 * cc + .15 * d));
}
const estDaily = c => viewsPerDay(c) * DB.settings.rpm / 1000;
function scoreBadge(n) {
  const col = n >= 75 ? '#ff5c5c' : n >= 60 ? '#ffb020' : n >= 45 ? '#3ddc84' : '#5f6878';
  return `<span class="score" style="background:${col}22;color:${col}" title="꿀통 지수">${n}</span>`;
}
const chAvg = c => { const [, , v, n] = lastSnap(c); return n ? v / n : 0; };

// ───────────────────────── 공통 UI 조각 ─────────────────────────
const lastRendered = new Map();
function videoCard(v, { rank, base } = {}) {
  lastRendered.set(v.id, v); if (lastRendered.size > 2000) lastRendered.delete(lastRendered.keys().next().value);
  const c = DB.channels[v.chId];
  const avg = base ?? (c ? chAvg(c) : 0);
  const ratio = avg ? v.views / avg : 0;
  const hrs = Math.max((Date.now() - v.pub) / H, 1);
  const badges = [];
  if (ratio >= 2) badges.push(`<span class="badge ${ratio >= 5 ? 'hot' : ''}">평소 ×${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}</span>`);
  if (c && ageDays(c.pub) <= 90) badges.push('<span class="badge new">신생</span>');
  const bm = !!DB.bookmarks[v.id];
  return `<div class="vcard">
    <button class="iconbtn bm ${bm ? 'on' : ''}" data-bm="${v.id}" title="영상 북마크">${bm ? '★' : '☆'}</button>
    <div class="thumb ${isShort(v) ? '' : 'wide'}" data-vid="${v.id}">
      <img loading="lazy" src="${esc(v.th)}" alt="">
      ${rank ? `<span class="rank ${rank <= 3 ? 'top' : ''}">${rank}</span>` : ''}
      <span class="dur">${durLabel(v.dur)}</span>
      <div class="badges">${badges.join('')}</div>
    </div>
    <div class="vbody">
      <a class="vtitle" href="https://www.youtube.com/${isShort(v) ? 'shorts/' : 'watch?v='}${v.id}" target="_blank" rel="noopener">${esc(v.t)}</a>
      <div class="vch" data-ch="${v.chId}">${esc(v.ch)}${c ? ` · ${fmt(lastSnap(c)[1])}` : ''}</div>
      <div class="vmeta"><span><b>${fmt(v.views)}</b>회</span><span>${ago(v.pub)}</span></div>
      <div class="vmeta"><span>시간당 ${fmt(v.views / hrs)}</span><span>👍 ${fmt(v.likes)}</span></div>
    </div></div>`;
}
const videoGrid = (vs, o = {}) => vs.length ? `<div class="vgrid">${vs.map((v, i) => videoCard(v, { ...o, rank: o.ranked ? i + 1 : undefined })).join('')}</div>` : `<div class="empty">조건에 맞는 영상이 없습니다.</div>`;

function chRow(c, i, right) {
  const [, subs, views] = lastSnap(c);
  return `<div class="crow" data-ch="${c.id}">
    <span class="no">${i + 1}</span>
    <img class="av" loading="lazy" src="${esc(c.th || '')}" alt="">
    <div style="min-width:0"><div class="cname">${esc(c.t)} ${ageDays(c.pub) <= 90 ? '<span class="badge new">신생</span>' : ''}</div>
      <div class="cmeta">구독 ${c.hid ? '비공개' : fmt(subs)} · 조회 ${fmt(views)} · ${ageLabel(c.pub)}</div></div>
    <div class="cright">${right ?? scoreBadge(honey(c))}</div></div>`;
}
const chList = (cs, right) => cs.length ? `<div class="clist">${cs.map((c, i) => chRow(c, i, right && right(c))).join('')}</div>` : '';

function lineChart(pts, { color = '#ffb020', h = 160, label = fmt } = {}) {
  if (pts.length < 2) return `<div class="empty small">데이터가 2개 이상 쌓이면 그래프가 표시됩니다.</div>`;
  const W = 600, P = { l: 48, r: 10, t: 10, b: 22 };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = x => P.l + (x - x0) / (x1 - x0 || 1) * (W - P.l - P.r);
  const Y = y => h - P.b - (y - y0) / (y1 - y0 || 1) * (h - P.t - P.b);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
  const dt = t => { const z = new Date(t); return `${z.getMonth() + 1}/${z.getDate()}`; };
  return `<svg class="chart" viewBox="0 0 ${W} ${h}" preserveAspectRatio="none">
    <line x1="${P.l}" x2="${W - P.r}" y1="${Y(y1)}" y2="${Y(y1)}" stroke="#262b34"/>
    <line x1="${P.l}" x2="${W - P.r}" y1="${Y(y0)}" y2="${Y(y0)}" stroke="#262b34"/>
    <text x="${P.l - 6}" y="${Y(y1) + 3}" text-anchor="end">${label(y1)}</text>
    <text x="${P.l - 6}" y="${Y(y0) + 3}" text-anchor="end">${label(y0)}</text>
    <text x="${P.l}" y="${h - 6}">${dt(x0)}</text><text x="${W - P.r}" y="${h - 6}" text-anchor="end">${dt(x1)}</text>
    <path d="${d} L${X(x1)} ${h - P.b} L${X(x0)} ${h - P.b}Z" fill="${color}" fill-opacity=".1"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function needKey() {
  return DB.settings.apiKey ? '' : `<div class="notice">⚙️ 먼저 <a class="acc" href="#/settings"><b>설정</b></a>에서 본인의 YouTube Data API 키를 입력하세요. (무료 · 하루 10,000 유닛)</div>`;
}
const loadingHtml = (t = '불러오는 중…') => `<div class="loading"><span class="spin"></span>${t}</div>`;
const errHtml = e => `<div class="notice">⚠️ ${esc(e.message || e)}</div>`;

// ───────────────────────── 라우터 ─────────────────────────
function route() {
  const [, name = 'dashboard', arg] = location.hash.replace(/^#/, '').split('/');
  return { name: name || 'dashboard', arg: arg && decodeURIComponent(arg) };
}
const VIEWS = {};
let renderId = 0;
async function render() {
  const r = route(), id = ++renderId;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r.name));
  const v = $('#view');
  const fn = VIEWS[r.name] || VIEWS.dashboard;
  v.innerHTML = '';
  try { await fn(v, r.arg, () => id === renderId); } catch (e) { if (id === renderId) v.innerHTML = errHtml(e); }
  window.scrollTo(0, 0);
}
function renderFoot() {
  const n = Object.keys(DB.channels).length;
  $('#sideFoot').innerHTML = `추적 채널 <b>${n.toLocaleString()}</b>개<br>
    오늘 API 사용 <b>${(DB.quota.day === ptDay() ? DB.quota.used : 0).toLocaleString()}</b> / 10,000<br>
    ${collecting ? '<span class="spin"></span>수집 중…' : '마지막 수집 ' + (DB.lastCollect ? ago(DB.lastCollect) : '없음')}`;
}

// ───────────────────────── 대시보드 ─────────────────────────
const dashState = { radar: 24 };
VIEWS.dashboard = async (v) => {
  const all = Object.values(DB.channels).filter(c => c.t && c.s.length);
  const radar = all.map(c => ({ c, g: growth(c, dashState.radar) })).filter(x => x.g && x.g.views > 0).sort((a, b) => b.g.vpd - a.g.vpd).slice(0, 15);
  const fresh = all.filter(c => ageDays(c.pub) <= 90).sort((a, b) => viewsPerDay(b) - viewsPerDay(a)).slice(0, 10);
  const honeyTop = all.filter(c => !c.hid).map(c => ({ c, h: honey(c) })).sort((a, b) => b.h - a.h).slice(0, 10);
  const weekly = all.map(c => ({ c, g: growth(c, 168) })).filter(x => x.g).sort((a, b) => b.g.subs - a.g.subs).slice(0, 10);
  const daily = DB.lastDaily?.videos || [];
  const best = daily.map(x => ({ v: x, r: DB.channels[x.chId] ? x.views / (chAvg(DB.channels[x.chId]) || 1) : 0 })).sort((a, b) => b.r - a.r)[0];

  v.innerHTML = `${needKey()}
  <div class="head"><div><h1>대시보드</h1><p class="sub" style="margin:0">추적 중인 채널의 시계열 데이터로 지금 뜨는 채널을 보여줍니다.</p></div>
    <div class="row"><button class="btn" id="seedBtn">🌱 채널 씨앗 수집</button><button class="btn pri" id="collectBtn">↻ 지금 수집</button></div></div>
  <div class="stats">
    <div class="stat"><div class="k">추적 채널</div><div class="v">${all.length.toLocaleString()}</div></div>
    <div class="stat"><div class="k">신생 채널 (90일 이내)</div><div class="v">${all.filter(c => ageDays(c.pub) <= 90).length}</div></div>
    <div class="stat"><div class="k">즐겨찾기</div><div class="v">${Object.keys(DB.favorites).length}</div></div>
    <div class="stat"><div class="k">마지막 수집</div><div class="v" style="font-size:16px">${DB.lastCollect ? ago(DB.lastCollect) : '없음'}</div></div>
  </div>
  ${!all.length ? `<div class="notice">아직 추적 중인 채널이 없습니다. <b>🌱 채널 씨앗 수집</b>을 누르면 최근 3일간 조회수가 높은 쇼츠의 채널 약 100개를 추적 목록에 추가합니다(약 200 유닛). 이후 데일리 떡상·탐색·Top 300에서 보는 채널도 자동으로 추적됩니다.</div>` : ''}
  <div class="grid2">
    <div class="card"><div class="card-h"><h2>🚀 급상승 레이더</h2>
      <div class="seg" id="radarSeg">${[[24, '24시간'], [72, '3일'], [168, '7일']].map(([h, l]) => `<button data-h="${h}" class="${dashState.radar === h ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${radar.length ? chList(radar.map(x => x.c), c => { const g = growth(c, dashState.radar); return `<b class="up">${sign(g.views)}</b><div class="muted">구독 ${sign(g.subs)}</div>`; })
        : `<div class="empty">비교할 과거 데이터가 아직 없습니다.<br>수집이 ${dashState.radar === 24 ? '하루' : dashState.radar === 72 ? '3일' : '일주일'} 이상 쌓이면 순위가 나타납니다.<br><span class="small">앱을 켜두면 ${DB.settings.collectHours}시간마다 자동 수집합니다.</span></div>`}
    </div>
    <div class="card"><div class="card-h"><h2>🐣 신생 떡상 <span class="muted small">개설 90일 이내</span></h2></div>
      ${chList(fresh, c => `<b>${fmt(viewsPerDay(c))}</b><div class="muted">일 조회</div>`) || '<div class="empty">신생 채널이 아직 없습니다.</div>'}
    </div>
    <div class="card"><div class="card-h"><h2>🍯 꿀통 지수 TOP</h2></div>
      ${chList(honeyTop.map(x => x.c), c => `${scoreBadge(honey(c))}<div class="muted">일 ${won(estDaily(c))}</div>`) || '<div class="empty">데이터 없음</div>'}
    </div>
    <div class="card"><div class="card-h"><h2>🎯 오늘의 한 방</h2>${DB.lastDaily ? `<span class="muted small">${ago(DB.lastDaily.at)} 데일리 떡상 기준</span>` : ''}</div>
      ${best ? `<div style="display:grid;grid-template-columns:150px 1fr;gap:14px;align-items:start">${videoCard(best.v)}
        <div><div class="badge hot" style="font-size:13px">평소 대비 ×${best.r.toFixed(1)}</div>
        <p class="small muted" style="line-height:1.7">채널 평균 조회수보다 가장 크게 터진 영상입니다. 썸네일에 마우스를 올리면 바로 재생됩니다.</p></div></div>`
        : `<div class="empty"><a class="acc" href="#/daily">데일리 떡상</a>을 한 번 불러오면 여기에 표시됩니다.</div>`}
    </div>
  </div>
  <div class="card mt"><div class="card-h"><h2>📅 주간 결산 <span class="muted small">최근 7일 구독자 증가</span></h2></div>
    ${weekly.length ? `<div class="tbl-wrap"><table><thead><tr><th>채널</th><th>구독 증가</th><th>조회 증가</th><th>현재 구독</th><th>꿀통</th></tr></thead><tbody>
      ${weekly.map(({ c, g }) => `<tr data-ch="${c.id}"><td><div class="tcell"><img class="av" src="${esc(c.th)}"><span>${esc(c.t)}</span></div></td><td class="up">${sign(g.subs)}</td><td>${sign(g.views)}</td><td>${fmt(lastSnap(c)[1])}</td><td>${scoreBadge(honey(c))}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">7일치 데이터가 쌓이면 주간 결산이 표시됩니다.</div>'}
  </div>`;

  $('#radarSeg').onclick = e => { const h = +e.target.dataset.h; if (h) { dashState.radar = h; render(); } };
  $('#collectBtn').onclick = async e => { e.target.disabled = true; await collectAll(); render(); };
  $('#seedBtn').onclick = async e => {
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span>수집 중…';
    try {
      let tok;
      for (let i = 0; i < 2; i++) { const r = await searchShorts({ region: DB.settings.region, after: Date.now() - 3 * D, pageToken: tok }); tok = r.next; if (!tok) break; }
      toast('씨앗 채널을 추가했습니다.'); render();
    } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = '🌱 채널 씨앗 수집'; }
  };
};

// ───────────────────────── 데일리 떡상 ─────────────────────────
const dailyState = { region: null, hours: 24, cat: '', q: '', min: null, sort: 'views', vids: [], next: null, loaded: false };
VIEWS.daily = async (v, _, alive) => {
  const s = dailyState;
  s.region ??= DB.settings.region; s.min ??= DB.settings.minDailyViews;
  const draw = () => {
    let list = s.vids.filter(x => x.views >= s.min);
    if (s.sort === 'views') list.sort((a, b) => b.views - a.views);
    if (s.sort === 'vph') list.sort((a, b) => b.views / Math.max(Date.now() - b.pub, H) - a.views / Math.max(Date.now() - a.pub, H));
    if (s.sort === 'ratio') { const r = x => x.views / (chAvg(DB.channels[x.chId] || { s: [] }) || Infinity); list.sort((a, b) => r(b) - r(a)); }
    $('#dres').innerHTML = s.loaded ? `<p class="muted small">${list.length}개 영상 · 최소 ${fmt(s.min)}회 이상</p>${videoGrid(list)}
      ${s.next ? '<div style="text-align:center;margin-top:18px"><button class="btn" id="dmore">더 불러오기 (+100 유닛)</button></div>' : ''}` : '<div class="empty">조건을 정하고 <b>불러오기</b>를 누르세요. (1회 약 102 유닛)</div>';
    const m = $('#dmore'); if (m) m.onclick = () => fetchD(true);
  };
  const fetchD = async (more) => {
    if (!more) { s.vids = []; s.next = null; }
    $('#dres').innerHTML = loadingHtml();
    try {
      const r = await searchShorts({ q: s.q, region: s.region, cat: s.cat, after: Date.now() - s.hours * H, pageToken: more ? s.next : undefined });
      const seen = new Set(s.vids.map(x => x.id));
      s.vids.push(...r.vids.filter(x => !seen.has(x.id))); s.next = r.next; s.loaded = true;
      DB.lastDaily = { at: Date.now(), region: s.region, videos: s.vids.slice(0, 60) }; save();
      if (alive()) draw();
    } catch (e) { if (alive()) $('#dres').innerHTML = errHtml(e); }
  };
  v.innerHTML = `${needKey()}<h1>데일리 떡상</h1><p class="sub">최근 업로드된 쇼츠 중 조회수 기준을 넘긴 영상만 모아봅니다.</p>
  <div class="filters">
    <div class="f"><label>국가</label><select id="dRegion">${opts(REGIONS, s.region)}</select></div>
    <div class="f"><label>업로드 기간</label><select id="dHours">${opts({ 24: '24시간', 48: '48시간', 72: '3일', 168: '7일' }, s.hours)}</select></div>
    <div class="f"><label>카테고리</label><select id="dCat">${opts(CATS, s.cat)}</select></div>
    <div class="f"><label>키워드 (선택)</label><input id="dQ" value="${esc(s.q)}" placeholder="예: 요리, 고양이"></div>
    <div class="f"><label>최소 조회수</label><input id="dMin" type="number" step="10000" value="${s.min}"></div>
    <div class="f"><label>정렬</label><select id="dSort">${opts({ views: '조회수순', vph: '시간당 조회순', ratio: '평소 대비 배수순' }, s.sort)}</select></div>
    <button class="btn pri" id="dGo">불러오기</button>
  </div><div id="dres"></div>`;
  const sync = () => { s.region = $('#dRegion').value; s.hours = +$('#dHours').value; s.cat = $('#dCat').value; s.q = $('#dQ').value.trim(); s.min = +$('#dMin').value || 0; s.sort = $('#dSort').value; };
  $('#dGo').onclick = () => { sync(); fetchD(false); };
  $('#dQ').onkeydown = e => { if (e.key === 'Enter') { sync(); fetchD(false); } };
  ['#dMin', '#dSort'].forEach(id => $(id).onchange = () => { sync(); draw(); });
  draw();
};

// ───────────────────────── 채널 탐색 ─────────────────────────
const exState = { scope: 'db', q: '', region: null, period: 30, cat: '', minSubs: '', maxSubs: '', maxAge: '', minScore: '', sort: 'honey', found: [], next: null };
VIEWS.explore = async (v, _, alive) => {
  const s = exState; s.region ??= DB.settings.region;
  const draw = () => {
    const pool = s.scope === 'db' ? Object.values(DB.channels) : s.found.map(id => DB.channels[id]);
    let list = pool.filter(c => c && c.t && c.s.length).map(c => ({ c, h: honey(c), vpd: viewsPerDay(c), g: growth(c, 24), sub: lastSnap(c)[1] }))
      .filter(x => (s.minSubs === '' || x.sub >= +s.minSubs) && (s.maxSubs === '' || x.sub <= +s.maxSubs)
        && (s.maxAge === '' || ageDays(x.c.pub) <= +s.maxAge) && (s.minScore === '' || x.h >= +s.minScore));
    const key = { honey: x => x.h, subs: x => x.sub, vpd: x => x.vpd, d24: x => x.g ? x.g.views : -1, young: x => -ageDays(x.c.pub), ratio: x => chAvg(x.c) / Math.max(x.sub, 100) }[s.sort];
    list.sort((a, b) => key(b) - key(a));
    $('#exRes').innerHTML = `<p class="muted small">${list.length.toLocaleString()}개 채널${list.length > 300 ? ' (상위 300개 표시)' : ''}</p>
    ${list.length ? `<div class="card" style="padding:4px 8px"><div class="tbl-wrap"><table><thead><tr>
      <th>채널</th><th data-s="honey">꿀통</th><th data-s="subs">구독자</th><th>평균 조회</th><th data-s="ratio">조회/구독</th><th data-s="vpd">일 조회</th><th data-s="d24">24h 증가</th><th>일 예상수익</th><th data-s="young">나이</th><th></th></tr></thead><tbody>
      ${list.slice(0, 300).map(({ c, h, vpd, g, sub }) => `<tr data-ch="${c.id}">
        <td><div class="tcell"><img class="av" loading="lazy" src="${esc(c.th)}"><span>${esc(c.t)}</span></div></td>
        <td>${scoreBadge(h)}</td><td>${c.hid ? '비공개' : fmt(sub)}</td><td>${fmt(chAvg(c))}</td><td>${(chAvg(c) / Math.max(sub, 1)).toFixed(1)}배</td>
        <td>${fmt(vpd)}</td><td class="${g && g.views > 0 ? 'up' : 'muted'}">${g ? sign(g.views) : '-'}</td><td>${won(vpd * DB.settings.rpm / 1000)}</td>
        <td>${ageLabel(c.pub)}</td><td><button class="iconbtn ${DB.favorites[c.id] ? 'on' : ''}" data-fav="${c.id}">${DB.favorites[c.id] ? '★' : '☆'}</button></td></tr>`).join('')}
    </tbody></table></div></div>` : '<div class="empty">조건에 맞는 채널이 없습니다.</div>'}
    ${s.scope === 'search' && s.next ? '<div style="text-align:center;margin-top:16px"><button class="btn" id="exMore">더 찾기 (+100 유닛)</button></div>' : ''}`;
    v.querySelectorAll('th[data-s]').forEach(th => { th.textContent += s.sort === th.dataset.s ? ' ▼' : ''; th.onclick = () => { s.sort = th.dataset.s; $('#exSort').value = s.sort; draw(); }; });
    const m = $('#exMore'); if (m) m.onclick = () => go(true);
  };
  const go = async (more) => {
    const q = s.q;
    if (/youtube\.com|youtu\.be|^@|^UC[\w-]{22}$/.test(q)) {
      try { const id = await resolveChannel(q); if (id) return void (location.hash = '#/channel/' + id); } catch (e) { return toast(e.message); }
    }
    s.scope = 'search'; $('#exScope').value = 'search';
    if (!more) { s.found = []; s.next = null; }
    $('#exRes').innerHTML = loadingHtml('쇼츠 채널을 찾는 중…');
    try {
      const r = await searchShorts({ q, region: s.region, cat: s.cat, after: Date.now() - s.period * D, order: q ? 'relevance' : 'viewCount', pageToken: more ? s.next : undefined });
      s.found = [...new Set([...s.found, ...r.vids.map(x => x.chId)])]; s.next = r.next;
      if (alive()) draw();
    } catch (e) { if (alive()) $('#exRes').innerHTML = errHtml(e); }
  };
  v.innerHTML = `${needKey()}<h1>채널 탐색</h1><p class="sub">키워드로 쇼츠 채널을 찾거나, 지금까지 추적한 전체 채널을 필터링하세요. 채널 URL·@핸들을 넣으면 바로 상세 분석으로 이동합니다.</p>
  <div class="filters">
    <div class="f"><label>범위</label><select id="exScope">${opts({ db: '추적 DB 전체', search: '검색 결과' }, s.scope)}</select></div>
    <div class="f" style="flex:1;min-width:200px"><label>키워드 / 채널 URL / @핸들</label><input id="exQ" value="${esc(s.q)}" placeholder="예: 썰, 동물, @handle"></div>
    <div class="f"><label>국가</label><select id="exRegion">${opts(REGIONS, s.region)}</select></div>
    <div class="f"><label>영상 기간</label><select id="exPeriod">${opts({ 7: '7일', 30: '30일', 90: '90일', 365: '1년' }, s.period)}</select></div>
    <div class="f"><label>카테고리</label><select id="exCat">${opts(CATS, s.cat)}</select></div>
    <button class="btn pri" id="exGo">검색 (100 유닛)</button>
  </div>
  <div class="filters">
    <div class="f"><label>최소 구독자</label><input id="exMinS" type="number" value="${s.minSubs}" placeholder="0"></div>
    <div class="f"><label>최대 구독자</label><input id="exMaxS" type="number" value="${s.maxSubs}" placeholder="제한 없음"></div>
    <div class="f"><label>채널 나이 (일 이하)</label><input id="exAge" type="number" value="${s.maxAge}" placeholder="예: 90"></div>
    <div class="f"><label>최소 꿀통 지수</label><input id="exScore" type="number" value="${s.minScore}" placeholder="0~100"></div>
    <div class="f"><label>정렬</label><select id="exSort">${opts({ honey: '꿀통 지수', vpd: '일 조회수', d24: '24시간 증가', ratio: '조회/구독 배수', subs: '구독자', young: '최신 개설' }, s.sort)}</select></div>
  </div><div id="exRes"></div>`;
  const sync = () => Object.assign(s, { scope: $('#exScope').value, q: $('#exQ').value.trim(), region: $('#exRegion').value, period: +$('#exPeriod').value, cat: $('#exCat').value, minSubs: $('#exMinS').value, maxSubs: $('#exMaxS').value, maxAge: $('#exAge').value, minScore: $('#exScore').value, sort: $('#exSort').value });
  $('#exGo').onclick = () => { sync(); go(false); };
  $('#exQ').onkeydown = e => { if (e.key === 'Enter') { sync(); go(false); } };
  ['#exScope', '#exMinS', '#exMaxS', '#exAge', '#exScore', '#exSort'].forEach(id => $(id).onchange = () => { sync(); draw(); });
  draw();
};

async function resolveChannel(input) {
  input = input.trim();
  let m = input.match(/(UC[\w-]{22})/); if (m) return m[1];
  m = input.match(/@([^/?#\s]+)/);
  if (m) {
    const j = await yt('channels', { part: 'snippet,statistics,contentDetails', forHandle: '@' + decodeURIComponent(m[1]) });
    if (j.items?.length) { upsertChannels(j.items); return j.items[0].id; }
  }
  const j = await yt('search', { part: 'snippet', type: 'channel', q: input, maxResults: 1 });
  const id = j.items?.[0]?.id?.channelId;
  if (!id) throw new Error('채널을 찾지 못했습니다.');
  return id;
}

// ───────────────────────── Top 300 ─────────────────────────
const topState = { region: null, src: 'search', shortsOnly: true, cache: {} };
VIEWS.top = async (v, _, alive) => {
  const s = topState; s.region ??= DB.settings.region;
  v.innerHTML = `${needKey()}<div class="head"><div><h1>Top 300</h1><p class="sub" style="margin:0">국가별로 지금 가장 많이 본 쇼츠 순위입니다.</p></div></div>
  <div class="filters">
    <div class="f"><label>국가</label><div class="seg" id="tReg">${['KR', 'US', 'JP'].map(r => `<button data-r="${r}" class="${s.region === r ? 'on' : ''}">${REGIONS[r]}</button>`).join('')}</div></div>
    <div class="f"><label>기타 국가</label><select id="tRegSel">${opts(REGIONS, s.region)}</select></div>
    <div class="f"><label>데이터 소스</label><select id="tSrc">${opts({ search: '최근 7일 쇼츠 조회수 Top 300 (약 606 유닛)', chart: 'YouTube 인기 차트 (최대 200, 약 8 유닛)' }, s.src)}</select></div>
    <label class="row small" style="padding-bottom:9px"><input type="checkbox" id="tShorts" ${s.shortsOnly ? 'checked' : ''}> 쇼츠만</label>
    <button class="btn pri" id="tGo">불러오기</button>
  </div><div id="tRes"></div>`;
  const key = () => `${s.src}:${s.region}`;
  const draw = () => {
    const c = s.cache[key()];
    if (!c) return void ($('#tRes').innerHTML = '<div class="empty">국가와 소스를 고르고 <b>불러오기</b>를 누르세요.</div>');
    let list = s.shortsOnly ? c.vids.filter(isShort) : c.vids;
    $('#tRes').innerHTML = `<p class="muted small">${REGIONS[s.region]} · ${list.length}개 · ${ago(c.at)} 갱신</p>${videoGrid(list.slice(0, 300), { ranked: true })}`;
  };
  const go = async () => {
    $('#tRes').innerHTML = loadingHtml('순위를 불러오는 중…');
    try {
      let vids = [];
      if (s.src === 'chart') {
        let tok;
        for (let i = 0; i < 4; i++) {
          const j = await yt('videos', { part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode: s.region, maxResults: 50, pageToken: tok });
          vids.push(...(j.items || []).map(normVideo)); tok = j.nextPageToken; if (!tok) break;
        }
        await fetchChannels(vids.map(x => x.chId));
      } else {
        let tok;
        for (let i = 0; i < 6 && vids.length < 300; i++) {
          const r = await searchShorts({ region: s.region, after: Date.now() - 7 * D, pageToken: tok });
          vids.push(...r.vids); tok = r.next; if (!tok) break;
          if (alive()) $('#tRes').innerHTML = loadingHtml(`순위를 불러오는 중… ${vids.length}개`);
        }
        const seen = new Set(); vids = vids.filter(x => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => b.views - a.views);
      }
      s.cache[key()] = { at: Date.now(), vids };
      if (alive()) draw();
    } catch (e) { if (alive()) $('#tRes').innerHTML = errHtml(e); }
  };
  $('#tReg').onclick = e => { if (e.target.dataset.r) { s.region = e.target.dataset.r; render(); } };
  $('#tRegSel').onchange = e => { s.region = e.target.value; render(); };
  $('#tSrc').onchange = e => { s.src = e.target.value; draw(); };
  $('#tShorts').onchange = e => { s.shortsOnly = e.target.checked; draw(); };
  $('#tGo').onclick = go;
  draw();
};

// ───────────────────────── 채널 상세 ─────────────────────────
VIEWS.channel = async (v, id, alive) => {
  v.innerHTML = loadingHtml('채널을 분석하는 중…');
  await fetchChannels([id]);
  const c = DB.channels[id];
  if (!c || !c.t) throw new Error('채널 정보를 불러오지 못했습니다.');
  DB.recent = [id, ...DB.recent.filter(x => x !== id)].slice(0, 40); save();

  let vids = [];
  if (c.up) {
    const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: c.up, maxResults: 50 }, { ttl: 10 * 60e3 }).catch(() => ({ items: [] }));
    vids = await videosByIds((pl.items || []).map(i => i.contentDetails.videoId));
    vids.sort((a, b) => b.pub - a.pub);
  }
  if (!alive()) return;
  const [, subs, views, vcount] = lastSnap(c);
  const shorts = vids.filter(isShort);
  const base = median(vids.map(x => x.views)) || 1;
  const span = vids.length > 1 ? (vids[0].pub - vids[vids.length - 1].pub) / D : 0;
  const perWeek = span ? (vids.length - 1) / span * 7 : 0;
  const g24 = growth(c, 24), g7 = growth(c, 168), fav = DB.favorites[id];
  const vpd = viewsPerDay(c);

  // 일별 증감 (하루 단위 마지막 스냅샷끼리 비교)
  const byDay = new Map();
  for (const sn of c.s) { const d = new Date(sn[0]); byDay.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, sn); }
  const days = [...byDay.entries()];
  const dRows = days.slice(1).map(([d, sn], i) => ({ d, subs: sn[1] - days[i][1][1], views: sn[2] - days[i][1][2], vids: sn[3] - days[i][1][3] })).reverse().slice(0, 30);

  let vf = 'all', vs = 'date';
  v.innerHTML = `<span class="back" onclick="history.back()">← 뒤로</span>
  <div class="card"><div class="chead">
    <img class="av lg" src="${esc(c.th)}" alt="">
    <div class="info"><h1>${esc(c.t)} ${scoreBadge(honey(c))} ${ageDays(c.pub) <= 90 ? '<span class="badge new">신생</span>' : ''}</h1>
      <div class="muted small">${esc(c.h || '')} · 개설 ${new Date(c.pub).toLocaleDateString('ko-KR')} (${ageLabel(c.pub)}) ${c.c ? '· ' + esc(c.c) : ''}</div></div>
    <div class="row">
      <a class="btn" href="https://www.youtube.com/channel/${id}" target="_blank" rel="noopener">YouTube ↗</a>
      <button class="btn" id="benchBtn">${DB.bench.includes(id) ? '벤치마크 해제' : '＋ 벤치마크'}</button>
      <button class="btn ${fav ? 'pri' : ''}" id="favBtn">${fav ? '★ 찜함' : '☆ 찜하기'}</button>
    </div></div>
    <div class="kpis">
      <div class="kpi"><div class="k">구독자</div><div class="v">${c.hid ? '비공개' : fmt(subs)}</div><div class="d ${g24?.subs > 0 ? 'up' : 'muted'}">${g24 ? '24h ' + sign(g24.subs) : '24h 데이터 대기'}</div></div>
      <div class="kpi"><div class="k">총 조회수</div><div class="v">${fmt(views)}</div><div class="d ${g24?.views > 0 ? 'up' : 'muted'}">${g24 ? '24h ' + sign(g24.views) : '-'}</div></div>
      <div class="kpi"><div class="k">영상 수</div><div class="v">${fmt(vcount)}</div><div class="d muted">주 ${perWeek.toFixed(1)}개 업로드</div></div>
      <div class="kpi"><div class="k">일 조회수 ${g24 || g7 ? '(실측)' : '(평균)'}</div><div class="v">${fmt(vpd)}</div><div class="d muted">7일 ${g7 ? sign(g7.views) : '-'}</div></div>
      <div class="kpi"><div class="k">일 예상 수익</div><div class="v">${won(vpd * DB.settings.rpm / 1000)}</div><div class="d muted">월 ${won(vpd * 30 * DB.settings.rpm / 1000)}</div></div>
      <div class="kpi"><div class="k">최근 영상 중앙값</div><div class="v">${fmt(base)}</div><div class="d muted">쇼츠 비율 ${vids.length ? Math.round(shorts.length / vids.length * 100) : 0}%</div></div>
      <div class="kpi"><div class="k">조회/구독 배수</div><div class="v">${(chAvg(c) / Math.max(subs, 1)).toFixed(1)}배</div><div class="d muted">영상당 평균 ${fmt(chAvg(c))}</div></div>
      ${fav ? `<div class="kpi"><div class="k">찜 시점 대비</div><div class="v up">${sign(subs - fav.subs)}</div><div class="d muted">조회 ${sign(views - fav.views)} · ${ago(fav.at)}</div></div>` : ''}
    </div></div>

  <div class="grid2 mt">
    <div class="card"><div class="card-h"><h2>구독자 성장 곡선</h2><span class="muted small">스냅샷 ${c.s.length}개</span></div>${lineChart(c.s.map(x => [x[0], x[1]]), { color: '#ffb020' })}</div>
    <div class="card"><div class="card-h"><h2>조회수 성장 곡선</h2></div>${lineChart(c.s.map(x => [x[0], x[2]]), { color: '#5aa9ff' })}</div>
  </div>

  <div class="grid2 mt">
    <div class="card"><div class="card-h"><h2>일일 증감</h2></div>
      ${dRows.length ? `<div class="tbl-wrap" style="max-height:300px;overflow-y:auto"><table><thead><tr><th>날짜</th><th>구독자</th><th>조회수</th><th>영상</th><th>예상 수익</th></tr></thead><tbody>
      ${dRows.map(r => `<tr style="cursor:default"><td>${r.d}</td><td class="${r.subs > 0 ? 'up' : r.subs < 0 ? 'down' : ''}">${sign(r.subs)}</td><td>${sign(r.views)}</td><td>${sign(r.vids)}</td><td>${won(Math.max(r.views, 0) * DB.settings.rpm / 1000)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty small">이틀 이상 수집되면 일별 증감이 표시됩니다.<br>찜해두면 자동 수집 시 계속 기록됩니다.</div>'}
    </div>
    <div class="card"><div class="card-h"><h2>📝 메모</h2><span class="muted small" id="memoSaved"></span></div>
      <textarea id="memo" placeholder="이 채널에서 벤치마킹할 포인트, 소재 아이디어 등을 적어두세요.">${esc(DB.memos[id]?.text || '')}</textarea></div>
  </div>

  <div class="card mt"><div class="card-h"><h2>최근 업로드 ${vids.length}개</h2>
    <div class="row"><div class="seg" id="vFilter"><button data-f="all" class="on">전체</button><button data-f="short">쇼츠</button><button data-f="long">롱폼</button></div>
    <div class="seg" id="vSort"><button data-s="date" class="on">최신순</button><button data-s="views">조회순</button></div></div></div>
    <p class="muted small" style="margin-top:-4px">배지 = 최근 영상 중앙값(${fmt(base)}회) 대비 배수. 썸네일에 마우스를 올리면 재생됩니다.</p>
    <div id="vlist"></div></div>`;

  const drawV = () => {
    let l = vids.filter(x => vf === 'all' || (vf === 'short' ? isShort(x) : !isShort(x)));
    if (vs === 'views') l = [...l].sort((a, b) => b.views - a.views);
    $('#vlist').innerHTML = videoGrid(l, { base });
  };
  drawV();
  const seg = (el, fn) => el.onclick = e => { const b = e.target.closest('button'); if (!b) return; el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); fn(b); drawV(); };
  seg($('#vFilter'), b => vf = b.dataset.f);
  seg($('#vSort'), b => vs = b.dataset.s);
  $('#favBtn').onclick = () => { toggleFav(id); render(); };
  $('#benchBtn').onclick = () => { toggleBench(id); render(); };
  let mt; $('#memo').oninput = e => {
    clearTimeout(mt); mt = setTimeout(() => {
      const t = e.target.value.trim();
      if (t) DB.memos[id] = { text: e.target.value, at: Date.now() }; else delete DB.memos[id];
      save(); $('#memoSaved').textContent = '저장됨';
    }, 400);
  };
};

function toggleFav(id) {
  if (DB.favorites[id]) { delete DB.favorites[id]; toast('찜 해제'); }
  else { const [, s, v] = lastSnap(DB.channels[id]); DB.favorites[id] = { at: Date.now(), subs: s, views: v }; toast('찜했습니다 — 이 시점 대비 성장이 기록됩니다'); }
  save();
}
function toggleBench(id) {
  if (DB.bench.includes(id)) DB.bench = DB.bench.filter(x => x !== id);
  else { if (DB.bench.length >= 6) return toast('벤치마크는 최대 6개까지 비교할 수 있습니다.'); DB.bench.push(id); toast('벤치마크에 추가했습니다'); }
  save();
}

// ───────────────────────── 내 활동 ─────────────────────────
const meState = { tab: 'fav' };
VIEWS.me = async (v) => {
  const s = meState;
  const tabs = { fav: `즐겨찾기 ${Object.keys(DB.favorites).length}`, bench: `벤치마크 ${DB.bench.length}`, bm: `북마크 영상 ${Object.keys(DB.bookmarks).length}`, memo: `메모 ${Object.keys(DB.memos).length}`, recent: '최근 본 채널' };
  let body = '';
  const chs = ids => ids.map(id => DB.channels[id]).filter(c => c && c.t);
  if (s.tab === 'fav') {
    const list = chs(Object.keys(DB.favorites)).sort((a, b) => (lastSnap(b)[1] - DB.favorites[b.id].subs) - (lastSnap(a)[1] - DB.favorites[a.id].subs));
    body = list.length ? `<div class="tbl-wrap"><table><thead><tr><th>채널</th><th>꿀통</th><th>구독자</th><th>찜 이후 구독</th><th>찜 이후 조회</th><th>24h 조회</th><th>찜한 날</th></tr></thead><tbody>
      ${list.map(c => { const f = DB.favorites[c.id], [, sb, vw] = lastSnap(c), g = growth(c, 24); return `<tr data-ch="${c.id}"><td><div class="tcell"><img class="av" src="${esc(c.th)}"><span>${esc(c.t)}</span></div></td>
      <td>${scoreBadge(honey(c))}</td><td>${fmt(sb)}</td><td class="${sb - f.subs > 0 ? 'up' : ''}">${sign(sb - f.subs)}</td><td>${sign(vw - f.views)}</td><td>${g ? sign(g.views) : '-'}</td><td>${new Date(f.at).toLocaleDateString('ko-KR')}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">채널 상세에서 ☆ 찜하기를 누르면 찜한 시점 대비 성장이 계속 기록됩니다.</div>';
  } else if (s.tab === 'bench') {
    const list = chs(DB.bench);
    const rows = [
      ['꿀통 지수', c => scoreBadge(honey(c))], ['구독자', c => fmt(lastSnap(c)[1])], ['총 조회수', c => fmt(lastSnap(c)[2])], ['영상 수', c => fmt(lastSnap(c)[3])],
      ['영상당 평균 조회', c => fmt(chAvg(c))], ['조회/구독 배수', c => (chAvg(c) / Math.max(lastSnap(c)[1], 1)).toFixed(1) + '배'],
      ['일 조회수', c => fmt(viewsPerDay(c))], ['일 예상 수익', c => won(estDaily(c))], ['24h 구독 증가', c => { const g = growth(c, 24); return g ? sign(g.subs) : '-'; }],
      ['7일 구독 증가', c => { const g = growth(c, 168); return g ? sign(g.subs) : '-'; }], ['주간 업로드(평균)', c => (lastSnap(c)[3] / (ageDays(c.pub) / 7)).toFixed(1) + '개'], ['채널 나이', c => ageLabel(c.pub)],
    ];
    body = `<div class="filters"><div class="f" style="flex:1;min-width:220px"><label>채널 추가 (URL · @핸들 · 채널ID · 이름)</label><input id="bIn" placeholder="https://www.youtube.com/@handle"></div>
      <button class="btn pri" id="bAdd">추가</button><label class="row small" style="padding-bottom:9px"><input type="checkbox" id="bMine"> 내 채널로 지정</label></div>
      ${list.length ? `<div class="tbl-wrap"><table><thead><tr><th>항목</th>${list.map(c => `<th data-ch="${c.id}" style="text-align:right">${DB.myChannel === c.id ? '🏠 ' : ''}${esc(c.t)}<br><span class="iconbtn" data-unbench="${c.id}">✕</span></th>`).join('')}</tr></thead><tbody>
        ${rows.map(([k, f]) => `<tr style="cursor:default"><td class="muted">${k}</td>${list.map(c => `<td>${f(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">비교할 채널을 추가하세요. 내 채널과 경쟁 채널을 나란히 놓고 비교할 수 있습니다.</div>'}`;
  } else if (s.tab === 'bm') {
    const list = Object.values(DB.bookmarks).sort((a, b) => b.at - a.at);
    body = list.length ? videoGrid(list) : '<div class="empty">영상 카드의 ☆을 눌러 벤치마킹할 영상을 저장하세요.</div>';
  } else if (s.tab === 'memo') {
    const list = Object.entries(DB.memos).sort((a, b) => b[1].at - a[1].at);
    body = list.length ? list.map(([id, m]) => { const c = DB.channels[id]; return `<div class="memo-item"><div class="row" style="cursor:pointer" data-ch="${id}"><img class="av" style="width:28px;height:28px" src="${esc(c?.th || '')}"><b>${esc(c?.t || id)}</b><span class="muted small">${ago(m.at)}</span></div><div style="white-space:pre-wrap;margin-top:6px">${esc(m.text)}</div></div>`; }).join('') : '<div class="empty">채널 상세 화면에서 메모를 남길 수 있습니다.</div>';
  } else {
    body = chList(chs(DB.recent)) || '<div class="empty">최근 본 채널이 없습니다.</div>';
  }
  v.innerHTML = `<h1>내 활동</h1><p class="sub">즐겨찾기, 벤치마크, 북마크, 메모를 한곳에서 관리합니다.</p>
    <div class="seg" id="meTabs" style="margin-bottom:16px;flex-wrap:wrap">${Object.entries(tabs).map(([k, l]) => `<button data-t="${k}" class="${s.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card">${body}</div>`;
  $('#meTabs').onclick = e => { if (e.target.dataset.t) { s.tab = e.target.dataset.t; render(); } };
  if (s.tab === 'bench') {
    const add = async () => {
      const q = $('#bIn').value.trim(); if (!q) return;
      try { const id = await resolveChannel(q); await fetchChannels([id]); if (!DB.bench.includes(id)) toggleBench(id); if ($('#bMine').checked) DB.myChannel = id; save(); render(); }
      catch (e) { toast(e.message); }
    };
    $('#bAdd').onclick = add; $('#bIn').onkeydown = e => { if (e.key === 'Enter') add(); };
    v.querySelectorAll('[data-unbench]').forEach(b => b.onclick = e => { e.stopPropagation(); toggleBench(b.dataset.unbench); render(); });
  }
};

// ───────────────────────── 설정 ─────────────────────────
VIEWS.settings = async (v) => {
  const st = DB.settings;
  const size = (new Blob([localStorage.getItem(LS_KEY) || '']).size / 1024 / 1024).toFixed(2);
  v.innerHTML = `<h1>설정</h1><p class="sub">모든 데이터는 이 브라우저에만 저장됩니다. 구독·결제·기능 제한 없음.</p>
  <div class="grid2">
    <div class="card"><h2>YouTube Data API 키</h2>
      <ol class="steps small muted">
        <li><a class="acc" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud 콘솔</a>에서 프로젝트 생성</li>
        <li><a class="acc" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a> 사용 설정</li>
        <li>사용자 인증 정보 → API 키 만들기 → 아래에 붙여넣기</li>
        <li>(권장) 키 제한: HTTP 리퍼러 <code>${esc(location.origin)}/*</code></li>
      </ol>
      <div class="row"><input id="sKey" type="password" value="${esc(st.apiKey)}" placeholder="AIza…" style="flex:1;min-width:200px"><button class="btn pri" id="sKeySave">저장 및 테스트</button></div>
      <p class="small muted">하루 무료 할당량 10,000 유닛 · 검색 1회 100 유닛, 채널/영상 조회 50개당 1 유닛</p></div>
    <div class="card"><h2>분석 기본값</h2>
      <div class="filters" style="margin-top:12px">
        <div class="f"><label>기본 국가</label><select id="sRegion">${opts(REGIONS, st.region)}</select></div>
        <div class="f"><label>쇼츠 최대 길이(초)</label><select id="sShort">${opts({ 60: '60초', 180: '180초 (3분)' }, st.shortMax)}</select></div>
        <div class="f"><label>쇼츠 RPM (1천 조회당 ₩)</label><input id="sRpm" type="number" value="${st.rpm}"></div>
        <div class="f"><label>데일리 최소 조회수</label><input id="sMin" type="number" step="10000" value="${st.minDailyViews}"></div>
      </div>
      <div class="filters">
        <label class="row small"><input type="checkbox" id="sAuto" ${st.autoCollect ? 'checked' : ''}> 자동 수집</label>
        <div class="f"><label>수집 간격</label><select id="sEvery">${opts({ 3: '3시간', 6: '6시간 (하루 4회)', 12: '12시간', 24: '24시간' }, st.collectHours)}</select></div>
      </div>
      <button class="btn pri" id="sSave">저장</button></div>
  </div>
  <div class="card mt"><h2>데이터 관리</h2><p class="small muted">추적 채널 ${Object.keys(DB.channels).length.toLocaleString()}개 · 저장 용량 ${size}MB (브라우저 한도 약 5MB)</p>
    <div class="row"><button class="btn" id="sExport">백업 내보내기 (JSON)</button><label class="btn">백업 불러오기<input type="file" id="sImport" accept=".json" hidden></label>
    <button class="btn" id="sPrune">오래된 스냅샷 정리</button><button class="btn" id="sPruneCh">찜 안 한 소형 채널 정리</button><button class="btn" id="sReset" style="color:var(--down)">전체 초기화</button></div></div>`;

  $('#sKeySave').onclick = async () => {
    st.apiKey = $('#sKey').value.trim(); save();
    try { await yt('videoCategories', { part: 'snippet', regionCode: 'KR', hl: 'ko' }); toast('✅ API 키가 정상 작동합니다'); maybeAutoCollect(); }
    catch (e) { toast(e.message, 4000); }
  };
  $('#sSave').onclick = () => {
    Object.assign(st, { region: $('#sRegion').value, shortMax: +$('#sShort').value, rpm: +$('#sRpm').value || 0, minDailyViews: +$('#sMin').value || 0, autoCollect: $('#sAuto').checked, collectHours: +$('#sEvery').value });
    dailyState.region = dailyState.min = exState.region = topState.region = null;
    save(); toast('저장했습니다');
  };
  $('#sExport').onclick = () => {
    const out = { ...DB, settings: { ...DB.settings, apiKey: '' } };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    a.download = `shorts-radar-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  $('#sImport').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      for (const [id, c] of Object.entries(d.channels || {})) {
        const cur = DB.channels[id];
        if (!cur) DB.channels[id] = c;
        else { const m = new Map([...cur.s, ...c.s].map(x => [x[0], x])); cur.s = [...m.values()].sort((a, b) => a[0] - b[0]).slice(-400); }
      }
      for (const k of ['favorites', 'bookmarks', 'memos']) Object.assign(DB[k], d[k] || {});
      DB.bench = [...new Set([...DB.bench, ...(d.bench || [])])]; DB.recent = [...new Set([...DB.recent, ...(d.recent || [])])].slice(0, 40);
      save(); toast('백업을 병합했습니다'); render();
    } catch { toast('백업 파일을 읽지 못했습니다'); }
  };
  $('#sPrune').onclick = () => {
    // 7일 이전 스냅샷은 하루 1개만 남김
    let n = 0;
    for (const c of Object.values(DB.channels)) {
      const keep = new Map(), cut = Date.now() - 7 * D, rest = [];
      for (const sn of c.s) { if (sn[0] >= cut) rest.push(sn); else keep.set(new Date(sn[0]).toDateString(), sn); }
      const ns = [...keep.values(), ...rest]; n += c.s.length - ns.length; c.s = ns;
    }
    save(); toast(`스냅샷 ${n}개 정리`); render();
  };
  $('#sPruneCh').onclick = () => {
    const keep = new Set([...Object.keys(DB.favorites), ...DB.bench, ...Object.keys(DB.memos)]);
    let n = 0;
    for (const c of Object.values(DB.channels)) if (!keep.has(c.id) && lastSnap(c)[1] < 1000 && honey(c) < 40) { delete DB.channels[c.id]; n++; }
    save(); toast(`채널 ${n}개 정리`); render();
  };
  $('#sReset').onclick = () => {
    if (!confirm('API 키를 제외한 모든 데이터(추적 채널, 찜, 메모, 북마크)를 삭제할까요?')) return;
    const key = DB.settings.apiKey; localStorage.removeItem(LS_KEY); localStorage.setItem(LS_KEY, JSON.stringify({ settings: { ...DEFAULT_SETTINGS, apiKey: key } })); location.reload();
  };
};

// ───────────────────────── 전역 이벤트 ─────────────────────────
document.addEventListener('click', e => {
  const bm = e.target.closest('[data-bm]');
  if (bm) {
    e.stopPropagation();
    const id = bm.dataset.bm;
    if (DB.bookmarks[id]) delete DB.bookmarks[id];
    else {
      const card = bm.closest('.vcard'), v = findVideo(id);
      if (v) DB.bookmarks[id] = { ...v, at: Date.now() };
      else DB.bookmarks[id] = { id, t: card.querySelector('.vtitle').textContent, chId: card.querySelector('.vch').dataset.ch, ch: card.querySelector('.vch').textContent, th: card.querySelector('img').src, pub: Date.now(), views: 0, likes: 0, dur: 30, at: Date.now() };
    }
    save(); bm.classList.toggle('on'); bm.textContent = DB.bookmarks[id] ? '★' : '☆';
    toast(DB.bookmarks[id] ? '영상을 북마크했습니다' : '북마크 해제');
    return;
  }
  const fav = e.target.closest('[data-fav]');
  if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); fav.classList.toggle('on'); fav.textContent = DB.favorites[fav.dataset.fav] ? '★' : '☆'; return; }
  const th = e.target.closest('.thumb[data-vid]');
  if (th) { const v = findVideo(th.dataset.vid); window.open(`https://www.youtube.com/${!v || isShort(v) ? 'shorts/' : 'watch?v='}${th.dataset.vid}`, '_blank', 'noopener'); return; }
  const ch = e.target.closest('[data-ch]');
  if (ch && !e.target.closest('a,button,input,textarea,select')) location.hash = '#/channel/' + ch.dataset.ch;
});
function findVideo(id) {
  const pools = [dailyState.vids, ...Object.values(topState.cache).map(c => c.vids), DB.lastDaily?.videos || [], Object.values(DB.bookmarks)];
  for (const p of pools) { const v = p.find(x => x.id === id); if (v) return v; }
  return lastRendered.get(id);
}

// 썸네일 위에 마우스를 올리면 그 자리에서 재생 (음소거 자동재생)
let hoverT;
document.addEventListener('mouseover', e => {
  const th = e.target.closest('.thumb[data-vid]');
  if (!th || th.contains(e.relatedTarget) || th.querySelector('iframe')) return;
  clearTimeout(hoverT);
  hoverT = setTimeout(() => {
    const id = th.dataset.vid;
    th.insertAdjacentHTML('beforeend', `<iframe src="https://www.youtube.com/embed/${id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&playsinline=1&modestbranding=1&rel=0" allow="autoplay; encrypted-media" title=""></iframe>`);
  }, 350);
});
document.addEventListener('mouseout', e => {
  const th = e.target.closest('.thumb[data-vid]');
  if (!th || th.contains(e.relatedTarget)) return;
  clearTimeout(hoverT);
  th.querySelector('iframe')?.remove();
});

// 깨진 이미지(채널 아바타 등)는 깨진 아이콘 대신 빈 원으로 표시
document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);

window.addEventListener('hashchange', render);
renderFoot();
render();
maybeAutoCollect();
setInterval(() => { maybeAutoCollect(); renderFoot(); }, 10 * 60e3);
