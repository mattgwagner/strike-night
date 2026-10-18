// Turns MapData into three.js meshes, lights and a sky. One merged mesh per
// material keeps draw calls low. The world agent owns this directory.
import * as THREE from 'three';
import type { MapBox, MapData } from '../../shared/map';

const MATS: Record<string, { color: number; rough?: number; metal?: number; emissive?: number }> = {
  floor:    { color: 0x2a2d3a, rough: 0.9 },
  wall:     { color: 0x3b3f52, rough: 0.8 },
  concrete: { color: 0x6b6f7a, rough: 0.95 },
  metal:    { color: 0x8a94a6, rough: 0.35, metal: 0.8 },
  crate:    { color: 0x9a6a3a, rough: 0.9 },
  wood:     { color: 0x8c5a2b, rough: 0.8 },
  stage:    { color: 0x5a1a1a, rough: 0.7 },
  curtain:  { color: 0x8b1020, rough: 1 },
  neon:     { color: 0xff2bd6, emissive: 0xff2bd6 },
  default:  { color: 0x777777, rough: 0.8 },
};

export interface BuiltWorld { group: THREE.Group; dispose(): void; tick(dt: number, t: number): void }

export function buildWorld(map: MapData, scene: THREE.Scene): BuiltWorld {
  const group = new THREE.Group();
  const byMat = new Map<string, MapBox[]>();
  for (const b of map.boxes) {
    const key = (b.mat ?? 'default') + (b.color ?? '');
    if (!byMat.has(key)) byMat.set(key, []);
    byMat.get(key)!.push(b);
  }
  const geos: THREE.BufferGeometry[] = [];
  for (const [key, boxes] of byMat) {
    const def = MATS[boxes[0].mat ?? 'default'] ?? MATS.default;
    const color = boxes[0].color ? new THREE.Color(boxes[0].color) : new THREE.Color(def.color);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: def.rough ?? 0.8, metalness: def.metal ?? 0, emissive: def.emissive ? new THREE.Color(def.emissive) : undefined, emissiveIntensity: def.emissive ? 1.5 : 0 });
    const geo = new THREE.BufferGeometry();
    const parts: THREE.BufferGeometry[] = [];
    for (const b of boxes) {
      const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(b.min[0] + sx / 2, b.min[1] + sy / 2, b.min[2] + sz / 2);
      parts.push(g);
    }
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.name = key;
    group.add(mesh);
    geos.push(merged, geo);
  }
  // grid lines on the floor for depth perception
  const grid = new THREE.GridHelper(map.half * 2, map.half, 0x3a4060, 0x262a3c);
  grid.position.y = 0.01;
  group.add(grid);

  const lights: THREE.PointLight[] = [];
  for (const l of map.lights) {
    const pl = new THREE.PointLight(new THREE.Color(l.color), l.intensity, l.distance, 1.6);
    pl.position.set(l.p[0], l.p[1], l.p[2]);
    pl.userData.flicker = !!l.flicker; pl.userData.base = l.intensity;
    group.add(pl); lights.push(pl);
  }
  const hemi = new THREE.HemisphereLight(0x8fa3d9, 0x4a3a2a, 1.4);
  group.add(hemi);
  const ambient = new THREE.AmbientLight(new THREE.Color(map.sky.ambient), 1.2);
  group.add(ambient);
  scene.background = new THREE.Color(map.sky.bottom);
  scene.fog = new THREE.Fog(new THREE.Color(map.sky.bottom), 20, map.sky.fog);
  scene.add(group);
  return {
    group,
    tick(_dt, t) {
      for (const pl of lights) if (pl.userData.flicker) pl.intensity = pl.userData.base * (0.6 + 0.4 * Math.abs(Math.sin(t * 7) * Math.sin(t * 13 + 1)));
    },
    dispose() { scene.remove(group); for (const g of geos) g.dispose(); },
  };
}

/** Minimal geometry merge (positions + normals + uvs) to avoid the addons import. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  let off = 0;
  for (const g of parts) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
    const ix = g.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    off += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}
