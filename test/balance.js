'use strict';

/* 밸런스 확인: node test/balance.js [초] [시드]
 * 봇 4명이 자동으로 플레이한 결과(영토·순자산·함락 횟수)와
 * 라운드별 약탈대를 표준 방어 구성으로 막을 수 있는지를 출력한다. */

const { Game, UNIT, TOWER } = require('../src/game');
const { think } = require('../src/bot');

const duration = Number(process.argv[2]) || 900;
const seed = Number(process.argv[3]) || 42;

console.log('== 봇 4명 자동 대전 (' + duration + '초, 시드 ' + seed + ')');
const ids = ['b1', 'b2', 'b3', 'b4'];
const g = new Game(ids.map((id) => ({ id, name: id })), { startCash: 1200, duration, seed });
for (let sec = 0; sec < duration && !g.ended; sec += 0.25) {
  g.tick(0.25);
  if (Math.round(sec * 4) % 6 === 0) for (const id of ids) think(g, id);
  if (Math.round(sec * 4) % 720 === 0) {
    console.log(
      `  t=${sec} r=${g.round} ` +
        ids.map((id) => `${id}${g.player(id).alive ? '' : '✗'} 땅${g.landOf(id).length} 💰${Math.round(g.player(id).cash)} nw${g.netWorth(g.player(id))}`).join(' | ')
    );
  }
}
console.log(
  `  종료: 라운드 ${g.round}, 함락 ${g.log.filter((l) => l.text.includes('함락')).length}회, 점령 ${g.log.filter((l) => l.text.includes('점령')).length}회, 생존 ${g.players.filter((p) => p.alive).length}명`
);

console.log('\n== 라운드별 약탈대 vs 표준 방어 (O 막음 / X 함락)');
function trial(r, towers, units) {
  const t2 = new Game([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { seed: 1 });
  const t = t2.map.tiles[t2.player('a').capital];
  t.b = towers.map((k) => ({ k, hp: TOWER[k].hp }));
  t.units = { inf: 0, tank: 0, air: 0, ...units };
  t.battle = { att: 'npc', from: null, A: Game.raidForce(r), t: 0 };
  for (let i = 0; i < 800; i++) {
    t2.tick(0.25);
    if (!t.battle) break;
  }
  return t.owner === 'a';
}
const templates = [
  ['A 시작 상태(기관총+포탑+보병8)', ['mg', 'cannon'], { inf: 8 }],
  ['B +대공포', ['mg', 'cannon', 'aa'], { inf: 8 }],
  ['C 3타워+보병8+전차2', ['mg', 'cannon', 'aa'], { inf: 8, tank: 2 }],
  ['D 3타워+보병12+전차4', ['mg', 'cannon', 'aa'], { inf: 12, tank: 4 }],
  ['E 4타워+보병15+전차6+항공기2', ['mg', 'cannon', 'cannon', 'aa'], { inf: 15, tank: 6, air: 2 }],
];
for (const [n] of templates) console.log('  ' + n);
for (const r of [1, 2, 3, 4, 5, 6, 8, 10, 12, 14]) {
  const f = Game.raidForce(r);
  console.log(`  r${String(r).padStart(2)} (보${f.inf} 전${f.tank} 공${f.air}): ` + templates.map(([n, tw, u]) => n[0] + (trial(r, tw, u) ? 'O' : 'X')).join(' '));
}
