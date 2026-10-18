// First-person weapon model attached to the camera. Primitive-built; the world
// agent can replace the meshes, the Game only calls this interface.
import * as THREE from 'three';
import type { WeaponId } from '../../shared/constants';

export interface Viewmodel {
  group: THREE.Group;
  setWeapon(w: WeaponId): void;
  kick(amount: number): void;
  muzzleWorld(): [number, number, number];
  update(dt: number, moveFrac: number, bobPhase: number, reloading: boolean, scoped: boolean, alive: boolean): void;
}

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
  const muzzle = new THREE.Vector3();
  return {
    group,
    setWeapon(w) { for (const [k, m] of Object.entries(models)) m.visible = k === w; current = w; swapT = 1; },
    kick(a) { kickZ += a * 0.03; kickRot += a * 0.05; },
    muzzleWorld() { muzzle.set(0.28, -0.2, -1.0); camera.localToWorld(muzzle); return [muzzle.x, muzzle.y, muzzle.z]; },
    update(dt, moveFrac, bobPhase, reloading, scoped, alive) {
      kickZ *= Math.exp(-dt * 10); kickRot *= Math.exp(-dt * 10);
      swapT = Math.max(0, swapT - dt * 4);
      reloadT = reloading ? Math.min(1, reloadT + dt * 3) : Math.max(0, reloadT - dt * 6);
      const bobX = Math.sin(bobPhase) * 0.012 * moveFrac, bobY = Math.abs(Math.cos(bobPhase)) * 0.01 * moveFrac;
      const scopeK = scoped ? 1 : 0;
      group.position.set(base.x + bobX - scopeK * 0.28, base.y + bobY - swapT * 0.3 - reloadT * 0.15 + scopeK * 0.16, base.z + kickZ + scopeK * 0.1);
      group.rotation.set(-kickRot - reloadT * 0.6, swapT * 0.5 + reloadT * 0.2, 0);
      group.visible = alive && !(scoped && current === 'sniper');
    },
  };
}
