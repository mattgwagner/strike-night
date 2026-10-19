// Turns MapData into three.js meshes, lights and a sky. One merged mesh per
// material keeps draw calls low (box colour overrides ride along as vertex
// colours). Tagged props (spinners, hammers, animatronics, signs) get a richer
// mesh and animate in tick(). The world agent owns this directory.
import * as THREE from 'three';
import type { MapBox, MapData, PointLight as MapLight } from '../../shared/map';
import type { Quality } from '../quality';

type TexName = 'hazard' | 'turf' | 'dirt' | 'chainlink' | 'tile' | 'crate' | 'plate' | 'floor' | 'rollup' | 'grate' | 'curtain' | 'pizzawall' | 'arenawall' | 'trailer' | 'concrete' | 'wood' | 'bleacher' | 'cabinet';

interface MatDef {
  color: number;
  rough?: number;
  metal?: number;
  /** Emissive colour; the material glows this colour at `glow` intensity. */
  emissive?: number;
  glow?: number;
  tex?: TexName;
  /** Metres per texture repeat (world-space UVs). Omit for per-face 0..1 UVs. */
  scale?: number;
  opacity?: number;
  alphaTest?: boolean;
  /** Unlit (MeshBasicMaterial), for signs and screens that should read at any light level. */
  basic?: boolean;
}

const MATS: Record<string, MatDef> = {
  floor:     { color: 0x4a4e5e, rough: 0.92, tex: 'floor', scale: 4 },
  plate:     { color: 0x8890a0, rough: 0.5, metal: 0.6, tex: 'plate', scale: 1.2 },
  wall:      { color: 0x50566c, rough: 0.85, tex: 'concrete', scale: 3 },
  concrete:  { color: 0x8a8e98, rough: 0.95, tex: 'concrete', scale: 2 },
  metal:     { color: 0x9aa4b6, rough: 0.35, metal: 0.75 },
  neon:      { color: 0xff2bd6, emissive: 0xff2bd6, glow: 2.2, basic: true },
  hazard:    { color: 0xffffff, rough: 0.7, tex: 'hazard', scale: 1 },
  crate:     { color: 0xc08a4a, rough: 0.9, tex: 'crate' },
  arenawall: { color: 0x3a3f4c, rough: 0.5, metal: 0.5, tex: 'arenawall', scale: 2 },
  pressbox:  { color: 0x1d3f7a, rough: 0.7, tex: 'concrete', scale: 2 },
  pizzawall: { color: 0xffffff, rough: 0.9, tex: 'pizzawall', scale: 4 },
  glass:     { color: 0xbfe3ff, rough: 0.05, metal: 0.1, opacity: 0.18 },
  screen:    { color: 0x55ffd0, emissive: 0x55ffd0, glow: 1.6, basic: true },
  turf:      { color: 0xffffff, rough: 1, tex: 'turf', scale: 6 },
  dirt:      { color: 0xffffff, rough: 1, tex: 'dirt', scale: 3 },
  chalk:     { color: 0xf4f4f0, rough: 0.9, emissive: 0x606060, glow: 0.4 },
  wood:      { color: 0xa0683a, rough: 0.85, tex: 'wood', scale: 1.5 },
  chainlink: { color: 0xd8dde6, rough: 0.4, metal: 0.8, tex: 'chainlink', scale: 0.6, alphaTest: true },
  bleacher:  { color: 0xb8c0cc, rough: 0.4, metal: 0.6, tex: 'bleacher', scale: 1 },
  foulpole:  { color: 0xffd400, emissive: 0xffd400, glow: 0.8 },
  lamp:      { color: 0xffffff, emissive: 0xf4f8ff, glow: 3, basic: true },
  tarp:      { color: 0x1f4fa8, rough: 0.8 },
  tile:      { color: 0xffffff, rough: 0.6, tex: 'tile', scale: 1.2 },
  stage:     { color: 0x4a2a5a, rough: 0.7, tex: 'wood', scale: 1.5 },
  curtain:   { color: 0xb01030, rough: 1, tex: 'curtain', scale: 1.2 },
  table:     { color: 0xa89a8a, rough: 0.6 },
  chair:     { color: 0xe23a8a, rough: 0.6 },
  pizza:     { color: 0xffb030, emissive: 0x803000, glow: 0.4 },
  cabinet:   { color: 0xffffff, rough: 0.5, tex: 'cabinet' },
  crust:     { color: 0xd07020, emissive: 0xd07020, glow: 1.6, basic: true },
  cheese:    { color: 0xffd23a, emissive: 0xffd23a, glow: 1.6, basic: true },
  pepperoni: { color: 0xff2a1a, emissive: 0xff2a1a, glow: 1.8, basic: true },
  rollup:    { color: 0xb8bcc4, rough: 0.6, metal: 0.4, tex: 'rollup', scale: 1.5 },
  dark:      { color: 0x15161a, rough: 0.9 },
  trailer:   { color: 0xb8bcc6, rough: 0.6, metal: 0.2, tex: 'trailer', scale: 2 },
  grate:     { color: 0xc8a020, rough: 0.5, metal: 0.6, tex: 'grate', scale: 0.8 },
  default:   { color: 0x888888, rough: 0.8 },
};

/** Tags whose box is replaced entirely by a custom mesh. */
const REPLACED = new Set(['animatronic', 'marquee', 'scoreboard', 'scorescreen']);

export interface BuiltWorld { group: THREE.Group; dispose(): void; tick(dt: number, t: number): void; setQuality(q: Quality): void }

export function buildWorld(map: MapData, scene: THREE.Scene): BuiltWorld {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const animators: Array<(dt: number, t: number) => void> = [];

  // --- merged static boxes, one mesh per material ---------------------------
  const byMat = new Map<string, MapBox[]>();
  for (const b of map.boxes) {
    if (b.tag && REPLACED.has(b.tag)) continue;
    const key = b.mat && MATS[b.mat] ? b.mat : 'default';
    if (!byMat.has(key)) byMat.set(key, []);
    byMat.get(key)!.push(b);
  }
  const matCache = new Map<string, THREE.Material>();
  for (const [key, boxes] of byMat) {
    const def = MATS[key];
    const mat = keep(makeMaterial(def));
    matCache.set(key, mat);
    const parts = boxes.map(b => boxGeo(b, def, b.color ? new THREE.Color(b.color) : new THREE.Color(def.color)));
    const merged = keep(mergeGeometries(parts));
    for (const p of parts) p.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = key;
    mesh.matrixAutoUpdate = false;
    if (def.opacity) mesh.renderOrder = 2;
    group.add(mesh);
  }

  // screens flicker gently, all together (one material)
  const screenMat = matCache.get('screen') as THREE.MeshBasicMaterial | undefined;
  if (screenMat) {
    const base = screenMat.color.clone();
    animators.push((_dt, t) => {
      const f = 0.82 + 0.18 * Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1) + (Math.sin(t * 0.7) > 0.97 ? -0.5 : 0);
      screenMat.color.copy(base).multiplyScalar(f);
    });
  }

  // --- tagged props ----------------------------------------------------------
  const spinners = map.boxes.filter(b => b.tag === 'spinner');
  if (spinners.length) group.add(...spinners.map(b => spinner(b, keep, animators)));
  const hammers = map.boxes.filter(b => b.tag === 'hammer');
  hammers.forEach((b, i) => group.add(hammer(b, i, keep, animators)));
  const anim = map.boxes.filter(b => b.tag === 'animatronic');
  if (anim.length) group.add(animatronics(anim, keep, animators));
  for (const b of map.boxes) {
    if (b.tag === 'marquee') group.add(marquee(b, keep, animators));
    if (b.tag === 'scoreboard') group.add(signPlane(b, ballparkBoard(), keep));
    if (b.tag === 'scorescreen') group.add(signPlane(b, pitScreen(), keep));
  }

  // --- lights ---------------------------------------------------------------
  const lights: THREE.PointLight[] = [];
  for (const [i, l] of map.lights.entries()) {
    const pl = new THREE.PointLight(new THREE.Color(l.color), l.intensity, l.distance, 1.7);
    pl.position.set(l.p[0], l.p[1], l.p[2]);
    pl.userData.flicker = !!l.flicker; pl.userData.base = l.intensity; pl.userData.phase = i * 1.37;
    group.add(pl); lights.push(pl);
  }
  group.add(new THREE.HemisphereLight(0x9fb2e8, 0x3a3040, 0.9));
  group.add(new THREE.AmbientLight(new THREE.Color(map.sky.ambient), 0.7));
  // Low quality: every lit fragment loops over every point light, so the map's lights are
  // merged by room into a few (hidden on High), with a little extra fill for the ones dropped.
  const lowLights = mergeLights(map.lights).map((l, i) => {
    const pl = new THREE.PointLight(l.color, l.intensity, l.distance, 1.7);
    pl.position.set(l.p[0], l.p[1], l.p[2]);
    pl.userData.flicker = l.flicker; pl.userData.base = l.intensity; pl.userData.phase = i * 1.37;
    pl.visible = false;
    group.add(pl);
    return pl;
  });
  const lowFill = new THREE.HemisphereLight(0x9fb2e8, 0x3a3040, 0.6);
  lowFill.visible = false;
  group.add(lowFill);
  lights.push(...lowLights);
  animators.push((_dt, t) => {
    for (const pl of lights) {
      if (!pl.visible) continue;
      if (!pl.userData.flicker) continue;
      const ph = pl.userData.phase as number;
      const buzz = 0.75 + 0.25 * Math.sin(t * 23 + ph) * Math.sin(t * 7 + ph);
      const drop = Math.sin(t * 1.3 + ph) * Math.sin(t * 0.37 + ph * 2) > 0.8 ? 0.15 : 1;
      pl.intensity = pl.userData.base * buzz * drop;
    }
  });

  // --- sky + stars ----------------------------------------------------------
  group.add(sky(map, keep));
  scene.background = new THREE.Color(map.sky.bottom);
  scene.fog = new THREE.Fog(new THREE.Color(map.sky.bottom), 30, map.sky.fog);
  scene.add(group);
  return {
    group,
    tick(dt, t) { for (const a of animators) a(dt, t); },
    setQuality(q) {
      const low = q === 'low';
      for (const pl of lights) pl.visible = lowLights.includes(pl) === low;
      lowFill.visible = low;
      // Lambert twins of the PBR materials: same colours, maps and glow, far cheaper per pixel
      group.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const hi = (m.userData.hiMat ??= m.material) as THREE.Material | THREE.Material[];
        m.material = low ? (Array.isArray(hi) ? hi.map(x => lambertOf(x, keep)) : lambertOf(hi, keep)) : hi;
      });
    },
    dispose() { scene.remove(group); for (const d of disposables) d.dispose(); },
  };
}

/** Map lights merged by room (within `radius` m), brightest `max` kept; tiny accent lights dropped. */
export function mergeLights(list: MapLight[], max = 6, radius = 12) {
  const out: Array<{ p: [number, number, number]; color: THREE.Color; intensity: number; distance: number; flicker: boolean }> = [];
  for (const l of [...list].filter(l => l.distance >= 8).sort((a, b) => b.intensity - a.intensity)) {
    const c = out.find(c => Math.hypot(c.p[0] - l.p[0], c.p[1] - l.p[1], c.p[2] - l.p[2]) < radius);
    if (!c) { out.push({ p: [...l.p], color: new THREE.Color(l.color), intensity: l.intensity, distance: l.distance, flicker: !!l.flicker }); continue; }
    const gap = Math.hypot(c.p[0] - l.p[0], c.p[1] - l.p[1], c.p[2] - l.p[2]);
    const w = c.intensity + l.intensity;
    for (let i = 0; i < 3; i++) c.p[i] = (c.p[i] * c.intensity + l.p[i] * l.intensity) / w;
    c.color.multiplyScalar(c.intensity).add(new THREE.Color(l.color).multiplyScalar(l.intensity)).multiplyScalar(1 / w);
    c.distance = Math.max(c.distance, l.distance) + gap / 2;
    // a merged light sits between the rooms it replaces: a bit brighter so both still read lit
    c.intensity = w * 1.25;
    c.flicker ||= !!l.flicker;
  }
  return out.sort((a, b) => b.intensity - a.intensity).slice(0, max);
}

const lambertCache = new WeakMap<THREE.Material, THREE.Material>();
/** Lambert stand-in for a MeshStandardMaterial (others pass through). Metal a little darker, since it loses its highlights. */
function lambertOf(m: THREE.Material, keep: Keep): THREE.Material {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return m;
  let l = lambertCache.get(m);
  if (!l) {
    l = keep(new THREE.MeshLambertMaterial({
      color: std.color.clone().multiplyScalar(1 - 0.25 * std.metalness),
      vertexColors: std.vertexColors, map: std.map,
      emissive: std.emissive, emissiveIntensity: std.emissiveIntensity,
      transparent: std.transparent, opacity: std.opacity, depthWrite: std.depthWrite,
      alphaTest: std.alphaTest, side: std.side, fog: std.fog,
    }));
    lambertCache.set(m, l);
  }
  return l;
}

// ---------------------------------------------------------------------------
// materials + textures
// ---------------------------------------------------------------------------

function makeMaterial(def: MatDef): THREE.Material {
  const map = def.tex ? texture(def.tex) : null;
  if (def.basic) {
    // vertex colours carry the hue (so per-box colour overrides work); the material colour is the glow
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(def.glow ?? 1), vertexColors: true, map, toneMapped: false });
  }
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map,
    roughness: def.rough ?? 0.8,
    metalness: def.metal ?? 0,
    emissive: def.emissive ? new THREE.Color(def.emissive) : new THREE.Color(0),
    emissiveIntensity: def.glow ?? 0,
    transparent: !!def.opacity,
    opacity: def.opacity ?? 1,
    depthWrite: !def.opacity,
    alphaTest: def.alphaTest ? 0.5 : 0,
    side: def.alphaTest || def.opacity ? THREE.DoubleSide : THREE.FrontSide,
  });
}

const texCache = new Map<TexName, THREE.Texture>();
function texture(name: TexName): THREE.Texture {
  const hit = texCache.get(name);
  if (hit) return hit;
  const size = name === 'cabinet' ? 128 : 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const S = size;
  const noise = (alpha: number, n = 900, light = false) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = light ? `rgba(255,255,255,${Math.random() * alpha})` : `rgba(0,0,0,${Math.random() * alpha})`;
      g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
  };
  switch (name) {
    case 'hazard': {
      g.fillStyle = '#ffc400'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#16161a';
      for (let i = -S; i < S * 2; i += S / 2) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S / 4, 0); g.lineTo(i + S / 4 - S, S); g.lineTo(i - S, S); g.fill(); }
      noise(0.15);
      break;
    }
    case 'turf': {
      for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#1c5a24' : '#246a2c'; g.fillRect(0, (i * S) / 4, S, S / 4); }
      for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(${Math.random() > 0.5 ? '20,60,20' : '120,200,110'},0.25)`; g.fillRect(Math.random() * S, Math.random() * S, 1, 3); }
      break;
    }
    case 'dirt': {
      g.fillStyle = '#b07a4a'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${Math.random() > 0.5 ? '90,50,25' : '220,170,120'},0.35)`; g.fillRect(Math.random() * S, Math.random() * S, 2, 2); }
      break;
    }
    case 'chainlink': {
      g.clearRect(0, 0, S, S);
      g.strokeStyle = '#ffffff'; g.lineWidth = 10;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(S, S); g.moveTo(S, 0); g.lineTo(0, S); g.stroke();
      break;
    }
    case 'tile': {
      const n = 4;
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) { g.fillStyle = (x + y) % 2 ? '#0c0c10' : '#4e4842'; g.fillRect((x * S) / n, (y * S) / n, S / n, S / n); }
      noise(0.12, 1500);
      break;
    }
    case 'crate': {
      g.fillStyle = '#c99556'; g.fillRect(0, 0, S, S);
      g.strokeStyle = '#6a4220'; g.lineWidth = 6;
      for (let i = 1; i < 5; i++) { g.beginPath(); g.moveTo(0, (i * S) / 5); g.lineTo(S, (i * S) / 5); g.stroke(); }
      g.fillStyle = '#7a4c24'; const w = S * 0.12;
      g.fillRect(0, 0, S, w); g.fillRect(0, S - w, S, w); g.fillRect(0, 0, w, S); g.fillRect(S - w, 0, w, S);
      g.lineWidth = w * 0.8; g.beginPath(); g.moveTo(w, w); g.lineTo(S - w, S - w); g.stroke();
      noise(0.2, 1500);
      break;
    }
    case 'plate': {
      g.fillStyle = '#8a8f9a'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#b6bcc8';
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g.save(); g.translate((x + (y % 2) * 0.5) * (S / 8), (y + 0.5) * (S / 8)); g.rotate(y % 2 ? 0.8 : -0.8);
        g.fillRect(-10, -3, 20, 6); g.restore();
      }
      g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 4; g.strokeRect(0, 0, S, S);
      break;
    }
    case 'floor': {
      g.fillStyle = '#5a5e6a'; g.fillRect(0, 0, S, S);
      noise(0.18, 3000); noise(0.08, 1500, true);
      g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 3;
      g.strokeRect(1.5, 1.5, S - 3, S - 3);
      g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
      break;
    }
    case 'concrete': {
      g.fillStyle = '#8c8f96'; g.fillRect(0, 0, S, S);
      noise(0.2, 4000); noise(0.1, 2000, true);
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2; g.strokeRect(1, 1, S - 2, S - 2);
      break;
    }
    case 'wood': {
      g.fillStyle = '#9a6a3a'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? 'rgba(0,0,0,0.12)' : 'rgba(255,220,180,0.08)'; g.fillRect(0, (i * S) / 8, S, S / 8); }
      g.strokeStyle = 'rgba(40,20,5,0.5)'; g.lineWidth = 2;
      for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(0, (i * S) / 8); g.lineTo(S, (i * S) / 8); g.stroke(); }
      noise(0.15, 1500);
      break;
    }
    case 'rollup': case 'trailer': {
      g.fillStyle = name === 'rollup' ? '#b8bcc4' : '#ececf0'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 12; i++) { const y = (i * S) / 12; g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(name === 'rollup' ? 0 : y, name === 'rollup' ? y : 0, name === 'rollup' ? S : 4, name === 'rollup' ? 4 : S); }
      noise(0.15, 1200);
      if (name === 'trailer') { g.fillStyle = '#e03030'; g.fillRect(0, S * 0.78, S, S * 0.06); }
      break;
    }
    case 'grate': {
      g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#d0a020';
      for (let i = 0; i < 8; i++) { g.fillRect((i * S) / 8, 0, 8, S); g.fillRect(0, (i * S) / 8, S, 8); }
      break;
    }
    case 'curtain': {
      for (let x = 0; x < S; x++) { const v = 0.55 + 0.45 * Math.sin((x / S) * Math.PI * 8); g.fillStyle = `rgb(${Math.round(150 + 90 * v)},${Math.round(20 * v)},${Math.round(40 * v)})`; g.fillRect(x, 0, 1, S); }
      g.fillStyle = '#ffcc33'; g.fillRect(0, S - 10, S, 6);
      break;
    }
    case 'pizzawall': {
      for (let x = 0; x < 8; x++) { g.fillStyle = x % 2 ? '#2a1438' : '#341a44'; g.fillRect((x * S) / 8, 0, S / 8, S); }
      // checker wainscot at the bottom (UV v=0 is the bottom of the face)
      const n = 8;
      for (let x = 0; x < n; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#e6e0d0'; g.fillRect((x * S) / n, S - ((y + 1) * S) / n, S / n, S / n); }
      g.fillStyle = '#e03050'; g.fillRect(0, S - (2 * S) / n - 8, S, 8);
      // stars and confetti
      for (let i = 0; i < 18; i++) { g.fillStyle = ['#ffd23a', '#33e0ff', '#ff5aa0'][i % 3]; g.fillRect(Math.random() * S, Math.random() * S * 0.6, 6, 6); }
      break;
    }
    case 'arenawall': {
      g.fillStyle = '#3a404e'; g.fillRect(0, 0, S, S);
      g.strokeStyle = '#20242c'; g.lineWidth = 6; g.strokeRect(3, 3, S - 6, S - 6);
      g.fillStyle = '#9aa2b0';
      for (const [x, y] of [[14, 14], [S - 14, 14], [14, S - 14], [S - 14, S - 14]]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#ff7a1a'; g.fillRect(0, S * 0.45, S, 10);
      noise(0.15, 1200);
      break;
    }
    case 'bleacher': {
      g.fillStyle = '#9aa2ae'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#c4ccd6' : '#8a92a0'; g.fillRect(0, (i * S) / 6, S, S / 12); }
      break;
    }
    case 'cabinet': {
      g.fillStyle = '#2a1050'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#ff2bd6'; g.fillRect(0, 0, 10, S); g.fillRect(S - 10, 0, 10, S);
      g.fillStyle = '#33e0ff'; g.fillRect(16, S * 0.62, S - 32, 8);
      g.fillStyle = '#ffd23a'; g.beginPath(); g.arc(S * 0.35, S * 0.75, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ff3040'; g.beginPath(); g.arc(S * 0.6, S * 0.75, 7, 0, Math.PI * 2); g.fill();
      break;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(name, t);
  return t;
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

/** A box with vertex colours and (optionally) world-space UVs so textures tile at a fixed scale. */
function boxGeo(b: MapBox, def: MatDef, color: THREE.Color): THREE.BufferGeometry {
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(b.min[0] + sx / 2, b.min[1] + sy / 2, b.min[2] + sz / 2);
  if (def.scale) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const s = def.scale;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (ax > 0.5) uv.setXY(i, z / s, y / s);
      else if (ay > 0.5) uv.setXY(i, x / s, z / s);
      else uv.setXY(i, x / s, y / s);
    }
  }
  paint(g, color);
  return g;
}

function paint(g: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Bake a coloured, transformed copy of `geo` (for vertex-coloured merged props). */
function part(geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  const g = geo;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(...s));
  g.applyMatrix4(m);
  return paint(g, new THREE.Color(color));
}

/** Minimal geometry merge (positions, normals, uvs, colours) to avoid the addons import. */
export function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  let off = 0;
  const withColor = parts.every(g => g.getAttribute('color'));
  for (const g of parts) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), u = g.getAttribute('uv'), c = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      if (u) uv.push(u.getX(i), u.getY(i)); else uv.push(0, 0);
      if (withColor) col.push(c.getX(i), c.getY(i), c.getZ(i));
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (withColor) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

const centre = (b: MapBox) => new THREE.Vector3((b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2);

type Keep = <T extends { dispose(): void }>(x: T) => T;
type Anim = Array<(dt: number, t: number) => void>;

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

/** A horizontal spinning bar over a hazard plinth. */
function spinner(b: MapBox, keep: Keep, anim: Anim): THREE.Object3D {
  const c = centre(b);
  const g = new THREE.Group();
  g.position.set(c.x, b.max[1] + 0.06, c.z);
  const blade = new THREE.Mesh(keep(mergeGeometries([
    part(new THREE.BoxGeometry(1.7, 0.08, 0.28), 0xd8dde6, 0, 0, 0),
    part(new THREE.BoxGeometry(0.22, 0.1, 0.32), 0xff3020, 0.75, 0, 0),
    part(new THREE.BoxGeometry(0.22, 0.1, 0.32), 0xff3020, -0.75, 0, 0),
    part(new THREE.CylinderGeometry(0.16, 0.16, 0.16, 12), 0x30343c, 0, 0, 0),
  ])), keep(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.9, roughness: 0.25 })));
  g.add(blade);
  const speed = 14 + Math.random() * 6;
  anim.push((dt) => { blade.rotation.y += speed * dt; });
  return g;
}

/** Pulverizer: a pivoting arm with a hammer head that winds up and slams. */
function hammer(b: MapBox, i: number, keep: Keep, anim: Anim): THREE.Object3D {
  const c = centre(b);
  const pivot = new THREE.Group();
  pivot.position.set(c.x, b.max[1], c.z);
  // arm points along +X in local space; rotate the pivot to face the variant direction
  const yaws: Record<string, number> = { 'x+': 0, 'x-': Math.PI, 'z+': -Math.PI / 2, 'z-': Math.PI / 2 };
  const yaw = yaws[b.variant ?? 'x+'] ?? 0;
  pivot.rotation.y = yaw;
  const swing = new THREE.Group();
  pivot.add(swing);
  const arm = new THREE.Mesh(keep(mergeGeometries([
    part(new THREE.BoxGeometry(2.4, 0.18, 0.22), 0x8a94a6, 1.2, 0.1, 0),
    part(new THREE.BoxGeometry(0.55, 0.7, 0.75), 0xff6a00, 2.35, -0.15, 0),
    part(new THREE.BoxGeometry(0.6, 0.12, 0.8), 0x16161a, 2.35, -0.52, 0),
    part(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 12), 0x30343c, 0, 0.1, 0, Math.PI / 2, 0, 0),
  ])), keep(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.35 })));
  swing.add(arm);
  const period = 3.2, offset = i * 1.6;
  anim.push((_dt, t) => {
    const k = ((t + offset) % period) / period;
    // slow wind-up to 75 degrees, hold, fast slam down to just above the floor
    const up = 1.1, rest = -0.45; // rest = head on the arena floor
    let a: number;
    if (k < 0.6) a = rest + (k / 0.6) * (up - rest);
    else if (k < 0.75) a = up;
    else if (k < 0.82) a = up + (rest - up) * ((k - 0.75) / 0.07);
    else a = rest;
    swing.rotation.z = a;
  });
  return pivot;
}

/** The three stage animatronics: one merged vertex-coloured mesh + one glowing-eyes mesh. */
function animatronics(list: MapBox[], keep: Keep, anim: Anim): THREE.Object3D {
  const body: THREE.BufferGeometry[] = [];
  const eyes: THREE.BufferGeometry[] = [];
  const sph = (r: number) => new THREE.SphereGeometry(r, 14, 10);
  const cyl = (rt: number, rb: number, h: number) => new THREE.CylinderGeometry(rt, rb, h, 14);
  const bx = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
  for (const b of list) {
    const c = centre(b);
    const o = (g: THREE.BufferGeometry, col: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s?: [number, number, number]) => {
      // statues face +X (out of the stage, toward the dining room)
      const m = part(g, col, 0, 0, 0, rx, ry, rz, s);
      m.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      m.translate(c.x + z, c.y + y, c.z - x);
      return m;
    };
    const add = (g: THREE.BufferGeometry, col: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s?: [number, number, number]) => body.push(o(g, col, x, y, z, rx, ry, rz, s));
    const eye = (x: number, y: number, z: number, r = 0.045) => eyes.push(o(sph(r), 0xffffff, x, y, z));
    const v = b.variant ?? 'bear';
    if (v === 'bear') {
      const fur = 0x7a4420, belly = 0xd8b088;
      add(cyl(0.12, 0.13, 0.75), fur, -0.15, 0.38, 0); add(cyl(0.12, 0.13, 0.75), fur, 0.15, 0.38, 0);
      add(bx(0.2, 0.08, 0.3), 0x2a1a10, -0.15, 0.04, 0.05); add(bx(0.2, 0.08, 0.3), 0x2a1a10, 0.15, 0.04, 0.05);
      add(sph(0.36), fur, 0, 1.08, 0, 0, 0, 0, [1, 1.15, 0.85]);
      add(sph(0.25), belly, 0, 1.02, 0.17, 0, 0, 0, [1, 1.2, 0.5]);
      add(cyl(0.09, 0.1, 0.6), fur, -0.42, 1.0, 0.05, 0, 0, 0.25); add(cyl(0.09, 0.1, 0.6), fur, 0.42, 1.0, 0.05, 0, 0, -0.25);
      add(bx(0.12, 0.1, 0.06), 0x111111, -0.07, 1.44, 0.24); add(bx(0.12, 0.1, 0.06), 0x111111, 0.07, 1.44, 0.24); // bow tie
      add(sph(0.26), fur, 0, 1.7, 0, 0, 0, 0, [1, 0.95, 0.95]);
      add(sph(0.13), belly, 0, 1.63, 0.2, 0, 0, 0, [1.1, 0.8, 0.9]);
      add(sph(0.05), 0x1a0e08, 0, 1.68, 0.31);
      add(sph(0.09), fur, -0.2, 1.93, 0); add(sph(0.09), fur, 0.2, 1.93, 0);
      add(bx(0.18, 0.04, 0.02), 0x1a0e08, 0, 1.56, 0.28); // stitched grin
      eye(-0.09, 1.76, 0.21); eye(0.09, 1.76, 0.21);
    } else if (v === 'bunny') {
      const fur = 0x2fa89a, pale = 0xbfeee6;
      add(cyl(0.1, 0.12, 0.75), fur, -0.14, 0.38, 0); add(cyl(0.1, 0.12, 0.75), fur, 0.14, 0.38, 0);
      add(bx(0.18, 0.08, 0.34), pale, -0.14, 0.04, 0.07); add(bx(0.18, 0.08, 0.34), pale, 0.14, 0.04, 0.07);
      add(cyl(0.24, 0.3, 0.7), fur, 0, 1.1, 0);
      add(bx(0.4, 0.5, 0.06), 0xff5aa0, 0, 1.1, 0.25); // vest
      add(cyl(0.07, 0.08, 0.6), fur, -0.33, 1.05, 0.1, 0.5, 0, 0.2); add(cyl(0.07, 0.08, 0.6), fur, 0.33, 1.05, 0.1, 0.5, 0, -0.2);
      add(bx(0.7, 0.1, 0.22), 0x222222, 0, 0.98, 0.32, 0, 0, 0.15); // keytar
      add(bx(0.5, 0.03, 0.1), 0xf0f0f0, 0.02, 1.04, 0.36, 0, 0, 0.15);
      add(sph(0.22), fur, 0, 1.6, 0, 0, 0, 0, [1, 1.05, 1]);
      add(sph(0.11), pale, 0, 1.53, 0.16, 0, 0, 0, [1.2, 0.8, 0.8]);
      add(bx(0.05, 0.06, 0.02), 0xffffff, -0.025, 1.47, 0.24); add(bx(0.05, 0.06, 0.02), 0xffffff, 0.025, 1.47, 0.24); // buck teeth
      add(bx(0.08, 0.42, 0.04), fur, -0.1, 1.98, 0, 0, 0, 0.12); add(bx(0.08, 0.32, 0.04), fur, 0.14, 1.92, 0, 0, 0, -0.7); // one ear bent
      eye(-0.08, 1.66, 0.18, 0.04); eye(0.08, 1.66, 0.18, 0.04);
    } else {
      const feather = 0xf2efe6, beak = 0xff8a1a;
      add(cyl(0.05, 0.05, 0.75), beak, -0.12, 0.38, 0); add(cyl(0.05, 0.05, 0.75), beak, 0.12, 0.38, 0);
      add(bx(0.2, 0.05, 0.3), beak, -0.12, 0.03, 0.07); add(bx(0.2, 0.05, 0.3), beak, 0.12, 0.03, 0.07);
      add(sph(0.36), feather, 0, 1.08, 0, 0, 0, 0, [1, 1.1, 1]);
      add(bx(0.36, 0.3, 0.04), 0x3a7aff, 0, 1.1, 0.33); // bib
      add(bx(0.12, 0.4, 0.3), feather, -0.4, 1.1, 0, 0, 0, 0.35); add(bx(0.12, 0.4, 0.3), feather, 0.4, 1.1, 0, 0, 0, -0.35); // wings
      add(cyl(0.32, 0.32, 0.03), 0x9aa4b6, 0, 1.2, 0.42, Math.PI / 2 - 0.3, 0, 0); // tray
      add(cyl(0.26, 0.26, 0.04), 0xffb030, 0, 1.24, 0.42, Math.PI / 2 - 0.3, 0, 0); // pizza on it
      add(sph(0.22), feather, 0, 1.66, 0);
      add(bx(0.06, 0.16, 0.22), 0xe02020, 0, 1.9, -0.02); // comb
      add(new THREE.ConeGeometry(0.08, 0.2, 8), beak, 0, 1.6, 0.26, Math.PI / 2, 0, 0);
      add(bx(0.06, 0.1, 0.04), 0xe02020, 0, 1.5, 0.22); // wattle
      eye(-0.085, 1.71, 0.18); eye(0.085, 1.71, 0.18);
    }
  }
  const g = new THREE.Group();
  const bodyMesh = new THREE.Mesh(keep(mergeGeometries(body)), keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 })));
  const eyeMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2020).multiplyScalar(3), toneMapped: false }));
  const eyeMesh = new THREE.Mesh(keep(mergeGeometries(eyes)), eyeMat);
  g.add(bodyMesh, eyeMesh);
  anim.push((_dt, t) => {
    // a slow pulse, and every so often they all blink out at once
    const blink = Math.sin(t * 0.9) * Math.sin(t * 0.23) > 0.85 ? 0.05 : 1;
    eyeMat.color.setRGB(3 * (0.7 + 0.3 * Math.sin(t * 2.4)) * blink, 0.15 * blink, 0.1 * blink);
  });
  return g;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, keep?: Keep): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  keep?.(t);
  return t;
}

/** The STRIKE NIGHT marquee: four lit text faces around a dark box, hung between the mid pillars. */
function marquee(b: MapBox, keep: Keep, anim: Anim): THREE.Object3D {
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const c = centre(b);
  const g = new THREE.Group();
  g.position.set(c.x, b.min[1] + sy / 2, c.z);
  const tex = canvasTex(1024, 160, x => {
    x.fillStyle = '#0a0418'; x.fillRect(0, 0, 1024, 160);
    x.strokeStyle = '#33e0ff'; x.lineWidth = 8; x.strokeRect(10, 10, 1004, 140);
    for (let i = 0; i < 40; i++) { x.fillStyle = i % 2 ? '#ffd23a' : '#ffffff'; x.beginPath(); x.arc(26 + i * 25.4, 24, 4, 0, Math.PI * 2); x.arc(26 + i * 25.4, 136, 4, 0, Math.PI * 2); x.fill(); }
    x.font = '900 92px Impact, "Arial Black", system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = '#ff2bd6'; x.shadowBlur = 24;
    x.fillStyle = '#ff5ae0'; x.fillText('STRIKE NIGHT', 512, 84);
    x.shadowBlur = 0; x.fillStyle = '#fff0ff'; x.fillText('STRIKE NIGHT', 512, 84);
  }, keep);
  const face = keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x14101e, roughness: 0.6, metalness: 0.4 }));
  // box body: dark on top/bottom, text on the four sides
  const geo = keep(new THREE.BoxGeometry(sx, sy, sz));
  const mesh = new THREE.Mesh(geo, [face, face, dark, dark, face, face]);
  g.add(mesh);
  // neon frame under the sign
  const bars = [
    part(new THREE.BoxGeometry(sx + 0.12, 0.08, 0.08), 0x33e0ff, 0, -sy / 2 - 0.04, sz / 2 + 0.02),
    part(new THREE.BoxGeometry(sx + 0.12, 0.08, 0.08), 0x33e0ff, 0, -sy / 2 - 0.04, -sz / 2 - 0.02),
    part(new THREE.BoxGeometry(0.08, 0.08, sz + 0.12), 0x33e0ff, sx / 2 + 0.02, -sy / 2 - 0.04, 0),
    part(new THREE.BoxGeometry(0.08, 0.08, sz + 0.12), 0x33e0ff, -sx / 2 - 0.02, -sy / 2 - 0.04, 0),
  ];
  const trim = new THREE.Mesh(keep(mergeGeometries(bars)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 2, 2), vertexColors: true, toneMapped: false })));
  g.add(trim);
  anim.push((_dt, t) => { face.color.setScalar(1.1 + 0.25 * Math.sin(t * 3)); });
  return g;
}

/** A flat lit sign on the face of a thin box (the thin axis is the facing direction). */
function signPlane(b: MapBox, tex: THREE.CanvasTexture, keep: Keep): THREE.Object3D {
  keep(tex);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const mat = keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(1.4, 1.4, 1.4) }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x101218 }));
  const geo = keep(new THREE.BoxGeometry(sx, sy, sz));
  const thinX = sx < sz;
  // material order: +x, -x, +y, -y, +z, -z. Show the sign on both broad faces.
  const mats = thinX ? [mat, mat, dark, dark, dark, dark] : [dark, dark, dark, dark, mat, mat];
  const m = new THREE.Mesh(geo, mats);
  m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  return m;
}

function ballparkBoard(): THREE.CanvasTexture {
  return canvasTex(512, 256, x => {
    x.fillStyle = '#0c3a1e'; x.fillRect(0, 0, 512, 256);
    x.strokeStyle = '#f2f2e8'; x.lineWidth = 6; x.strokeRect(6, 6, 500, 244);
    x.fillStyle = '#ffd23a'; x.font = 'bold 34px Impact, "Arial Black", sans-serif'; x.textAlign = 'center';
    x.fillText('THE YARD', 256, 46);
    x.font = 'bold 22px monospace'; x.textAlign = 'left';
    x.fillStyle = '#f2f2e8';
    x.fillText('INN  1 2 3 4 5 6 7 8 9  R', 24, 92);
    x.fillText('AWAY 0 1 0 0 2 0 0 1 0  4', 24, 128);
    x.fillText('HOME 1 0 0 3 0 0 0 0 -  4', 24, 164);
    x.fillStyle = '#ff5a3a'; x.fillText('BALL ●●○  STRIKE ●●  OUT ●●', 24, 214);
  });
}

function pitScreen(): THREE.CanvasTexture {
  return canvasTex(1024, 256, x => {
    x.fillStyle = '#05060a'; x.fillRect(0, 0, 1024, 256);
    for (let y = 0; y < 256; y += 4) { x.fillStyle = 'rgba(255,255,255,0.03)'; x.fillRect(0, y, 1024, 2); }
    x.font = '900 70px Impact, "Arial Black", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ff7a1a'; x.fillText('THE PIT', 512, 60);
    x.font = 'bold 54px Impact, "Arial Black", sans-serif';
    x.fillStyle = '#ff3a2a'; x.fillText('KILLSAW', 230, 160);
    x.fillStyle = '#ffffff'; x.fillText('VS', 512, 160);
    x.fillStyle = '#3aa0ff'; x.fillText('CHALLENGER', 800, 160);
    x.fillStyle = '#ffd23a'; x.font = 'bold 34px monospace'; x.fillText('3:00  ·  FIGHT!', 512, 225);
  });
}

/** Night sky gradient dome plus a few hundred stars. */
function sky(map: MapData, keep: Keep): THREE.Object3D {
  const g = new THREE.Group();
  const geo = keep(new THREE.SphereGeometry(220, 24, 12));
  const mat = keep(new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(map.sky.top) }, bottom: { value: new THREE.Color(map.sky.bottom) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float k = smoothstep(-0.05, 0.6, vP.y); gl_FragColor = vec4(mix(bottom, top, k), 1.0); }',
  }));
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -10;
  g.add(dome);
  const n = 450;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const az = rnd() * Math.PI * 2, el = Math.asin(0.12 + rnd() * 0.88);
    const r = 200;
    pos[i * 3] = Math.cos(el) * Math.cos(az) * r; pos[i * 3 + 1] = Math.sin(el) * r; pos[i * 3 + 2] = Math.cos(el) * Math.sin(az) * r;
    const b = 0.5 + rnd() * 0.5, warm = rnd();
    col[i * 3] = b; col[i * 3 + 1] = b * (0.9 + warm * 0.1); col[i * 3 + 2] = b * (1.05 - warm * 0.2);
  }
  const sg = keep(new THREE.BufferGeometry());
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(sg, keep(new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false })));
  stars.renderOrder = -9;
  g.add(stars);
  return g;
}
