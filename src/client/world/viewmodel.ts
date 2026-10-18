// First-person weapon model attached to the camera. Primitive-built; the world
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

// muzzle tip per weapon, in viewmodel-group space
const MUZZLE: Record<WeaponId, [number, number, number]> = {
  knife: [0, 0, -0.25], pistol: [0, 0.01, -0.18], rifle: [0, 0.02, -0.72], shotgun: [0, 0.01, -0.52], sniper: [0, 0.02, -0.92],
};

export function buildViewmodel(camera: THREE.Camera): Viewmodel {
  const group = new THREE.Group();
  camera.add(group);
  const base = new THREE.Vector3(0.28, -0.26, -0.55);
  group.position.copy(base);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f26, metalness: 0.7, roughness: 0.35 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.8 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0x440000, roughness: 0.5 });
  const models: Record<WeaponId, THREE.Group> = { knife: new THREE.Group(), pistol: new THREE.Group(), rifle: new THREE.Group(), shotgun: new THREE.Group(), sniper: new THREE.Group() };
  const add = (g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  // rifle
  add(models.rifle, new THREE.BoxGeometry(0.06, 0.09, 0.62), dark, 0, 0, -0.1);
  add(models.rifle, new THREE.BoxGeometry(0.05, 0.16, 0.06), dark, 0, -0.1, 0.05);
  add(models.rifle, new THREE.BoxGeometry(0.03, 0.14, 0.05), accent, 0, -0.1, -0.08);
  add(models.rifle, new THREE.CylinderGeometry(0.012, 0.012, 0.3).rotateX(Math.PI / 2), dark, 0, 0.02, -0.55);
  add(models.rifle, new THREE.BoxGeometry(0.07, 0.08, 0.2), wood, 0, -0.02, 0.3);
  // pistol
  add(models.pistol, new THREE.BoxGeometry(0.04, 0.06, 0.22), dark, 0, 0, -0.05);
  add(models.pistol, new THREE.BoxGeometry(0.035, 0.13, 0.05), dark, 0, -0.08, 0.05);
  // shotgun
  add(models.shotgun, new THREE.CylinderGeometry(0.02, 0.02, 0.6).rotateX(Math.PI / 2), dark, 0, 0.01, -0.2);
  add(models.shotgun, new THREE.CylinderGeometry(0.02, 0.02, 0.3).rotateX(Math.PI / 2), wood, 0, -0.03, -0.15);
  add(models.shotgun, new THREE.BoxGeometry(0.07, 0.09, 0.3), wood, 0, -0.03, 0.3);
  // sniper
  add(models.sniper, new THREE.BoxGeometry(0.05, 0.08, 0.8), dark, 0, 0, -0.15);
  add(models.sniper, new THREE.CylinderGeometry(0.025, 0.025, 0.2).rotateX(Math.PI / 2), dark, 0, 0.08, 0);
  add(models.sniper, new THREE.CylinderGeometry(0.01, 0.01, 0.4).rotateX(Math.PI / 2), dark, 0, 0.02, -0.7);
  add(models.sniper, new THREE.BoxGeometry(0.06, 0.1, 0.25), accent, 0, -0.04, 0.35);
  // knife
  add(models.knife, new THREE.BoxGeometry(0.03, 0.08, 0.12), wood, 0, -0.02, 0.05);
  add(models.knife, new THREE.BoxGeometry(0.008, 0.04, 0.22), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.2 }), 0, 0, -0.12);
  for (const m of Object.values(models)) { m.visible = false; group.add(m); }
  let current: WeaponId = 'rifle';
  models.rifle.visible = true;
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
      if (current === 'knife') return;
      const m = MUZZLE[current];
      flashSprite.position.set(m[0], m[1], m[2] - 0.03);
      const s = (current === 'shotgun' || current === 'sniper' ? 0.32 : current === 'pistol' ? 0.17 : 0.22) * (0.85 + Math.random() * 0.3);
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
      group.visible = alive && !(scoped && current === 'sniper');
    },
  };
}
