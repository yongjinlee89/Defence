'use strict';

const { Game } = require('./game');
const { think: botThink } = require('./bot');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const BOT_NAMES = ['알파', '베타', '감마', '델타', '엡실론'];

const TICK_MS = 250; // 시뮬레이션 간격
// 몇 틱마다 화면을 갱신할지 (250ms × 4 = 1초).
// 무료 배포의 월 트래픽 한도 때문에 1초로 둔다 — 사람의 행동에는 즉시 브로드캐스트가 나가므로 체감 반응성은 그대로다.
const BROADCAST_EVERY = 4;
const BOT_THINK_MS = 1500;

const DEFAULT_SETTINGS = {
  startCash: 800,
  duration: 600,
};

const SETTING_CHOICES = {
  startCash: [500, 800, 1200, 2000],
  duration: [600, 900, 1200],
};

/**
 * 방 하나. 대기실 상태와 실시간 게임 루프를 관리한다.
 * phase: 'lobby' | 'playing' | 'ended'
 */
class Room {
  constructor(id, onChange) {
    this.id = id;
    this.onChange = onChange || (() => {});
    this.phase = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = [];
    this.hostId = null;
    this.game = null;
    this.chat = [];
    this._chatSeq = 0;
    this.updatedAt = Date.now();
    this._loop = null;
    this._ticks = 0;
    this._botClock = 0;
    // 서버가 diff 브로드캐스트에 쓰는 "마지막으로 보낸 스냅샷" (server.js 가 관리)
    this._snap = null;
    this._seq = 0;
  }

  touch() {
    this.updatedAt = Date.now();
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  /** 봇만 남은 방은 빈 방으로 본다 (그렇지 않으면 영원히 정리되지 않는다) */
  isEmpty() {
    return !this.players.some((p) => p.connected && !p.isBot);
  }

  reassignHost() {
    const next = this.players.find((p) => !p.isBot) || null;
    this.hostId = next ? next.id : null;
  }

  /* ---------------------------------------------------------------- 입장/퇴장 */

  join(playerId, name, socketId) {
    this.touch();
    const existing = this.player(playerId);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      existing.name = name || existing.name;
      this.pushLog(`${existing.name} 님이 다시 접속했습니다.`);
      return { ok: true };
    }
    if (this.phase !== 'lobby') return { ok: false, error: '이미 게임이 진행 중인 방입니다.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: `최대 ${MAX_PLAYERS}명까지 입장할 수 있습니다.` };
    if (this.players.some((p) => p.name === name)) return { ok: false, error: '같은 이름이 이미 방에 있습니다.' };
    this.players.push({ id: playerId, name, socketId, connected: true });
    if (!this.hostId) this.hostId = playerId;
    this.pushLog(`${name} 님이 입장했습니다.`);
    return { ok: true };
  }

  leave(playerId) {
    this.touch();
    const p = this.player(playerId);
    if (!p) return { ok: true };
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== playerId);
      this.pushLog(`${p.name} 님이 나갔습니다.`);
      if (this.hostId === playerId) this.reassignHost();
    } else {
      p.connected = false;
      p.socketId = null;
      this.pushLog(`${p.name} 님이 자리를 비웠습니다.`);
    }
    return { ok: true };
  }

  disconnect(socketId) {
    if (!socketId) return;
    const p = this.players.find((x) => x.socketId === socketId);
    if (!p) return;
    this.touch();
    p.socketId = null;
    p.connected = false;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== p.id);
      if (this.hostId === p.id) this.reassignHost();
      this.pushLog(`${p.name} 님이 나갔습니다.`);
    } else {
      this.pushLog(`${p.name} 님의 연결이 끊겼습니다.`);
    }
  }

  /* ---------------------------------------------------------------- 컴퓨터 */

  addBot(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 추가할 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 컴퓨터를 추가할 수 있습니다.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: `최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.` };
    const used = new Set(this.players.map((p) => p.name));
    const label = BOT_NAMES.map((n) => '컴퓨터 ' + n).find((n) => !used.has(n));
    if (!label) return { ok: false, error: '더 추가할 수 없습니다.' };
    this.players.push({ id: 'bot_' + Math.random().toString(36).slice(2, 10), name: label, socketId: null, connected: true, isBot: true });
    this.pushLog(`${label} 님이 참가했습니다.`);
    this.touch();
    return { ok: true };
  }

  removeBot(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 뺄 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 컴퓨터를 뺄 수 있습니다.' };
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].isBot) {
        const [removed] = this.players.splice(i, 1);
        this.pushLog(`${removed.name} 님이 나갔습니다.`);
        this.touch();
        return { ok: true };
      }
    }
    return { ok: false, error: '뺄 컴퓨터가 없습니다.' };
  }

  /* ---------------------------------------------------------------- 설정/시작 */

  updateSettings(playerId, patch) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 설정을 바꿀 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 설정을 바꿀 수 있습니다.' };
    for (const [key, choices] of Object.entries(SETTING_CHOICES)) {
      if (patch[key] !== undefined) {
        const v = Number(patch[key]);
        if (!choices.includes(v)) return { ok: false, error: '잘못된 설정 값입니다.' };
        this.settings[key] = v;
      }
    }
    this.touch();
    return { ok: true };
  }

  start(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '이미 시작했습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 시작할 수 있습니다.' };
    const connected = this.players.filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS) return { ok: false, error: `최소 ${MIN_PLAYERS}명이 필요합니다. (컴퓨터를 추가해도 됩니다)` };
    this.phase = 'playing';
    this.game = new Game(
      connected.map((p) => ({ id: p.id, name: p.name })),
      { ...this.settings }
    );
    this.game.pushLog(`게임 시작! 시작 자금 ${this.settings.startCash}, 제한 시간 ${Math.round(this.settings.duration / 60)}분. 공장으로 돈을 벌고, 타워와 병력으로 지키고, 이웃을 쳐서 영토를 넓히세요.`);
    this.startLoop();
    this.touch();
    return { ok: true };
  }

  resetToLobby() {
    this.stopLoop();
    this.phase = 'lobby';
    this.game = null;
    this.players = this.players.filter((p) => p.connected || p.isBot);
    if (!this.player(this.hostId)) this.reassignHost();
    this.touch();
  }

  restart(playerId) {
    if (this.phase === 'lobby') return { ok: true };
    if (this.phase !== 'ended') return { ok: false, error: '게임이 아직 진행 중입니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 다시 시작할 수 있습니다.' };
    this.resetToLobby();
    this.pushLog('대기실로 돌아왔습니다. 설정을 바꾸고 다시 시작하세요.');
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 실시간 루프 */

  startLoop() {
    this.stopLoop();
    this._ticks = 0;
    this._botClock = 0;
    this._loop = setInterval(() => this.step(), TICK_MS);
  }

  stopLoop() {
    if (this._loop) {
      clearInterval(this._loop);
      this._loop = null;
    }
  }

  clearAutoTimer() {
    this.stopLoop();
  }

  step() {
    if (this.phase !== 'playing' || !this.game) return;
    this.game.tick(TICK_MS / 1000);

    this._botClock += TICK_MS;
    if (this._botClock >= BOT_THINK_MS) {
      this._botClock = 0;
      let changed = false;
      for (const p of this.players) {
        if (!p.isBot) continue;
        try {
          if (botThink(this.game, p.id)) changed = true;
        } catch (err) {
          console.error('[bot] 판단 중 오류', err);
        }
      }
      if (changed) {
        this.onChange(this);
        return;
      }
    }

    if (this.game.ended) {
      this.phase = 'ended';
      this.stopLoop();
      this.touch();
      this.onChange(this);
      return;
    }

    this._ticks++;
    if (this._ticks % BROADCAST_EVERY === 0) this.onChange(this);
  }

  gameAction(playerId, fn) {
    if (this.phase !== 'playing' || !this.game) return { ok: false, error: '게임 중이 아닙니다.' };
    if (!this.game.player(playerId)) return { ok: false, error: '게임 참가자가 아닙니다.' };
    const result = fn(this.game);
    if (result && result.ok) this.touch();
    return result;
  }

  /* ---------------------------------------------------------------- 로그/상태 */

  pushLog(text) {
    if (this.game) this.game.pushLog(text);
    else this.pushChat('알림', text);
  }

  pushChat(name, text) {
    this.chat.push({ id: ++this._chatSeq, t: Date.now(), name, text });
    if (this.chat.length > 100) this.chat.shift();
  }

  /** 방 전체에 뿌릴 완전한 상태. 숨은 정보가 없으므로 한 번만 만들어 모두에게 같은 것을 보낸다. */
  state() {
    const base = {
      roomId: this.id,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      settingChoices: SETTING_CHOICES,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      roomPlayers: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isBot: !!p.isBot })),
      // 배열이 아니라 id 키 객체 — 창이 밀릴 때 전체 재전송을 막는다
      chat: Object.fromEntries(this.chat.slice(-60).map((e) => [e.id, e])),
    };
    if (this.game) {
      base.game = this.game.publicState();
      base.log = Object.fromEntries(this.game.log.slice(-50).map((e) => [e.id, e]));
    }
    return base;
  }
}

module.exports = { Room, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_CHOICES, TICK_MS };
