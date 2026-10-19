// Client grenades: G throws paint, F throws smoke (hold up to 1 s for power).
// Draws the dotted preview arc from the shared sim, interpolates in-flight
// grenades from the server's 'proj' stream, and plays the paint burst and
// smoke cloud when they resolve. Wired from game.ts with one constructor call
// and one update() per frame; it listens to the net and keyboard itself.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/constants';
import type { MapBox } from '../../shared/map';
import { bulletBoxes, forward, rayBox, solidBoxes } from '../../shared/physics';
import {
  GRENADE, GRENADES_PER_LIFE, PAINT, SMOKE, simulateArc, type GrenadeKind,
} from '../../shared/projectiles';
import type { ServerMsg, Vec3 } from '../../shared/protocol';
import { MAPS } from '../../shared/map';
import { SmokeField } from '../world/smoke';
import type { Game } from '../game';

const INTERP_MS = 100;
const KEYS: Record<string, GrenadeKind> = { KeyG: 'paint', KeyF: 'smoke' };
const SMOKE_GREY = 0x8d8f94;
const MAX_SPLATS = 64, SPLAT_LIFE = 25, SPLAT_FADE = 4;
const PREVIEW_PTS = 160;

interface Sample { t: number; p: Vec3; v: Vec3 }
interface InFlight { id: number; kind: GrenadeKind; owner: number; mesh: THREE.Mesh; buf: Sample[] }

let splatTex: THREE.Texture | null = null;
function splatTexture(): THREE.Texture {
  if (splatTex) return splatTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(64, 64, 34, 0, Math.PI * 2); g.fill();
  // droplets and drips
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, d = 34 + Math.random() * 24, r = 3 + Math.random() * 8;
    g.beginPath(); g.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r, 0, Math.PI * 2); g.fill();
    g.lineWidth = r * 0.9; g.strokeStyle = '#fff';
    g.beginPath(); g.moveTo(64 + Math.cos(a) * 20, 64 + Math.sin(a) * 20); g.lineTo(64 + Math.cos(a) * d, 64 + Math.sin(a) * d); g.stroke();
  }
  splatTex = new THREE.CanvasTexture(c);
  splatTex.colorSpace = THREE.SRGBColorSpace;
  return splatTex;
}

export class Grenades {
  /** What you have left this life (the server enforces the same). */
  left: Record<GrenadeKind, number> = { ...GRENADES_PER_LIFE };
  smoke: SmokeField;
  private flying = new Map<number, InFlight>();
  private solids: MapBox[];
  private bullets: MapBox[];
  private half: number;
  private holding: { kind: GrenadeKind; t0: number } | null = null;
  private preview: THREE.Points;
  private previewGeo: THREE.BufferGeometry;
  private landMark: THREE.Mesh;
  private ballGeo = new THREE.SphereGeometry(GRENADE.radius * 1.15, 12, 8);
  private bursts: Array<{ mesh: THREE.Mesh; age: number }> = [];
  private splats: Array<{ mesh: THREE.Mesh; age: number }> = [];
  private splatNext = 0;
  private myColor: string;
  private shown = '';

  constructor(private game: Game, mySkin: string) {
    const map = MAPS.arcade; // same map Game builds
    this.solids = solidBoxes(map.boxes);
    this.bullets = bulletBoxes(map.boxes);
    this.half = map.half;
    this.myColor = (CHARACTERS.find(c => c.id === mySkin) ?? CHARACTERS[0]).color;
    this.smoke = new SmokeField(game.scene, game.camera);

    // dotted preview arc
    this.previewGeo = new THREE.BufferGeometry();
    this.previewGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREVIEW_PTS * 3), 3));
    this.previewGeo.setDrawRange(0, 0);
    this.preview = new THREE.Points(this.previewGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false }));
    this.preview.frustumCulled = false;
    this.preview.visible = false;
    game.scene.add(this.preview);
    this.landMark = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.32, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    this.landMark.rotation.x = -Math.PI / 2;
    this.landMark.visible = false;
    game.scene.add(this.landMark);

    // burst spheres (pooled)
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0 }));
      m.visible = false;
      game.scene.add(m);
      this.bursts.push({ mesh: m, age: 99 });
    }
    // splat decals (pooled)
    const sg = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_SPLATS; i++) {
      const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: splatTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.visible = false;
      game.scene.add(m);
      this.splats.push({ mesh: m, age: 99 });
    }

    game.net.on(m => this.onMsg(m));
    window.addEventListener('keydown', e => { if (!e.repeat && KEYS[e.code]) this.press(KEYS[e.code]); });
    window.addEventListener('keyup', e => { if (KEYS[e.code] && this.holding?.kind === KEYS[e.code]) this.release(); });
    window.addEventListener('blur', () => this.cancel());
    this.pushHud();
  }

  private canAct() { const g = this.game; return g.input.locked && !g.hud.chatOpen && g.me.alive && g.myId >= 0; }

  press(kind: GrenadeKind) {
    if (!this.canAct() || this.left[kind] <= 0 || this.holding) return;
    this.holding = { kind, t0: performance.now() };
  }

  /** Throw what you are holding with power from the hold time. */
  release() {
    const h = this.holding;
    this.holding = null;
    this.preview.visible = false; this.landMark.visible = false;
    if (!h || !this.canAct() || this.left[h.kind] <= 0) return;
    const power = this.power(h.t0);
    const g = this.game;
    this.left[h.kind]--;
    this.pushHud();
    g.net.send({ t: 'throw', kind: h.kind, o: g.me.eye(), d: forward(g.me.yaw, g.me.pitch), power });
  }

  cancel() { this.holding = null; this.preview.visible = false; this.landMark.visible = false; }

  private power(t0: number) { return Math.min(1, (performance.now() - t0) / GRENADE.holdMs); }

  private pushHud() {
    const key = `${this.left.paint}/${this.left.smoke}`;
    if (key === this.shown) return;
    this.shown = key;
    this.game.hud.setGrenades(this.left.paint, this.left.smoke);
  }

  private colorOf(owner: number, kind: GrenadeKind): THREE.ColorRepresentation {
    if (kind === 'smoke') return SMOKE_GREY;
    if (owner === this.game.myId) return this.myColor;
    return this.game.remotes.get(owner)?.color ?? '#ff3bd5';
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'welcome': this.left = { ...GRENADES_PER_LIFE }; this.pushHud(); break;
      case 'spawn': if (m.id === this.game.myId) { this.left = { ...GRENADES_PER_LIFE }; this.cancel(); this.pushHud(); } break;
      case 'proj': {
        let f = this.flying.get(m.id);
        if (!f) {
          const mesh = new THREE.Mesh(this.ballGeo, new THREE.MeshStandardMaterial({ color: this.colorOf(m.owner, m.kind), roughness: 0.4, emissive: new THREE.Color(this.colorOf(m.owner, m.kind)).multiplyScalar(0.35) }));
          mesh.position.set(m.p[0], m.p[1], m.p[2]);
          this.game.scene.add(mesh);
          f = { id: m.id, kind: m.kind, owner: m.owner, mesh, buf: [] };
          this.flying.set(m.id, f);
        }
        f.buf.push({ t: m.now ?? this.game.net.serverNow(), p: m.p, v: m.v });
        if (f.buf.length > 12) f.buf.shift();
        break;
      }
      case 'burst': this.drop(m.id); this.burst(m.p, this.colorOf(m.owner, 'paint')); break;
      case 'smoke': this.drop(m.id); this.smoke.add(m.id, m.p, m.until, this.game.net.serverNow()); break;
    }
  }

  private drop(id: number) {
    const f = this.flying.get(id);
    if (!f) return;
    this.game.scene.remove(f.mesh);
    (f.mesh.material as THREE.Material).dispose();
    this.flying.delete(id);
  }

  /** Paint burst: an expanding sphere in the thrower's colour plus splats on nearby surfaces. */
  burst(p: Vec3, color: THREE.ColorRepresentation) {
    const b = this.bursts.find(x => x.age > 0.6) ?? this.bursts[0];
    b.age = 0;
    b.mesh.position.set(p[0], p[1] + 0.2, p[2]);
    (b.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    b.mesh.visible = true;
    const fx = this.game.fx;
    fx.puff([p[0], p[1] + 0.3, p[2]], color, true);
    fx.puff([p[0], p[1] + 0.8, p[2]], color, true);
    fx.light([p[0], p[1] + 0.5, p[2]], 8);
    // splats: rays out in a rough sphere, biased downward and outward
    const n = 22;
    const o: Vec3 = [p[0], p[1] + 0.25, p[2]];
    for (let i = 0; i < n; i++) {
      const y = 1 - (i + 0.5) / n * 1.6;           // more rays below the horizon
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = i * 2.39996 + Math.random() * 0.4;  // golden angle
      const d: Vec3 = [Math.cos(a) * r, y, Math.sin(a) * r];
      const hit = this.rayFace(o, d, PAINT.radius);
      if (!hit || Math.random() < 0.25) continue;
      const near = 1 - hit.t / PAINT.radius;
      this.splat(hit.p, hit.n, 0.7 + near * 1.3 + Math.random() * 0.4, color);
    }
  }

  /** Nearest bullet-blocking face along a ray, with its normal. */
  private rayFace(o: Vec3, d: Vec3, maxDist: number): { t: number; p: Vec3; n: Vec3 } | null {
    let best = maxDist, box: MapBox | null = null;
    for (const b of this.bullets) {
      const t = rayBox(o, d, b.min, b.max, best);
      if (t !== null && t > 0 && t < best) { best = t; box = b; }
    }
    if (!box) return null;
    const p: Vec3 = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
    let n: Vec3 = [0, 1, 0], bd = Infinity;
    for (let i = 0; i < 3; i++) {
      for (const [v, s] of [[box.min[i], -1], [box.max[i], 1]] as const) {
        const e = Math.abs(p[i] - v);
        if (e < bd) { bd = e; n = [0, 0, 0]; n[i] = s; }
      }
    }
    return { t: best, p, n };
  }

  private splat(p: Vec3, n: Vec3, size: number, color: THREE.ColorRepresentation) {
    const s = this.splats[this.splatNext]; this.splatNext = (this.splatNext + 1) % MAX_SPLATS;
    s.age = 0;
    const m = s.mesh;
    m.position.set(p[0] + n[0] * 0.01, p[1] + n[1] * 0.01, p[2] + n[2] * 0.01);
    m.lookAt(p[0] + n[0], p[1] + n[1], p[2] + n[2]);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.color.set(color); mat.opacity = 0.95;
    m.visible = true;
  }

  /** Per frame, from Game.frame. */
  update(dt: number) {
    const g = this.game;
    const serverNow = g.net.serverNow();
    // preview arc while a key is held
    if (this.holding && !this.canAct()) this.cancel();
    if (this.holding) {
      const kind = this.holding.kind;
      const arc = simulateArc(g.me.eye(), forward(g.me.yaw, g.me.pitch), this.power(this.holding.t0), this.solids, kind, kind === 'paint' ? PAINT.fuseMs : SMOKE.fuseMs, this.half);
      const pos = this.previewGeo.getAttribute('position') as THREE.BufferAttribute;
      let k = 0;
      // skip the first metre (dots in your face are huge) and add midpoints for a denser dotted line
      const eye = arc.points[0];
      const far = (q: number[]) => Math.hypot(q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]) > 1.2;
      for (let i = 1; i < arc.points.length && k < PREVIEW_PTS - 1; i++) {
        const a = arc.points[i - 1], b = arc.points[i];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        if (far(mid)) pos.setXYZ(k++, mid[0], mid[1], mid[2]);
        if (far(b)) pos.setXYZ(k++, b[0], b[1], b[2]);
      }
      pos.needsUpdate = true;
      this.previewGeo.setDrawRange(0, k);
      (this.preview.material as THREE.PointsMaterial).color.set(kind === 'paint' ? this.myColor : 0xdddddd);
      this.preview.visible = true;
      const e = arc.end;
      this.landMark.position.set(e[0], e[1] - GRENADE.radius + 0.03, e[2]);
      this.landMark.visible = true;
    }
    // in-flight grenades, interpolated like remote players
    const renderT = serverNow - INTERP_MS;
    for (const f of this.flying.values()) {
      const buf = f.buf;
      let pos: Vec3 = buf[0].p;
      if (renderT >= buf[buf.length - 1].t) {
        const last = buf[buf.length - 1];
        const ex = Math.min(0.15, (renderT - last.t) / 1000);
        pos = [last.p[0] + last.v[0] * ex, last.p[1] + last.v[1] * ex - 0.5 * GRENADE.gravity * ex * ex, last.p[2] + last.v[2] * ex];
      } else {
        for (let i = buf.length - 1; i > 0; i--) {
          if (buf[i - 1].t <= renderT) {
            const a = buf[i - 1], b = buf[i];
            const k = (renderT - a.t) / Math.max(1, b.t - a.t);
            pos = [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k];
            break;
          }
        }
      }
      f.mesh.position.set(pos[0], pos[1], pos[2]);
      f.mesh.rotation.x += dt * 9; f.mesh.rotation.z += dt * 5;
    }
    // burst spheres
    for (const b of this.bursts) {
      if (!b.mesh.visible) continue;
      b.age += dt;
      const k = Math.min(1, b.age / 0.45);
      b.mesh.scale.setScalar(0.3 + (PAINT.radius * 0.75) * (1 - (1 - k) * (1 - k)));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - k);
      if (k >= 1) b.mesh.visible = false;
    }
    for (const s of this.splats) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      if (s.age > SPLAT_LIFE - SPLAT_FADE) (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * Math.max(0, (SPLAT_LIFE - s.age) / SPLAT_FADE);
      if (s.age > SPLAT_LIFE) s.mesh.visible = false;
    }
    this.smoke.update(dt, serverNow, g.camera.getWorldPosition(this.tmp));
    this.pushHud();
  }
  private tmp = new THREE.Vector3();
}
