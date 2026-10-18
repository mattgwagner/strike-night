// Character meshes. Each skin returns a Group whose origin is at the feet and
// whose +Z is the character's forward (the renderer rotates by yaw). Keep the
// bounds inside the shared PLAYER box so what you see is what gets hit.
import * as THREE from 'three';
import { CHARACTERS, PLAYER } from '../../shared/constants';

export interface SkinRig { group: THREE.Group; head: THREE.Object3D; gun: THREE.Object3D; setCrouch(c: boolean): void }

export function buildSkin(skinId: string, team: 0 | 1 = 0): SkinRig {
  const def = CHARACTERS.find(c => c.id === skinId) ?? CHARACTERS[0];
  const color = new THREE.Color(def.color);
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: def.id === 'bot' ? 0.7 : 0.1 });
  const darkMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.45), roughness: 0.8 });
  const r = PLAYER.radius;
  const torsoH = 0.75;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(r * 1.8, torsoH, r * 1.1), bodyMat);
  torso.position.y = 0.75 + torsoH / 2;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, 0.75, r * 0.9), darkMat);
  legs.position.y = 0.375;
  const head = new THREE.Group();
  const headMesh = new THREE.Mesh(def.id === 'bot' ? new THREE.BoxGeometry(0.34, 0.3, 0.34) : new THREE.SphereGeometry(0.19, 12, 10), bodyMat);
  headMesh.position.y = 0.17;
  head.add(headMesh);
  head.position.y = PLAYER.height - PLAYER.headHeight - 0.02;
  // eyes so you can tell which way they face
  const eyeMat = new THREE.MeshBasicMaterial({ color: def.id === 'bear' ? 0xff2020 : 0xffffff });
  for (const sx of [-0.07, 0.07]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), eyeMat);
    e.position.set(sx, 0.2, 0.17);
    head.add(e);
  }
  if (def.id === 'bear') { for (const sx of [-0.12, 0.12]) { const ear = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), bodyMat); ear.position.set(sx, 0.36, 0); head.add(ear); } }
  if (def.id === 'slugger') { const brim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.22), darkMat); brim.position.set(0, 0.28, 0.18); head.add(brim); }
  if (def.id === 'bot') { const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.25), darkMat); ant.position.set(0.1, 0.42, 0); head.add(ant); }
  const gun = new THREE.Group();
  const gunMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 }));
  gunMesh.position.set(0, 0, 0.25);
  gun.add(gunMesh);
  gun.position.set(r * 0.9, 1.25, 0.1);
  // team stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(r * 1.85, 0.08, r * 1.15), new THREE.MeshBasicMaterial({ color: team === 0 ? 0x7f5cff : 0xffb300 }));
  stripe.position.y = 0.78;
  g.add(legs, torso, head, gun, stripe);
  g.traverse(o => { o.castShadow = true; });
  return {
    group: g, head, gun,
    setCrouch(c) { const s = c ? PLAYER.crouchHeight / PLAYER.height : 1; g.scale.y = s; },
  };
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = PLAYER.height + 0.3;
  return sprite;
}
