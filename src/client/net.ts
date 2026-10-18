// WebSocket client with auto-reconnect and a tiny typed event bus.
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private closed = false;
  private joinMsg: Extract<ClientMsg, { t: 'join' }> | null = null;
  rtt = 0;
  clockOffset = 0; // serverNow - performance.now()
  connected = false;
  onStatus: (s: 'connecting' | 'open' | 'closed') => void = () => {};

  constructor(public room: string) {}

  connect(name: string, skin: string) {
    this.joinMsg = { t: 'join', name, skin, v: PROTOCOL_VERSION };
    this.open();
  }

  private open() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.onStatus('connecting');
    const ws = new WebSocket(`${proto}://${location.host}/api/room/${encodeURIComponent(this.room)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.onStatus('open');
      if (this.joinMsg) this.send(this.joinMsg);
      this.ping();
    };
    ws.onmessage = ev => {
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'pong') {
        const now = performance.now();
        this.rtt = now - msg.c;
        this.clockOffset = msg.now - (now - this.rtt / 2);
      } else if (msg.t === 'error' && msg.msg === 'rejoin' && this.joinMsg) {
        this.send(this.joinMsg);
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus('closed');
      if (!this.closed) setTimeout(() => this.open(), 1500);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  private ping() {
    if (this.closed) return;
    this.send({ t: 'ping', c: performance.now(), rtt: this.rtt });
    setTimeout(() => this.ping(), 2000);
  }

  /** Server clock estimate, in server ms. */
  serverNow() { return performance.now() + this.clockOffset; }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(h: Handler) { this.handlers.push(h); }

  close() { this.closed = true; this.ws?.close(); }
}
