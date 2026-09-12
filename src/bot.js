'use strict';

/**
 * 컴퓨터 플레이어 — Game 의 공개 메서드만 호출한다 (반칙 불가, 규칙이 바뀌면 자동으로 따라온다).
 * 1.5초마다 한 번 판단한다. 우선순위:
 *   1) 자동 판매 켜기 (자원을 돈으로)
 *   2) 경제 건물 짓기 (빈 부지가 있으면 자원 채취 > 상점/공장)
 *   3) 라운드에 맞춰 타워 짓기 (모든 땅에 최소 방어)
 *   4) 가장 약한 땅에 병력 채우기
 *   5) 충분히 강하면 인접한 약한 땅 공격
 * 반환값: 맵이 바뀌었으면 true (즉시 브로드캐스트용)
 */

const { UNIT, TOWER, ECON, MAT_KINDS, UNIT_KINDS } = require('./game');

function power(units) {
  let p = 0;
  for (const u of UNIT_KINDS) p += (units[u] || 0) * UNIT[u].hp * UNIT[u].dps;
  return p;
}
function towerPower(t) {
  let p = 0;
  for (const b of t.b) if (TOWER[b.k]) p += b.hp * TOWER[b.k].dps;
  return p;
}
function defensePower(game, t) {
  return power(t.units) + towerPower(t);
}

function think(game, pid) {
  const p = game.player(pid);
  if (!p || !p.alive || game.ended) return false;
  let changed = false;
  const land = game.landOf(pid);
  if (!land.length) return false;

  // 1) 자동 판매 — 철·부품은 군수용으로 남기고 나머지는 판다
  if (!p.autoSell.food) game.setAutoSell(pid, 'food', true);
  if (!p.autoSell.oil) game.setAutoSell(pid, 'oil', true);

  // 부품이 없으면 시장에서 조금 산다 (타워·전차 재료), 철이 쌓이면 판다
  if (p.inv.parts < 3 && p.cash > 400) game.trade(pid, { mat: 'parts', side: 'buy', qty: 3 });
  if (p.inv.iron < 10 && p.cash > 300) game.trade(pid, { mat: 'iron', side: 'buy', qty: 15 });
  if (p.inv.iron > 60) game.trade(pid, { mat: 'iron', side: 'sell', qty: Math.floor(p.inv.iron - 40) });

  // 2) 건설 — 땅마다 타워 자리(최대 3칸)는 남겨 두고 나머지에 경제 건물을 짓는다
  for (const t of land) {
    const free = t.slots - t.b.length;
    if (free <= 0) continue;
    const hasExtract = t.res && t.b.some((b) => ECON[b.k] && ECON[b.k].res === t.res);
    const towers = t.b.filter((b) => TOWER[b.k]).length;
    const maxTowers = Math.min(3, t.slots - 2);
    const wantTowers = Math.min(maxTowers, 1 + Math.floor((game.round + 1) / 2));
    let kind = null;
    if (t.res && !hasExtract) kind = { iron: 'mine', oil: 'well', food: 'farm' }[t.res];
    else if (towers < wantTowers) {
      // 라운드가 오르면 전차·항공기가 오므로 포탑·대공포를 섞는다
      const has = (k) => t.b.some((b) => b.k === k);
      kind = !has('mg') ? 'mg' : !has('cannon') ? 'cannon' : game.round >= 3 && !has('aa') ? 'aa' : 'mortar';
    } else if (free > maxTowers - towers) {
      const factories = land.reduce((n, x) => n + x.b.filter((b) => b.k === 'factory').length, 0);
      const mines = land.reduce((n, x) => n + x.b.filter((b) => b.k === 'mine').length, 0);
      const wells = land.reduce((n, x) => n + x.b.filter((b) => b.k === 'well').length, 0);
      kind = mines >= 1 && wells >= 1 && factories < Math.min(mines, wells) ? 'factory' : 'shop';
    }
    if (kind && game.build(pid, t.idx, kind).ok) {
      changed = true;
      break; // 한 번에 하나만
    }
  }

  // 3) 병력 — 가장 약한 땅에 보병을, 여유가 있으면 전차를
  const weakest = [...land].sort((a, b) => defensePower(game, a) - defensePower(game, b))[0];
  const minPower = 200 + game.round * 180;
  if (defensePower(game, weakest) < minPower) {
    if (p.inv.parts >= 2 && p.cash > 200 && game.train(pid, weakest.idx, 'tank', 1).ok) changed = true;
    else if (game.train(pid, weakest.idx, 'inf', 3).ok) changed = true;
  } else if (p.cash > 600) {
    // 여유 자금은 공격군에 쓴다
    const strongest = [...land].sort((a, b) => power(b.units) - power(a.units))[0];
    const pick = p.inv.parts >= 3 && p.inv.oil >= 4 ? 'air' : p.inv.parts >= 2 ? 'arty' : 'inf';
    if (game.train(pid, strongest.idx, pick, pick === 'inf' ? 4 : 1).ok) changed = true;
  }

  // 4) 공격 — 내 땅에서 인접한 남의 땅을, 보내는 병력이 상대의 2배 이상일 때만
  for (const t of land) {
    if (t.battle) continue;
    // 80% 를 보내되, 2 이하로 있는 종류는 전부 보낸다 (1대의 80% = 0 이 되는 것을 막는다)
    const send = {};
    for (const u of UNIT_KINDS) {
      const n = Math.floor(t.units[u]);
      send[u] = n <= 2 ? n : Math.floor(n * 0.8);
    }
    const sendPower = power(send);
    if (sendPower < 120) continue;
    const targets = game
      .neighbors(t)
      .filter((o) => o.owner !== pid && !o.battle)
      .map((o) => ({ o, pw: defensePower(game, o) + (o.owner ? 100 : 0) }))
      .sort((a, b) => a.pw - b.pw);
    if (!targets.length) continue;
    const { o, pw } = targets[0];
    if (sendPower < pw * 2) continue;
    if (game.attack(pid, t.idx, o.idx, send).ok) {
      changed = true;
      break;
    }
  }

  // 5) 전투 중인 내 공격이 불리하면 후퇴
  for (const t of game.map.tiles) {
    if (!t.battle || t.battle.att !== pid) continue;
    if (power(t.battle.A) < defensePower(game, t) * 0.3) {
      game.retreat(pid, t.idx);
      changed = true;
    }
  }

  return changed;
}

module.exports = { think, power, defensePower };
