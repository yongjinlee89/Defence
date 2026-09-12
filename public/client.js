'use strict';

/* ================================================================== 기본 설정 */

// 웹소켓 전용 — HTTP 롱폴링 폴백은 트래픽이 몇 배라 쓰지 않는다 (서버도 막아 둠)
const socket = io({ transports: ['websocket'] });

function myId() {
  let id = localStorage.getItem('defense:playerId');
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('defense:playerId', id);
  }
  return id;
}
const ME = myId();

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmt = (n) => Math.round(n || 0).toLocaleString('ko-KR');
const fmt1 = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let S = null; // 서버 상태
let C = null; // 게임 상수 (S.game.constants)
let joined = false;
let selected = null; // 선택한 영토 idx
let targeting = null; // { mode: 'move'|'attack', from, units }
let activeTab = 'tile';
let lastStateAt = Date.now();
let resultDismissed = false;

const UNIT_KINDS = ['inf', 'tank', 'arty', 'air'];
const MAT_KINDS = ['iron', 'oil', 'food', 'parts'];

/* ================================================================== 입장 */

$('#join-name').value = localStorage.getItem('defense:name') || '';
$('#join-room').value = localStorage.getItem('defense:room') || '';

function join() {
  const name = $('#join-name').value.trim();
  const roomId = $('#join-room').value.trim();
  if (!name) return showJoinError('이름을 입력해 주세요.');
  if (!roomId) return showJoinError('방 코드를 입력해 주세요.');
  localStorage.setItem('defense:name', name);
  localStorage.setItem('defense:room', roomId);
  socket.emit('joinRoom', { roomId, name, playerId: ME }, (res) => {
    if (!res || !res.ok) return showJoinError(res ? res.error : '접속에 실패했습니다.');
    joined = true;
    showJoinError('');
  });
}
function showJoinError(msg) {
  $('#join-error').textContent = msg || '';
}
$('#join-btn').addEventListener('click', join);
$('#join-room').addEventListener('keydown', (e) => e.key === 'Enter' && join());
$('#join-name').addEventListener('keydown', (e) => e.key === 'Enter' && join());

socket.on('connect', () => {
  if (joined) {
    socket.emit('joinRoom', { roomId: localStorage.getItem('defense:room'), name: localStorage.getItem('defense:name'), playerId: ME }, () => {});
  }
});

/* 탭을 덮어 두면 20초 뒤 상태 수신을 멈춰 트래픽을 아낀다. 돌아오면 서버가 전체 상태를 다시 준다. */
let bgTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => socket.emit('bg'), 20000);
  } else {
    clearTimeout(bgTimer);
    socket.emit('fg');
  }
});

/* ================================================================== 상태 수신 (diff 패치) */

const PATCH_DEL = '\u0000~del~\u0000'; // 서버 src/diff.js 와 반드시 같은 값
let stateSeq = 0;

function applyPatch(target, patch) {
  for (const k of Object.keys(patch)) {
    if (k === '$len') continue;
    const v = patch[k];
    if (v === PATCH_DEL) {
      delete target[k];
      continue;
    }
    const cur = target[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object') {
      applyPatch(cur, v);
    } else {
      target[k] = v;
    }
  }
  if (patch.$len !== undefined && Array.isArray(target)) target.length = patch.$len;
}

socket.on('state', (msg) => {
  if (!msg) return;
  const prevPhase = S ? S.phase : null;
  if (msg.f) {
    S = msg.f;
    stateSeq = msg.v;
  } else if (msg.p) {
    if (!S || stateSeq !== msg.base) {
      socket.emit('resync');
      return;
    }
    applyPatch(S, msg.p);
    stateSeq = msg.v;
  } else return;
  lastStateAt = Date.now();
  C = S.game ? S.game.constants : null;
  if (prevPhase !== S.phase) {
    resultDismissed = false;
    selected = null;
    targeting = null;
    for (const k of Object.keys(panes)) delete panes[k];
    if (S.phase === 'playing' && S.game) {
      const p = S.game.players.find((x) => x.id === ME);
      if (p) selected = p.capital;
    }
  }
  render();
});

function emit(event, payload, cb) {
  socket.emit(event, payload || {}, (res) => {
    if (res && !res.ok && res.error) toast(res.error);
    if (cb) cb(res);
  });
}

let toastTimer = null;
function toast(msg) {
  let node = $('#toast');
  if (!node) {
    node = el('div', '');
    node.id = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

/* ================================================================== 도우미 */

function me() {
  if (!S || !S.game) return null;
  return S.game.players.find((p) => p.id === ME) || null;
}
function playerOf(id) {
  if (!S || !S.game) return null;
  return S.game.players.find((p) => p.id === id) || null;
}
function isBotId(id) {
  const rp = S && S.roomPlayers ? S.roomPlayers.find((p) => p.id === id) : null;
  return !!(rp && rp.isBot);
}
function nameOf(id) {
  if (id === 'npc') return '약탈대';
  const p = playerOf(id);
  return p ? (isBotId(id) ? '🤖 ' : '') + p.name : '중립';
}
function colorOf(id) {
  const p = playerOf(id);
  return p ? p.color : '#555b6a';
}
function tiles() {
  return S.game.map.tiles;
}
function xyOf(idx) {
  const w = S.game.map.w;
  return { x: idx % w, y: Math.floor(idx / w) };
}
function adjacent(a, b) {
  const p = xyOf(a);
  const q = xyOf(b);
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y) === 1;
}
function neighborsOf(idx) {
  const out = [];
  for (let i = 0; i < tiles().length; i++) if (adjacent(idx, i)) out.push(i);
  return out;
}
function unitsOf(t) {
  const u = t.u || {};
  return { inf: u.inf || 0, tank: u.tank || 0, arty: u.arty || 0, air: u.air || 0 };
}
function unitsText(u) {
  const parts = [];
  for (const k of UNIT_KINDS) if ((u[k] || 0) >= 1 || (u[k] || 0) > 0.05) parts.push(C.UNIT[k].icon + fmt1(u[k]));
  return parts.join(' ') || '없음';
}
function costText(cost) {
  const parts = [];
  if (cost.cash) parts.push('💰' + fmt(cost.cash));
  for (const m of MAT_KINDS) if (cost[m]) parts.push(C.MATERIALS[m].icon + cost[m]);
  return parts.join(' ');
}
function canAfford(cost, times = 1) {
  const p = me();
  if (!p) return false;
  if (p.cash < (cost.cash || 0) * times) return false;
  for (const m of MAT_KINDS) if (cost[m] && p.inv[m] < cost[m] * times) return false;
  return true;
}
/** 마지막 상태 수신 뒤 흐른 시간을 더한 "지금" 경과 시간 */
function nowElapsed() {
  if (!S || !S.game) return 0;
  if (S.game.ended) return S.game.elapsed;
  return S.game.elapsed + (Date.now() - lastStateAt) / 1000;
}

/* ================================================================== 렌더링 */

function render() {
  if (!S) return;
  const phase = S.phase;
  $('#screen-join').classList.toggle('hidden', joined);
  $('#screen-lobby').classList.toggle('hidden', !joined || phase !== 'lobby');
  $('#screen-game').classList.toggle('hidden', !joined || phase === 'lobby');
  if (phase === 'lobby') renderLobby();
  else renderGame();
}

/* ------------------------------------------------------------------ 대기실 */

const SETTING_LABELS = { startCash: '시작 자금', duration: '게임 시간' };
const settingText = (key, v) => (key === 'duration' ? `${Math.round(v / 60)}분` : String(v));

function renderLobby() {
  $('#lobby-room-code').textContent = '#' + S.roomId;
  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of S.roomPlayers) {
    const li = el('li', p.connected ? '' : 'off');
    li.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === S.hostId ? ' 👑' : '');
    if (p.id === ME) li.classList.add('me');
    list.appendChild(li);
  }
  for (let i = S.roomPlayers.length; i < S.maxPlayers; i++) list.appendChild(el('li', 'empty', '빈 자리'));

  const isHost = ME === S.hostId;
  const wrap = $('#lobby-settings');
  wrap.innerHTML = '';
  for (const [key, choices] of Object.entries(S.settingChoices)) {
    const row = el('div', 'setting-row');
    row.appendChild(el('span', 'setting-label', SETTING_LABELS[key] || key));
    const group = el('div', 'setting-choices');
    for (const c of choices) {
      const btn = el('button', 'chip' + (S.settings[key] === c ? ' on' : ''), settingText(key, c));
      btn.disabled = !isHost;
      btn.addEventListener('click', () => emit('updateSettings', { [key]: c }));
      group.appendChild(btn);
    }
    row.appendChild(group);
    wrap.appendChild(row);
  }
  $('#lobby-add-bot').disabled = !isHost;
  $('#lobby-remove-bot').disabled = !isHost;
  $('#lobby-start').disabled = !isHost;
  $('#lobby-hint').textContent = isHost
    ? `${S.minPlayers}~${S.maxPlayers}명. 혼자면 컴퓨터를 추가해서 시작하세요.`
    : '방장이 시작하기를 기다리는 중...';
}
$('#lobby-add-bot').addEventListener('click', () => emit('addBot'));
$('#lobby-remove-bot').addEventListener('click', () => emit('removeBot'));
$('#lobby-start').addEventListener('click', () => emit('startGame'));
$('#lobby-leave').addEventListener('click', () => {
  emit('leaveRoom');
  joined = false;
  S = null;
  $('#screen-join').classList.remove('hidden');
  $('#screen-lobby').classList.add('hidden');
});

/* ------------------------------------------------------------------ 화면 조각 (부분 갱신) */

// 구조가 바뀌지 않으면 DOM 을 다시 만들지 않는다 — 입력칸·버튼 클릭이 씹히지 않게
const panes = {};
function renderPane(name, sig, build) {
  if (!panes[name]) panes[name] = { sig: null, live: [] };
  const p = panes[name];
  if (p.sig === sig) {
    for (const fn of p.live) fn();
    return false;
  }
  p.sig = sig;
  p.live = [];
  build(p.live);
  for (const fn of p.live) fn();
  return true;
}

/* ------------------------------------------------------------------ 게임 */

function renderGame() {
  const g = S.game;
  if (!g) return;
  renderHud();
  drawMap();
  renderTargetHint();
  renderTab();
  renderResult();
}

function renderHud() {
  const g = S.game;
  const p = me();
  $('#hud-timer').textContent = '⏱ ' + mmss(g.duration - nowElapsed());
  renderWave();
  const inv = $('#hud-inv');
  inv.innerHTML = '';
  if (p) {
    for (const m of MAT_KINDS) {
      const span = el('span');
      span.innerHTML = `${C.MATERIALS[m].icon} <b>${fmt1(p.inv[m])}</b>`;
      span.title = C.MATERIALS[m].name;
      inv.appendChild(span);
    }
  }
  $('#hud-land').textContent = p ? `🚩 ${p.land}칸` : '';
  $('#hud-cash').textContent = p ? `💰 ${fmt(p.cash)}` : '관전';
  $('#time-fill').style.width = `${Math.max(0, 100 - (nowElapsed() / g.duration) * 100)}%`;
}

function renderWave() {
  const g = S.game;
  const left = g.nextWave - nowElapsed();
  const node = $('#hud-wave');
  const warned = Object.keys(g.raids || {}).length > 0;
  node.textContent = `🔥 ${g.round + 1}라운드 습격까지 ${mmss(left)}`;
  node.classList.toggle('soon', warned);
}

// 시계·습격 카운트다운은 서버가 초마다 보내지 않아도 여기서 이어 깎는다
setInterval(() => {
  if (!S || S.phase !== 'playing' || !S.game) return;
  $('#hud-timer').textContent = '⏱ ' + mmss(S.game.duration - nowElapsed());
  renderWave();
}, 250);

/* ------------------------------------------------------------------ 지도 */

const canvas = $('#map');
const ctx = canvas.getContext('2d');

function mapGeometry() {
  const wrap = $('#map-wrap');
  const g = S.game;
  const pad = 8;
  const availW = wrap.clientWidth - pad * 2;
  const availH = wrap.clientHeight - pad * 2;
  const cell = Math.floor(Math.min(availW / g.map.w, availH / g.map.h));
  return { cell, w: cell * g.map.w, h: cell * g.map.h };
}

function drawMap() {
  const g = S.game;
  const geo = mapGeometry();
  if (geo.cell < 10) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== geo.w * dpr || canvas.height !== geo.h * dpr) {
    canvas.width = geo.w * dpr;
    canvas.height = geo.h * dpr;
    canvas.style.width = geo.w + 'px';
    canvas.style.height = geo.h + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, geo.w, geo.h);
  const cell = geo.cell;
  const gap = 3;
  const targets = targeting ? validTargets() : null;
  const p = me();

  tiles().forEach((t, idx) => {
    const { x, y } = xyOf(idx);
    const px = x * cell + gap;
    const py = y * cell + gap;
    const size = cell - gap * 2;
    // 바탕
    ctx.fillStyle = t.owner ? colorOf(t.owner) : '#2a2f3a';
    ctx.globalAlpha = t.owner ? 0.42 : 1;
    roundRect(px, py, size, size, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (t.bt) {
      // 전투 중 — 공격자 색 빗금 느낌으로 테두리를 굵게
      ctx.strokeStyle = t.bt.att === 'npc' ? '#f97316' : colorOf(t.bt.att);
      ctx.lineWidth = 3;
      roundRect(px + 1.5, py + 1.5, size - 3, size - 3, 7);
      ctx.stroke();
    }
    // 테두리 (선택 / 타깃)
    if (targets && targets.has(idx)) {
      ctx.strokeStyle = targeting.mode === 'attack' ? '#ef4444' : '#22c55e';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      roundRect(px + 1.5, py + 1.5, size - 3, size - 3, 7);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (idx === selected) {
      ctx.strokeStyle = '#ffd866';
      ctx.lineWidth = 3;
      roundRect(px + 1.5, py + 1.5, size - 3, size - 3, 7);
      ctx.stroke();
    }
    const fs = Math.max(10, Math.floor(cell / 9));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    // 이름 + 수도/자원
    ctx.fillStyle = '#e8eaf0';
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.fillText((t.cap ? '★ ' : '') + t.n, px + 6, py + 5);
    ctx.textAlign = 'right';
    ctx.font = `${fs}px sans-serif`;
    let res = t.res ? C.MATERIALS[t.res].icon + (t.rich > 1 ? '×2' : '') : '';
    if (g.raids && g.raids[idx]) res = '⚠️ ' + res;
    ctx.fillText(res, px + size - 6, py + 5);
    // 건물 아이콘
    ctx.textAlign = 'left';
    const icons = (t.b || []).map((b) => (C.ECON[b.k] || C.TOWER[b.k]).icon).join('');
    ctx.font = `${Math.floor(fs * 1.1)}px sans-serif`;
    ctx.fillText(icons, px + 6, py + 6 + fs * 1.4);
    // 빈 부지
    const free = t.slots - (t.b || []).length;
    ctx.fillStyle = '#9aa1b0';
    ctx.font = `${Math.floor(fs * 0.9)}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(`빈 ${free}`, px + size - 6, py + 6 + fs * 1.5);
    // 병력
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8eaf0';
    ctx.font = `${fs}px sans-serif`;
    const u = unitsOf(t);
    const uTxt = UNIT_KINDS.filter((k) => u[k] >= 0.5).map((k) => C.UNIT[k].icon + Math.floor(u[k])).join(' ');
    ctx.fillText(uTxt, px + 6, py + size - fs - 6);
    // 전투 표시
    if (t.bt) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fca5a5';
      ctx.font = `bold ${fs}px sans-serif`;
      const a = t.bt.A || {};
      const aTxt = UNIT_KINDS.filter((k) => (a[k] || 0) >= 0.5).map((k) => C.UNIT[k].icon + Math.floor(a[k])).join(' ');
      ctx.fillText('⚔️ ' + aTxt, px + size - 6, py + size - fs - 6);
    }
  });
  // 내 수도 없으면(관전) 아무것도 안 함
  void p;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function validTargets() {
  const set = new Set();
  if (!targeting) return set;
  for (const n of neighborsOf(targeting.from)) {
    const t = tiles()[n];
    if (targeting.mode === 'move' && t.owner === ME) set.add(n);
    if (targeting.mode === 'attack' && t.owner !== ME && (!t.bt || t.bt.att === ME)) set.add(n);
  }
  return set;
}

canvas.addEventListener('click', (e) => {
  if (!S || !S.game) return;
  const rect = canvas.getBoundingClientRect();
  const geo = mapGeometry();
  const x = Math.floor((e.clientX - rect.left) / geo.cell);
  const y = Math.floor((e.clientY - rect.top) / geo.cell);
  const g = S.game;
  if (x < 0 || y < 0 || x >= g.map.w || y >= g.map.h) return;
  const idx = y * g.map.w + x;
  if (targeting) {
    if (validTargets().has(idx)) {
      const payload = { from: targeting.from, to: idx, units: targeting.units };
      const mode = targeting.mode;
      targeting = null;
      emit(mode, payload, (res) => {
        if (res && res.ok) {
          selected = idx;
          setTab('tile');
          renderGame();
        }
      });
      renderGame();
      return;
    }
    toast(targeting.mode === 'attack' ? '인접한 남의 영토를 클릭하세요.' : '인접한 내 영토를 클릭하세요.');
    return;
  }
  selected = idx;
  setTab('tile');
  renderGame();
});

window.addEventListener('resize', () => {
  if (S && S.phase !== 'lobby' && S.game) drawMap();
});

function renderTargetHint() {
  const node = $('#target-hint');
  if (!targeting) {
    node.classList.add('hidden');
    return;
  }
  node.classList.remove('hidden');
  node.classList.toggle('attack', targeting.mode === 'attack');
  node.innerHTML = '';
  node.appendChild(el('span', '', (targeting.mode === 'attack' ? '⚔️ 공격할' : '➡️ 이동할') + ' 인접 영토를 클릭하세요 — ' + unitsText(targeting.units)));
  const cancel = el('button', 'small', '취소');
  cancel.addEventListener('click', () => {
    targeting = null;
    renderGame();
  });
  node.appendChild(cancel);
}

/* ------------------------------------------------------------------ 탭 */

for (const btn of document.querySelectorAll('#tabs .tab')) {
  btn.addEventListener('click', () => {
    setTab(btn.dataset.tab);
    renderTab();
  });
}
function setTab(name) {
  activeTab = name;
  for (const btn of document.querySelectorAll('#tabs .tab')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const body of document.querySelectorAll('.tab-body')) body.classList.toggle('hidden', body.id !== 'tab-' + name);
}

function renderTab() {
  if (activeTab === 'tile') renderTilePane();
  else if (activeTab === 'market') renderMarketPane();
  else if (activeTab === 'rank') renderRankPane();
  else if (activeTab === 'help') renderHelpPane();
  else if (activeTab === 'log') renderLogPane();
}

/* ------------------------------------------------------------------ 영토 패널 */

function renderTilePane() {
  const wrap = $('#tab-tile');
  const g = S.game;
  const p = me();
  if (selected === null || selected === undefined || !tiles()[selected]) {
    renderPane('tile:none', 'none', () => {
      wrap.innerHTML = '';
      wrap.appendChild(el('p', 'dim', '지도에서 영토를 클릭하세요.'));
    });
    return;
  }
  const t = tiles()[selected];
  const mine = !!p && p.alive && t.owner === ME;
  const bSig = (t.b || []).map((b) => b.k + (b.lv || 1)).join(',');
  const sig = ['tile', selected, t.owner, bSig, t.slots, t.bt ? t.bt.att : '', mine, p ? p.alive : 0, g.ended].join('|');
  renderPane('tile', sig, (live) => {
    wrap.innerHTML = '';

    // 헤더
    const head = el('div', 'card');
    const h = el('h3');
    h.appendChild(el('span', '', `${t.cap ? '★ ' : ''}${t.n} 영토`));
    const tag = el('span', 'owner-tag', t.owner ? nameOf(t.owner) : '중립');
    tag.style.background = t.owner ? colorOf(t.owner) : '#555b6a';
    h.appendChild(tag);
    head.appendChild(h);
    const info = el('div', 'dim');
    info.textContent = `${t.res ? `${C.MATERIALS[t.res].icon} ${C.MATERIALS[t.res].name} 땅${t.rich > 1 ? ' (풍부 ×2)' : ''}` : '자원 없음'} · 부지 ${(t.b || []).length}/${t.slots}`;
    head.appendChild(info);
    const raid = el('div', '');
    live.push(() => {
      const tt = tiles()[selected];
      const pid = S.game.raids && S.game.raids[selected];
      raid.textContent = pid ? `⚠️ 약탈대가 이 영토를 노리고 있습니다! (${mmss(S.game.nextWave - nowElapsed())} 뒤)` : '';
      raid.style.color = '#fca5a5';
      void tt;
    });
    head.appendChild(raid);
    wrap.appendChild(head);

    // 전투
    if (t.bt) {
      const bc = el('div', 'card battle');
      bc.appendChild(el('h3', '', '⚔️ 전투 중'));
      const bar = el('div', 'battle-bar');
      const aFill = el('div', 'a');
      const dFill = el('div', 'd');
      bar.appendChild(aFill);
      bar.appendChild(dFill);
      bc.appendChild(bar);
      const sides = el('div', 'side-list');
      const aBox = el('div');
      const dBox = el('div');
      sides.appendChild(aBox);
      sides.appendChild(dBox);
      bc.appendChild(sides);
      const elapsed = el('div', 'dim');
      bc.appendChild(elapsed);
      live.push(() => {
        const tt = tiles()[selected];
        if (!tt.bt) return;
        const A = tt.bt.A || {};
        const D = unitsOf(tt);
        const towers = (tt.b || []).filter((b) => C.TOWER[b.k]);
        const ap = UNIT_KINDS.reduce((s, k) => s + (A[k] || 0) * C.UNIT[k].hp, 0);
        const dp = UNIT_KINDS.reduce((s, k) => s + D[k] * C.UNIT[k].hp, 0) + towers.reduce((s, b) => s + (b.hp !== undefined ? b.hp : C.TOWER[b.k].hp), 0);
        const tot = ap + dp || 1;
        aFill.style.width = `${(ap / tot) * 100}%`;
        dFill.style.width = `${(dp / tot) * 100}%`;
        aBox.innerHTML = `<b style="color:#fca5a5">공격 ${nameOf(tt.bt.att)}</b><br>${unitsText(A)}`;
        dBox.innerHTML = `<b style="color:#93c5fd">수비 ${tt.owner ? nameOf(tt.owner) : '중립'}</b><br>${unitsText(D)}${towers.length ? '<br>' + towers.map((b) => C.TOWER[b.k].icon).join('') : ''}`;
        elapsed.textContent = `경과 ${tt.bt.t}초 · 전투 중인 영토에도 병력을 보내 증원할 수 있습니다.`;
      });
      if (t.bt.att === ME) {
        const rt = el('button', 'danger', '🏳️ 후퇴 (생존 병력을 출발지로)');
        rt.addEventListener('click', () => emit('retreat', { idx: selected }));
        bc.appendChild(rt);
      }
      wrap.appendChild(bc);
    }

    // 건물
    const bc = el('div', 'card');
    bc.appendChild(el('h3', '', '🏗️ 부지'));
    const list = el('div', 'slot-list');
    (t.b || []).forEach((b, i) => {
      const def = C.ECON[b.k] || C.TOWER[b.k];
      const row = el('div', 'slot');
      row.appendChild(el('span', '', def.icon));
      const name = el('span', 'name', def.name + (C.ECON[b.k] ? ` Lv${b.lv || 1}` : ''));
      row.appendChild(name);
      if (C.TOWER[b.k]) {
        const hp = el('span', 'hp');
        live.push(() => {
          const bb = (tiles()[selected].b || [])[i];
          if (bb) hp.textContent = `${bb.hp !== undefined ? Math.round(bb.hp) : C.TOWER[b.k].hp}/${C.TOWER[b.k].hp}`;
        });
        row.appendChild(hp);
      } else {
        row.appendChild(el('span', 'hp', econRateText(b, t)));
      }
      if (mine && !g.ended) {
        if (C.ECON[b.k] && (b.lv || 1) < C.MAX_LEVEL) {
          const cost = Math.round(def.cost.cash * Math.pow(C.UPGRADE_MULT, b.lv || 1));
          const up = el('button', 'small', `증설 💰${fmt(cost)}`);
          up.addEventListener('click', () => emit('upgrade', { idx: selected, slot: i }));
          live.push(() => (up.disabled = !me() || me().cash < cost));
          row.appendChild(up);
        }
        const dm = el('button', 'small', '✕');
        dm.title = `철거 (건설비 ${Math.round(C.DEMOLISH_REFUND * 100)}% 환불)`;
        dm.addEventListener('click', () => {
          if (confirm(`${def.name}을(를) 철거할까요? 건설비의 ${Math.round(C.DEMOLISH_REFUND * 100)}%만 돌려받습니다.`)) emit('demolish', { idx: selected, slot: i });
        });
        row.appendChild(dm);
      }
      list.appendChild(row);
    });
    for (let i = (t.b || []).length; i < t.slots; i++) list.appendChild(el('div', 'slot empty', '빈 부지'));
    bc.appendChild(list);

    if (mine && !g.ended && (t.b || []).length < t.slots) {
      bc.appendChild(el('h4', '', '건설 — 경제 건물은 돈을 벌고, 타워는 지킵니다'));
      const grid = el('div', 'build-grid');
      for (const [k, def] of [...Object.entries(C.ECON), ...Object.entries(C.TOWER)]) {
        if (def.res && def.res !== t.res) continue;
        const btn = el('button');
        btn.appendChild(el('span', '', `${def.icon} ${def.name}`));
        btn.appendChild(el('span', 'cost', costText(def.cost)));
        btn.title = def.desc;
        btn.addEventListener('click', () => emit('build', { idx: selected, kind: k }));
        live.push(() => (btn.disabled = !canAfford(def.cost)));
        grid.appendChild(btn);
      }
      bc.appendChild(grid);
    }
    wrap.appendChild(bc);

    // 병력
    const uc = el('div', 'card');
    uc.appendChild(el('h3', '', mine ? '🪖 주둔 병력 · 훈련' : '🪖 주둔 병력'));
    for (const k of UNIT_KINDS) {
      const def = C.UNIT[k];
      const row = el('div', 'unit-row');
      const nm = el('span', '', `${def.icon} ${def.name}`);
      nm.title = def.desc;
      row.appendChild(nm);
      const cnt = el('span', 'cnt');
      live.push(() => (cnt.textContent = fmt1(unitsOf(tiles()[selected])[k])));
      row.appendChild(cnt);
      if (mine && !g.ended) {
        for (const q of [1, 5, 10]) {
          const b = el('button', 'small', `+${q}`);
          b.addEventListener('click', () => emit('train', { idx: selected, unit: k, qty: q }));
          live.push(() => (b.disabled = !canAfford(def.cost, q)));
          row.appendChild(b);
        }
        row.appendChild(el('span', 'cost', `1기당 ${costText(def.cost)} · 체력 ${def.hp} 공격 ${def.dps}/초`));
      } else {
        row.appendChild(el('span', 'dim', `체력 ${def.hp}`));
        row.appendChild(el('span'));
        row.appendChild(el('span'));
      }
      uc.appendChild(row);
    }
    wrap.appendChild(uc);

    // 이동/공격
    if (mine && !g.ended) {
      const dc = el('div', 'card');
      dc.appendChild(el('h3', '', '🎯 출정'));
      dc.appendChild(el('div', 'dim', '보낼 수를 정한 뒤 이동(내 땅) 또는 공격(남의 땅)을 누르고 지도에서 인접 영토를 클릭하세요.'));
      const grid = el('div', 'pick-grid');
      const inputs = {};
      for (const k of UNIT_KINDS) {
        const lab = el('label', '', `${C.UNIT[k].icon} ${C.UNIT[k].name}`);
        const inp = el('input');
        inp.type = 'number';
        inp.min = 0;
        inp.value = Math.floor(unitsOf(t)[k]);
        inputs[k] = inp;
        lab.appendChild(inp);
        grid.appendChild(lab);
        // 병력이 늘면 상한만 올린다 — 사용자가 적은 값을 지우지 않는다
        live.push(() => {
          const have = Math.floor(unitsOf(tiles()[selected])[k]);
          inp.max = have;
          if (Number(inp.value) > have) inp.value = have;
        });
      }
      dc.appendChild(grid);
      const row = el('div', 'row');
      const all = el('button', 'small', '전부');
      all.addEventListener('click', () => {
        for (const k of UNIT_KINDS) inputs[k].value = Math.floor(unitsOf(tiles()[selected])[k]);
      });
      const half = el('button', 'small', '절반');
      half.addEventListener('click', () => {
        for (const k of UNIT_KINDS) inputs[k].value = Math.floor(unitsOf(tiles()[selected])[k] / 2);
      });
      const pick = () => {
        const u = {};
        let any = false;
        for (const k of UNIT_KINDS) {
          u[k] = Math.max(0, Math.floor(Number(inputs[k].value) || 0));
          if (u[k] > 0) any = true;
        }
        return any ? u : null;
      };
      const mv = el('button', 'primary', '➡️ 이동');
      mv.addEventListener('click', () => {
        const u = pick();
        if (!u) return toast('보낼 병력을 정하세요.');
        targeting = { mode: 'move', from: selected, units: u };
        renderGame();
      });
      const at = el('button', 'danger', '⚔️ 공격');
      at.addEventListener('click', () => {
        const u = pick();
        if (!u) return toast('보낼 병력을 정하세요.');
        targeting = { mode: 'attack', from: selected, units: u };
        renderGame();
      });
      row.appendChild(all);
      row.appendChild(half);
      row.appendChild(el('span', 'grow'));
      row.appendChild(mv);
      row.appendChild(at);
      dc.appendChild(row);
      wrap.appendChild(dc);
    } else if (p && p.alive && !g.ended) {
      wrap.appendChild(el('p', 'dim', '이 영토를 치려면 인접한 내 영토를 선택해 "공격" 을 누르세요.'));
    }
  });
}

function econRateText(b, t) {
  const def = C.ECON[b.k];
  const lv = b.lv || 1;
  if (def.res) return `+${fmt1(def.rate * (t.rich || 1) * lv)}/초`;
  if (def.income) return `+💰${fmt1(def.income * lv)}/초`;
  if (def.out) return `⚙️+${fmt1(def.out.parts * lv)}/초`;
  return '';
}

/* ------------------------------------------------------------------ 시장 */

function renderMarketPane() {
  const wrap = $('#tab-market');
  const p = me();
  const g = S.game;
  const sig = ['mkt', p ? MAT_KINDS.map((m) => (p.autoSell[m] ? 1 : 0)).join('') : 'x', p ? p.alive : 0, g.ended].join('|');
  renderPane('market', sig, (live) => {
    wrap.innerHTML = '';
    wrap.appendChild(el('p', 'dim', `사면 오르고 팔면 내립니다. 거래 수수료 ${Math.round(C.SPREAD * 100)}%. 시간이 지나면 기준가로 돌아옵니다.`));
    for (const m of MAT_KINDS) {
      const def = C.MATERIALS[m];
      const card = el('div', 'card');
      const row = el('div', 'mkt-row');
      const nm = el('div');
      nm.innerHTML = `${def.icon} <b>${def.name}</b> <span class="dim">기준 ${def.base}</span>`;
      row.appendChild(nm);
      const price = el('div', 'price');
      row.appendChild(price);
      const have = el('div', 'dim');
      row.appendChild(have);
      const auto = el('div');
      row.appendChild(auto);
      live.push(() => {
        const pp = me();
        price.textContent = `💰${fmt1(S.game.market[m])}`;
        have.textContent = pp ? `보유 ${fmt1(pp.inv[m])}` : '';
      });
      if (p && p.alive && !g.ended) {
        const tg = el('button', 'small' + (p.autoSell[m] ? ' on' : ''), p.autoSell[m] ? `자동 판매 켬 (${C.AUTO_SELL_KEEP[m]} 남김)` : '자동 판매');
        tg.addEventListener('click', () => emit('setAutoSell', { mat: m, on: !p.autoSell[m] }));
        auto.appendChild(tg);
        const btns = el('div', 'btns');
        for (const q of [1, 10, 50]) {
          const b = el('button', 'small', `사기 ${q}`);
          b.addEventListener('click', () => emit('trade', { mat: m, side: 'buy', qty: q }));
          btns.appendChild(b);
        }
        for (const q of [1, 10, -1]) {
          const b = el('button', 'small', q === -1 ? '전부 팔기' : `팔기 ${q}`);
          b.addEventListener('click', () => emit('trade', { mat: m, side: 'sell', qty: q }));
          live.push(() => (b.disabled = !me() || me().inv[m] < (q === -1 ? 1 : q)));
          btns.appendChild(b);
        }
        row.appendChild(btns);
      }
      card.appendChild(row);
      wrap.appendChild(card);
    }
    if (p) {
      const nw = el('div', 'card');
      const nwText = el('div');
      live.push(() => (nwText.innerHTML = `순자산 <b>💰${fmt(me().nw)}</b> <span class="dim">(돈+자원+건물+병력+땅)</span>`));
      nw.appendChild(nwText);
      wrap.appendChild(nw);
    }
  });
}

/* ------------------------------------------------------------------ 순위 */

function renderRankPane() {
  const wrap = $('#tab-rank');
  const g = S.game;
  wrap.innerHTML = '';
  const table = el('table', 'rank');
  const thead = el('thead');
  thead.innerHTML = '<tr><th>플레이어</th><th>땅</th><th>돈</th><th>순자산</th></tr>';
  table.appendChild(thead);
  const tbody = el('tbody');
  const rows = [...g.players].sort((a, b) => (a.alive !== b.alive ? (a.alive ? -1 : 1) : b.nw - a.nw));
  for (const p of rows) {
    const tr = el('tr', (p.id === ME ? 'me ' : '') + (p.alive ? '' : 'dead'));
    const nm = el('td');
    const dot = el('span', '', '● ');
    dot.style.color = p.color;
    nm.appendChild(dot);
    nm.appendChild(document.createTextNode((isBotId(p.id) ? '🤖 ' : '') + p.name + (p.id === ME ? ' (나)' : '')));
    tr.appendChild(nm);
    tr.appendChild(el('td', '', String(p.land)));
    tr.appendChild(el('td', '', fmt(p.cash)));
    tr.appendChild(el('td', '', fmt(p.nw)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(el('p', 'dim', `${g.round}라운드 진행 중 · 다음 습격: 보병 ${3 + Math.round(1.5 * (g.round + 1))}${g.round + 1 >= 2 ? ' + 전차·포병' : ''}${g.round + 1 >= 5 ? ' + 항공기' : ''}`));
}

/* ------------------------------------------------------------------ 상성표 */

function renderHelpPane() {
  const wrap = $('#tab-help');
  renderPane('help', 'static', () => {
    wrap.innerHTML = '';
    const cats = ['inf', 'tank', 'arty', 'air', 'mg', 'cannon', 'mortar', 'aa'];
    const label = (k) => (C.UNIT[k] || C.TOWER[k]).icon;
    const table = el('table', 'mult');
    const head = el('tr');
    head.appendChild(el('th', '', '공격↓ 대상→'));
    for (const c of cats) head.appendChild(el('th', '', label(c)));
    table.appendChild(head);
    for (const a of cats) {
      const tr = el('tr');
      const th = el('th', '', `${label(a)} ${(C.UNIT[a] || C.TOWER[a]).name}`);
      tr.appendChild(th);
      for (const c of cats) {
        const m = C.MULT[a][c];
        const td = el('td', m === undefined ? 'zero' : m === 0 ? 'zero' : m >= 1.5 ? 'hi' : m <= 0.5 ? 'lo' : '', m === undefined ? '—' : m === 0 ? '✕' : `×${m}`);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    wrap.appendChild(el('p', 'dim', '피해 배수. 초록은 강함, 빨강은 약함, ✕는 아예 못 때림. 타워는 수비 때만 싸웁니다.'));
    wrap.appendChild(table);
    const list = el('div', 'help-list');
    for (const [k, d] of [...Object.entries(C.UNIT), ...Object.entries(C.TOWER)]) {
      const line = el('div');
      line.innerHTML = `<span class="k">${d.icon} ${d.name}</span> 체력 ${d.hp} · 공격 ${d.dps}/초 · ${costText(d.cost)}<br><span class="dim">${d.desc}</span>`;
      list.appendChild(line);
    }
    for (const [k, d] of Object.entries(C.ECON)) {
      const line = el('div');
      line.innerHTML = `<span class="k">${d.icon} ${d.name}</span> ${costText(d.cost)} · 증설 시 생산 ×레벨<br><span class="dim">${d.desc}</span>`;
      list.appendChild(line);
    }
    const tips = el('div');
    tips.innerHTML = `<span class="k">💡 요령</span><br><span class="dim">· 습격은 12초 전에 예고됩니다. 인접한 땅의 병력을 옮겨 막으세요.<br>· 점령하면 상대의 경제 건물을 그대로 가져옵니다. 타워는 전투에서 부서집니다.<br>· 부품은 공장에서만 나옵니다. 시장에서 사면 비쌉니다.<br>· 곡사(포병)는 타워를 잘 부수지만 보병에 약합니다. 항공기는 대공포가 없으면 막기 어렵습니다.</span>`;
    list.appendChild(tips);
    wrap.appendChild(list);
  });
}

/* ------------------------------------------------------------------ 기록/채팅 */

function renderLogPane() {
  const list = $('#log-list');
  const entries = [];
  for (const e of Object.values(S.log || {})) entries.push({ key: 'l' + e.id, order: e.id, text: e.text, t: e.t });
  for (const e of Object.values(S.chat || {})) entries.push({ key: 'c' + e.id, order: e.t / 1000, chat: true, name: e.name, text: e.text });
  const sig = entries.map((e) => e.key).join(',');
  const changed = renderPane('log', sig, () => {
    list.innerHTML = '';
    const logs = entries.filter((e) => !e.chat).sort((a, b) => a.order - b.order);
    const chats = entries.filter((e) => e.chat).sort((a, b) => a.order - b.order);
    // 채팅은 아래쪽에, 게임 기록은 시간순으로 — 둘 다 마지막 40줄
    for (const e of logs.slice(-40)) {
      const line = el('div', 'line');
      line.appendChild(el('span', 't', mmss(e.t)));
      line.appendChild(document.createTextNode(e.text));
      list.appendChild(line);
    }
    for (const e of chats.slice(-30)) {
      const line = el('div', 'line chat');
      line.appendChild(el('span', 'name', e.name));
      line.appendChild(document.createTextNode(e.text));
      list.appendChild(line);
    }
  });
  if (changed) list.scrollTop = list.scrollHeight;
}
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  emit('chat', { text });
  input.value = '';
});

/* ------------------------------------------------------------------ 결과 */

function renderResult() {
  const g = S.game;
  const overlay = $('#result-overlay');
  if (!g.ended || !g.ranking || resultDismissed) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const list = $('#result-list');
  list.innerHTML = '';
  g.ranking.forEach((r, i) => {
    const li = el('li', r.id === ME ? 'me' : '');
    li.textContent = `${['🥇', '🥈', '🥉'][i] || ''} ${isBotId(r.id) ? '🤖 ' : ''}${r.name} — 순자산 ${fmt(r.netWorth)}, 땅 ${r.land}칸${r.alive ? '' : ' (탈락)'}`;
    list.appendChild(li);
  });
  const isHost = ME === S.hostId;
  $('#result-restart').disabled = !isHost;
  $('#result-hint').textContent = isHost ? '다시 하기를 누르면 대기실로 돌아갑니다.' : '방장이 다시 시작하기를 기다리는 중...';
}
$('#result-restart').addEventListener('click', () => emit('restart'));
$('#result-close').addEventListener('click', () => {
  resultDismissed = true;
  renderResult();
});
