'use strict';

/* 봇 테스트: node test/bot.test.js — 봇 4명이 15분을 오류 없이 플레이하고 게임이 실제로 흘러가는지 */

const assert = require('assert');
const { Game } = require('../src/game');
const { think } = require('../src/bot');

const ids = ['b1', 'b2', 'b3', 'b4'];
const g = new Game(ids.map((id) => ({ id, name: id })), { startCash: 800, duration: 900, seed: 42 });
let actions = 0;
for (let sec = 0; sec < 900 && !g.ended; sec += 0.25) {
  g.tick(0.25);
  if (Math.round(sec * 4) % 6 === 0) for (const id of ids) if (think(g, id)) actions++;
}
assert.ok(actions > 50, '봇이 행동한다');
const land = ids.map((id) => g.landOf(id).length);
assert.ok(land.some((n) => n > 1), '봇이 영토를 넓힌다: ' + land.join(','));
const built = g.map.tiles.reduce((n, t) => n + t.b.length, 0);
assert.ok(built > 20, '봇이 건물을 짓는다');
assert.ok(g.round >= 10 || g.ended, '라운드가 진행된다');
const alive = g.players.filter((p) => p.alive).length;
console.log(`✓ 봇 4명 15분: 행동 ${actions}회, 영토 ${land.join('/')}, 건물 ${built}, 라운드 ${g.round}, 생존 ${alive}, 순자산 ${g.players.map((p) => g.netWorth(p)).join('/')}`);
console.log('bot.test.js 통과');
