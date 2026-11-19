/**
 * 의자 쌓기 — 방 · 채팅 · 차례 진행.
 *
 * 물리는 서버가 돌리지 않는다. 차례인 사람의 화면이 의자를 떨어뜨려 계산하고,
 *  - 떨어지는 동안의 위치(fr)를 서버가 다른 사람들에게 그대로 넘겨 주고
 *  - 멈추면 그 사람이 탑 전체 위치(settled)를 올려 보낸다. 서버는 그걸 다음 차례의 출발점으로 저장한다.
 *  - 무너지면 그 사람이 fell 을 보내고 판이 끝난다. 무너뜨린 사람이 진다.
 * 어떤 의자가 나올지는 서버가 정한다(확장판 룰렛 결과가 모두에게 같게).
 */

const MAX_PLAYERS = 6;
const MAX_IN_ROOM = 12;           // 판 도중 들어온 구경꾼 포함
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ODDS = [['chair', 32], ['rocking', 26], ['beanbag', 22], ['highchair', 13], ['throne', 7]];
const PAL_N = 12;                 // 색 번호. 화면마다 자기 테마 색 목록에서 나머지로 고른다
const AIM_MS = 45_000;            // 놓기까지 (룰렛 포함)
const SETTLE_MS = 15_000;         // 놓은 뒤 멈춤 보고까지
const GONE_TURN_MS = 8_000;       // 차례인 사람이 끊기면 이만큼 기다렸다 넘긴다
const LOBBY_GONE_MS = 45_000;     // 대기실에서 끊긴 사람 자리 정리
const EMPTY_ROOM_MS = 3 * 60_000;

export const rooms = new Map();
const watchers = new Set();

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const rid = () => Math.random().toString(36).slice(2, 10);

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function pickType(mode) {
  if (mode !== 'ext') return 'chair';
  let r = Math.random() * 100;
  for (const [k, p] of ODDS) { r -= p; if (r < 0) return k; }
  return 'chair';
}

function createRoom(cfg) {
  const r = {
    code: newCode(), players: [], hostId: null, phase: 'lobby',
    cfg: { mode: cfg.mode === 'ext' ? 'ext' : 'basic', priv: !!cfg.priv },
    chairs: [], count: 0, order: [], turnI: -1, turn: null, seq: 0,
    loser: null, chat: [], madeAt: Date.now(), emptySince: 0, timer: null, best: 0,
  };
  rooms.set(r.code, r);
  return r;
}

function addPlayer(room, name, spec) {
  const p = { id: rid(), token: rid() + rid(), name, ws: null, on: false, spec: !!spec, goneAt: 0 };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

const active = room => room.players.filter(p => !p.spec);

function view(room) {
  return {
    t: 'room', code: room.code, host: room.hostId, phase: room.phase, cfg: room.cfg,
    players: room.players.map(p => ({ id: p.id, name: p.name, on: p.on, spec: p.spec })),
    order: room.order, turn: room.turn && { pid: room.turn.pid, type: room.turn.type, pal: room.turn.pal, seq: room.turn.seq, stage: room.turn.stage, until: room.turn.until },
    chairs: room.chairs, count: room.count, loser: room.loser, best: room.best,
  };
}

function broadcast(room, o, except) {
  const s = JSON.stringify(o);
  for (const p of room.players) if (p.ws && p.ws !== except && p.ws.readyState === 1) p.ws.send(s);
}
const sync = room => { broadcast(room, view(room)); listChanged(); };
function note(room, text) {
  const m = { t: 'chat', sys: true, text, at: Date.now() };
  room.chat.push(m); if (room.chat.length > 40) room.chat.shift();
  broadcast(room, m);
}

function attach(room, p, ws) {
  if (p.ws && p.ws !== ws) { send(p.ws, { t: 'moved' }); try { p.ws.close(4001, 'moved'); } catch (_) {} }
  p.ws = ws; p.on = true; p.goneAt = 0;
  ws.roomCode = room.code; ws.pid = p.id;
  watchers.delete(ws);
  room.emptySince = 0;
  send(ws, { t: 'welcome', you: p.id, token: p.token, code: room.code });
  send(ws, { t: 'chatlog', list: room.chat });
  sync(room);
}

/* ── 차례 ── */
function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function arm(room, ms, fn) { clearTimer(room); room.timer = setTimeout(() => { room.timer = null; fn(); }, ms); }

function startGame(room) {
  for (const p of room.players) if (p.spec && active(room).length < MAX_PLAYERS) p.spec = false;
  room.phase = 'play'; room.chairs = []; room.count = 0; room.loser = null; room.best = 0;
  room.order = active(room).map(p => p.id).sort(() => Math.random() - .5);
  room.turnI = -1;
  nextTurn(room);
}

function nextTurn(room) {
  if (room.phase !== 'play') return;
  const ids = room.order;
  let tries = 0, p = null;
  do {
    room.turnI = (room.turnI + 1) % ids.length;
    p = room.players.find(q => q.id === ids[room.turnI]);
    tries++;
  } while ((!p || !p.on) && tries <= ids.length);
  if (!p || !p.on) { room.turn = null; return; }      // 모두 끊김 — 누가 돌아오면 이어서
  room.seq++;
  room.turn = { pid: p.id, type: pickType(room.cfg.mode), pal: Math.floor(Math.random() * PAL_N), seq: room.seq, stage: 'aim', until: Date.now() + AIM_MS };
  const seq = room.seq;
  arm(room, AIM_MS, () => { if (room.turn && room.turn.seq === seq) { note(room, `${p.name} 님이 시간 안에 놓지 못해 차례가 넘어가요.`); nextTurn(room); sync(room); } });
  sync(room);
}

function skipTurn(room, why) {
  const p = room.players.find(q => q.id === room.turn?.pid);
  if (p) note(room, why === 'gone' ? `${p.name} 님 연결이 끊겨 차례를 넘겨요.` : `${p.name} 님 차례를 넘겨요.`);
  broadcast(room, { t: 'revert' });                      // 놓던 의자는 없던 일로, 저장된 탑으로 되돌린다
  nextTurn(room);
}

function endGame(room, loserId) {
  clearTimer(room);
  room.phase = 'over'; room.loser = loserId; room.turn = null;
  const p = room.players.find(q => q.id === loserId);
  if (p) note(room, `${p.name} 님이 탑을 무너뜨렸어요. 쌓은 의자 ${room.count}개.`);
  sync(room);
}

/* ── 방 목록 ── */
let listT = null;
function listChanged() {
  if (listT || !watchers.size) return;
  listT = setTimeout(() => { listT = null; const m = JSON.stringify(roomList()); for (const w of watchers) if (w.readyState === 1) w.send(m); }, 300);
}
function roomList() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.players.some(p => p.on)) continue;
    const host = r.players.find(p => p.id === r.hostId);
    const state = r.phase !== 'lobby' ? 'playing' : active(r).length >= MAX_PLAYERS ? 'full' : 'wait';
    const o = { host: host ? host.name : '', n: active(r).length, max: MAX_PLAYERS, mode: r.cfg.mode, state };
    if (r.cfg.priv) o.priv = true; else o.code = r.code;
    list.push(o);
  }
  list.sort((a, b) => (a.state === 'wait' && !a.priv ? 0 : 1) - (b.state === 'wait' && !b.priv ? 0 : 1));
  return { t: 'rooms', list: list.slice(0, 20) };
}

/* ── 메시지 ── */
function leaveRoom(room, p, why) {
  room.players = room.players.filter(q => q !== p);
  if (p.ws) { p.ws.roomCode = null; p.ws.pid = null; }
  if (room.hostId === p.id) room.hostId = (room.players.find(q => q.on && !q.spec) || room.players[0])?.id || null;
  if (room.phase === 'play') {
    room.order = room.order.filter(id => id !== p.id);
    if (room.turn?.pid === p.id) { note(room, `${p.name} 님이 나갔어요.`); room.turnI--; skipTurn(room, 'left'); }
    else note(room, `${p.name} 님이 나갔어요.`);
    if (active(room).length < 2 && room.phase === 'play') { room.phase = 'lobby'; room.turn = null; clearTimer(room); note(room, '한 명만 남아 대기실로 돌아가요.'); }
  } else if (why !== 'quiet') note(room, `${p.name} 님이 나갔어요.`);
  if (!room.players.length) { clearTimer(room); rooms.delete(room.code); listChanged(); return; }
  sync(room);
}

export function handle(ws, msg) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  const me = room ? room.players.find(p => p.id === ws.pid) : null;

  switch (msg.t) {
    case 'rooms': if (!room) { watchers.add(ws); send(ws, roomList()); } return;
    case 'unwatch': watchers.delete(ws); return;

    case 'create': {
      if (room && me) leaveRoom(room, me, 'quiet');
      const r = createRoom({ mode: msg.mode, priv: msg.priv === true });
      const p = addPlayer(r, clean(msg.name, 12) || '플레이어 1');
      note(r, `${p.name} 님이 방을 만들었어요.`);
      attach(r, p, ws);
      return;
    }
    case 'join': {
      const r = rooms.get(clean(msg.code, 6).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
      if (r.players.length >= MAX_IN_ROOM) return send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
      const spec = r.phase !== 'lobby' || active(r).length >= MAX_PLAYERS;
      if (spec && r.phase === 'lobby') return send(ws, { t: 'err', msg: '방이 가득 찼어요. (최대 6명)' });
      if (room && me && room !== r) leaveRoom(room, me, 'quiet');
      const p = addPlayer(r, clean(msg.name, 12) || `플레이어 ${r.players.length + 1}`, spec);
      note(r, spec ? `${p.name} 님이 구경하러 들어왔어요. 다음 판부터 같이 해요.` : `${p.name} 님이 들어왔어요.`);
      attach(r, p, ws);
      return;
    }
    case 'resume': {
      const r = rooms.get(clean(msg.code, 6).toUpperCase());
      const p = r && r.players.find(q => q.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '방이 사라졌어요.', fatal: true });
      attach(r, p, ws);
      if (r.phase === 'play' && !r.turn) nextTurn(r);
      return;
    }
  }

  if (!room || !me) return;
  const isHost = room.hostId === me.id;
  const myTurn = room.phase === 'play' && room.turn && room.turn.pid === me.id;

  switch (msg.t) {
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const m = { t: 'chat', from: me.id, name: me.name, text, at: Date.now() };
      room.chat.push(m); if (room.chat.length > 40) room.chat.shift();
      broadcast(room, m);
      return;
    }
    case 'mark': {   // 핑: 3번 찍으면 5초 쉰다(ping.js 와 같은 규칙). 보낸 사람 빼고 넘긴다
      const g = me.mk || (me.mk = { n: 0, last: 0, until: 0 }), now = Date.now();
      const p = Array.isArray(msg.p) ? msg.p.slice(0, 2).map(Number) : [];
      if (!['q', 'd', 'go'].includes(msg.k) || p.length !== 2 || !p.every(v => Number.isFinite(v) && Math.abs(v) < 1e5)) return;
      if (myTurn || now < g.until) return;   // 내 차례에는 못 찍는다
      if (now - g.last > 5000) g.n = 0;
      g.n++; g.last = now;
      if (g.n >= 3) { g.until = now + 5000; g.n = 0; }
      broadcast(room, { t: 'mark', k: msg.k, p, name: me.name }, ws);
      return;
    }
    case 'cfg':
      if (!isHost || room.phase !== 'lobby') return;
      if (msg.mode === 'ext' || msg.mode === 'basic') room.cfg.mode = msg.mode;
      if (typeof msg.priv === 'boolean') room.cfg.priv = msg.priv;
      sync(room); return;
    case 'kick': {
      if (!isHost || msg.id === me.id) return;
      const t = room.players.find(q => q.id === msg.id);
      if (!t) return;
      send(t.ws, { t: 'err', msg: '방장이 내보냈어요.', fatal: true });
      leaveRoom(room, t, 'kick');
      return;
    }
    case 'start':
      if (!isHost || room.phase === 'play') return;
      if (room.players.filter(p => p.on).length < 2) return send(ws, { t: 'err', msg: '2명 이상이어야 시작할 수 있어요.' });
      startGame(room); return;
    case 'again':
      if (!isHost || room.phase !== 'over') return;
      room.phase = 'lobby'; room.chairs = []; room.count = 0; room.loser = null; room.turn = null;
      for (const p of room.players) if (p.spec && active(room).length < MAX_PLAYERS) p.spec = false;
      sync(room); return;
    case 'leave':
      leaveRoom(room, me, 'leave');
      return;

    // 차례인 사람의 화면이 보내는 것들
    case 'aim':
      if (!myTurn || room.turn.stage !== 'aim') return;
      broadcast(room, { t: 'aim', x: +msg.x || 0, a: +msg.a || 0, f: msg.f === -1 ? -1 : 1 }, ws);
      return;
    case 'drop': {
      if (!myTurn || room.turn.stage !== 'aim' || msg.seq !== room.turn.seq) return;
      room.turn.stage = 'settle';
      const seq = room.turn.seq;
      broadcast(room, { t: 'drop', x: +msg.x || 0, y: +msg.y || 0, a: +msg.a || 0, f: msg.f === -1 ? -1 : 1, seq }, ws);
      arm(room, SETTLE_MS, () => { if (room.turn && room.turn.seq === seq) skipTurn(room, 'gone'); sync(room); });
      return;
    }
    case 'fr':
      if (!myTurn || room.turn.stage !== 'settle' || !Array.isArray(msg.b)) return;
      broadcast(room, { t: 'fr', b: msg.b.slice(0, 200) }, ws);
      return;
    case 'settled': {
      if (!myTurn || room.turn.stage !== 'settle' || msg.seq !== room.turn.seq || !Array.isArray(msg.chairs)) return;
      room.chairs = msg.chairs.slice(0, 200).map(c => ({ k: String(c.k), p: c.p | 0, f: c.f === -1 ? -1 : 1, x: +c.x, y: +c.y, a: +c.a }));
      room.count++;
      room.best = Math.max(room.best, +msg.h || 0);
      nextTurn(room);
      return;
    }
    case 'fell':
      if (!myTurn || msg.seq !== room.turn.seq) return;
      broadcast(room, { t: 'fr', b: Array.isArray(msg.b) ? msg.b.slice(0, 200) : [] }, ws);
      endGame(room, me.id);
      return;
  }
}

export function disconnect(ws) {
  watchers.delete(ws);
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const p = room.players.find(q => q.id === ws.pid);
  if (!p || p.ws !== ws) return;
  p.on = false; p.goneAt = Date.now();
  if (room.phase === 'play' && room.turn?.pid === p.id) {
    const seq = room.turn.seq;
    arm(room, GONE_TURN_MS, () => { if (room.turn && room.turn.seq === seq && !p.on) { skipTurn(room, 'gone'); sync(room); } });
  }
  if (room.hostId === p.id) {
    const h = room.players.find(q => q.on && !q.spec) || room.players.find(q => q.on);
    if (h) room.hostId = h.id;
  }
  sync(room);
}

/** 오래 끊긴 대기실 자리 · 빈 방 정리 */
export function sweep(now) {
  for (const r of [...rooms.values()]) {
    if (r.phase === 'lobby') for (const p of [...r.players]) if (!p.on && now - p.goneAt > LOBBY_GONE_MS) leaveRoom(r, p, 'quiet');
    if (!rooms.has(r.code)) continue;
    if (r.players.some(p => p.on)) { r.emptySince = 0; continue; }
    if (!r.emptySince) r.emptySince = now;
    else if (now - r.emptySince > EMPTY_ROOM_MS) { clearTimer(r); rooms.delete(r.code); listChanged(); }
  }
}
