'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('./src/room');
const { diff } = require('./src/diff');

const PORT = process.env.PORT || Number(process.argv[2]) || 7863;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // 웹소켓 전용 — HTTP 롱폴링 폴백은 메시지마다 HTTP 헤더가 붙어 트래픽이 몇 배로 나간다.
  transports: ['websocket'],
  pingInterval: 10000,
  pingTimeout: 10000,
  cors: { origin: '*' },
  // 상태 JSON 은 키가 반복돼 압축이 아주 잘 된다
  perMessageDeflate: { threshold: 256 },
});

app.use(compression());
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);
app.get('/healthz', (_req, res) => {
  let playing = 0;
  let humans = 0;
  for (const room of rooms.values()) {
    if (room.phase === 'playing') playing++;
    humans += room.players.filter((p) => p.connected && !p.isBot).length;
  }
  res.json({ ok: true, rooms: rooms.size, playing, humans, sockets: io.engine.clientsCount });
});

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socket.id -> {roomId, playerId} */
const sessions = new Map();

/**
 * 방 전체에 "바뀐 부분만" 보낸다 — 트래픽 절감의 핵심.
 *   { v, f }        — 전체 상태 (입장·재동기화 때만)
 *   { v, base, p }  — base 버전에서 v 버전으로 가는 패치
 * 클라이언트는 자기 버전이 base 와 다르면 'resync' 를 요청한다.
 */
function snapshotOf(room) {
  return JSON.parse(JSON.stringify(room.state()));
}

function broadcast(room) {
  const snap = snapshotOf(room);
  if (!room._snap) {
    room._snap = snap;
    room._seq = 1;
    io.to(room.id).emit('state', { v: 1, f: snap });
    return;
  }
  const patch = diff(room._snap, snap);
  if (patch === undefined) return;
  const base = room._seq;
  room._seq = base + 1;
  room._snap = snap;
  io.to(room.id).emit('state', { v: room._seq, base, p: patch });
}

function sendFull(socket, room) {
  if (!room._snap) {
    room._snap = snapshotOf(room);
    room._seq = 1;
  }
  socket.emit('state', { v: room._seq, f: room._snap });
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, (r) => broadcast(r));
    rooms.set(roomId, room);
  }
  return room;
}

function normalizeRoomId(raw) {
  const id = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 24);
  return id || 'lobby';
}

function sanitizeName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16);
  return name || '이름없음';
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (payload = {}, ack) => {
    const roomId = normalizeRoomId(payload.roomId);
    const playerId = String(payload.playerId || '').slice(0, 64);
    const name = sanitizeName(payload.name);
    if (!playerId) {
      if (ack) ack({ ok: false, error: '잘못된 접속 정보입니다.' });
      return;
    }
    const prev = sessions.get(socket.id);
    if (prev && prev.roomId !== roomId) {
      const prevRoom = rooms.get(prev.roomId);
      if (prevRoom) prevRoom.disconnect(socket.id);
      socket.leave(prev.roomId);
    }
    const room = getRoom(roomId);
    const result = room.join(playerId, name, socket.id);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }
    sessions.set(socket.id, { roomId, playerId });
    socket.join(roomId);
    if (ack) ack({ ok: true, roomId });
    // 순서 중요: 새 사람에게 직전 스냅샷을 먼저 주고, 그 위에 얹을 패치를 방 전체에 뿌린다
    sendFull(socket, room);
    broadcast(room);
  });

  socket.on('resync', () => {
    const s = sessions.get(socket.id);
    if (!s) return;
    const room = rooms.get(s.roomId);
    if (room) sendFull(socket, room);
  });

  // 백그라운드 탭 절전 — 방송 채널에서 빠지고, 30분 넘게 안 돌아오면 연결을 끊는다
  socket.on('bg', () => {
    const s = sessions.get(socket.id);
    if (!s) return;
    socket.leave(s.roomId);
    clearTimeout(socket._bgTimer);
    socket._bgTimer = setTimeout(() => socket.disconnect(true), 30 * 60 * 1000);
  });

  socket.on('fg', () => {
    clearTimeout(socket._bgTimer);
    const s = sessions.get(socket.id);
    if (!s) return;
    const room = rooms.get(s.roomId);
    if (!room) return;
    socket.join(s.roomId);
    sendFull(socket, room);
  });

  function withRoom(handler) {
    return (payload, ack) => {
      const s = sessions.get(socket.id);
      if (!s) {
        if (ack) ack({ ok: false, error: '방에 접속해 있지 않습니다.' });
        return;
      }
      const room = rooms.get(s.roomId);
      if (!room) {
        if (ack) ack({ ok: false, error: '방을 찾을 수 없습니다.' });
        return;
      }
      let result;
      try {
        result = handler(room, s.playerId, payload || {}) || { ok: true };
      } catch (err) {
        console.error('[action]', err);
        result = { ok: false, error: '처리 중 오류가 났습니다.' };
      }
      if (ack) ack(result);
      if (result.ok) broadcast(room);
    };
  }

  /* ------------------------------------------------------------ 로비 */
  socket.on('updateSettings', withRoom((room, pid, p) => room.updateSettings(pid, p)));
  socket.on('addBot', withRoom((room, pid) => room.addBot(pid)));
  socket.on('removeBot', withRoom((room, pid) => room.removeBot(pid)));
  socket.on('startGame', withRoom((room, pid) => room.start(pid)));
  socket.on('restart', withRoom((room, pid) => room.restart(pid)));

  /* ------------------------------------------------------------ 게임 행동 */
  socket.on('build', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.build(pid, p.idx, p.kind))));
  socket.on('upgrade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.upgrade(pid, p.idx, p.slot))));
  socket.on('demolish', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.demolish(pid, p.idx, p.slot))));
  socket.on('train', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.train(pid, p.idx, p.unit, p.qty))));
  socket.on('move', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.move(pid, p.from, p.to, p.units))));
  socket.on('attack', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.attack(pid, p.from, p.to, p.units))));
  socket.on('retreat', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.retreat(pid, p.idx))));
  socket.on('trade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.trade(pid, p))));
  socket.on('setAutoSell', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setAutoSell(pid, p.mat, p.on))));

  /* ------------------------------------------------------------ 기타 */
  socket.on('leaveRoom', withRoom((room, pid) => {
    room.leave(pid);
    socket.leave(room.id);
    sessions.delete(socket.id);
    return { ok: true };
  }));

  socket.on('chat', withRoom((room, pid, payload) => {
    const text = String(payload.text || '').trim().slice(0, 200);
    if (!text) return { ok: true };
    const p = room.player(pid);
    room.pushChat(p ? p.name : '?', text);
    return { ok: true };
  }));

  socket.on('disconnect', () => {
    clearTimeout(socket._bgTimer);
    const s = sessions.get(socket.id);
    if (!s) return;
    sessions.delete(socket.id);
    const room = rooms.get(s.roomId);
    if (!room) return;
    room.disconnect(socket.id);
    broadcast(room);
  });
});

// 사람이 아무도 없는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.isEmpty()) continue;
    const idle = now - room.updatedAt;
    if (idle > 5 * 60 * 1000) {
      room.clearAutoTimer();
      rooms.delete(id);
    } else if (idle > 2 * 60 * 1000 && room.phase !== 'lobby') {
      room.resetToLobby();
    }
  }
}, 30 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`디펜스 서버 실행 중: http://0.0.0.0:${PORT} (${MIN_PLAYERS}~${MAX_PLAYERS}인)`);
});
