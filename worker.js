/**
 * 의자 쌓기 — Cloudflare Workers 무료 플랜용 서버.
 *  - 화면(index.html)은 정적 자산으로 나간다.
 *  - /ws 소켓만 Durable Object 하나(main)로 보낸다. 방은 전부 그 안에 산다(room.js).
 *  - 소켓이 하나라도 있으면 객체가 깨어 있으므로, 2분 반 넘게 소식 없는 소켓과
 *    20분 동안 아무것도 안 한 소켓은 닫는다. 화면은 다시 누르면 이어 붙는다.
 */
import { DurableObject } from 'cloudflare:workers';
import * as game from './room.js';

const ALIVE_MS = 150_000;
const IDLE_MS = 20 * 60_000;
const SWEEP_MS = 10_000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname === '/healthz') {
      return env.GAME.get(env.GAME.idFromName('main')).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

class Sock {
  constructor(ws) { this.ws = ws; this.open = true; this.seen = this.acted = Date.now(); }
  get readyState() { return this.open ? 1 : 3; }
  send(text) { if (!this.open) return; try { this.ws.send(text); } catch (_) { this.open = false; } }
  close(code = 1000, reason = '') { if (!this.open) return; this.open = false; try { this.ws.close(code, reason); } catch (_) {} }
}

export class ChairGame extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.socks = new Set();
    this.timer = null;
  }

  async fetch(req) {
    if (new URL(req.url).pathname === '/healthz') {
      return Response.json({ ok: true, rooms: game.rooms.size, sockets: this.socks.size });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const s = new Sock(server);
    this.socks.add(s);
    server.addEventListener('message', e => {
      s.seen = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') return;
      if (msg.t !== 'fr' && msg.t !== 'aim') s.acted = s.seen;
      try { game.handle(s, msg); } catch (err) { console.error('handle error', err); }
    });
    const gone = () => { if (!this.socks.delete(s)) return; s.open = false; game.disconnect(s); this.tick(); };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    this.tick();
    return new Response(null, { status: 101, webSocket: client });
  }

  tick() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      for (const s of [...this.socks]) {
        if (now - s.seen > ALIVE_MS) this.drop(s, 1001, 'gone');
        else if (now - s.acted > IDLE_MS) { s.send(JSON.stringify({ t: 'idle' })); this.drop(s, 4000, 'idle'); }
      }
      game.sweep(now);
      if (this.socks.size || game.rooms.size) this.tick();
    }, SWEEP_MS);
  }

  drop(s, code, reason) { this.socks.delete(s); s.close(code, reason); game.disconnect(s); }
}
