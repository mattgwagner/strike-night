// Worker: serves the built client from ASSETS and routes /api/room/<code> to
// one Durable Object per room, which runs the authoritative Game.
import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { TICK_MS } from '../shared/constants';
import { Game, type Outbox } from './game';

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
}

const ROOM_RE = /^\/api\/room\/([a-z0-9-]{2,24})$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(ROOM_RE);
    if (m) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(req);
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true, v: PROTOCOL_VERSION });
    if (url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

interface Attachment { id: number }

export class Room extends DurableObject<Env> {
  private game = new Game('arcade', Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  private sockets = new Map<number, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Re-adopt sockets that survived a hibernation/eviction. Their players are
    // gone from memory, so they get told to rejoin on their first message.
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) this.sockets.set(a.id, ws);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ players: this.game.players.size, match: this.game.match, map: this.game.map.id, room: url.pathname.split('/').pop() });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return;
    let msg: ClientMsg;
    try { msg = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    const a = ws.deserializeAttachment() as Attachment | null;
    if (msg.t === 'join') {
      if (msg.v !== PROTOCOL_VERSION) { this.send(ws, { t: 'error', msg: 'update' }); try { ws.close(4001, 'update'); } catch { /* gone */ } return; }
      if (a && this.game.players.has(a.id)) this.flush(this.game.leave(a.id));
      const r = (msg.token && this.game.rejoin(msg.token, now)) || this.game.join(msg.name, msg.skin, now);
      if ('error' in r) { this.send(ws, { t: 'error', msg: r.error }); return; }
      const old = this.sockets.get(r.player.id);
      if (old && old !== ws) { try { old.close(4000, 'replaced'); } catch { /* gone */ } }
      ws.serializeAttachment({ id: r.player.id } satisfies Attachment);
      this.sockets.set(r.player.id, ws);
      this.flush(r.out);
      this.ensureTicking();
      return;
    }
    if (!a || !this.game.players.has(a.id)) { this.send(ws, { t: 'error', msg: 'rejoin' }); return; }
    this.flush(this.game.handle(a.id, msg, now));
  }

  webSocketClose(ws: WebSocket) { this.drop(ws); }
  webSocketError(ws: WebSocket) { this.drop(ws); }

  private drop(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a && this.sockets.get(a.id) === ws) {
      this.sockets.delete(a.id);
      // Keep the player for the reconnect grace; tick() calls leave() when it expires,
      // and the interval stops itself once the human roster is empty.
      this.flush(this.game.disconnect(a.id, Date.now()));
    }
    try { ws.close(1000); } catch { /* already closed */ }
  }

  private ensureTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.game.humanCount() === 0) {
        this.flush(this.game.setBots(0, Date.now()));
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        return;
      }
      this.flush(this.game.tick(Date.now()));
    }, TICK_MS);
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* gone */ }
  }

  private flush(out: Outbox) {
    for (const { to, msg } of out) {
      const data = JSON.stringify(msg);
      if (to === 'all') {
        for (const [id, ws] of this.sockets) {
          try { ws.send(data); } catch { this.sockets.delete(id); }
        }
      } else {
        const ws = this.sockets.get(to);
        if (ws) try { ws.send(data); } catch { /* gone */ }
      }
    }
  }
}
