'use strict';

/**
 * 디펜스 — 영토 확장 실시간 디펜스 게임의 규칙 엔진 (단순화판: 자원은 돈 하나).
 *
 * 핵심 구조:
 *  - 맵은 N×N 격자의 "영토(타일)". 각 영토에는 땅 등급(yield: 돈이 얼마나 잘 벌리는지), 부지 수(slots),
 *    건물 목록(b), 주둔 병력(units)이 있다. 상하좌우로 인접한 영토끼리만 이동·공격이 가능하다.
 *  - 돈은 타워가 적을 죽여서 버는 게 아니라, 부지에 지은 공장이 초당 벌어 준다.
 *    부지는 공장과 타워가 함께 쓰므로 "경제 vs 방어" 를 매 영토마다 저울질해야 한다.
 *  - 전투는 영토 단위 소모전이다. 양쪽 병력이 매 틱 상성표(MULT)에 따라 서로를 갉아먹는다.
 *    타워도 전투원이다(hp 가 있고 부서진다). 공격자가 이기면 영토·공장을 빼앗고 살아남은 병력이 주둔한다.
 *  - 라운드(습격): 일정 시간마다 NPC 약탈대가 각 플레이어의 영토 하나를 친다. 막지 못하면 그 땅을 잃는다.
 *
 * 이 파일은 순수 규칙만 담는다. 네트워크·타이머는 room.js/server.js 가 맡는다.
 * 봇(bot.js)도 이 파일의 공개 메서드만 호출한다 — 반칙 불가.
 */

/* ================================================================== 상수 */

// 유닛 3종. 전차 > 보병, 항공기 > 전차. 항공기는 대공포·항공기만 제대로 막는다 (지상군은 거의 못 맞춘다).
const UNIT = {
  inf: { name: '보병', icon: '🪖', hp: 10, dps: 1.2, cost: 20, desc: '싸고 많다. 전차·기관총에 약하고, 항공기는 거의 못 맞춘다.' },
  tank: { name: '전차', icon: '🛡️', hp: 50, dps: 6, cost: 100, desc: '보병을 밀어내고 타워를 부순다. 항공기를 못 때린다.' },
  air: { name: '항공기', icon: '✈️', hp: 40, dps: 10, cost: 150, desc: '전차를 잡는다. 대공포와 항공기만 제대로 막을 수 있다.' },
};
const UNIT_KINDS = Object.keys(UNIT);

// 타워 3종. 부지 하나를 차지하는 건물이며 전투에 참가한다. 각자 담당이 하나씩.
const TOWER = {
  mg: { name: '기관총', icon: '🔫', hp: 60, dps: 4, cost: 100, desc: '보병 담당. 전차에 약하다.' },
  cannon: { name: '포탑', icon: '🎯', hp: 80, dps: 7, cost: 160, desc: '전차 담당. 항공기를 못 때린다.' },
  aa: { name: '대공포', icon: '🚀', hp: 60, dps: 6, cost: 150, desc: '항공기 담당. 지상에는 약하다.' },
};
const TOWER_KINDS = Object.keys(TOWER);

// 경제 건물은 공장 하나. 수입 = INCOME × 땅 등급 × 레벨 (초당)
const FACTORY = { name: '공장', icon: '🏭', cost: 200, income: 1.5, desc: '초당 돈을 번다. 좋은 땅일수록 더 번다. 3레벨까지 증설.' };
const LAND_INCOME = 1; // 땅 기본 수입: 초당 0.5 × 땅 등급 (공장 없이도 들어온다 — 영토 자체가 가치)
const MAX_YIELD = 3;
const LAND_UPGRADE = { 1: 400, 2: 700 }; // 땅 등급 올리기 비용 (현재 등급 → +1). 등급이 오르면 기본 수입·공장 수입이 오르고 부지가 한 칸 는다
// 연구 개발. 각 플레이어가 돈으로 산다. unlock 은 1회, 강화는 3레벨까지.
// 병종 강화는 그 병종의 체력·공격을 레벨당 +20%, 생산성은 모든 공장 수입을 레벨당 +20%.
const RESEARCH = {
  tank: { name: '전차 개발', icon: 'tank', cost: [300], desc: '전차를 생산할 수 있게 된다.' },
  air: { name: '항공기 개발', icon: 'air', cost: [500], req: 'tank', desc: '항공기를 생산할 수 있게 된다. (전차 개발 필요)' },
  inf: { name: '보병 강화', icon: 'inf', cost: [200, 400, 700], desc: '보병 체력·공격 +20% / 레벨' },
  tankU: { name: '전차 강화', icon: 'tank', cost: [300, 600, 1000], req: 'tank', desc: '전차 체력·공격 +20% / 레벨' },
  airU: { name: '항공기 강화', icon: 'air', cost: [400, 800, 1300], req: 'air', desc: '항공기 체력·공격 +20% / 레벨' },
  prod: { name: '공장 생산성', icon: 'factory', cost: [250, 500, 900], desc: '모든 공장 수입 +20% / 레벨' },
};
const RESEARCH_STEP = 0.2;
const UNIT_RESEARCH = { inf: 'inf', tank: 'tankU', air: 'airU' }; // 병종 → 강화 연구 키
const MAX_LEVEL = 3;
// 타워 레벨별 체력·화력 배수 (1→2→3레벨). 증설 비용은 공장과 같은 규칙(건설비 × UPGRADE_MULT^현재 레벨)
const TOWER_LV_MULT = [1, 1.6, 2.4];
const UPGRADE_MULT = 1.5; // 레벨업 비용 = 건설비 × 1.5^(현재 레벨) — 새로 짓는 것보다 조금 비싸지만 부지를 아낀다
const LAND_VALUE = 300; // 순자산에 더하는 땅 한 칸의 가치

/**
 * 상성표 — 공격자 종류(행) 가 대상 종류(열) 에게 주는 피해 배수. 0 이면 아예 맞출 수 없다.
 */
const MULT = {
  inf: { inf: 1.0, tank: 0.5, air: 0.5, mg: 0.5, cannon: 0.7, aa: 1.0 },
  tank: { inf: 1.5, tank: 1.0, air: 0, mg: 1.5, cannon: 1.0, aa: 1.5 },
  air: { inf: 1.0, tank: 1.5, air: 1.0, mg: 1.0, cannon: 1.5, aa: 0.5 },
  mg: { inf: 2.0, tank: 0.3, air: 0.8 },
  cannon: { inf: 0.5, tank: 2.5, air: 0 },
  aa: { inf: 0.3, tank: 0.2, air: 3.0 },
};

const WAVE_SEC = 75; // 습격 간격
const WAVE_WARN = 12; // 습격 예고 (초)
const RAID_PER_LAND = 3; // 영토 3칸마다 습격 지점이 하나씩 늘어난다
const BATTLE_LIMIT = 150; // 이보다 긴 전투는 공격자 후퇴로 강제 종료 (교착 방지)
const TOWER_REPAIR = 1; // 전투 중이 아닐 때 타워 초당 수리량
const DEMOLISH_REFUND = 0.3;
const UPKEEP = 0.005; // 병력 유지비: 초당 유닛 가격의 0.5% (보병 0.1, 전차 0.45, 항공기 0.65) — 군대가 수입을 넘으면 탈영한다
const DESERT_RATE = 0.05; // 돈이 바닥나면 초당 5% 씩 탈영

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4'];

/* ================================================================== 도우미 */

function sum(obj) {
  let s = 0;
  for (const v of Object.values(obj)) s += v;
  return s;
}
function emptyUnits() {
  return { inf: 0, tank: 0, air: 0 };
}
function tileName(x, y) {
  return String.fromCharCode(65 + x) + (y + 1);
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ================================================================== 게임 */

class Game {
  constructor(players, settings) {
    this.settings = { startCash: 800, duration: 600, raids: 0, ...settings };
    this.elapsed = 0;
    this.ended = false;
    this.ranking = null;
    this.round = 0;
    this.nextWave = WAVE_SEC;
    this.raids = {}; // 예고된 습격 {pid: [tileIdx, ...]}
    this.log = [];
    this._logSeq = 0;
    this._rand = rng(this.settings.seed || (Date.now() & 0xffffffff));

    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: COLORS[i % COLORS.length],
      cash: this.settings.startCash,
      alive: true,
      diedAt: null,
      capital: -1,
      rs: { tank: 0, air: 0, inf: 0, tankU: 0, airU: 0, prod: 0 }, // 연구 레벨
    }));

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
        const yieldLv = r < 0.5 ? 1 : r < 0.85 ? 2 : 3; // 땅 등급 1~3
        this.map.tiles.push({
          idx: y * size + x,
          x,
          y,
          name: tileName(x, y),
          yield: yieldLv,
          slots: 3 + yieldLv, // 4~6칸
          owner: null,
          capital: false,
          b: [],
          units: emptyUnits(),
          battle: null,
        });
      }
    }
    const L = size - 1;
    const mid = Math.floor(size / 2);
    const spots = [[0, 0], [L, L], [L, 0], [0, L], [mid, 0], [mid, L]];
    this.players.forEach((p, i) => {
      const [x, y] = spots[i];
      const t = this.tileAt(x, y);
      t.yield = MAX_YIELD; // 시작 땅은 모두 최고 등급 — 공평하게, 돈 잘 벌리는 곳에서 출발
      t.slots = 6;
      t.owner = p.id;
      t.capital = true;
      t.b = [{ k: 'factory', lv: 1 }, { k: 'mg', hp: TOWER.mg.hp }, { k: 'cannon', hp: TOWER.cannon.hp }];
      t.units = { inf: 8, tank: 0, air: 0 };
      p.capital = t.idx;
    });
    // 중립 땅의 수비대 — 수도에서 멀수록, 좋은 땅일수록 세다
    for (const t of this.map.tiles) {
      if (t.owner) continue;
      let dist = Infinity;
      for (const p of this.players) {
        const c = this.map.tiles[p.capital];
        dist = Math.min(dist, Math.abs(c.x - t.x) + Math.abs(c.y - t.y));
      }
      const scale = dist <= 1 ? 1 : dist === 2 ? 1.6 : 2.4;
      t.units = emptyUnits();
      t.units.inf = Math.round((3 + 2 * t.yield) * scale);
      if (dist >= 2) t.units.tank = Math.round(scale - 1);
      if (t.yield >= 2) t.b.push({ k: 'mg', hp: TOWER.mg.hp });
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

  upgradeCost(b) {
    const base = b.k === 'factory' ? FACTORY.cost : TOWER[b.k].cost;
    return Math.round(base * Math.pow(UPGRADE_MULT, b.lv || 1));
  }
  /** 타워의 레벨 배수 / 최대 체력 */
  static towerMult(b) {
    return TOWER_LV_MULT[(b.lv || 1) - 1];
  }
  static towerMax(b) {
    return TOWER[b.k].hp * Game.towerMult(b);
  }
  /** 봇·화면이 쓰는 "게임 진행 단계" — 습격이 꺼져 있으면 시간으로 센다 */
  stage() {
    return this.settings.raids ? this.round : Math.floor(this.elapsed / WAVE_SEC);
  }

  /** 초당 수입 = 땅 기본 수입 + 공장 합계 */
  incomeOf(p) {
    let v = 0;
    const prod = 1 + RESEARCH_STEP * p.rs.prod;
    for (const t of this.landOf(p.id)) {
      v += LAND_INCOME * t.yield;
      for (const b of t.b) if (b.k === 'factory') v += FACTORY.income * t.yield * b.lv * prod;
    }
    return v;
  }

  /** 병종 강화 배수 — pid 가 null(중립)·'npc'(약탈대) 면 1 */
  unitMult(pid, u) {
    const p = pid && pid !== 'npc' ? this.player(pid) : null;
    return p ? 1 + RESEARCH_STEP * p.rs[UNIT_RESEARCH[u]] : 1;
  }

  /* ---------------------------------------------------------------- 행동: 연구 */

  research(pid, key) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    if (!p || !p.alive) return { ok: false, error: '탈락한 플레이어입니다.' };
    const def = RESEARCH[key];
    if (!def) return { ok: false, error: '없는 연구입니다.' };
    const lv = p.rs[key];
    if (lv >= def.cost.length) return { ok: false, error: '이미 최고 단계입니다.' };
    if (def.req && !p.rs[def.req]) return { ok: false, error: `${RESEARCH[def.req].name} 연구가 먼저 필요합니다.` };
    const cost = def.cost[lv];
    if (p.cash < cost) return { ok: false, error: '돈이 부족합니다.' };
    p.cash -= cost;
    p.rs[key] = lv + 1;
    return { ok: true };
  }

  /** 초당 병력 유지비 (주둔 + 출정 중인 병력 모두) */
  upkeepOf(p) {
    let v = 0;
    for (const t of this.map.tiles) {
      if (t.owner === p.id) for (const u of UNIT_KINDS) v += t.units[u] * UNIT[u].cost * UPKEEP;
      if (t.battle && t.battle.att === p.id) for (const u of UNIT_KINDS) v += t.battle.A[u] * UNIT[u].cost * UPKEEP;
    }
    return v;
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
    const def = kind === 'factory' ? FACTORY : TOWER[kind];
    if (!def) return { ok: false, error: '없는 건물입니다.' };
    if (t.b.length >= t.slots) return { ok: false, error: '빈 부지가 없습니다.' };
    if (p.cash < def.cost) return { ok: false, error: '돈이 부족합니다.' };
    p.cash -= def.cost;
    if (kind === 'factory') t.b.push({ k: 'factory', lv: 1 });
    else t.b.push({ k: kind, hp: def.hp });
    return { ok: true };
  }

  upgrade(pid, idx, slot) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, idx);
    if (r.error) return { ok: false, error: r.error };
    const { p, t } = r;
    const b = t.b[slot];
    if (!b) return { ok: false, error: '없는 건물입니다.' };
    if ((b.lv || 1) >= MAX_LEVEL) return { ok: false, error: '최대 레벨입니다.' };
    if (TOWER[b.k] && t.battle) return { ok: false, error: '전투 중에는 타워를 증설할 수 없습니다.' };
    const cost = this.upgradeCost(b);
    if (p.cash < cost) return { ok: false, error: '돈이 부족합니다.' };
    p.cash -= cost;
    if (TOWER[b.k]) {
      // 타워: 체력 상한이 오르고 오른 만큼 즉시 채워진다 (화력은 defenders() 에서 배수로 반영)
      const before = Game.towerMax(b);
      b.lv = (b.lv || 1) + 1;
      b.hp += Game.towerMax(b) - before;
    } else b.lv++;
    return { ok: true };
  }

  /** 땅 등급 올리기 — 그 땅의 기본 수입·모든 공장 수입이 등급 비례로 오르고 부지가 한 칸 는다 */
  upgradeLand(pid, idx) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const r = this.ownedTile(pid, idx);
    if (r.error) return { ok: false, error: r.error };
    const { p, t } = r;
    if (t.yield >= MAX_YIELD) return { ok: false, error: '최고 등급 땅입니다.' };
    if (t.battle) return { ok: false, error: '전투 중에는 개발할 수 없습니다.' };
    const cost = LAND_UPGRADE[t.yield];
    if (p.cash < cost) return { ok: false, error: '돈이 부족합니다.' };
    p.cash -= cost;
    t.yield++;
    t.slots++;
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
    const def = b.k === 'factory' ? FACTORY : TOWER[b.k];
    p.cash += Math.round(def.cost * DEMOLISH_REFUND);
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
    if ((unit === 'tank' || unit === 'air') && !p.rs[unit]) return { ok: false, error: `${RESEARCH[unit].name} 연구가 필요합니다.` };
    qty = Math.floor(Number(qty) || 0);
    if (qty < 1 || qty > 200) return { ok: false, error: '수량은 1~200 입니다.' };
    if (p.cash < def.cost * qty) return { ok: false, error: '돈이 부족합니다.' };
    p.cash -= def.cost * qty;
    t.units[unit] += qty;
    return { ok: true };
  }

  /** 요청한 병력 구성을 실제로 뺄 수 있는 양으로 정리한다. want 가 'all'/'half' 면 전부/절반. */
  takeUnits(t, want) {
    const out = emptyUnits();
    let any = false;
    for (const u of UNIT_KINDS) {
      const have = Math.floor(t.units[u]);
      const n = want === 'all' ? have : want === 'half' ? Math.floor(have / 2) : Math.min(Math.floor(Number(want && want[u]) || 0), have);
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

  /* ---------------------------------------------------------------- 틱 */

  tick(dt) {
    if (this.ended) return;
    this.elapsed += dt;
    this.tickEconomy(dt);
    this.tickBattles(dt);
    this.tickWaves();
    if (this.elapsed >= this.settings.duration) this.finish('제한 시간이 끝났습니다.');
    else {
      const alive = this.players.filter((p) => p.alive);
      if (alive.length <= 1 && this.players.length > 1) this.finish(alive[0] ? alive[0].name + ' 이(가) 마지막까지 살아남았습니다.' : '모두 탈락했습니다.');
    }
  }

  tickEconomy(dt) {
    for (const p of this.players) {
      if (!p.alive) continue;
      p.cash += (this.incomeOf(p) - this.upkeepOf(p)) * dt;
      if (p.cash < 0) {
        // 유지비를 못 내면 병력이 흩어진다
        p.cash = 0;
        for (const t of this.landOf(p.id)) for (const u of UNIT_KINDS) t.units[u] *= 1 - DESERT_RATE * dt;
      }
      for (const t of this.landOf(p.id)) {
        if (t.battle) continue;
        for (const b of t.b) if (TOWER[b.k] && b.hp < Game.towerMax(b)) b.hp = Math.min(Game.towerMax(b), b.hp + TOWER_REPAIR * dt);
      }
    }
  }

  /* ---------------------------------------------------------------- 전투 */

  tickBattles(dt) {
    for (const t of this.map.tiles) if (t.battle) this.resolveBattle(t, dt);
  }

  /** 수비 측 구성: 주둔 유닛 + 타워(종류별 개수) */
  defenders(t) {
    const D = {};
    for (const u of UNIT_KINDS) if (t.units[u] > 0) D[u] = t.units[u];
    // 타워는 레벨 배수만큼의 '문 수' 로 센다 — 2레벨 타워 하나는 1.6문의 화력
    for (const b of t.b) if (TOWER[b.k] && b.hp > 0) D[b.k] = (D[b.k] || 0) + Game.towerMult(b);
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
    const attM = (u) => this.unitMult(bt.att, u);
    const defM = (u) => this.unitMult(t.owner, u);
    for (const a of UNIT_KINDS) {
      if (!(A[a] > 0)) continue;
      const total = A[a] * UNIT[a].dps * attM(a) * dt;
      for (const c of Object.keys(D)) {
        const m = MULT[a][c] || 0;
        if (m) dmgD[c] = (dmgD[c] || 0) + total * (D[c] / dTotal) * m;
      }
    }
    for (const d of Object.keys(D)) {
      const dps = UNIT[d] ? UNIT[d].dps * defM(d) : TOWER[d].dps;
      const total = D[d] * dps * dt;
      for (const a of UNIT_KINDS) {
        if (!(A[a] > 0)) continue;
        const m = MULT[d][a] || 0;
        if (m) dmgA[a] = (dmgA[a] || 0) + total * (A[a] / aTotal) * m;
      }
    }
    for (const a of UNIT_KINDS) if (dmgA[a]) A[a] = Math.max(0, A[a] - dmgA[a] / (UNIT[a].hp * attM(a)));
    for (const c of Object.keys(dmgD)) {
      if (UNIT[c]) t.units[c] = Math.max(0, t.units[c] - dmgD[c] / (UNIT[c].hp * defM(c)));
      else {
        // 타워는 앞에서부터 차례로 맞는다
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
    t.b = t.b.filter((b) => b.k === 'factory');
    t.units = emptyUnits();
    for (const u of UNIT_KINDS) t.units[u] = bt.A[u];
    t.owner = bt.att === 'npc' ? null : bt.att;
    if (bt.att === 'npc') this.pushLog(`💀 ${t.name} (${prevOwner ? prevOwner.name : '?'}) 이(가) 약탈대에게 함락됐습니다!`);
    else this.pushLog(`🚩 ${attName} 이(가) ${t.name} 을(를) 점령했습니다${prevOwner ? ` (${prevOwner.name} 에게서)` : ''}.`);
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

  /**
   * 라운드 r 의 약탈대 한 무리. 처음 3라운드는 배우는 시간이라 약하게.
   * land 는 그 플레이어의 영토 수 — 넓을수록 무리도 조금 커진다 (무리 수는 raidCount 가 늘린다).
   */
  static raidForce(r, land = 1) {
    const scale = 1 + 0.15 * Math.max(0, land - 1);
    return {
      inf: Math.round((r <= 3 ? 2 + r : 3 + Math.round(1.2 * r)) * scale),
      tank: Math.floor(Math.max(0, (r - 3) * 0.3) * scale),
      air: Math.floor(Math.max(0, (r - 5) * 0.3) * scale),
    };
  }

  /** 영토 수에 따라 동시에 습격당하는 땅 수: 1~3칸 1곳, 4~6칸 2곳, 7~9칸 3곳 … — 넓힌 만큼 여러 곳을 지켜야 한다 */
  static raidCount(land) {
    return 1 + Math.floor(Math.max(0, land - 1) / RAID_PER_LAND);
  }

  tickWaves() {
    if (!this.settings.raids) return; // 약탈대 습격 꺼짐 (대기실 설정)
    if (Object.keys(this.raids).length === 0 && this.elapsed >= this.nextWave - WAVE_WARN) {
      const names = [];
      for (const p of this.players) {
        if (!p.alive) continue;
        const cands = this.landOf(p.id).filter((t) => !t.battle);
        if (!cands.length) continue;
        const n = Math.min(cands.length, Game.raidCount(this.landOf(p.id).length));
        const picked = [];
        for (let i = 0; i < n; i++) {
          const j = Math.floor(this._rand() * cands.length);
          picked.push(cands.splice(j, 1)[0].idx);
        }
        this.raids[p.id] = picked;
        names.push(`${p.name}: ${picked.map((idx) => this.map.tiles[idx].name).join('·')}`);
      }
      if (names.length) this.pushLog(`⚠️ 약탈대가 접근 중입니다! ${WAVE_WARN}초 뒤 습격 — ${names.join(' / ')}`);
    }
    if (this.elapsed < this.nextWave) return;
    this.round++;
    this.nextWave += WAVE_SEC;
    const force = Game.raidForce(this.round);
    for (const [pid, idxs] of Object.entries(this.raids)) {
      const p = this.player(pid);
      if (!p.alive) continue;
      const land = this.landOf(pid).length;
      for (const idx of idxs) {
        const t = this.map.tiles[idx];
        if (t.owner !== pid || t.battle) continue;
        t.battle = { att: 'npc', from: null, A: Game.raidForce(this.round, land), t: 0 };
      }
    }
    this.raids = {};
    this.pushLog(`🔥 ${this.round} 라운드 습격 시작! (한 무리: 보병 ${force.inf}${force.tank ? `, 전차 ${force.tank}` : ''}${force.air ? `, 항공기 ${force.air}` : ''})`);
  }

  /* ---------------------------------------------------------------- 점수 */

  unitValue(units) {
    let v = 0;
    for (const u of UNIT_KINDS) v += (units[u] || 0) * UNIT[u].cost * 0.5;
    return v;
  }

  netWorth(p) {
    let v = p.cash;
    for (const t of this.landOf(p.id)) {
      v += LAND_VALUE;
      for (const b of t.b) v += b.k === 'factory' ? FACTORY.cost * 0.6 * b.lv : TOWER[b.k].cost * 0.5 * Game.towerMult(b);
      v += this.unitValue(t.units);
    }
    return Math.round(v);
  }

  finish(reason) {
    if (this.ended) return;
    this.ended = true;
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
   * 트래픽 절감 — 돈·순자산·시계처럼 "매초 조금씩" 바뀌는 값은 매초 보내면 패치의 1/3 을 차지한다.
   * 이 값들은 econ 스냅샷에 담아 두고, refresh 가 true 일 때만(5초마다, 그리고 사람이 행동한 직후) 새로 만든다.
   * 클라이언트는 그 사이를 수입−유지비로 이어 계산해 보여 준다 (시계도 마찬가지).
   */
  econSnapshot(refresh) {
    if (!this._econ || refresh) {
      const r1 = (n) => Math.round(n * 10) / 10;
      this._econ = {
        elapsed: Math.round(this.elapsed),
        players: this.players.map((p) => ({
          cash: Math.round(p.cash),
          income: r1(this.incomeOf(p)),
          upkeep: r1(this.upkeepOf(p)),
          // 순자산은 순위표에만 쓰인다 — 100 단위면 충분
          nw: Math.round(this.netWorth(p) / 100) * 100,
        })),
      };
    }
    return this._econ;
  }

  publicState(opts = {}) {
    const r1 = (n) => Math.round(n * 10) / 10;
    const econ = this.econSnapshot(opts.econ || this.ended);
    const units = (u) => {
      const o = {};
      // 0.5 단위 — 지도는 정수로, 패널은 소수 한 자리로 보여 주므로 이 정도면 충분하고 매초 나가는 잔 변동이 절반으로 준다
      for (const k of UNIT_KINDS) if (u[k] >= 0.05) o[k] = Math.max(0.5, Math.round(u[k] * 2) / 2);
      return o;
    };
    const tiles = this.map.tiles.map((t) => {
      const o = { n: t.name, y: t.yield, slots: t.slots };
      if (t.owner) o.owner = t.owner;
      if (t.capital) o.cap = 1;
      if (t.b.length) {
        o.b = t.b.map((b) => {
          if (b.k === 'factory') return b.lv > 1 ? { k: b.k, lv: b.lv } : { k: b.k };
          const o2 = { k: b.k };
          if ((b.lv || 1) > 1) o2.lv = b.lv;
          if (b.hp < Game.towerMax(b) - 0.5) o2.hp = Math.round(b.hp);
          return o2;
        });
      }
      const u = units(t.units);
      if (Object.keys(u).length) o.u = u;
      // 경과 시간은 안 보낸다 — 매초 바뀌는 값이라, 클라이언트가 전투를 처음 본 시각부터 센다
      if (t.battle) o.bt = { att: t.battle.att, A: units(t.battle.A) };
      return o;
    });
    const raids = {};
    for (const [pid, idxs] of Object.entries(this.raids)) for (const idx of idxs) raids[idx] = pid;
    return {
      elapsed: econ.elapsed,
      duration: this.settings.duration,
      ended: this.ended,
      round: this.round,
      nextWave: this.nextWave,
      raidsOn: this.settings.raids ? 1 : 0,
      raids,
      ranking: this.ranking,
      map: { w: this.map.w, h: this.map.h, tiles },
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        cash: econ.players[i].cash,
        income: econ.players[i].income,
        upkeep: econ.players[i].upkeep,
        alive: p.alive,
        land: this.landOf(p.id).length,
        nw: econ.players[i].nw,
        capital: p.capital,
        rs: p.rs,
      })),
      // 상수는 게임 중 안 바뀌므로 첫 전송 뒤에는 diff 에서 빠진다
      constants: { UNIT, TOWER, TOWER_LV_MULT, FACTORY, RESEARCH, RESEARCH_STEP, UNIT_RESEARCH, LAND_INCOME, LAND_UPGRADE, MAX_YIELD, MULT, MAX_LEVEL, UPGRADE_MULT, WAVE_SEC, WAVE_WARN, RAID_PER_LAND, DEMOLISH_REFUND, UPKEEP },
    };
  }
}

module.exports = { Game, UNIT, UNIT_KINDS, TOWER, TOWER_KINDS, FACTORY, RESEARCH, MULT, WAVE_SEC, WAVE_WARN, MAX_LEVEL, emptyUnits };
