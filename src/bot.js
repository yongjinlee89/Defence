'use strict';

/**
 * 컴퓨터 플레이어 — Game 의 공개 메서드만 호출한다 (반칙 불가).
 * 1.5초마다 한 번 판단한다. 우선순위:
 *   1) 건설: 땅마다 타워 자리(최대 3칸)는 남겨 두고 공장을 짓고, 라운드에 맞춰 타워를 올린다
 *   2) 가장 약한 땅에 병력 채우기 (여유가 있으면 공격군 양성)
 *   3) 보내는 병력이 상대의 2배 이상이면 인접한 약한 땅 공격
 *   4) 불리한 공격은 후퇴
 * 반환값: 맵이 바뀌었으면 true (즉시 브로드캐스트용)
 */

const { UNIT, TOWER, UNIT_KINDS } = require('./game');

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

  // 1) 건설
  for (const t of land) {
    const free = t.slots - t.b.length;
    if (free <= 0) continue;
    const towers = t.b.filter((b) => TOWER[b.k]).length;
    const factories = t.b.filter((b) => b.k === 'factory').length;
    const maxTowers = Math.min(3, t.slots - 2);
    const wantTowers = Math.min(maxTowers, 1 + Math.floor((game.round + 1) / 2));
    let kind = null;
    if (factories === 0) kind = 'factory';
    else if (towers < wantTowers) {
      const has = (k) => t.b.some((b) => b.k === k);
      kind = !has('mg') ? 'mg' : !has('cannon') ? 'cannon' : !has('aa') ? 'aa' : 'cannon';
    } else if (free > maxTowers - towers) kind = 'factory';
    if (kind && game.build(pid, t.idx, kind).ok) {
      changed = true;
      break;
    }
  }
  // 땅 개발 — 공장이 둘 이상 있는 땅부터 (등급이 오르면 그 공장들이 다 같이 더 번다)
  if (p.cash > 900) {
    const t = land.filter((x) => x.yield < 3 && !x.battle && x.b.filter((b) => b.k === 'factory').length >= 2).sort((a, b) => b.b.length - a.b.length)[0];
    if (t && game.upgradeLand(pid, t.idx).ok) changed = true;
  }
  // 공장 증설 — 돈이 넉넉할 때
  if (p.cash > 700) {
    for (const t of land) {
      const i = t.b.findIndex((b) => b.k === 'factory' && b.lv < 3);
      if (i >= 0 && game.upgrade(pid, t.idx, i).ok) {
        changed = true;
        break;
      }
    }
  }

  // 2) 병력 — 가장 약한 땅부터
  const weakest = [...land].sort((a, b) => defensePower(game, a) - defensePower(game, b))[0];
  const minPower = 200 + game.round * 180;
  if (defensePower(game, weakest) < minPower) {
    const pick = game.round >= 4 && p.cash > 300 ? 'tank' : 'inf';
    if (game.train(pid, weakest.idx, pick, pick === 'inf' ? 3 : 1).ok) changed = true;
  } else if (p.cash > 500) {
    const strongest = [...land].sort((a, b) => power(b.units) - power(a.units))[0];
    const pick = p.cash > 800 && game.round >= 3 ? 'air' : p.cash > 400 ? 'tank' : 'inf';
    if (game.train(pid, strongest.idx, pick, pick === 'inf' ? 4 : 1).ok) changed = true;
  }

  // 3) 공격 — 보내는 병력(2 이하는 전부, 그 외 80%)의 전투력이 상대의 2배 이상일 때만
  for (const t of land) {
    if (t.battle) continue;
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

  // 4) 불리하면 후퇴
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
