'use strict';

/**
 * 디펜스 — 영토 확장 실시간 디펜스 게임의 규칙 엔진.
 *
 * 핵심 구조:
 *  - 맵은 N×N 격자의 "영토(타일)". 각 영토에는 자원(철/석유/식량/없음), 부지 수(slots),
 *    건물 목록(b), 주둔 병력(units)이 있다. 상하좌우로 인접한 영토끼리만 이동·공격이 가능하다.
 *  - 돈은 타워가 적을 죽여서 버는 게 아니라, 부지에 지은 광산·유정·농장·공장·상점이 벌어 준다.
 *    부지는 건물과 타워가 함께 쓰므로 "경제 vs 방어" 를 매 영토마다 저울질해야 한다.
 *  - 전투는 영토 단위 소모전이다. 양쪽 병력이 매 틱 상성표(MULT)에 따라 서로를 갉아먹는다.
 *    타워도 전투원이다(hp 가 있고 부서진다). 공격자가 이기면 영토·경제 건물을 빼앗고 살아남은
 *    병력이 그대로 주둔한다.
 *  - 라운드(습격): 일정 시간마다 NPC 약탈대가 각 플레이어의 영토 하나를 친다. 막지 못하면 그 땅을
 *    잃는다 — 그래서 모든 땅에 최소한의 방어가 필요하다.
 *  - 시장: 자원·부품은 돈으로 사고팔 수 있고, 사면 오르고 팔면 내린다(수요·공급).
 *
 * 이 파일은 순수 규칙만 담는다. 네트워크·타이머는 room.js/server.js 가 맡는다.
 * 봇(bot.js)도 이 파일의 공개 메서드만 호출한다 — 반칙 불가.
 */

/* ================================================================== 상수 */

// 자원 4종 (부품은 공장에서 제작하는 2차 자원)
const MATERIALS = {
  iron: { name: '철', icon: '⛏️', base: 10, impact: 0.004 },
  oil: { name: '석유', icon: '🛢️', base: 15, impact: 0.005 },
  food: { name: '식량', icon: '🌾', base: 6, impact: 0.003 },
  parts: { name: '부품', icon: '⚙️', base: 60, impact: 0.02 },
};
const MAT_KINDS = Object.keys(MATERIALS);
const SPREAD = 0.02; // 살 때 +2%, 팔 때 −2% — 왕복만으로 돈이 불어나는 것을 막는다
const REVERT = 0.03; // 가격 배수가 초당 3% 씩 1.0 으로 되돌아간다

// 유닛 4종. dps = 초당 공격력, hp = 체력. type 은 공중/지상 구분.
const UNIT = {
  inf: { name: '보병', icon: '🪖', hp: 10, dps: 1.2, cost: { cash: 20, food: 2 }, desc: '싸고 많다. 포병에 강하고 전차·기관총에 약하다.' },
  tank: { name: '전차', icon: '🛡️', hp: 40, dps: 4, cost: { cash: 80, parts: 2, iron: 3 }, desc: '직사화기. 타워를 잘 부수고 보병을 밀어낸다. 공중을 못 때린다.' },
  arty: { name: '포병', icon: '💣', hp: 15, dps: 5, cost: { cash: 70, parts: 2, iron: 1 }, desc: '곡사화기. 멀리서 타워·보병을 부순다. 보병·항공기가 접근하면 약하다.' },
  air: { name: '항공기', icon: '✈️', hp: 25, dps: 6, cost: { cash: 120, parts: 3, oil: 4 }, desc: '전차·포병에 강하다. 대공포와 보병(소총)만 맞출 수 있다.' },
};
const UNIT_KINDS = Object.keys(UNIT);

// 타워 4종. 부지 하나를 차지하는 건물이며 전투에 참가한다.
const TOWER = {
  mg: { name: '기관총탑', icon: '🔫', hp: 60, dps: 4, cost: { cash: 100, iron: 10 }, desc: '보병 학살. 전차에 약하다.' },
  cannon: { name: '포탑', icon: '🏯', hp: 80, dps: 6, cost: { cash: 150, iron: 15, parts: 2 }, desc: '직사. 전차를 잡는다. 공중을 못 때린다.' },
  mortar: { name: '박격포', icon: '🎯', hp: 50, dps: 5, cost: { cash: 130, iron: 8, parts: 3 }, desc: '곡사. 보병·포병에 강하다. 공중을 못 때린다.' },
  aa: { name: '대공포', icon: '🚀', hp: 60, dps: 6, cost: { cash: 140, iron: 10, parts: 3 }, desc: '항공기 전담. 지상에는 약하다.' },
};
const TOWER_KINDS = Object.keys(TOWER);

// 경제 건물. 광산/유정/농장은 해당 자원이 있는 땅에만 지을 수 있다.
const ECON = {
  mine: { name: '광산', icon: '⛏️', res: 'iron', cost: { cash: 150 }, rate: 0.4, desc: '철 생산 (철 땅 전용)' },
  well: { name: '유정', icon: '🛢️', res: 'oil', cost: { cash: 150 }, rate: 0.4, desc: '석유 생산 (석유 땅 전용)' },
  farm: { name: '농장', icon: '🌾', res: 'food', cost: { cash: 150 }, rate: 0.5, desc: '식량 생산 (식량 땅 전용)' },
  factory: { name: '공장', icon: '🏭', cost: { cash: 250 }, in: { iron: 0.3, oil: 0.15 }, out: { parts: 0.2 }, desc: '철+석유 → 부품 제작. 부품은 비싸게 팔리고 전차·포병·항공기 재료다.' },
  shop: { name: '상점', icon: '🏪', cost: { cash: 120 }, income: 3, desc: '초당 돈을 번다. 자원이 없는 땅에도 지을 수 있다.' },
};
const ECON_KINDS = Object.keys(ECON);
const MAX_LEVEL = 3;
const UPGRADE_MULT = 1.6; // 레벨업 비용 = 건설비 × 1.6^(현재 레벨)
const LAND_VALUE = 300; // 순자산에 더하는 땅 한 칸의 가치

/**
 * 상성표 — 공격자 종류(행) 가 대상 종류(열) 에게 주는 피해 배수.
 * 0 이면 아예 맞출 수 없다 (직사·곡사화기는 공중을 못 때린다).
 * 곡사(포병·박격포)는 사거리 덕에 직사화기(전차·포탑·기관총)에게 덜 맞고,
 * 대신 접근하는 보병·항공기에는 약하다.
 */
const MULT = {
  inf: { inf: 1.0, tank: 0.4, arty: 1.5, air: 0.2, mg: 0.5, cannon: 0.6, mortar: 1.0, aa: 1.0 },
  tank: { inf: 1.2, tank: 1.0, arty: 0.6, air: 0, mg: 1.5, cannon: 1.2, mortar: 1.5, aa: 1.5 },
  arty: { inf: 1.5, tank: 0.8, arty: 1.0, air: 0, mg: 2.0, cannon: 2.0, mortar: 1.5, aa: 2.0 },
  air: { inf: 1.0, tank: 1.5, arty: 1.5, air: 1.0, mg: 1.0, cannon: 1.5, mortar: 1.5, aa: 0.5 },
  mg: { inf: 2.0, tank: 0.3, arty: 0.5, air: 0.5 },
  cannon: { inf: 0.6, tank: 2.0, arty: 0.5, air: 0 },
  mortar: { inf: 1.5, tank: 0.6, arty: 1.5, air: 0 },
  aa: { inf: 0.3, tank: 0.2, arty: 0.3, air: 3.0 },
};

const WAVE_SEC = 75; // 습격 간격
const WAVE_WARN = 12; // 습격 예고 (초) — 이 시간 동안 병력을 옮겨 대비할 수 있다
const BATTLE_LIMIT = 150; // 이보다 긴 전투는 공격자 후퇴로 강제 종료 (교착 방지)
const TOWER_REPAIR = 1; // 전투 중이 아닐 때 타워 초당 수리량
const DEMOLISH_REFUND = 0.3;
const AUTO_SELL_KEEP = { iron: 10, oil: 10, food: 10, parts: 4 }; // 자동 판매 시 남겨 두는 양

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4'];

/* ================================================================== 도우미 */

function sum(obj) {
  let s = 0;
  for (const v of Object.values(obj)) s += v;
  return s;
}
function emptyUnits() {
  return { inf: 0, tank: 0, arty: 0, air: 0 };
}
function tileName(x, y) {
  return String.fromCharCode(65 + x) + (y + 1);
}
/** 단순한 결정적 난수 (테스트 재현용 시드) */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ================================================================== 게임 */

class Game {
  /**
   * @param {Array<{id:string,name:string}>} players
   * @param {{startCash:number,duration:number,seed?:number}} settings
   */
  constructor(players, settings) {
    this.settings = { startCash: 800, duration: 600, ...settings };
    this.elapsed = 0;
    this.ended = false;
    this.ranking = null;
    this.round = 0;
    this.nextWave = WAVE_SEC;
    /** 예고된 습격 {pid: tileIdx} — 예고 시점에 정하고 습격 시점에 실행 */
    this.raids = {};
    this.log = [];
    this._logSeq = 0;
    this._rand = rng(this.settings.seed || (Date.now() & 0xffffffff));

    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: COLORS[i % COLORS.length],
      cash: this.settings.startCash,
      inv: { iron: 20, oil: 10, food: 20, parts: 4 },
      alive: true,
      diedAt: null,
      autoSell: { iron: false, oil: false, food: false, parts: false },
      capital: -1,
    }));

    this.market = {};
    for (const m of MAT_KINDS) this.market[m] = { mult: 1 };

    this.buildMap();
  }

  /* ---------------------------------------------------------------- 맵 생성 */

  buildMap() {
    const n = this.players.length;
    const size = n <= 2 ? 4 : n <= 4 ? 5 : 6;
    this.map = { w: size, h: size, tiles: [] };
    const rand = this._rand;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = rand();
        const res = r < 0.3 ? 'iron' : r < 0.55 ? 'oil' : r < 0.8 ? 'food' : null;
        const rich = res && rand() < 0.25 ? 2 : 1;
        this.map.tiles.push({
          idx: y * size + x,
          x,
          y,
          name: tileName(x, y),
          res,
          rich,
          slots: res ? 3 + rich : 4,
          owner: null,
          capital: false,
          b: [],
          units: emptyUnits(),
          battle: null,
        });
      }
    }
    // 수도 위치 — 서로 최대한 떨어뜨린다 (모서리 → 변 가운데)
    const L = size - 1;
    const mid = Math.floor(size / 2);
    const spots = [
      [0, 0],
      [L, L],
      [L, 0],
      [0, L],
      [mid, 0],
      [mid, L],
    ];
    this.players.forEach((p, i) => {
      const [x, y] = spots[i];
      const t = this.tileAt(x, y);
      t.res = 'iron'; // 누구나 철은 캘 수 있어야 전차·타워를 만들 수 있다
      t.rich = 1;
      t.slots = 6;
      t.owner = p.id;
      t.capital = true;
      t.b = [
        { k: 'mine', lv: 1 },
        { k: 'shop', lv: 1 },
        { k: 'mg', hp: TOWER.mg.hp },
        { k: 'mg', hp: TOWER.mg.hp },
      ];
      t.units = { inf: 8, tank: 0, arty: 0, air: 0 };
      p.capital = t.idx;
    });
    // 중립 땅의 수비대 — 수도에서 멀수록 세다 (자원이 풍부한 땅도 더 지킨다)
    for (const t of this.map.tiles) {
      if (t.owner) continue;
      let dist = Infinity;
      for (const p of this.players) {
        const c = this.map.tiles[p.capital];
        dist = Math.min(dist, Math.abs(c.x - t.x) + Math.abs(c.y - t.y));
      }
      const scale = dist <= 1 ? 1 : dist === 2 ? 1.6 : 2.4;
      t.units = emptyUnits();
      t.units.inf = Math.round((3 + 2 * t.rich + (t.res ? 2 : 0)) * scale);
      if (t.res && dist >= 2) t.units.tank = Math.round(scale - 1);
      if (t.res) t.b.push({ k: 'mg', hp: TOWER.mg.hp });
      if (dist >= 3) t.b.push({ k: 'cannon', hp: TOWER.cannon.hp });
    }
  }

  tileAt(x, y) {
    return this.map.tiles[y * this.map.w + x];
  }
  tile(idx) {
    return Number.isInteger(idx) && idx >= 0 && idx < this.map.tiles.length ? this.map.tiles[idx] : null;
  }
  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }
  adjacent(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  }
  neighbors(t) {
    return this.map.tiles.filter((o) => this.adjacent(t, o));
  }
  landOf(pid) {
    return this.map.tiles.filter((t) => t.owner === pid);
  }

  pushLog(text) {
    this.log.push({ id: ++this._logSeq, t: Math.round(this.elapsed), text });
    if (this.log.length > 80) this.log.shift();
  }

  /* ---------------------------------------------------------------- 가격 */

  price(m) {
    return MATERIALS[m].base * this.market[m].mult;
  }
  /** q 개를 살 때 총액 (사는 동안 가격이 오르는 것을 반영) */
  buyCost(m, q) {
    const mat = MATERIALS[m];
    const mk = this.market[m];
    return mat.base * q * (mk.mult + (mat.impact * q) / 2) * (1 + SPREAD);
  }
  /** q 개를 팔 때 받는 돈 (파는 동안 가격이 내리는 것을 반영, 배수는 0.2 아래로 안 내려간다) */
  sellGain(m, q) {
    const mat = MATERIALS[m];
    const mk = this.market[m];
    const end = Math.max(0.2, mk.mult - mat.impact * q);
    return mat.base * q * ((mk.mult + end) / 2) * (1 - SPREAD);
  }

  /* ---------------------------------------------------------------- 비용 검사 */

  canAfford(p, cost, times = 1) {
    if (p.cash < (cost.cash || 0) * times) return '돈이 부족합니다.';
    for (const m of MAT_KINDS) {
      if (cost[m] && p.inv[m] < cost[m] * times) return `${MATERIALS[m].name}이(가) 부족합니다.`;
    }
    return null;
  }
  pay(p, cost, times = 1) {
    p.cash -= (cost.cash || 0) * times;
    for (const m of MAT_KINDS) if (cost[m]) p.inv[m] -= cost[m] * times;
  }

  upgradeCost(b) {
    return Math.round(ECON[b.k].cost.cash * Math.pow(UPGRADE_MULT, b.lv));
  }

  /* ---------------------------------------------------------------- 행동: 건설 */

  ownedTile(pid, idx) {
    const p = this.player(pid);
    if (!p || !p.alive) return { error: '탈락한 플레이어입니다.' };
    const t = this.tile(idx);
    if (!t) return { error: '없는 영토입니다.' };
    if (t.owner !== pid) return { error: '내 영토가 아닙니다.' };
    return { p, t };
  }

  build(pid, idx, kind) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, idx);
    if (r.error) return { ok: false, error: r.error };
    const { p, t } = r;
    const def = ECON[kind] || TOWER[kind];
    if (!def) return { ok: false, error: '없는 건물입니다.' };
    if (t.b.length >= t.slots) return { ok: false, error: '빈 부지가 없습니다.' };
    if (ECON[kind] && ECON[kind].res && ECON[kind].res !== t.res) {
      return { ok: false, error: `${def.name}은(는) ${MATERIALS[ECON[kind].res].name} 땅에만 지을 수 있습니다.` };
    }
    const err = this.canAfford(p, def.cost);
    if (err) return { ok: false, error: err };
    this.pay(p, def.cost);
    if (ECON[kind]) t.b.push({ k: kind, lv: 1 });
    else t.b.push({ k: kind, hp: def.hp });
    return { ok: true };
  }

  upgrade(pid, idx, slot) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, idx);
    if (r.error) return { ok: false, error: r.error };
    const { p, t } = r;
    const b = t.b[slot];
    if (!b || !ECON[b.k]) return { ok: false, error: '증설할 수 있는 건물이 아닙니다.' };
    if (b.lv >= MAX_LEVEL) return { ok: false, error: '최대 레벨입니다.' };
    const cost = this.upgradeCost(b);
    if (p.cash < cost) return { ok: false, error: '돈이 부족합니다.' };
    p.cash -= cost;
    b.lv++;
    return { ok: true };
  }

  demolish(pid, idx, slot) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, idx);
    if (r.error) return { ok: false, error: r.error };
    const { p, t } = r;
    const b = t.b[slot];
    if (!b) return { ok: false, error: '없는 건물입니다.' };
    if (t.battle) return { ok: false, error: '전투 중에는 철거할 수 없습니다.' };
    const def = ECON[b.k] || TOWER[b.k];
    p.cash += Math.round(def.cost.cash * DEMOLISH_REFUND);
    t.b.splice(slot, 1);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 행동: 병력 */

  train(pid, idx, unit, qty) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, idx);
    if (r.error) return { ok: false, error: r.error };
    const { p, t } = r;
    const def = UNIT[unit];
    if (!def) return { ok: false, error: '없는 유닛입니다.' };
    qty = Math.floor(Number(qty) || 0);
    if (qty < 1 || qty > 200) return { ok: false, error: '수량은 1~200 입니다.' };
    const err = this.canAfford(p, def.cost, qty);
    if (err) return { ok: false, error: err };
    this.pay(p, def.cost, qty);
    t.units[unit] += qty;
    return { ok: true };
  }

  /** 요청한 병력 구성을 검증해 실제로 뺄 수 있는 양으로 정리한다 (없으면 null) */
  takeUnits(t, want) {
    const out = emptyUnits();
    let any = false;
    for (const u of UNIT_KINDS) {
      const n = Math.min(Math.floor(Number(want && want[u]) || 0), Math.floor(t.units[u]));
      if (n > 0) {
        out[u] = n;
        any = true;
      }
    }
    return any ? out : null;
  }

  move(pid, from, to, want) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, from);
    if (r.error) return { ok: false, error: r.error };
    const a = r.t;
    const b = this.tile(to);
    if (!b || b.owner !== pid) return { ok: false, error: '내 영토로만 이동할 수 있습니다.' };
    if (!this.adjacent(a, b)) return { ok: false, error: '인접한 영토로만 이동할 수 있습니다.' };
    const units = this.takeUnits(a, want);
    if (!units) return { ok: false, error: '보낼 병력이 없습니다.' };
    for (const u of UNIT_KINDS) {
      a.units[u] -= units[u];
      b.units[u] += units[u];
    }
    return { ok: true };
  }

  attack(pid, from, to, want) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, from);
    if (r.error) return { ok: false, error: r.error };
    const { p, t: a } = r;
    const b = this.tile(to);
    if (!b) return { ok: false, error: '없는 영토입니다.' };
    if (b.owner === pid) return { ok: false, error: '내 영토는 공격할 수 없습니다. 이동을 쓰세요.' };
    if (!this.adjacent(a, b)) return { ok: false, error: '인접한 영토만 공격할 수 있습니다.' };
    if (b.battle && b.battle.att !== pid) return { ok: false, error: '이미 다른 전투가 벌어지고 있는 영토입니다.' };
    const units = this.takeUnits(a, want);
    if (!units) return { ok: false, error: '보낼 병력이 없습니다.' };
    for (const u of UNIT_KINDS) a.units[u] -= units[u];
    if (b.battle) {
      for (const u of UNIT_KINDS) b.battle.A[u] += units[u];
      b.battle.from = from;
    } else {
      b.battle = { att: pid, from, A: units, t: 0 };
      const owner = b.owner ? this.player(b.owner) : null;
      this.pushLog(`⚔️ ${p.name} 이(가) ${b.name}${owner ? ` (${owner.name})` : ' (중립)'} 을(를) 공격합니다.`);
    }
    return { ok: true };
  }

  retreat(pid, idx) {
    const t = this.tile(idx);
    if (!t || !t.battle || t.battle.att !== pid) return { ok: false, error: '내가 공격 중인 전투가 아닙니다.' };
    const p = this.player(pid);
    const back = this.tile(t.battle.from);
    const survivors = t.battle.A;
    if (back && back.owner === pid) {
      for (const u of UNIT_KINDS) back.units[u] += survivors[u];
      this.pushLog(`🏳️ ${p.name} 이(가) ${t.name} 에서 후퇴했습니다.`);
    } else {
      this.pushLog(`🏳️ ${p.name} 이(가) ${t.name} 에서 후퇴했지만 돌아갈 땅이 없어 병력이 흩어졌습니다.`);
    }
    t.battle = null;
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 행동: 시장 */

  trade(pid, { mat, side, qty }) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    if (!p || !p.alive) return { ok: false, error: '탈락한 플레이어입니다.' };
    if (!MATERIALS[mat]) return { ok: false, error: '없는 자원입니다.' };
    qty = Math.floor(Number(qty) || 0);
    if (side === 'sell' && qty === -1) qty = Math.floor(p.inv[mat]); // 전부
    if (qty < 1 || qty > 1000) return { ok: false, error: '수량은 1~1000 입니다.' };
    const mk = this.market[mat];
    if (side === 'buy') {
      const cost = this.buyCost(mat, qty);
      if (p.cash < cost) return { ok: false, error: '돈이 부족합니다.' };
      p.cash -= cost;
      p.inv[mat] += qty;
      mk.mult += MATERIALS[mat].impact * qty;
    } else if (side === 'sell') {
      if (p.inv[mat] < qty) return { ok: false, error: '수량이 부족합니다.' };
      p.cash += this.sellGain(mat, qty);
      p.inv[mat] -= qty;
      mk.mult = Math.max(0.2, mk.mult - MATERIALS[mat].impact * qty);
    } else {
      return { ok: false, error: '잘못된 거래입니다.' };
    }
    return { ok: true };
  }

  setAutoSell(pid, mat, on) {
    const p = this.player(pid);
    if (!p) return { ok: false, error: '플레이어를 찾을 수 없습니다.' };
    if (!MATERIALS[mat]) return { ok: false, error: '없는 자원입니다.' };
    p.autoSell[mat] = !!on;
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 틱 */

  tick(dt) {
    if (this.ended) return;
    this.elapsed += dt;

    this.tickEconomy(dt);
    this.tickMarket(dt);
    this.tickBattles(dt);
    this.tickWaves();

    if (this.elapsed >= this.settings.duration) this.finish('제한 시간이 끝났습니다.');
    else {
      const alive = this.players.filter((p) => p.alive);
      if (alive.length <= 1 && this.players.length > 1) this.finish(`${alive[0] ? alive[0].name + ' 이(가) 마지막까지 살아남았습니다.' : '모두 탈락했습니다.'}`);
    }
  }

  tickEconomy(dt) {
    for (const p of this.players) {
      if (!p.alive) continue;
      for (const t of this.landOf(p.id)) {
        for (const b of t.b) {
          const def = ECON[b.k];
          if (!def) {
            // 타워 수리 (전투 중이 아닐 때만)
            if (!t.battle && b.hp < TOWER[b.k].hp) b.hp = Math.min(TOWER[b.k].hp, b.hp + TOWER_REPAIR * dt);
            continue;
          }
          const lv = b.lv || 1;
          if (def.res) {
            p.inv[def.res] += def.rate * t.rich * lv * dt;
          } else if (def.in) {
            // 공장: 재료가 모자라면 그만큼만 돌아간다
            let ratio = 1;
            for (const [m, need] of Object.entries(def.in)) ratio = Math.min(ratio, p.inv[m] / (need * lv * dt));
            ratio = Math.max(0, Math.min(1, ratio));
            if (ratio > 0) {
              for (const [m, need] of Object.entries(def.in)) p.inv[m] -= need * lv * dt * ratio;
              for (const [m, out] of Object.entries(def.out)) p.inv[m] += out * lv * dt * ratio;
            }
          } else if (def.income) {
            p.cash += def.income * lv * dt;
          }
        }
      }
      // 자동 판매 — 남겨 둘 양을 넘는 만큼만 판다
      for (const m of MAT_KINDS) {
        if (!p.autoSell[m]) continue;
        const surplus = Math.floor(p.inv[m] - AUTO_SELL_KEEP[m]);
        if (surplus >= 1) this.trade(p.id, { mat: m, side: 'sell', qty: surplus });
      }
    }
  }

  tickMarket(dt) {
    for (const m of MAT_KINDS) {
      const mk = this.market[m];
      mk.mult += (1 - mk.mult) * REVERT * dt;
    }
  }

  /* ---------------------------------------------------------------- 전투 */

  tickBattles(dt) {
    for (const t of this.map.tiles) {
      if (!t.battle) continue;
      this.resolveBattle(t, dt);
    }
  }

  /** 수비 측 구성: 주둔 유닛 + 타워(종류별 개수) */
  defenders(t) {
    const D = {};
    for (const u of UNIT_KINDS) if (t.units[u] > 0) D[u] = t.units[u];
    for (const b of t.b) if (TOWER[b.k] && b.hp > 0) D[b.k] = (D[b.k] || 0) + 1;
    return D;
  }

  resolveBattle(t, dt) {
    const bt = t.battle;
    bt.t += dt;
    const A = bt.A;
    const D = this.defenders(t);
    const aTotal = sum(A);
    const dTotal = sum(D);

    if (aTotal < 0.05) return this.endBattle(t, 'defender');
    if (dTotal < 0.05) return this.endBattle(t, 'attacker');
    if (bt.t > BATTLE_LIMIT) {
      this.pushLog(`⏳ ${t.name} 전투가 너무 길어져 공격군이 물러납니다.`);
      if (bt.att !== 'npc') return this.retreat(bt.att, t.idx);
      t.battle = null;
      return;
    }

    // 양쪽 피해를 틱 시작 시점의 구성으로 동시에 계산한다 (선공 없음)
    const dmgD = {};
    const dmgA = {};
    for (const a of UNIT_KINDS) {
      if (!(A[a] > 0)) continue;
      const total = A[a] * UNIT[a].dps * dt;
      for (const c of Object.keys(D)) {
        const m = MULT[a][c] || 0;
        if (m) dmgD[c] = (dmgD[c] || 0) + total * (D[c] / dTotal) * m;
      }
    }
    for (const d of Object.keys(D)) {
      const dps = UNIT[d] ? UNIT[d].dps : TOWER[d].dps;
      const total = D[d] * dps * dt;
      for (const a of UNIT_KINDS) {
        if (!(A[a] > 0)) continue;
        const m = MULT[d][a] || 0;
        if (m) dmgA[a] = (dmgA[a] || 0) + total * (A[a] / aTotal) * m;
      }
    }
    for (const a of UNIT_KINDS) if (dmgA[a]) A[a] = Math.max(0, A[a] - dmgA[a] / UNIT[a].hp);
    for (const c of Object.keys(dmgD)) {
      if (UNIT[c]) {
        t.units[c] = Math.max(0, t.units[c] - dmgD[c] / UNIT[c].hp);
      } else {
        // 타워는 앞에서부터 차례로 맞는다 — 하나가 부서지면 나머지 피해가 다음으로 넘어간다
        let left = dmgD[c];
        for (const b of t.b) {
          if (b.k !== c || left <= 0) continue;
          const take = Math.min(b.hp, left);
          b.hp -= take;
          left -= take;
        }
      }
    }
    t.b = t.b.filter((b) => !TOWER[b.k] || b.hp > 0.01);
  }

  endBattle(t, winner) {
    const bt = t.battle;
    t.battle = null;
    const attName = bt.att === 'npc' ? '약탈대' : this.player(bt.att).name;
    const prevOwner = t.owner ? this.player(t.owner) : null;
    if (winner === 'defender') {
      this.pushLog(`🛡️ ${t.name} 방어 성공 — ${attName}의 공격을 막았습니다.`);
      return;
    }
    // 공격자 승리 — 땅과 경제 건물을 넘겨받고 살아남은 병력이 주둔한다
    t.b = t.b.filter((b) => ECON[b.k]);
    t.units = emptyUnits();
    for (const u of UNIT_KINDS) t.units[u] = bt.A[u];
    t.owner = bt.att === 'npc' ? null : bt.att;
    if (bt.att === 'npc') {
      this.pushLog(`💀 ${t.name} (${prevOwner ? prevOwner.name : '?'}) 이(가) 약탈대에게 함락됐습니다!`);
    } else {
      this.pushLog(`🚩 ${attName} 이(가) ${t.name} 을(를) 점령했습니다${prevOwner ? ` (${prevOwner.name} 에게서)` : ''}.`);
    }
    if (prevOwner) this.checkElimination(prevOwner);
  }

  checkElimination(p) {
    if (!p.alive) return;
    if (this.landOf(p.id).length === 0) {
      p.alive = false;
      p.diedAt = this.elapsed;
      this.pushLog(`☠️ ${p.name} 이(가) 모든 영토를 잃고 탈락했습니다.`);
    }
  }

  /* ---------------------------------------------------------------- 습격 (라운드) */

  /** 라운드 r 의 약탈대 구성 — 라운드가 오를수록 전차·포병·항공기가 섞인다 */
  static raidForce(r) {
    return {
      inf: 3 + Math.round(1.5 * r),
      tank: Math.max(0, Math.floor((r - 1) * 0.3)),
      arty: Math.max(0, Math.floor((r - 2) * 0.3)),
      air: Math.max(0, Math.floor((r - 4) * 0.3)),
    };
  }

  tickWaves() {
    // 예고: 다음 습격 대상 영토를 미리 알려 준다
    if (Object.keys(this.raids).length === 0 && this.elapsed >= this.nextWave - WAVE_WARN) {
      for (const p of this.players) {
        if (!p.alive) continue;
        const cands = this.landOf(p.id).filter((t) => !t.battle);
        if (!cands.length) continue;
        const t = cands[Math.floor(this._rand() * cands.length)];
        this.raids[p.id] = t.idx;
      }
      if (Object.keys(this.raids).length) {
        this.pushLog(`⚠️ 약탈대가 접근 중입니다! ${WAVE_WARN}초 뒤 습격: ${Object.entries(this.raids).map(([pid, idx]) => `${this.map.tiles[idx].name}(${this.player(pid).name})`).join(', ')}`);
      }
    }
    if (this.elapsed < this.nextWave) return;
    this.round++;
    this.nextWave += WAVE_SEC;
    const force = Game.raidForce(this.round);
    for (const [pid, idx] of Object.entries(this.raids)) {
      const t = this.map.tiles[idx];
      const p = this.player(pid);
      if (!p.alive || t.owner !== pid) continue;
      if (t.battle) {
        // 이미 전투 중이면 약탈대는 공격자 편이 아니라 별개로 취급할 수 없으므로 건너뛴다
        continue;
      }
      t.battle = { att: 'npc', from: null, A: { ...force }, t: 0 };
    }
    this.raids = {};
    this.pushLog(`🔥 ${this.round} 라운드 습격 시작! (보병 ${force.inf}${force.tank ? `, 전차 ${force.tank}` : ''}${force.arty ? `, 포병 ${force.arty}` : ''}${force.air ? `, 항공기 ${force.air}` : ''})`);
  }

  /* ---------------------------------------------------------------- 점수 */

  unitValue(units) {
    let v = 0;
    for (const u of UNIT_KINDS) v += (units[u] || 0) * UNIT[u].cost.cash * 0.5;
    return v;
  }

  netWorth(p) {
    let v = p.cash;
    for (const m of MAT_KINDS) v += p.inv[m] * this.price(m);
    for (const t of this.landOf(p.id)) {
      v += LAND_VALUE;
      for (const b of t.b) {
        if (ECON[b.k]) v += ECON[b.k].cost.cash * 0.6 * (b.lv || 1);
        else v += TOWER[b.k].cost.cash * 0.5;
      }
      v += this.unitValue(t.units);
    }
    return Math.round(v);
  }

  finish(reason) {
    if (this.ended) return;
    this.ended = true;
    // 병력 정리 — 진행 중인 전투는 그 자리에서 멈춘다
    const rows = this.players.map((p) => ({ id: p.id, name: p.name, netWorth: this.netWorth(p), land: this.landOf(p.id).length, alive: p.alive, diedAt: p.diedAt }));
    rows.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive && !b.alive) return b.diedAt - a.diedAt;
      return b.netWorth - a.netWorth;
    });
    this.ranking = rows;
    this.pushLog(`🏁 게임 종료 — ${reason} 우승: ${rows[0].name}`);
  }

  /* ---------------------------------------------------------------- 공개 상태 */

  /**
   * 방 전체에 뿌릴 상태. 화면에 쓰이는 값만, 화면 해상도로 반올림해 담는다.
   * (서버가 직전 스냅샷과 diff 해서 바뀐 부분만 보내므로, 잔 변동을 여기서 잘라내는 게 곧 트래픽 절감이다)
   */
  publicState() {
    const r1 = (n) => Math.round(n * 10) / 10;
    const units = (u) => {
      const o = {};
      for (const k of UNIT_KINDS) if (u[k] >= 0.05) o[k] = r1(u[k]);
      return o;
    };
    const tiles = this.map.tiles.map((t) => {
      const o = { n: t.name, slots: t.slots };
      if (t.res) {
        o.res = t.res;
        if (t.rich > 1) o.rich = t.rich;
      }
      if (t.owner) o.owner = t.owner;
      if (t.capital) o.cap = 1;
      if (t.b.length) {
        o.b = t.b.map((b) => {
          if (ECON[b.k]) return b.lv > 1 ? { k: b.k, lv: b.lv } : { k: b.k };
          const full = TOWER[b.k].hp;
          return b.hp < full - 0.5 ? { k: b.k, hp: Math.round(b.hp) } : { k: b.k };
        });
      }
      const u = units(t.units);
      if (Object.keys(u).length) o.u = u;
      if (t.battle) o.bt = { att: t.battle.att, A: units(t.battle.A), t: Math.round(t.battle.t) };
      return o;
    });
    const market = {};
    for (const m of MAT_KINDS) market[m] = r1(this.price(m));
    const raids = {};
    for (const [pid, idx] of Object.entries(this.raids)) raids[idx] = pid;
    return {
      elapsed: Math.round(this.elapsed),
      duration: this.settings.duration,
      ended: this.ended,
      round: this.round,
      nextWave: this.nextWave,
      raids,
      ranking: this.ranking,
      market,
      map: { w: this.map.w, h: this.map.h, tiles },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        cash: Math.round(p.cash),
        inv: Object.fromEntries(MAT_KINDS.map((m) => [m, r1(p.inv[m])])),
        alive: p.alive,
        land: this.landOf(p.id).length,
        nw: Math.round(this.netWorth(p) / 10) * 10,
        autoSell: p.autoSell,
        capital: p.capital,
      })),
      // 상수는 게임 중 안 바뀌므로 첫 전송 뒤에는 diff 에서 빠진다
      constants: { MATERIALS, UNIT, TOWER, ECON, MULT, MAX_LEVEL, UPGRADE_MULT, SPREAD, WAVE_SEC, WAVE_WARN, DEMOLISH_REFUND, AUTO_SELL_KEEP },
    };
  }
}

module.exports = { Game, MATERIALS, MAT_KINDS, UNIT, UNIT_KINDS, TOWER, TOWER_KINDS, ECON, ECON_KINDS, MULT, WAVE_SEC, WAVE_WARN, MAX_LEVEL, emptyUnits };
