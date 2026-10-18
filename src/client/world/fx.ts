// Pooled combat effects: muzzle flashes, tracers, impact sparks, hit puffs,
// bullet decals and shell casings. Everything is allocated once in the
// constructor; spawning an effect only writes into typed arrays.
import * as THREE from 'three';
import type { MapBox } from '../../shared/map';

type V3 = [number, number, number] | THREE.Vector3;
const vx = (v: V3) => (Array.isArray(v) ? v[0] : v.x);
const vy = (v: V3) => (Array.isArray(v) ? v[1] : v.y);
const vz = (v: V3) => (Array.isArray(v) ? v[2] : v.z);

let flashTex: THREE.Texture | null = null;
/** Shared star-burst texture for muzzle flashes (also used by the viewmodel). */
export function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.25, 'rgba(255,220,120,0.95)');
  grad.addColorStop(0.6, 'rgba(255,140,30,0.35)');
  grad.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, r = i % 2 ? 13 : 32;
    g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  flashTex = new THREE.CanvasTexture(c);
  flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}

// ----- point particles (sparks, puffs) --------------------------------------

const PARTICLE_VS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor; varying float vAlpha;
void main() {
  vColor = aColor; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vAlpha <= 0.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * smoothstep(1.0, 0.45, d));
}`;

class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array; private vel: Float32Array; private col: Float32Array;
  private size: Float32Array; private alpha: Float32Array;
  private life: Float32Array; private max: Float32Array; private size0: Float32Array; private grow: Float32Array;
  private next = 0; private live = 0;
  private geo = new THREE.BufferGeometry();
  readonly mat: THREE.ShaderMaterial;

  constructor(private n: number, additive: boolean, private gravity: number, private drag: number) {
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.alpha = new Float32Array(n);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.size0 = new Float32Array(n); this.grow = new Float32Array(n);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, uniforms: { uScale: { value: 500 } },
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, grow = 0) {
    const i = this.next; this.next = (this.next + 1) % this.n;
    const k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.col[k] = color.r; this.col[k + 1] = color.g; this.col[k + 2] = color.b;
    this.size0[i] = size; this.size[i] = size; this.grow[i] = grow;
    this.life[i] = life; this.max[i] = life; this.alpha[i] = 1;
    this.live = this.n; // cheap: keep updating until everything has died
  }

  update(dt: number) {
    if (!this.live) return;
    let alive = 0;
    const damp = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.size[i] = 0; } continue; }
      alive++;
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k] *= damp; this.vel[k + 1] = this.vel[k + 1] * damp - this.gravity * dt; this.vel[k + 2] *= damp;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      const f = Math.max(0, this.life[i] / this.max[i]);
      this.alpha[i] = f;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * (1 - f));
    }
    this.live = alive;
    for (const name of ['position', 'aAlpha', 'aSize', 'aColor']) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// ----- decals ---------------------------------------------------------------

const DECAL_VS = `
attribute float aAlpha; varying float vAlpha; varying vec2 vUv;
void main() { vAlpha = aAlpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DECAL_FS = `
varying float vAlpha; varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = vAlpha * (smoothstep(1.0, 0.6, d) * 0.45 + smoothstep(0.42, 0.3, d) * 0.5);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(0.03, 0.03, 0.04, a);
}`;

const MAX_DECALS = 64;
const DECAL_HOLD = 6, DECAL_FADE = 2;

// ----- the system -------------------------------------------------------------

const TRACERS = 48;
const FLASH_SPRITES = 8;
const CASINGS = 32;

export class Fx {
  private group = new THREE.Group();
  private sparks = new Particles(384, true, 9, 2.5);
  private puffs = new Particles(192, false, -0.4, 3.5);
  // tracers
  private trPos = new Float32Array(TRACERS * 6);
  private trCol = new Float32Array(TRACERS * 6);
  private trBase = new Float32Array(TRACERS * 3);
  private trLife = new Float32Array(TRACERS);
  private trFresh = new Uint8Array(TRACERS);
  private trGeo = new THREE.BufferGeometry();
  private trMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  private trNext = 0; private trLive = false;
  // decals
  private dcPos = new Float32Array(MAX_DECALS * 12);
  private dcAlpha = new Float32Array(MAX_DECALS * 4);
  private dcAge = new Float32Array(MAX_DECALS).fill(1e9);
  private dcGeo = new THREE.BufferGeometry();
  private dcMat = new THREE.ShaderMaterial({ vertexShader: DECAL_VS, fragmentShader: DECAL_FS, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  private dcNext = 0;
  // muzzle flash sprites + lights
  private sprites: Array<{ s: THREE.Sprite; life: number; max: number; fresh: boolean }> = [];
  private lights: Array<{ l: THREE.PointLight; life: number; max: number; peak: number; fresh: boolean }> = [];
  private lightNext = 0;
  // casings
  private csMesh: THREE.InstancedMesh;
  private cs = Array.from({ length: CASINGS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), spin: new THREE.Vector3(), floor: 0, life: 0, bounced: false }));
  private csNext = 0; private csLive = false;
  // scratch
  private tmpC = new THREE.Color();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(private scene: THREE.Scene, private boxes: MapBox[]) {
    this.group.add(this.sparks.points, this.puffs.points);
    // tracers
    this.trGeo.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.trGeo.setAttribute('color', new THREE.BufferAttribute(this.trCol, 3).setUsage(THREE.DynamicDrawUsage));
    const tr = new THREE.LineSegments(this.trGeo, this.trMat);
    tr.frustumCulled = false; tr.renderOrder = 3;
    this.group.add(tr);
    // decals
    const uv = new Float32Array(MAX_DECALS * 8);
    const idx: number[] = [];
    for (let i = 0; i < MAX_DECALS; i++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    this.dcGeo.setAttribute('position', new THREE.BufferAttribute(this.dcPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.dcGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.dcGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.dcAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.dcGeo.setIndex(idx);
    this.dcMat.side = THREE.DoubleSide;
    const dc = new THREE.Mesh(this.dcGeo, this.dcMat);
    dc.frustumCulled = false; dc.renderOrder = 1;
    this.group.add(dc);
    // flash sprites (one material each so opacity can vary)
    for (let i = 0; i < FLASH_SPRITES; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      s.visible = false; s.renderOrder = 4;
      this.group.add(s);
      this.sprites.push({ s, life: 0, max: 1, fresh: false });
    }
    // a fixed number of lights so the shader light count never changes
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 7, 1.2);
      this.group.add(l);
      this.lights.push({ l, life: 0, max: 1, peak: 0, fresh: false });
    }
    // casings
    this.csMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.007, 0.007, 0.03, 6), new THREE.MeshStandardMaterial({ color: 0xd9a63a, metalness: 0.9, roughness: 0.3 }), CASINGS);
    this.csMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < CASINGS; i++) this.csMesh.setMatrixAt(i, this.zero);
    this.csMesh.frustumCulled = false;
    this.group.add(this.csMesh);
    scene.add(this.group);
  }

  /** Compile every effect's shader up front so the first shot does not hitch. */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    for (const s of this.sprites) s.s.visible = true;
    renderer.compile(this.group, camera, this.scene);
    for (const s of this.sprites) s.s.visible = false;
  }

  /** Muzzle flash sprite + point light at a world position (remote guns). */
  muzzle(at: V3, scale = 1, withLight = true) {
    const slot = this.sprites.find(s => s.life <= 0) ?? this.sprites[0];
    slot.s.position.set(vx(at), vy(at), vz(at));
    const sz = (0.35 + Math.random() * 0.15) * scale;
    slot.s.scale.set(sz, sz, 1);
    (slot.s.material as THREE.SpriteMaterial).rotation = Math.random() * Math.PI;
    slot.s.visible = true; slot.life = slot.max = 0.05; slot.fresh = true;
    if (withLight) this.light(at, 9 * scale);
  }

  /** Brief point light (the local viewmodel flash uses this directly). */
  light(at: V3, intensity = 6) {
    const L = this.lights[this.lightNext]; this.lightNext = (this.lightNext + 1) % this.lights.length;
    L.l.position.set(vx(at), vy(at), vz(at));
    L.peak = intensity; L.life = L.max = 0.06; L.l.intensity = intensity; L.fresh = true;
  }

  /** Thin bright additive line that fades over ~90 ms. */
  tracer(a: V3, b: V3, color = 0xffe7a0) {
    const i = this.trNext; this.trNext = (this.trNext + 1) % TRACERS;
    const k = i * 6;
    this.trPos[k] = vx(a); this.trPos[k + 1] = vy(a); this.trPos[k + 2] = vz(a);
    this.trPos[k + 3] = vx(b); this.trPos[k + 4] = vy(b); this.trPos[k + 5] = vz(b);
    this.tmpC.setHex(color);
    this.trBase[i * 3] = this.tmpC.r; this.trBase[i * 3 + 1] = this.tmpC.g; this.trBase[i * 3 + 2] = this.tmpC.b;
    this.trLife[i] = 0.09; this.trFresh[i] = 1;
    this.trLive = true;
    (this.trGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Bullet hits the world: spark burst + a dark mark that fades over ~8 s. */
  impact(point: V3, dir: V3, small = false) {
    const px = vx(point), py = vy(point), pz = vz(point);
    const n = this.normalAt(px, py, pz, vx(dir), vy(dir), vz(dir));
    const count = small ? 4 : 8;
    for (let i = 0; i < count; i++) {
      const s = 2 + Math.random() * 4;
      this.tmpC.setRGB(1, 0.75 + Math.random() * 0.25, 0.35 + Math.random() * 0.3);
      this.sparks.spawn(px + n[0] * 0.02, py + n[1] * 0.02, pz + n[2] * 0.02,
        (n[0] + (Math.random() - 0.5) * 1.4) * s, (n[1] + Math.random() * 0.9) * s, (n[2] + (Math.random() - 0.5) * 1.4) * s,
        this.tmpC, 0.035 + Math.random() * 0.03, 0.18 + Math.random() * 0.22);
    }
    // a little dust
    this.tmpC.setRGB(0.55, 0.52, 0.48);
    this.puffs.spawn(px + n[0] * 0.05, py + n[1] * 0.05, pz + n[2] * 0.05, n[0] * 0.6, n[1] * 0.6 + 0.2, n[2] * 0.6, this.tmpC, 0.12, 0.45, 2.5);
    this.decal(px, py, pz, n, small ? 0.035 : 0.055);
  }

  /** Bullet hits a player: a cartoon puff in their colour, plus a few bright bits. */
  puff(point: V3, color: THREE.ColorRepresentation, head = false) {
    const px = vx(point), py = vy(point), pz = vz(point);
    const c = this.tmpC.set(color);
    const n = head ? 9 : 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.8 + Math.random() * 1.6;
      this.puffs.spawn(px, py, pz, Math.cos(a) * s, 0.6 + Math.random() * 1.4, Math.sin(a) * s, c, 0.12 + Math.random() * 0.08, 0.35 + Math.random() * 0.2, 1.5);
    }
    // white star pops so the hit reads at range
    this.tmpC.setRGB(1, 1, 1);
    for (let i = 0; i < (head ? 6 : 3); i++) {
      this.sparks.spawn(px, py, pz, (Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5, this.tmpC, head ? 0.07 : 0.05, 0.15);
    }
  }

  /** Ejected shell casing with gravity; `floor` is the y it lands on. */
  casing(at: V3, vel: V3, floor: number) {
    const c = this.cs[this.csNext]; this.csNext = (this.csNext + 1) % CASINGS;
    c.p.set(vx(at), vy(at), vz(at)); c.v.set(vx(vel), vy(vel), vz(vel));
    c.r.set(Math.random() * 3, Math.random() * 3, 0);
    c.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    c.floor = floor; c.life = 1.5; c.bounced = false;
    this.csLive = true;
  }

  /** Call once per frame. `pxPerRad` = viewport height / (2·tan(fov/2)). */
  update(dt: number, pxPerRad: number) {
    this.sparks.mat.uniforms.uScale.value = pxPerRad;
    this.puffs.mat.uniforms.uScale.value = pxPerRad;
    this.sparks.update(dt);
    this.puffs.update(dt);
    // tracers
    if (this.trLive) {
      let any = false;
      for (let i = 0; i < TRACERS; i++) {
        // every effect is drawn at least once, even at very low frame rates
        if (this.trFresh[i]) this.trFresh[i] = 0; else if (this.trLife[i] > 0) this.trLife[i] -= dt;
        const f = Math.max(0, this.trLife[i] / 0.09);
        if (f > 0) any = true;
        const k = i * 6, b = i * 3;
        // tail end (shooter side) dimmer than the head
        this.trCol[k] = this.trBase[b] * f * 0.35; this.trCol[k + 1] = this.trBase[b + 1] * f * 0.35; this.trCol[k + 2] = this.trBase[b + 2] * f * 0.35;
        this.trCol[k + 3] = this.trBase[b] * f; this.trCol[k + 4] = this.trBase[b + 1] * f; this.trCol[k + 5] = this.trBase[b + 2] * f;
      }
      (this.trGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      this.trLive = any;
    }
    // decals
    let dirty = false;
    for (let i = 0; i < MAX_DECALS; i++) {
      if (this.dcAge[i] > DECAL_HOLD + DECAL_FADE + 1) continue;
      this.dcAge[i] += dt;
      const a = this.dcAge[i] < DECAL_HOLD ? 1 : Math.max(0, 1 - (this.dcAge[i] - DECAL_HOLD) / DECAL_FADE);
      for (let j = 0; j < 4; j++) this.dcAlpha[i * 4 + j] = a;
      dirty = true;
    }
    if (dirty) (this.dcGeo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    // flashes
    for (const s of this.sprites) if (s.fresh) s.fresh = false; else if (s.life > 0) { s.life -= dt; (s.s.material as THREE.SpriteMaterial).opacity = Math.max(0, s.life / s.max); if (s.life <= 0) s.s.visible = false; }
    for (const L of this.lights) if (L.fresh) L.fresh = false; else if (L.life > 0) { L.life -= dt; L.l.intensity = L.life > 0 ? L.peak * (L.life / L.max) : 0; }
    // casings
    if (this.csLive) {
      let any = false;
      for (let i = 0; i < CASINGS; i++) {
        const c = this.cs[i];
        if (c.life <= 0) continue;
        c.life -= dt;
        if (c.life <= 0) { this.csMesh.setMatrixAt(i, this.zero); continue; }
        any = true;
        c.v.y -= 14 * dt;
        c.p.addScaledVector(c.v, dt);
        if (c.p.y < c.floor + 0.01) {
          c.p.y = c.floor + 0.01;
          if (!c.bounced && c.v.y < -1) { c.v.y *= -0.35; c.v.x *= 0.5; c.v.z *= 0.5; c.bounced = true; c.spin.multiplyScalar(0.5); }
          else { c.v.set(0, 0, 0); c.spin.set(0, 0, 0); c.r.x = Math.PI / 2; }
        }
        c.r.x += c.spin.x * dt; c.r.y += c.spin.y * dt; c.r.z += c.spin.z * dt;
        this.tmpQ.setFromEuler(c.r);
        this.tmpS.setScalar(1);
        this.tmpM.compose(c.p, this.tmpQ, this.tmpS);
        this.csMesh.setMatrixAt(i, this.tmpM);
      }
      this.csMesh.instanceMatrix.needsUpdate = true;
      this.csLive = any;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.sparks.dispose(); this.puffs.dispose();
    this.trGeo.dispose(); this.trMat.dispose();
    this.dcGeo.dispose(); this.dcMat.dispose();
    for (const s of this.sprites) (s.s.material as THREE.SpriteMaterial).dispose();
    for (const L of this.lights) L.l.dispose();
    this.csMesh.geometry.dispose(); (this.csMesh.material as THREE.Material).dispose(); this.csMesh.dispose();
    flashTex?.dispose(); flashTex = null;
  }

  // ----- internals -----------------------------------------------------------

  private decal(x: number, y: number, z: number, n: [number, number, number], r: number) {
    const i = this.dcNext; this.dcNext = (this.dcNext + 1) % MAX_DECALS;
    // tangent basis on an axis-aligned face
    let ux = 0, uy = 0, uz = 0, wx = 0, wy = 0, wz = 0;
    if (Math.abs(n[1]) > 0.5) { ux = 1; wz = 1; } else if (Math.abs(n[0]) > 0.5) { uz = 1; wy = 1; } else { ux = 1; wy = 1; }
    const rot = Math.random() * Math.PI;
    const c = Math.cos(rot) * r, s = Math.sin(rot) * r;
    const ax = ux * c + wx * s, ay = uy * c + wy * s, az = uz * c + wz * s;
    const bx = -ux * s + wx * c, by = -uy * s + wy * c, bz = -uz * s + wz * c;
    const ox = x + n[0] * 0.004, oy = y + n[1] * 0.004, oz = z + n[2] * 0.004;
    const k = i * 12;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let j = 0; j < 4; j++) {
      const [p, q] = corners[j];
      this.dcPos[k + j * 3] = ox + ax * p + bx * q;
      this.dcPos[k + j * 3 + 1] = oy + ay * p + by * q;
      this.dcPos[k + j * 3 + 2] = oz + az * p + bz * q;
    }
    this.dcAge[i] = 0;
    (this.dcGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Face normal of the box surface at a hit point; falls back to -dir. */
  private normalAt(x: number, y: number, z: number, dx: number, dy: number, dz: number): [number, number, number] {
    let best = 0.03, n: [number, number, number] | null = null;
    for (const b of this.boxes) {
      if (x < b.min[0] - 0.03 || x > b.max[0] + 0.03 || y < b.min[1] - 0.03 || y > b.max[1] + 0.03 || z < b.min[2] - 0.03 || z > b.max[2] + 0.03) continue;
      const faces: Array<[number, [number, number, number]]> = [
        [Math.abs(x - b.min[0]), [-1, 0, 0]], [Math.abs(x - b.max[0]), [1, 0, 0]],
        [Math.abs(y - b.min[1]), [0, -1, 0]], [Math.abs(y - b.max[1]), [0, 1, 0]],
        [Math.abs(z - b.min[2]), [0, 0, -1]], [Math.abs(z - b.max[2]), [0, 0, 1]],
      ];
      for (const [d, fn] of faces) if (d < best && fn[0] * dx + fn[1] * dy + fn[2] * dz < 0) { best = d; n = fn; }
    }
    if (n) return n;
    const l = Math.hypot(dx, dy, dz) || 1;
    return [-dx / l, -dy / l, -dz / l];
  }
}
