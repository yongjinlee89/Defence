'use strict';

/* 규칙 엔진 테스트: node test/game.test.js */

const assert = require('assert');
const { Game, UNIT, TOWER, ECON, WAVE_SEC, WAVE_WARN } = require('../src/game');

const P = [
  { id: 'a', name: '갑' },
  { id: 'b', name: '을' },
];
const newGame = (opts = {}) => new Game(P, { startCash: 800, duration: 600, seed: 7, ...opts });
const tick = (g, sec) => {
  for (let i = 0; i < sec * 4; i++) g.tick(0.25);
};
const cap = (g, pid) => g.map.tiles[g.player(pid).capital];
const adjOwnedBy = (g, t, owner) => g.neighbors(t).find((o) => o.owner === owner);

/* ---------------- 맵 ---------------- */
{
  const g = newGame();
  assert.strictEqual(g.map.w, 4);
  assert.strictEqual(g.map.tiles.length, 16);
  const ca = cap(g, 'a');
  const cb = cap(g, 'b');
  assert.ok(ca.capital && cb.capital);
  assert.strictEqual(ca.res, 'iron', '수도는 항상 철 땅');
  assert.strictEqual(ca.units.inf, 8);
  assert.strictEqual(ca.b.filter((b) => b.k === 'mg').length, 2);
  assert.ok(Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y) >= 4, '수도는 서로 떨어져 있다');
  const neutral = g.map.tiles.filter((t) => !t.owner);
  assert.ok(neutral.every((t) => t.units.inf > 0), '중립 땅에는 수비대가 있다');
  const g6 = new Game(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id })),
    { seed: 1 }
  );
  assert.strictEqual(g6.map.w, 6);
  assert.strictEqual(new Set(g6.players.map((p) => p.capital)).size, 6, '수도가 겹치지 않는다');
  console.log('✓ 맵 생성');
}

/* ---------------- 건설/증설/철거 ---------------- */
{
  const g = newGame();
  const ca = cap(g, 'a');
  const p = g.player('a');
  assert.ok(!g.build('a', ca.idx, 'farm').ok, '철 땅에 농장은 불가');
  assert.ok(!g.build('a', cap(g, 'b').idx, 'shop').ok, '남의 땅에 건설 불가');
  assert.ok(g.build('a', ca.idx, 'shop').ok);
  assert.strictEqual(p.cash, 800 - ECON.shop.cost.cash);
  assert.ok(g.build('a', ca.idx, 'mg').ok, '타워도 부지를 쓴다');
  assert.strictEqual(p.inv.iron, 20 - TOWER.mg.cost.iron);
  assert.strictEqual(ca.b.length, 6);
  assert.ok(!g.build('a', ca.idx, 'cannon').ok, '부지 6칸이 다 찼다');
  // 철거해서 부지를 비운다
  assert.ok(g.demolish('a', ca.idx, ca.b.findIndex((b) => b.k === 'shop')).ok);
  assert.strictEqual(ca.b.length, 5);
  assert.ok(!g.build('a', ca.idx, 'cannon').ok, '철 부족');
  p.inv.iron = 50;
  assert.ok(g.build('a', ca.idx, 'cannon').ok);
  // 증설
  const slot = ca.b.findIndex((b) => b.k === 'mine');
  const before = p.cash;
  assert.ok(g.upgrade('a', ca.idx, slot).ok);
  assert.strictEqual(ca.b[slot].lv, 2);
  assert.strictEqual(before - p.cash, Math.round(150 * 1.6));
  assert.ok(!g.upgrade('a', ca.idx, ca.b.findIndex((b) => b.k === 'mg')).ok, '타워는 증설 불가');
  console.log('✓ 건설/증설/철거');
}

/* ---------------- 경제 ---------------- */
{
  const g = newGame();
  const p = g.player('a');
  const ca = cap(g, 'a');
  const iron0 = p.inv.iron;
  const cash0 = p.cash;
  tick(g, 10);
  assert.ok(p.inv.iron > iron0 + 3.9 && p.inv.iron < iron0 + 4.1, '광산 0.4/s');
  assert.ok(p.cash > cash0 + 29, '상점 3/s');
  // 공장: 철+석유 → 부품
  g.build('a', ca.idx, 'factory');
  const parts0 = p.inv.parts;
  tick(g, 10);
  assert.ok(p.inv.parts > parts0 + 1.4, '공장이 부품을 만든다');
  // 재료가 없으면 공장이 멈춘다
  p.inv.oil = 0;
  const parts1 = p.inv.parts;
  tick(g, 2);
  assert.ok(p.inv.parts - parts1 < 0.01, '석유가 없으면 부품이 안 나온다');
  console.log('✓ 경제');
}

/* ---------------- 시장 ---------------- */
{
  const g = newGame();
  const p = g.player('a');
  const price0 = g.price('iron');
  const cash0 = p.cash;
  assert.ok(g.trade('a', { mat: 'iron', side: 'buy', qty: 50 }).ok);
  const price1 = g.price('iron');
  assert.ok(price1 > price0, '사면 오른다');
  assert.strictEqual(p.inv.iron, 70);
  assert.ok(g.trade('a', { mat: 'iron', side: 'sell', qty: 50 }).ok);
  assert.ok(p.cash < cash0, '왕복 거래는 반드시 손해 (스프레드+가격 충격)');
  assert.ok(g.price('iron') < price1, '팔면 내린다');
  g.trade('a', { mat: 'iron', side: 'sell', qty: 20 });
  assert.ok(g.price('iron') < price0);
  tick(g, 60);
  assert.ok(Math.abs(g.price('iron') - price0) < 0.5, '시간이 지나면 가격이 돌아온다');
  assert.ok(!g.trade('a', { mat: 'parts', side: 'sell', qty: 100 }).ok, '없는 걸 팔 수 없다');
  assert.ok(!g.trade('a', { mat: 'gold', side: 'buy', qty: 1 }).ok);
  // 전부 팔기
  assert.ok(g.trade('a', { mat: 'food', side: 'sell', qty: -1 }).ok);
  assert.ok(p.inv.food < 1);
  // 자동 판매는 남겨 둘 양을 넘는 만큼만
  p.inv.oil = 30;
  g.setAutoSell('a', 'oil', true);
  tick(g, 1);
  assert.ok(p.inv.oil >= 10 && p.inv.oil < 11.5, '자동 판매 후 10 남김');
  console.log('✓ 시장');
}

/* ---------------- 병력/이동 ---------------- */
{
  const g = newGame();
  const p = g.player('a');
  const ca = cap(g, 'a');
  assert.ok(g.train('a', ca.idx, 'tank', 1).ok);
  assert.strictEqual(ca.units.tank, 1);
  assert.strictEqual(p.inv.parts, 2);
  assert.ok(!g.train('a', ca.idx, 'air', 1).ok, '부품 부족');
  assert.ok(g.train('a', ca.idx, 'inf', 5).ok);
  assert.strictEqual(ca.units.inf, 13);
  assert.ok(!g.train('a', ca.idx, 'inf', 0).ok);
  // 이동은 인접한 내 땅으로만
  const nb = g.neighbors(ca)[0];
  assert.ok(!g.move('a', ca.idx, nb.idx, { inf: 3 }).ok, '중립 땅으로 이동 불가');
  nb.owner = 'a';
  assert.ok(g.move('a', ca.idx, nb.idx, { inf: 3, tank: 5 }).ok, '있는 만큼만 보낸다');
  assert.strictEqual(nb.units.inf, 3 + nb.units.inf - 3); // 기존 수비대 포함
  assert.strictEqual(ca.units.inf, 10);
  assert.strictEqual(ca.units.tank, 0, '전차 5 요청 → 1 이동');
  const far = g.map.tiles.find((t) => !g.adjacent(t, ca) && t.idx !== ca.idx);
  far.owner = 'a';
  assert.ok(!g.move('a', ca.idx, far.idx, { inf: 1 }).ok, '인접하지 않으면 이동 불가');
  console.log('✓ 병력/이동');
}

/* ---------------- 전투/점령 ---------------- */
{
  const g = newGame();
  const p = g.player('a');
  const ca = cap(g, 'a');
  const target = g.neighbors(ca).find((t) => !t.owner);
  assert.ok(!g.attack('a', ca.idx, ca.idx, { inf: 1 }).ok, '내 땅 공격 불가');
  // 압도적 전력으로 공격
  p.cash = 5000;
  p.inv.parts = 50;
  p.inv.iron = 100;
  p.inv.food = 100;
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
  // 항공기만으로 공격 → 대공포가 없으면 거의 무손실로 이기고, 대공포가 있으면 진다
  const setup = (withAA) => {
    const g = newGame();
    const ca = cap(g, 'a');
    const t = g.neighbors(ca).find((x) => !x.owner);
    t.units = { inf: 8, tank: 2, arty: 0, air: 0 };
    t.b = withAA ? [{ k: 'aa', hp: 60 }, { k: 'aa', hp: 60 }] : [{ k: 'cannon', hp: 80 }];
    ca.units.air = 4;
    g.attack('a', ca.idx, t.idx, { air: 4 });
    tick(g, 120);
    return { g, t };
  };
  const a = setup(false);
  assert.strictEqual(a.t.owner, 'a', '대공포 없으면 항공기가 이긴다');
  assert.ok(a.t.units.air > 2.5, '거의 손실 없이');
  const b = setup(true);
  assert.notStrictEqual(b.t.owner, 'a', '대공포 2문이면 항공기 4대가 진다');
  // 전차 돌격 vs 포탑
  const g2 = newGame();
  const ca2 = cap(g2, 'a');
  const t2 = g2.neighbors(ca2).find((x) => !x.owner);
  t2.units = { inf: 0, tank: 0, arty: 0, air: 0 };
  t2.b = [{ k: 'cannon', hp: 80 }, { k: 'cannon', hp: 80 }];
  ca2.units.tank = 3;
  g2.attack('a', ca2.idx, t2.idx, { tank: 3 });
  tick(g2, 120);
  assert.notStrictEqual(t2.owner, 'a', '포탑 2문은 전차 3대를 막는다');
  // 같은 포탑을 포병으로 두들기면 무너진다
  const g3 = newGame();
  const ca3 = cap(g3, 'a');
  const t3 = g3.neighbors(ca3).find((x) => !x.owner);
  t3.units = { inf: 0, tank: 0, arty: 0, air: 0 };
  t3.b = [{ k: 'cannon', hp: 80 }, { k: 'cannon', hp: 80 }];
  ca3.units.arty = 5;
  g3.attack('a', ca3.idx, t3.idx, { arty: 5 });
  tick(g3, 120);
  assert.strictEqual(t3.owner, 'a', '포병 5문은 포탑 2문을 부순다 (전차 5대는 못 뚫는다)');
  const g4 = newGame();
  const ca4 = cap(g4, 'a');
  const t4 = g4.neighbors(ca4).find((x) => !x.owner);
  t4.units = { inf: 0, tank: 0, arty: 0, air: 0 };
  t4.b = [{ k: 'cannon', hp: 80 }, { k: 'cannon', hp: 80 }];
  ca4.units.tank = 5;
  g4.attack('a', ca4.idx, t4.idx, { tank: 5 });
  tick(g4, 120);
  assert.notStrictEqual(t4.owner, 'a');
  console.log('✓ 상성');
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
  // 다른 사람은 그 전투에 끼어들 수 없다
  const cb = cap(g, 'b');
  const nb = g.neighbors(t).find((x) => x.idx !== ca.idx);
  nb.owner = 'b';
  nb.units.inf = 5;
  assert.ok(!g.attack('b', nb.idx, t.idx, { inf: 5 }).ok, '다른 전투가 진행 중');
  // 후퇴
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
  const g = newGame();
  tick(g, WAVE_SEC - WAVE_WARN + 1);
  assert.ok(Object.keys(g.raids).length === 2, '예고가 뜬다');
  const ps = g.publicState();
  assert.ok(Object.keys(ps.raids).length === 2);
  tick(g, WAVE_WARN);
  assert.strictEqual(g.round, 1);
  const battles = g.map.tiles.filter((t) => t.battle && t.battle.att === 'npc');
  assert.strictEqual(battles.length, 2, '각 플레이어 땅 하나씩 습격');
  tick(g, 60);
  assert.ok(g.map.tiles.every((t) => !t.battle), '1라운드는 기본 방어로 막힌다');
  assert.ok(g.player('a').alive && g.player('b').alive);
  assert.ok(g.landOf('a').length === 1);
  // 무방비 땅은 함락돼 중립이 된다
  const ca = cap(g, 'a');
  ca.units = { inf: 0, tank: 0, arty: 0, air: 0 };
  ca.b = ca.b.filter((b) => !TOWER[b.k]);
  tick(g, WAVE_SEC + 60);
  assert.strictEqual(g.round, 2);
  assert.strictEqual(ca.owner, null, '함락');
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
  assert.ok(!g.build('a', cap(g, 'a').idx, 'shop').ok, '끝난 뒤에는 행동 불가');
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
  assert.ok(s.constants.UNIT.inf);
  const size = JSON.stringify(s).length;
  assert.ok(size < 12000, `전체 상태가 작다 (${size}B)`);
  console.log(`✓ 공개 상태 (전체 ${size}B)`);
}

console.log('game.test.js 통과');
