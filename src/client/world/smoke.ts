// Smoke clouds: ~40 soft grey billboards per cloud that swirl slowly, fill in
// over the first second and fade over the last two. Dense enough that you
// cannot see through the middle, and a grey screen veil when you are inside.
import * as THREE from 'three';
import { SMOKE, type SmokeVolume } from '../../shared/projectiles';
import type { Vec3 } from '../../shared/protocol';

const PUFFS = 40;
const FILL_MS = 1000, FADE_MS = 2000;

let puffTex: THREE.Texture | null = null;
function puffTexture(): THREE.Texture {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  // a few overlapping blobs so the edge is lumpy, not a perfect disc
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2, rr = i ? 22 : 0;
    const x = 64 + Math.cos(a) * rr, y = 64 + Math.sin(a) * rr;
    const grad = g.createRadialGradient(x, y, 0, x, y, i ? 40 : 60);
    grad.addColorStop(0, 'rgba(255,255,255,0.75)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  puffTex = new THREE.CanvasTexture(c);
  puffTex.colorSpace = THREE.SRGBColorSpace;
  return puffTex;
}

interface Puff { s: THREE.Sprite; r: number; a: number; y: number; w: number; size: number; spin: number }

class Cloud {
  group = new THREE.Group();
  puffs: Puff[] = [];
  mats: THREE.SpriteMaterial[] = [];
  constructor(public id: number, public p: Vec3, public until: number, public born: number) {
    const tex = puffTexture();
    for (let i = 0; i < PUFFS; i++) {
      // fill the sphere evenly-ish: a dense core, and a shell near the rim
      const shell = i < PUFFS * 0.55;
      const r = (shell ? 0.55 + Math.random() * 0.35 : Math.random() * 0.55) * SMOKE.radius;
      const a = Math.random() * Math.PI * 2;
      const y = (Math.random() * 0.9 - 0.15) * SMOKE.radius * 0.8;
      const shade = 0.5 + Math.random() * 0.16;
      const m = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(shade, shade, shade * 1.03), transparent: true, depthWrite: false, opacity: 0, fog: true });
      m.rotation = Math.random() * Math.PI * 2;
      const s = new THREE.Sprite(m);
      const size = SMOKE.radius * (0.9 + Math.random() * 0.7);
      this.puffs.push({ s, r, a, y, w: (0.08 + Math.random() * 0.12) * (Math.random() < 0.5 ? -1 : 1), size, spin: (Math.random() - 0.5) * 0.3 });
      this.mats.push(m);
      this.group.add(s);
    }
    this.group.position.set(p[0], p[1], p[2]);
  }
  dispose() { for (const m of this.mats) m.dispose(); }
}

export class SmokeField {
  private clouds = new Map<number, Cloud>();
  private veil: THREE.Mesh;
  private veilMat: THREE.MeshBasicMaterial;

  constructor(private scene: THREE.Scene, camera: THREE.Camera) {
    this.veilMat = new THREE.MeshBasicMaterial({ color: 0x9a9a9e, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.veil = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.veilMat);
    this.veil.position.set(0, 0, -0.2);
    this.veil.renderOrder = 999;
    this.veil.visible = false;
    camera.add(this.veil);
  }

  /** A cloud from the server. `until` and `now` are server ms. */
  add(id: number, p: Vec3, until: number, now: number) {
    if (this.clouds.has(id)) return;
    const c = new Cloud(id, p, until, now);
    this.clouds.set(id, c);
    this.scene.add(c.group);
  }

  get count() { return this.clouds.size; }

  /** Active clouds as the shared smoke volumes (client-side smokeBlocks checks). */
  volumes(): SmokeVolume[] {
    const out: SmokeVolume[] = [];
    for (const c of this.clouds.values()) out.push({ id: c.id, p: c.p, until: c.until });
    return out;
  }

  /** Opacity 0..1 of a cloud at server time `now`. */
  private alpha(c: Cloud, now: number) {
    const fill = Math.min(1, Math.max(0, (now - c.born) / FILL_MS));
    const fade = Math.min(1, Math.max(0, (c.until - now) / FADE_MS));
    return Math.min(fill * (2 - fill), fade);
  }

  update(dt: number, now: number, eye: THREE.Vector3) {
    let inside = 0;
    for (const [id, c] of this.clouds) {
      if (now >= c.until) { this.scene.remove(c.group); c.dispose(); this.clouds.delete(id); continue; }
      const k = this.alpha(c, now);
      const grow = 0.55 + 0.45 * Math.min(1, (now - c.born) / FILL_MS);
      for (const pf of c.puffs) {
        pf.a += pf.w * dt;
        const rr = pf.r * grow;
        pf.s.position.set(Math.cos(pf.a) * rr, Math.max(0.2, pf.y * grow + SMOKE.radius * 0.35 * grow), Math.sin(pf.a) * rr);
        pf.s.scale.setScalar(pf.size * grow);
        const m = pf.s.material as THREE.SpriteMaterial;
        m.rotation += pf.spin * dt;
        m.opacity = Math.min(1, 1.05 * k);
      }
      const d = eye.distanceTo(c.group.position);
      if (d < SMOKE.radius) inside = Math.max(inside, k * Math.min(1, (SMOKE.radius - d) / 1.5));
    }
    this.veil.visible = inside > 0.01;
    this.veilMat.opacity = 0.93 * inside;
  }

  clear() { for (const c of this.clouds.values()) { this.scene.remove(c.group); c.dispose(); } this.clouds.clear(); }
}
