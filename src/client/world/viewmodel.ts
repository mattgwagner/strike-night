// First-person paintball marker attached to the camera. Primitive-built; the world
// agent can replace the meshes, the Game only calls this interface.
import * as THREE from 'three';
import type { WeaponId } from '../../shared/constants';
import { flashTexture } from './fx';

export interface Viewmodel {
  group: THREE.Group;
  setWeapon(w: WeaponId): void;
  kick(amount: number): void;
  muzzleWorld(): [number, number, number];
  /** Where a shell casing leaves the gun, in world space. */
  ejectWorld(): [number, number, number];
  /** Show the muzzle flash sprite for a frame or two. */
  flash(): void;
  /** Mouse movement this frame (pixels) for weapon sway. */
  sway(dx: number, dy: number): void;
  /** Landing dip, 0..1. */
  land(impact: number): void;
  update(dt: number, moveFrac: number, bobPhase: number, reloading: boolean, scoped: boolean, alive: boolean): void;
}

// barrel tip per marker, in viewmodel-group space
const MUZZLE: Record<WeaponId, [number, number, number]> = {
  tag: [0, 0, -0.25], pistol: [0, 0.01, -0.2], semi: [0, 0.02, -0.66], auto: [0, 0.02, -0.6], pump: [0, 0.02, -0.86],
};

export function buildViewmodel(camera: THREE.Camera): Viewmodel {
  const group = new THREE.Group();
  camera.add(group);
  const base = new THREE.Vector3(0.28, -0.26, -0.55);
  group.position.copy(base);
  // paintball markers: bright plastic bodies, a hopper on top, an air tank at the back
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262e, metalness: 0.5, roughness: 0.4 });
  const plastic = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.05 });
  const hopperMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, transparent: true, opacity: 0.55 });
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xffd23b, emissive: 0x332200, roughness: 0.3 });
  const tank = new THREE.MeshStandardMaterial({ color: 0x4a505e, metalness: 0.5, roughness: 0.45 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.85 });
  const models: Record<WeaponId, THREE.Group> = { tag: new THREE.Group(), pistol: new THREE.Group(), semi: new THREE.Group(), auto: new THREE.Group(), pump: new THREE.Group() };
  const add = (g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  const barrel = (len: number, r = 0.014) => new THREE.CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2);
  const marker = (g: THREE.Group, body: number, barrelLen: number, hopperR: number) => {
    add(g, new THREE.BoxGeometry(0.06, 0.08, 0.3), plastic(body), 0, 0, -0.05);                // body
    add(g, new THREE.BoxGeometry(0.045, 0.14, 0.05), dark, 0, -0.1, 0.04);                    // grip
    add(g, new THREE.BoxGeometry(0.02, 0.05, 0.04), dark, 0, -0.06, -0.05);                   // trigger guard
    add(g, barrel(barrelLen), dark, 0, 0.02, -0.2 - barrelLen / 2);                           // barrel
    add(g, new THREE.CylinderGeometry(0.022, 0.022, 0.04, 10), dark, 0, 0.07, -0.06);          // feed neck
    add(g, new THREE.SphereGeometry(hopperR, 14, 10).scale(0.9, 0.8, 1.25), hopperMat, 0, 0.07 + hopperR * 0.8, -0.04); // hopper
    for (let i = 0; i < 4; i++) add(g, new THREE.SphereGeometry(0.017, 8, 6), ballMat, (i % 2 - 0.5) * 0.03, 0.06 + hopperR * 0.6 + (i >> 1) * 0.03, -0.06 + (i % 2) * 0.03);
    add(g, new THREE.CylinderGeometry(0.03, 0.03, 0.16, 12).rotateX(Math.PI / 2), tank, 0, -0.035, 0.18); // air tank
  };
  marker(models.semi, 0x1e9bff, 0.36, 0.07);
  marker(models.auto, 0xff3b6b, 0.3, 0.085);
  // pump: long barrel, a pump handle under it, a scope on top
  marker(models.pump, 0x3fbf5a, 0.58, 0.06);
  add(models.pump, new THREE.BoxGeometry(0.05, 0.04, 0.12), dark, 0, -0.025, -0.36);
  add(models.pump, new THREE.CylinderGeometry(0.022, 0.022, 0.18, 12).rotateX(Math.PI / 2), dark, 0, 0.1, 0.06);
  // sidearm: compact body, a little magazine, no hopper
  add(models.pistol, new THREE.BoxGeometry(0.045, 0.065, 0.2), plastic(0xffb300), 0, 0, -0.04);
  add(models.pistol, new THREE.BoxGeometry(0.035, 0.13, 0.05), dark, 0, -0.08, 0.04);
  add(models.pistol, barrel(0.08, 0.011), dark, 0, 0.01, -0.18);
  add(models.pistol, new THREE.CylinderGeometry(0.02, 0.02, 0.1, 10).rotateX(Math.PI / 2), tank, 0, -0.03, 0.12);
  // hand tag: an open glove, fingers forward
  add(models.tag, new THREE.BoxGeometry(0.09, 0.03, 0.1), glove, 0, 0, -0.02);
  for (let i = 0; i < 4; i++) add(models.tag, new THREE.BoxGeometry(0.018, 0.022, 0.09), glove, -0.033 + i * 0.022, 0, -0.11 - (i === 1 || i === 2 ? 0.01 : 0));
  add(models.tag, new THREE.BoxGeometry(0.02, 0.022, 0.06), glove, 0.055, 0, -0.03).rotation.y = -0.6;
  add(models.tag, new THREE.BoxGeometry(0.06, 0.05, 0.12), plastic(0x1e9bff), 0, -0.005, 0.1); // sleeve
  for (const m of Object.values(models)) { m.visible = false; group.add(m); }
  let current: WeaponId = 'semi';
  models.semi.visible = true;
  let kickZ = 0, kickRot = 0, swapT = 0, reloadT = 0;
  let swayX = 0, swayY = 0, swayVX = 0, swayVY = 0; // spring toward 0, driven by mouse
  let dip = 0, dipV = 0;
  let flashLife = 0, flashFresh = false;
  const muzzle = new THREE.Vector3();
  const flashMat = new THREE.SpriteMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false });
  const flashSprite = new THREE.Sprite(flashMat);
  flashSprite.visible = false; flashSprite.renderOrder = 10;
  group.add(flashSprite);
  return {
    group,
    setWeapon(w) { for (const [k, m] of Object.entries(models)) m.visible = k === w; current = w; swapT = 1; },
    kick(a) { kickZ += a * 0.03; kickRot += a * 0.05; },
    muzzleWorld() { const m = MUZZLE[current]; muzzle.set(m[0], m[1], m[2]); group.updateMatrixWorld(); group.localToWorld(muzzle); return [muzzle.x, muzzle.y, muzzle.z]; },
    ejectWorld() { muzzle.set(0.04, 0.03, current === 'pistol' ? -0.04 : -0.12); group.updateMatrixWorld(); group.localToWorld(muzzle); return [muzzle.x, muzzle.y, muzzle.z]; },
    flash() {
      if (current === 'tag') return;
      const m = MUZZLE[current];
      flashSprite.position.set(m[0], m[1], m[2] - 0.03);
      // markers have no muzzle fire, just a small puff of air
      const s = (current === 'pump' ? 0.14 : current === 'pistol' ? 0.08 : 0.1) * (0.85 + Math.random() * 0.3);
      flashSprite.scale.set(s, s, 1);
      flashMat.rotation = Math.random() * Math.PI;
      flashMat.opacity = 1;
      flashSprite.visible = true; flashLife = 0.05; flashFresh = true;
    },
    sway(dx, dy) {
      swayVX += -dx * 0.00012; swayVY += dy * 0.00012;
    },
    land(impact) { dipV -= impact * 1.6; },
    update(dt, moveFrac, bobPhase, reloading, scoped, alive) {
      kickZ *= Math.exp(-dt * 10); kickRot *= Math.exp(-dt * 10);
      // critically-damped-ish springs for sway and landing dip
      const sk = 120, sd = 16;
      swayVX += (-swayX * sk - swayVX * sd) * dt; swayVY += (-swayY * sk - swayVY * sd) * dt;
      swayX += swayVX * dt; swayY += swayVY * dt;
      swayX = Math.max(-0.05, Math.min(0.05, swayX)); swayY = Math.max(-0.04, Math.min(0.04, swayY));
      dipV += (-dip * 90 - dipV * 13) * dt; dip += dipV * dt;
      if (flashFresh) flashFresh = false; else if (flashLife > 0) { flashLife -= dt; flashMat.opacity = Math.max(0, flashLife / 0.05); if (flashLife <= 0) flashSprite.visible = false; }
      swapT = Math.max(0, swapT - dt * 4);
      reloadT = reloading ? Math.min(1, reloadT + dt * 3) : Math.max(0, reloadT - dt * 6);
      const bobX = Math.sin(bobPhase) * 0.012 * moveFrac, bobY = Math.abs(Math.cos(bobPhase)) * 0.01 * moveFrac;
      const scopeK = scoped ? 1 : 0;
      group.position.set(base.x + bobX + swayX - scopeK * 0.28, base.y + bobY + swayY + dip * 0.12 - swapT * 0.3 - reloadT * 0.15 + scopeK * 0.16, base.z + kickZ + scopeK * 0.1);
      group.rotation.set(-kickRot - reloadT * 0.6 + swayY * 1.5 + dip * 0.3, swapT * 0.5 + reloadT * 0.2 + swayX * 2, -swayX * 3);
      group.visible = alive && !(scoped && current === 'pump');
    },
  };
}
