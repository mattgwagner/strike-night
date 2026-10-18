// Character meshes. Each skin returns a Group whose origin is at the feet.
// Parts are authored facing +Z inside an inner group that is turned 180°, so
// the rig as a whole faces -Z: `group.rotation.y = yaw` then looks along
// physics `forward(yaw)`, and `head/gun.rotation.x = -pitch` tilts up for a
// positive pitch. Keep the bounds inside the shared PLAYER box (radius 0.35,
// height 1.8) with the head in the top PLAYER.headHeight, so what you see is
// what gets hit.
import * as THREE from 'three';
import { CHARACTERS, PLAYER } from '../../shared/constants';

export interface SkinRig { group: THREE.Group; head: THREE.Object3D; gun: THREE.Object3D; setCrouch(c: boolean): void }

const R = PLAYER.radius;
const HEAD_Y = PLAYER.height - PLAYER.headHeight; // 1.5: head pivot; head parts live in [0, 0.3] above it

/** Collects parts per material and merges them, so a skin is a handful of draw calls. */
class Kit {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s?: [number, number, number]) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(...(s ?? [1, 1, 1])));
    geo.applyMatrix4(m);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat)!.push(geo);
    return this;
  }
  build(into: THREE.Object3D) {
    for (const [mat, geos] of this.parts) {
      const mesh = new THREE.Mesh(merge(geos), mat);
      for (const g of geos) g.dispose();
      into.add(mesh);
    }
    this.parts.clear();
  }
}

const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const sph = (r: number, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h);
const cyl = (rt: number, rb: number, h: number, n = 14) => new THREE.CylinderGeometry(rt, rb, h, n);

function std(color: number | THREE.Color, rough = 0.6, metal = 0.1, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}
function glow(color: number, k = 2.5) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false });
}

let pinTex: THREE.Texture | null = null;
function pinstripes(): THREE.Texture {
  if (pinTex) return pinTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#1e3fa8';
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 3, 64);
  pinTex = new THREE.CanvasTexture(c);
  pinTex.wrapS = pinTex.wrapT = THREE.RepeatWrapping;
  pinTex.repeat.set(2, 2);
  pinTex.colorSpace = THREE.SRGBColorSpace;
  return pinTex;
}

export function buildSkin(skinId: string, team: 0 | 1 = 0): SkinRig {
  const def = CHARACTERS.find(c => c.id === skinId) ?? CHARACTERS[0];
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = Math.PI;
  group.add(inner);
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  const gun = new THREE.Group();
  gun.position.set(R * 0.75, 1.22, 0.12);
  const gunMesh = new THREE.Mesh(box(0.08, 0.1, 0.6), std(0x222222, 0.4, 0.6));
  gunMesh.position.set(0, 0, 0.25);
  gun.add(gunMesh);
  inner.add(head, gun);
  const body = new Kit(), face = new Kit();
  const spinners: THREE.Object3D[] = [];
  const color = new THREE.Color(def.color);

  switch (def.id) {
    case 'bot': { // Killsaw: boxy combat robot, spinning disc on its back, antenna
      const shell = std(color, 0.45, 0.6), steel = std(0x3a3f4a, 0.35, 0.85), tread = std(0x16161a, 0.9, 0.2), eye = glow(0xff3020, 3);
      body.add(box(0.22, 0.62, 0.36), tread, -0.13, 0.31, 0).add(box(0.22, 0.62, 0.36), tread, 0.13, 0.31, 0);
      body.add(box(0.5, 0.16, 0.42), steel, 0, 0.7, 0);
      body.add(box(0.56, 0.62, 0.4), shell, 0, 1.08, 0);
      body.add(box(0.36, 0.2, 0.04), steel, 0, 1.14, 0.21);
      body.add(box(0.1, 0.42, 0.12), steel, -0.3, 1.02, 0.02).add(box(0.1, 0.42, 0.12), steel, 0.3, 1.02, 0.02);
      body.add(box(0.12, 0.12, 0.2), shell, -0.3, 0.76, 0.08).add(box(0.12, 0.12, 0.2), shell, 0.3, 0.76, 0.08);
      body.add(box(0.12, 0.12, 0.12), steel, 0, 1.43, 0); // neck
      face.add(box(0.34, 0.22, 0.3), shell, 0, 0.11, 0);
      face.add(box(0.26, 0.05, 0.02), eye, 0, 0.13, 0.155);
      face.add(cyl(0.008, 0.008, 0.08, 6), steel, 0.11, 0.26, -0.05);
      face.add(sph(0.022, 8, 6), eye, 0.11, 0.285, -0.05);
      // the spinner: a vertical disc on the back that never stops
      const disc = new THREE.Group();
      disc.position.set(0, 1.08, -0.255);
      const blade = new Kit();
      blade.add(cyl(0.29, 0.29, 0.03, 20), steel, 0, 0, 0, Math.PI / 2, 0, 0);
      for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 2; blade.add(box(0.07, 0.06, 0.035), shell, Math.cos(a) * 0.27, Math.sin(a) * 0.27, 0, 0, 0, a); }
      blade.add(cyl(0.06, 0.06, 0.05, 10), tread, 0, 0, 0, Math.PI / 2, 0, 0);
      blade.build(disc);
      inner.add(disc);
      spinners.push(disc);
      break;
    }
    case 'slugger': { // cap with brim, bat on the back, pinstripes
      const jersey = std(0xffffff, 0.7, 0, { map: pinstripes() }), team = std(color, 0.55), skin = std(0xe0a27a, 0.7), wood = std(0xc89a5a, 0.5);
      body.add(box(0.2, 0.68, 0.24), jersey, -0.12, 0.42, 0).add(box(0.2, 0.68, 0.24), jersey, 0.12, 0.42, 0);
      body.add(box(0.22, 0.1, 0.3), std(0x111111, 0.6), -0.12, 0.05, 0.03).add(box(0.22, 0.1, 0.3), std(0x111111, 0.6), 0.12, 0.05, 0.03);
      body.add(box(0.2, 0.08, 0.25), team, -0.12, 0.2, 0).add(box(0.2, 0.08, 0.25), team, 0.12, 0.2, 0); // socks
      body.add(box(0.5, 0.66, 0.3), jersey, 0, 1.1, 0);
      body.add(box(0.1, 0.36, 0.12), jersey, -0.3, 1.16, 0.02).add(box(0.1, 0.36, 0.12), jersey, 0.3, 1.16, 0.02);
      body.add(box(0.09, 0.2, 0.1), skin, -0.3, 0.88, 0.04).add(box(0.09, 0.2, 0.1), skin, 0.3, 0.88, 0.04);
      body.add(box(0.12, 0.08, 0.12), skin, 0, 1.46, 0);
      body.add(box(0.2, 0.2, 0.02), team, 0, 1.12, -0.16); // number patch
      body.add(cyl(0.035, 0.02, 0.82, 10), wood, 0.05, 1.05, -0.2, 0, 0, 0.45); // bat across the back
      face.add(sph(0.13), skin, 0, 0.13, 0);
      face.add(sph(0.14, 14, 8), team, 0, 0.18, 0, 0, 0, 0, [1, 0.75, 1]);
      face.add(box(0.24, 0.025, 0.14), team, 0, 0.17, 0.15); // brim
      face.add(box(0.05, 0.02, 0.02), std(0x111111), -0.05, 0.13, 0.125).add(box(0.05, 0.02, 0.02), std(0x111111), 0.05, 0.13, 0.125);
      face.add(box(0.06, 0.06, 0.02), std(0x0f2a7a), 0, 0.23, 0.12); // cap logo
      break;
    }
    case 'bear': { // Night Bear: round ears, muzzle, bow tie, glowing red eyes
      const fur = std(color, 0.85), belly = std(0xd8b088, 0.85), dark = std(0x1a0e08, 0.6), eye = glow(0xff1a1a, 3.5);
      body.add(cyl(0.12, 0.13, 0.72), fur, -0.13, 0.36, 0).add(cyl(0.12, 0.13, 0.72), fur, 0.13, 0.36, 0);
      body.add(box(0.2, 0.08, 0.28), dark, -0.13, 0.04, 0.04).add(box(0.2, 0.08, 0.28), dark, 0.13, 0.04, 0.04);
      body.add(sph(0.31), fur, 0, 1.06, 0, 0, 0, 0, [1, 1.2, 0.95]);
      body.add(sph(0.22), belly, 0, 1.02, 0.12, 0, 0, 0, [1, 1.25, 0.7]);
      body.add(cyl(0.07, 0.075, 0.56), fur, -0.27, 1.02, 0.02, 0, 0, 0.1).add(cyl(0.07, 0.075, 0.56), fur, 0.27, 1.02, 0.02, 0, 0, -0.1);
      body.add(box(0.11, 0.09, 0.05), dark, -0.065, 1.42, 0.2).add(box(0.11, 0.09, 0.05), dark, 0.065, 1.42, 0.2).add(box(0.04, 0.05, 0.06), dark, 0, 1.42, 0.2);
      face.add(sph(0.15), fur, 0, 0.14, 0);
      face.add(sph(0.075), belly, 0, 0.1, 0.12, 0, 0, 0, [1.1, 0.8, 0.8]);
      face.add(sph(0.03, 8, 6), dark, 0, 0.12, 0.18);
      face.add(box(0.1, 0.012, 0.01), dark, 0, 0.065, 0.165);
      face.add(sph(0.055), fur, -0.12, 0.24, 0).add(sph(0.055), fur, 0.12, 0.24, 0);
      face.add(sph(0.03, 8, 6), belly, -0.12, 0.24, 0.03).add(sph(0.03, 8, 6), belly, 0.12, 0.24, 0.03);
      face.add(sph(0.027, 8, 6), eye, -0.055, 0.17, 0.13).add(sph(0.027, 8, 6), eye, 0.055, 0.17, 0.13);
      break;
    }
    case 'ghost': { // Phantom: see-through robe, glowing core
      const robe = std(color, 0.3, 0, { transparent: true, opacity: 0.6, depthWrite: false }), core = glow(0x9a8aff, 4), eye = glow(0xe8f0ff, 3);
      body.add(cyl(0.2, 0.34, 1.0, 16), robe, 0, 0.5, 0);
      body.add(cyl(0.22, 0.2, 0.5, 16), robe, 0, 1.25, 0);
      body.add(cyl(0.06, 0.09, 0.5, 8), robe, -0.23, 1.12, 0.05, 0, 0, 0.3).add(cyl(0.06, 0.09, 0.5, 8), robe, 0.23, 1.12, 0.05, 0, 0, -0.3);
      body.add(sph(0.12), core, 0, 1.18, 0);
      body.add(sph(0.045), core, 0, 0.75, 0);
      face.add(sph(0.15), robe, 0, 0.14, 0, 0, 0, 0, [1, 1.05, 1]);
      face.add(box(0.05, 0.025, 0.02), eye, -0.05, 0.15, 0.14).add(box(0.05, 0.025, 0.02), eye, 0.05, 0.15, 0.14);
      break;
    }
    case 'astro': { // Astro: white suit, visor dome, backpack
      const suit = std(color, 0.55), trim = std(0x8a94a6, 0.4, 0.6), visor = std(0x1a2a5a, 0.08, 0.9, { emissive: new THREE.Color(0x203a80), emissiveIntensity: 0.6 }), light = glow(0x33e0ff, 2.5), red = glow(0xff4030, 2.5);
      body.add(cyl(0.11, 0.12, 0.72), suit, -0.13, 0.36, 0).add(cyl(0.11, 0.12, 0.72), suit, 0.13, 0.36, 0);
      body.add(box(0.22, 0.12, 0.3), trim, -0.13, 0.06, 0.03).add(box(0.22, 0.12, 0.3), trim, 0.13, 0.06, 0.03);
      body.add(box(0.5, 0.66, 0.34), suit, 0, 1.08, 0);
      body.add(box(0.2, 0.14, 0.03), trim, 0, 1.16, 0.18);
      body.add(box(0.04, 0.04, 0.02), light, -0.05, 1.16, 0.2).add(box(0.04, 0.04, 0.02), red, 0.05, 1.16, 0.2);
      body.add(cyl(0.06, 0.07, 0.5, 10), suit, -0.28, 1.08, 0.02).add(cyl(0.06, 0.07, 0.5, 10), suit, 0.28, 1.08, 0.02);
      body.add(box(0.42, 0.5, 0.15), trim, 0, 1.1, -0.25); // backpack
      body.add(cyl(0.05, 0.05, 0.42, 10), suit, -0.1, 1.1, -0.29).add(cyl(0.05, 0.05, 0.42, 10), suit, 0.1, 1.1, -0.29);
      body.add(cyl(0.16, 0.17, 0.06, 16), trim, 0, 1.47, 0); // neck ring
      face.add(sph(0.16, 16, 12), suit, 0, 0.14, 0);
      face.add(sph(0.14, 16, 10, ), visor, 0, 0.145, 0.04, 0, 0, 0, [0.95, 0.75, 0.85]);
      face.add(box(0.03, 0.06, 0.03), light, 0.13, 0.26, -0.02);
      break;
    }
    default: { // chef: tall hat, apron, pizza on the back
      const shirt = std(color, 0.6), apron = std(0xf6f2ea, 0.8), pants = std(0x222428, 0.7), skin = std(0xe8b08a, 0.7), hat = std(0xffffff, 0.6), tache = std(0x3a2414, 0.8);
      const crust = std(0xd08a3a, 0.8), sauce = std(0xffc040, 0.7), pep = std(0xc02a1a, 0.6);
      body.add(box(0.2, 0.7, 0.24), pants, -0.12, 0.35, 0).add(box(0.2, 0.7, 0.24), pants, 0.12, 0.35, 0);
      body.add(box(0.54, 0.72, 0.34), shirt, 0, 1.08, 0);
      body.add(box(0.4, 0.8, 0.03), apron, 0, 0.88, 0.18);
      body.add(box(0.1, 0.4, 0.12), shirt, -0.3, 1.14, 0.02).add(box(0.1, 0.4, 0.12), shirt, 0.3, 1.14, 0.02);
      body.add(box(0.09, 0.14, 0.1), skin, -0.3, 0.88, 0.04).add(box(0.09, 0.14, 0.1), skin, 0.3, 0.88, 0.04);
      body.add(box(0.14, 0.1, 0.14), skin, 0, 1.46, 0);
      // a whole pie strapped to the back
      body.add(cyl(0.26, 0.26, 0.04, 20), crust, 0, 1.1, -0.2, Math.PI / 2, 0, 0);
      body.add(cyl(0.22, 0.22, 0.045, 20), sauce, 0, 1.1, -0.205, Math.PI / 2, 0, 0);
      for (const [x, y] of [[-0.1, 0.06], [0.08, 0.1], [0.02, -0.1], [-0.12, -0.08], [0.13, -0.04]]) body.add(cyl(0.035, 0.035, 0.05, 10), pep, x, 1.1 + y, -0.21, Math.PI / 2, 0, 0);
      face.add(sph(0.12), skin, 0, 0.1, 0);
      face.add(box(0.13, 0.025, 0.03), tache, 0, 0.07, 0.115);
      face.add(box(0.03, 0.025, 0.02), std(0x111111), -0.045, 0.12, 0.11).add(box(0.03, 0.025, 0.02), std(0x111111), 0.045, 0.12, 0.11);
      face.add(cyl(0.12, 0.11, 0.07, 14), hat, 0, 0.19, 0);
      face.add(sph(0.12, 14, 8), hat, 0, 0.23, 0, 0, 0, 0, [1.15, 0.6, 1.15]); // puffy top, still under 1.8 m
      break;
    }
  }
  body.build(inner);
  face.build(head);

  // team stripe (belt)
  const stripe = new THREE.Mesh(box(R * 1.6, 0.07, R * 1.05), new THREE.MeshBasicMaterial({ color: team === 0 ? 0x7f5cff : 0xffb300 }));
  stripe.position.y = 0.8;
  inner.add(stripe);
  if (spinners.length) {
    const spin = spinners[0];
    const mesh = spin.children[0];
    mesh.onBeforeRender = () => { spin.rotation.z = (performance.now() / 1000) * 18; };
  }
  return {
    group, head, gun,
    setCrouch(c) { const s = c ? PLAYER.crouchHeight / PLAYER.height : 1; group.scale.y = s; },
  };
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  let off = 0;
  for (const g of parts) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0); }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export function makeNameTag(name: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const w = Math.min(250, ctx.measureText(name).width + 24);
  ctx.beginPath(); ctx.roundRect(128 - w / 2, 8, w, 48, 10); ctx.fill();
  ctx.fillStyle = color; ctx.fillText(name, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = PLAYER.height + 0.3;
  return sprite;
}
