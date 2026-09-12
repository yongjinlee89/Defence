'use strict';

/* 방/실시간 루프 테스트: node test/room.test.js */

const assert = require('assert');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('../src/room');
const { diff, applyPatch } = require('../src/diff');

const newRoom = (onChange) => new Room('test', onChange || (() => {}));

{
  const room = newRoom();
  assert.ok(room.join('a', '갑', 's1').ok);
  assert.ok(room.join('b', '을', 's2').ok);
  assert.strictEqual(room.hostId, 'a');
  assert.ok(!room.join('c', '갑', 's3').ok, '같은 이름은 거부');
  for (let i = 0; i < MAX_PLAYERS; i++) room.join('x' + i, '손님' + i, 'sx' + i);
  assert.ok(room.players.length <= MAX_PLAYERS);
  room.leave('a');
  assert.strictEqual(room.hostId, 'b', '방장이 넘어간다');
  console.log('✓ 입장/퇴장');
}

{
  const room = newRoom();
  room.join('a', '갑', 's1');
  assert.ok(!room.start('a').ok, `혼자서는 시작 불가 (최소 ${MIN_PLAYERS}명)`);
  assert.ok(!room.addBot('zzz').ok, '방장만 봇 추가');
  assert.ok(room.addBot('a').ok);
  assert.ok(room.updateSettings('a', { startCash: 1200, duration: 900 }).ok);
  assert.ok(!room.updateSettings('a', { duration: 77 }).ok);
  assert.ok(room.start('a').ok);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.game.players.length, 2);
  assert.strictEqual(room.game.player('a').cash, 1200);
  assert.ok(!room.join('z', '난입', 'sz').ok, '게임 중 새 입장 거부');
  assert.ok(room.join('a', '갑', 's1-new').ok, '재접속 허용');
  room.stopLoop();
  console.log('✓ 설정/시작/봇');
}

{
  // 실시간 루프 + diff 패치가 클라이언트 상태를 정확히 재현하는지
  let snap = null;
  let seq = 0;
  let client = null;
  let bytes = 0;
  let msgs = 0;
  const room = newRoom((r) => {
    const s = JSON.parse(JSON.stringify(r.state()));
    if (!snap) {
      snap = s;
      seq = 1;
      client = JSON.parse(JSON.stringify(s));
      return;
    }
    const p = diff(snap, s);
    if (p === undefined) return;
    snap = s;
    seq++;
    const wire = JSON.stringify({ v: seq, base: seq - 1, p });
    bytes += wire.length;
    msgs++;
    applyPatch(client, JSON.parse(wire).p);
  });
  room.join('a', '갑', 's1');
  room.addBot('a');
  room.addBot('a');
  room.start('a');
  room.stopLoop();
  room.onChange(room); // 첫 스냅샷
  const g = room.game;
  for (let i = 0; i < 4 * 200; i++) room.step(); // 200초
  assert.ok(g.elapsed > 199);
  assert.deepStrictEqual(client, snap, '패치를 쌓은 결과가 마지막 브로드캐스트 상태와 같다');
  const perSec = bytes / 200;
  console.log(`✓ 실시간 루프/diff 동기화 (200초, ${msgs}건, 평균 ${perSec.toFixed(0)}B/s 미압축)`);
  assert.ok(perSec < 2500, '초당 패치가 작다');
}

{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.addBot('a');
  room.start('a');
  room.stopLoop();
  room.game.finish('테스트');
  room.step();
  assert.strictEqual(room.phase, 'ended');
  assert.ok(!room.restart('bot').ok);
  assert.ok(room.restart('a').ok);
  assert.strictEqual(room.phase, 'lobby');
  assert.ok(room.players.some((p) => p.isBot), '봇은 대기실에 남는다');
  assert.ok(!room.isEmpty());
  room.disconnect('s1');
  assert.ok(room.isEmpty(), '봇만 남으면 빈 방');
  console.log('✓ 종료/재시작/빈 방');
}

console.log('room.test.js 통과');
