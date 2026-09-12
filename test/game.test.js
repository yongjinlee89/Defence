'use strict';

/* 규칙 엔진 테스트: node test/game.test.js */

const assert = require('assert');
const { Game, TOWER, FACTORY, RESEARCH, WAVE_SEC, WAVE_WARN } = require('../src/game');

const P = [
  { id: 'a', name: '갑' },
  { id: 'b', name: '을' },
];
const newGame = (opts = {}) => new Game(P, { startCash: 800, duration: 600, seed: 7, raids: 1, ...opts });
const tick = (g, sec) => {
  for (let i = 0; i < sec * 4; i++) g.tick(0.25);
};
const cap = (g, pid) => g.map.tiles[g.player(pid).capital];

/* ---------------- 맵 ---------------- */
{
  const g = newGame();
  assert.strictEqual(g.map.w, 4);
  assert.strictEqual(g.map.tiles.length, 16);
  const ca = cap(g, 'a');
  const cb = cap(g, 'b');
  assert.ok(ca.capital && cb.capital);
  assert.strictEqual(ca.units.inf, 8);
  assert.ok(ca.b.some((b) => b.k === 'mg') && ca.b.some((b) => b.k === 'cannon'), '수도는 기관총+포탑');
  assert.ok(ca.b.some((b) => b.k === 'factory'));
  assert.ok(Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y) >= 4, '수도는 서로 떨어져 있다');
  assert.ok(g.map.tiles.filter((t) => !t.owner).every((t) => t.units.inf > 0), '중립 땅에는 수비대가 있다');
  assert.ok(g.map.tiles.every((t) => t.yield >= 1 && t.yield <= 3 && t.slots === 3 + t.yield || t.capital));
  const g6 = new Game(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id })), { seed: 1 });
  assert.strictEqual(g6.map.w, 6);
  assert.strictEqual(new Set(g6.players.map((p) => p.capital)).size, 6, '수도가 겹치지 않는다');
  console.log('✓ 맵 생성');
}

/* ---------------- 건설/증설/철거/경제 ---------------- */
{
  const g = newGame();
  const ca = cap(g, 'a');
  const p = g.player('a');
  assert.ok(!g.build('a', cap(g, 'b').idx, 'factory').ok, '남의 땅에 건설 불가');
  assert.ok(!g.build('a', ca.idx, 'mine').ok, '없는 건물');
  assert.ok(g.build('a', ca.idx, 'factory').ok);
  assert.strictEqual(p.cash, 800 - FACTORY.cost);
  assert.ok(g.build('a', ca.idx, 'cannon').ok, '타워도 부지를 쓴다');
  assert.ok(g.build('a', ca.idx, 'aa').ok);
  assert.strictEqual(ca.b.length, 6);
  assert.ok(!g.build('a', ca.idx, 'mg').ok, '부지 6칸이 다 찼다');
  // 수입: 땅 기본 1×3 + 공장 2개 × 등급 3 × 1.5 = 12/초 (수도는 최고 등급)
  assert.strictEqual(ca.yield, 3);
  assert.ok(Math.abs(g.incomeOf(p) - 12) < 1e-9);
  const cash0 = p.cash;
  tick(g, 10);
  // 수입 80 − 보병 8명 유지비 (8×0.1×10 = 8)
  assert.ok(Math.abs(p.cash - (cash0 + 120 - 8)) < 0.01, '10초에 120 − 유지비 8');
  assert.ok(Math.abs(g.upkeepOf(p) - 0.8) < 1e-9);
  // 돈이 바닥나면 탈영
  p.cash = 0;
  ca.units.inf = 200; // 유지비 20/초 > 수입 12/초
  tick(g, 10);
  assert.ok(ca.units.inf < 200 && ca.units.inf > 100, '유지비를 못 내면 병력이 준다');
  ca.units.inf = 8;
  p.cash = 1000;
  // 증설
  const slot = ca.b.findIndex((b) => b.k === 'factory');
  const before = p.cash;
  assert.ok(g.upgrade('a', ca.idx, slot).ok);
  assert.strictEqual(ca.b[slot].lv, 2);
  assert.strictEqual(before - p.cash, 300, '증설 1.5배');
  assert.ok(Math.abs(g.incomeOf(p) - 16.5) < 1e-9);
  // 타워 증설: 체력 상한·화력 배수 상승, 비용은 타워 건설비 × 1.5^레벨
  const mgSlot = ca.b.findIndex((b) => b.k === 'mg');
  p.cash = 1000;
  assert.ok(g.upgrade('a', ca.idx, mgSlot).ok);
  assert.strictEqual(ca.b[mgSlot].lv, 2);
  assert.strictEqual(p.cash, 1000 - 150);
  assert.ok(Math.abs(ca.b[mgSlot].hp - 96) < 1e-9, '60 × 1.6');
  assert.ok(Math.abs(g.defenders(ca).mg - 1.6) < 1e-9, '2레벨 기관총은 1.6문');
  assert.ok(g.upgrade('a', ca.idx, mgSlot).ok);
  assert.strictEqual(ca.b[mgSlot].lv, 3);
  assert.ok(!g.upgrade('a', ca.idx, mgSlot).ok, '3레벨이 최대');
  const ps = g.publicState().map.tiles[ca.idx].b[mgSlot];
  assert.strictEqual(ps.lv, 3);
  assert.strictEqual(ps.hp, undefined, '만피면 hp 안 보냄');
  // 땅 개발 — 수도는 이미 최고 등급, 등급 1 땅을 뺏어 개발하면 부지 +1, 수입 상승
  assert.ok(!g.upgradeLand('a', ca.idx).ok, '최고 등급은 더 못 올린다');
  const low = g.map.tiles.find((t) => !t.owner && t.yield === 1);
  low.owner = 'a';
  low.b = [{ k: 'factory', lv: 1 }];
  p.cash = 1000;
  const inc0 = g.incomeOf(p);
  const slots0 = low.slots;
  assert.ok(g.upgradeLand('a', low.idx).ok);
  assert.strictEqual(low.yield, 2);
  assert.strictEqual(low.slots, slots0 + 1);
  assert.strictEqual(p.cash, 600);
  assert.ok(Math.abs(g.incomeOf(p) - (inc0 + 2.5)) < 1e-9, '기본 1 + 공장 1.5 만큼 오른다');
  assert.strictEqual(g.upgradeLand('a', low.idx).ok, false, '700 필요');
  p.cash = 700;
  assert.ok(g.upgradeLand('a', low.idx).ok);
  assert.strictEqual(low.yield, 3);
  assert.ok(!g.upgradeLand('a', cap(g, 'b').idx).ok, '남의 땅 불가');
  // 철거
  const n = ca.b.length;
  assert.ok(g.demolish('a', ca.idx, ca.b.findIndex((b) => b.k === 'aa')).ok);
  assert.strictEqual(ca.b.length, n - 1);
  console.log('✓ 건설/증설/철거/경제');
}

/* ---------------- 병력/이동 ---------------- */
{
  const g = newGame();
  const p = g.player('a');
  const ca = cap(g, 'a');
  assert.ok(!g.train('a', ca.idx, 'tank', 1).ok, '전차는 연구 전에 못 뽑는다');
  assert.ok(!g.research('a', 'air').ok, '항공기는 전차 개발이 먼저');
  assert.ok(g.research('a', 'tank').ok);
  assert.strictEqual(p.cash, 500);
  assert.ok(!g.research('a', 'tank').ok, '개발은 한 번');
  assert.ok(g.train('a', ca.idx, 'tank', 1).ok);
  assert.strictEqual(ca.units.tank, 1);
  assert.strictEqual(p.cash, 400);
  assert.ok(!g.train('a', ca.idx, 'air', 10).ok, '돈 부족');
  assert.ok(g.train('a', ca.idx, 'inf', 5).ok);
  assert.strictEqual(ca.units.inf, 13);
  assert.ok(!g.train('a', ca.idx, 'inf', 0).ok);
  const nb = g.neighbors(ca)[0];
  assert.ok(!g.move('a', ca.idx, nb.idx, 'all').ok, '중립 땅으로 이동 불가');
  nb.owner = 'a';
  const nbInf = nb.units.inf;
  assert.ok(g.move('a', ca.idx, nb.idx, { inf: 3, tank: 5 }).ok, '있는 만큼만 보낸다');
  assert.strictEqual(nb.units.inf, nbInf + 3);
  assert.strictEqual(ca.units.inf, 10);
  assert.strictEqual(ca.units.tank, 0, '전차 5 요청 → 1 이동');
  assert.ok(g.move('a', ca.idx, nb.idx, 'half').ok, '절반');
  assert.strictEqual(ca.units.inf, 5);
  assert.ok(g.move('a', ca.idx, nb.idx, 'all').ok, '전부');
  assert.strictEqual(ca.units.inf, 0);
  assert.ok(!g.move('a', ca.idx, nb.idx, 'all').ok, '보낼 병력이 없다');
  const far = g.map.tiles.find((t) => !g.adjacent(t, nb) && t.idx !== nb.idx && t.idx !== ca.idx);
  far.owner = 'a';
  assert.ok(!g.move('a', nb.idx, far.idx, 'all').ok, '인접하지 않으면 이동 불가');
  console.log('✓ 병력/이동');
}

/* ---------------- 전투/점령 ---------------- */
{
  const g = newGame();
  const p = g.player('a');
  const ca = cap(g, 'a');
  const target = g.neighbors(ca).find((t) => !t.owner);
  assert.ok(!g.attack('a', ca.idx, ca.idx, 'all').ok, '내 땅 공격 불가');
  p.cash = 5000;
  assert.ok(g.research('a', 'tank').ok);
  assert.ok(g.train('a', ca.idx, 'tank', 5).ok);
  assert.ok(g.train('a', ca.idx, 'inf', 20).ok);
  assert.ok(g.attack('a', ca.idx, target.idx, { inf: 20, tank: 5 }).ok);
  assert.ok(target.battle && target.battle.att === 'a');
  assert.strictEqual(ca.units.inf, 8, '보낸 병력은 출발지에서 빠진다');
  const defBefore = target.units.inf;
  tick(g, 1);
  assert.ok(target.units.inf < defBefore, '수비대가 줄어든다');
  assert.ok(target.battle.A.inf < 20, '공격군도 소모된다');
  tick(g, 60);
  assert.strictEqual(target.battle, null, '전투가 끝났다');
  assert.strictEqual(target.owner, 'a', '점령했다');
  assert.ok(target.units.tank > 0, '생존 병력이 주둔한다');
  assert.ok(!target.b.some((b) => TOWER[b.k]), '점령 시 타워는 파괴된다');
  assert.ok(g.log.some((l) => l.text.includes('점령')));
  console.log('✓ 전투/점령');
}

/* ---------------- 상성 ---------------- */
{
  const setup = (towers, def, atk) => {
    const g = newGame();
    const ca = cap(g, 'a');
    const t = g.neighbors(ca).find((x) => !x.owner);
    t.units = { inf: 0, tank: 0, air: 0, ...def };
    t.b = towers.map((k) => ({ k, hp: TOWER[k].hp }));
    Object.assign(ca.units, atk);
    g.attack('a', ca.idx, t.idx, atk);
    tick(g, 120);
    return t;
  };
  assert.strictEqual(setup(['cannon'], { tank: 3 }, { air: 4 }).owner, 'a', '대공포·보병이 없으면 항공기가 이긴다');
  assert.notStrictEqual(setup(['aa', 'aa'], { tank: 3 }, { air: 4 }).owner, 'a', '대공포 2문이면 항공기 4대가 진다');
  assert.strictEqual(setup(['cannon'], { inf: 10, tank: 2 }, { air: 4 }).owner, 'a', '보병이 많아도 항공기를 못 막는다');
  assert.notStrictEqual(setup([], { air: 3 }, { air: 3 }).owner, 'a', '항공기는 항공기로 막는다');
  assert.notStrictEqual(setup(['cannon', 'cannon'], {}, { tank: 4 }).owner, 'a', '포탑 2문은 전차 4대를 막는다');
  assert.strictEqual(setup(['cannon', 'cannon'], {}, { inf: 15 }).owner, 'a', '보병 15명은 포탑 2문을 뚫는다');
  assert.strictEqual(setup(['cannon', 'cannon'], {}, { air: 3 }).owner, 'a', '포탑은 항공기를 못 때린다');
  assert.strictEqual(setup(['mg', 'mg'], {}, { tank: 3 }).owner, 'a', '전차는 기관총을 뚫는다');
  assert.notStrictEqual(setup(['mg', 'mg'], {}, { inf: 12 }).owner, 'a', '기관총 2문은 보병 12명을 막는다');
  assert.notStrictEqual(setup([], { air: 3 }, { inf: 12 }).owner, 'a', '보병 12명도 항공기 3대를 못 잡는다');
  assert.strictEqual(setup([], { inf: 10 }, { tank: 3 }).owner, 'a', '전차는 보병을 밀어낸다');
  console.log('✓ 상성 (전차 > 보병, 항공기 > 전차, 항공기는 대공포·항공기로만, 타워는 담당 하나씩)');
}

/* ---------------- 연구 강화 ---------------- */
{
  // 같은 보병 12 vs 12 — 강화 3단계면 강화한 쪽이 이긴다
  const run = (lvA) => {
    const g = newGame();
    const p = g.player('a');
    p.cash = 5000;
    for (let i = 0; i < lvA; i++) assert.ok(g.research('a', 'inf').ok);
    const ca = cap(g, 'a');
    const t = g.neighbors(ca).find((x) => !x.owner);
    t.owner = 'b';
    t.b = [];
    t.units = { inf: 12, tank: 0, air: 0 };
    ca.units.inf = 12;
    g.attack('a', ca.idx, t.idx, { inf: 12 });
    tick(g, 120);
    return t.owner;
  };
  assert.notStrictEqual(run(0), 'a', '같은 수면 수비가 이긴다(선공 없음, 공격자가 먼저 소모)');
  assert.strictEqual(run(3), 'a', '보병 강화 3단계(+60%)면 공격이 이긴다');
  // 생산성
  const g = newGame();
  const p = g.player('a');
  p.cash = 5000;
  const inc0 = g.incomeOf(p);
  assert.ok(g.research('a', 'prod').ok);
  assert.ok(Math.abs(g.incomeOf(p) - (inc0 + 0.2 * 4.5)) < 1e-9, '공장 수입만 +20%');
  assert.ok(g.research('a', 'prod').ok && g.research('a', 'prod').ok);
  assert.ok(!g.research('a', 'prod').ok, '3단계가 최대');
  assert.ok(!g.research('a', 'zzz').ok);
  assert.strictEqual(g.publicState().players[0].rs.prod, 3);
  assert.ok(RESEARCH.airU.req === 'air');
  console.log('✓ 연구 (개발 잠금, 강화, 생산성)');
}

/* ---------------- 증원/후퇴 ---------------- */
{
  const g = newGame();
  const ca = cap(g, 'a');
  const t = g.neighbors(ca).find((x) => !x.owner);
  ca.units.inf = 30;
  g.attack('a', ca.idx, t.idx, { inf: 10 });
  assert.ok(g.attack('a', ca.idx, t.idx, { inf: 10 }).ok, '같은 공격자는 증원 가능');
  assert.ok(t.battle.A.inf >= 19);
  const nb = g.neighbors(t).find((x) => x.idx !== ca.idx);
  nb.owner = 'b';
  nb.units.inf = 5;
  assert.ok(!g.attack('b', nb.idx, t.idx, 'all').ok, '다른 전투가 진행 중');
  tick(g, 1);
  const alive = t.battle.A.inf;
  assert.ok(g.retreat('a', t.idx).ok);
  assert.strictEqual(t.battle, null);
  assert.ok(Math.abs(ca.units.inf - (10 + alive)) < 0.01, '생존자가 출발지로 돌아온다');
  assert.ok(!g.retreat('b', t.idx).ok);
  console.log('✓ 증원/후퇴');
}

/* ---------------- 습격 라운드 ---------------- */
{
  const off = newGame({ raids: 0 });
  tick(off, WAVE_SEC + 5);
  assert.strictEqual(off.round, 0, '습격 꺼짐이면 라운드가 안 오른다');
  assert.ok(off.map.tiles.every((t) => !t.battle));
  assert.strictEqual(off.publicState().raidsOn, 0);
  assert.strictEqual(off.stage(), 1, '단계는 시간으로 센다');
  const g = newGame();
  tick(g, WAVE_SEC - WAVE_WARN + 1);
  assert.strictEqual(Object.keys(g.raids).length, 2, '예고가 뜬다');
  assert.strictEqual(Object.keys(g.publicState().raids).length, 2);
  tick(g, WAVE_WARN);
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.map.tiles.filter((t) => t.battle && t.battle.att === 'npc').length, 2, '각 플레이어 땅 하나씩 습격');
  tick(g, 60);
  assert.ok(g.map.tiles.every((t) => !t.battle), '1라운드는 기본 방어로 막힌다');
  assert.ok(g.player('a').alive && g.player('b').alive);
  // 땅이 많으면 여러 곳을 동시에 습격당한다
  assert.strictEqual(Game.raidCount(1), 1);
  assert.strictEqual(Game.raidCount(3), 1);
  assert.strictEqual(Game.raidCount(4), 2);
  assert.strictEqual(Game.raidCount(7), 3);
  const ca = cap(g, 'a');
  ca.units = { inf: 0, tank: 0, air: 0 };
  ca.b = ca.b.filter((b) => !TOWER[b.k]);
  tick(g, WAVE_SEC + 60);
  assert.strictEqual(g.round, 2);
  assert.strictEqual(ca.owner, null, '무방비 땅은 함락돼 중립이 된다');
  assert.ok(ca.b.some((b) => b.k === 'factory'), '공장은 남는다');
  assert.ok(!g.player('a').alive, '땅이 없으면 탈락');
  assert.ok(g.ended, '한 명만 남으면 종료');
  assert.strictEqual(g.ranking[0].id, 'b');
  console.log('✓ 습격 라운드');
}

/* ---------------- 종료/순위 ---------------- */
{
  const g = newGame({ duration: 30 });
  tick(g, 31);
  assert.ok(g.ended);
  assert.strictEqual(g.ranking.length, 2);
  assert.ok(g.ranking[0].netWorth >= g.ranking[1].netWorth);
  assert.ok(!g.build('a', cap(g, 'a').idx, 'factory').ok, '끝난 뒤에는 행동 불가');
  console.log('✓ 종료/순위');
}

/* ---------------- 공개 상태 ---------------- */
{
  const g = newGame();
  const s = JSON.parse(JSON.stringify(g.publicState()));
  assert.strictEqual(s.map.tiles.length, 16);
  const t = s.map.tiles[g.player('a').capital];
  assert.strictEqual(t.owner, 'a');
  assert.strictEqual(t.cap, 1);
  assert.deepStrictEqual(t.u, { inf: 8 });
  assert.ok(t.b.every((b) => b.hp === undefined), '멀쩡한 타워는 hp 를 안 보낸다');
  assert.ok(s.map.tiles.every((x) => x.units === undefined && x.battle === undefined), '내부 필드는 안 나간다');
  assert.strictEqual(s.players[0].income, 7.5);
  const size = JSON.stringify(s).length;
  assert.ok(size < 8000, `전체 상태가 작다 (${size}B)`);
  console.log(`✓ 공개 상태 (전체 ${size}B)`);
}

console.log('game.test.js 통과');
