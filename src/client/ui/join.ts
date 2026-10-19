// Join screen: name, character, primary marker, room code.
import * as THREE from 'three';
import { CHARACTERS, DEFAULT_PRIMARY, PRIMARY_WEAPONS, WEAPONS, type WeaponId } from '../../shared/constants';
import { buildSkin } from '../world/skins';
import { el, esc } from './hud';

export interface JoinChoice { name: string; skin: string; primary: WeaponId; room: string }
export interface JoinDefaults extends Partial<JoinChoice> { rooms?: string[] }

const MARKER_BLURB: Partial<Record<WeaponId, string>> = {
  semi: 'accurate · 5 a second',
  auto: 'hold it down · 10 a second',
  pump: 'scoped · one ball, you\'re out',
};

const ROOM_A = ['night', 'bot', 'slug', 'bear', 'ghost', 'astro', 'pizza', 'spin', 'cage', 'dugout', 'home', 'rally'];
const ROOM_B = ['pit', 'den', 'yard', 'match', 'lane', 'box', 'run', 'out', 'inning', 'arena'];

export function cleanRoom(raw: string): string {
  return (raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'family').slice(0, 24);
}

export function inviteUrl(room: string): string {
  return `https://strikenight.redleg.dev/?room=${cleanRoom(room)}`;
}

export function randomRoom(avoid = ''): string {
  for (let i = 0; i < 8; i++) {
    const code = `${ROOM_A[Math.floor(Math.random() * ROOM_A.length)]}-${ROOM_B[Math.floor(Math.random() * ROOM_B.length)]}${10 + Math.floor(Math.random() * 90)}`;
    if (code !== avoid) return code.slice(0, 24);
  }
  return `night-${Math.random().toString(36).slice(2, 6)}`;
}

export function showJoin(parent: HTMLElement, defaults: JoinDefaults): Promise<JoinChoice> {
  return new Promise(resolve => {
    const knownSkin = CHARACTERS.some(c => c.id === defaults.skin) ? defaults.skin! : CHARACTERS[0].id;
    const knownWeapon = defaults.primary && PRIMARY_WEAPONS.includes(defaults.primary) ? defaults.primary : DEFAULT_PRIMARY;
    let skin = knownSkin;
    let primary: WeaponId = knownWeapon;
    const recent = [...new Set((defaults.rooms ?? []).map(cleanRoom))].slice(0, 5);
    const coarse = window.matchMedia('(pointer: coarse)').matches;

    const root = el('div', 'join');
    root.innerHTML = `
      ${coarse ? '<div class="touch">Plays with a keyboard and a trackpad or mouse. Touch alone can only look around.</div>' : ''}
      <header class="brand">
        <h1>STRIKE <span>NIGHT</span></h1>
        <p class="tag">family paintball · browser · no install</p>
      </header>
      <div class="stage">
        <canvas aria-hidden="true"></canvas>
        <div class="who"><b></b><small></small></div>
      </div>
      <form class="card">
        <label for="name">Your name</label>
        <input type="text" id="name" maxlength="14" placeholder="Name" autocomplete="nickname" value="${esc(defaults.name ?? '')}" />
        <label>Character</label>
        <div class="skins">${CHARACTERS.map(c => `<button type="button" class="skin ${c.id === skin ? 'sel' : ''}" data-skin="${c.id}" style="--skin:${c.color}"><b>${esc(c.name)}</b></button>`).join('')}</div>
        <label>Marker</label>
        <div class="weapons">${PRIMARY_WEAPONS.map(w => `<button type="button" class="weapon ${w === primary ? 'sel' : ''}" data-w="${w}">${WEAPONS[w].name}<small style="display:block;font-weight:600;font-size:11px;opacity:0.7;margin-top:2px">${MARKER_BLURB[w] ?? ''}</small></button>`).join('')}</div>
        <label for="room">Room</label>
        <div class="room"><input type="text" id="room" maxlength="24" spellcheck="false" autocapitalize="off" value="${esc(defaults.room ?? 'family')}" /></div>
        <p class="invite"></p>
        <div class="room-actions">
          <button type="button" class="alt copy">Copy invite link</button>
          <button type="button" class="alt random">Random room</button>
        </div>
        <div class="recent"${recent.length ? '' : ' hidden'}>${recent.map(r => `<button type="button" class="chip" data-room="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <button type="button" class="go">PLAY</button>
      </form>
      <div class="howto"><kbd>WASD</kbd> move · <kbd>Mouse</kbd> aim · <kbd>Click</kbd> shoot · 3 hits and you're out · first to 30 marks, or best when time runs out · <kbd>Enter</kbd> plays</div>`;
    parent.appendChild(root);

    const name = root.querySelector('#name') as HTMLInputElement;
    const room = root.querySelector('#room') as HTMLInputElement;
    const invite = root.querySelector('.invite') as HTMLElement;
    const whoB = root.querySelector('.who b') as HTMLElement;
    const whoS = root.querySelector('.who small') as HTMLElement;
    const canvas = root.querySelector('canvas') as HTMLCanvasElement;
    const copyBtn = root.querySelector('.copy') as HTMLButtonElement;

    const paintWho = () => {
      const c = CHARACTERS.find(x => x.id === skin) ?? CHARACTERS[0];
      whoB.textContent = c.name;
      whoS.textContent = c.blurb;
    };
    const paintInvite = () => { invite.textContent = inviteUrl(room.value).replace('https://', ''); };
    const markRoom = () => {
      const code = cleanRoom(room.value);
      root.querySelectorAll<HTMLButtonElement>('.chip').forEach(b => b.classList.toggle('sel', b.dataset.room === code));
    };
    const selectSkin = (id: string) => {
      skin = id;
      root.querySelectorAll<HTMLButtonElement>('.skin').forEach(b => b.classList.toggle('sel', b.dataset.skin === id));
      paintWho();
    };
    paintWho();
    paintInvite();
    markRoom();

    const stopPreview = mountPreview(canvas, () => skin);
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      stopPreview();
      const n = name.value.trim() || 'Player';
      const r = cleanRoom(room.value);
      root.remove();
      resolve({ name: n, skin, primary, room: r });
    };

    root.querySelectorAll<HTMLButtonElement>('.skin').forEach(b => b.addEventListener('click', () => selectSkin(b.dataset.skin!)));
    root.querySelectorAll<HTMLButtonElement>('.weapon').forEach(b => b.addEventListener('click', () => {
      primary = b.dataset.w as WeaponId;
      root.querySelectorAll('.weapon').forEach(x => x.classList.toggle('sel', x === b));
    }));
    root.querySelector('.go')!.addEventListener('click', go);
    room.addEventListener('input', () => { paintInvite(); markRoom(); });
    copyBtn.addEventListener('click', async () => {
      const link = inviteUrl(room.value);
      try {
        await navigator.clipboard.writeText(link);
        flash(copyBtn, 'Copied');
      } catch {
        flash(copyBtn, 'Select the link');
        room.focus();
        room.select();
      }
    });
    root.querySelector('.random')!.addEventListener('click', () => {
      room.value = randomRoom(cleanRoom(room.value));
      paintInvite();
      markRoom();
    });
    root.querySelectorAll<HTMLButtonElement>('.chip').forEach(b => b.addEventListener('click', () => {
      room.value = b.dataset.room ?? 'family';
      paintInvite();
      markRoom();
    }));
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const t = e.target;
        if (t instanceof HTMLButtonElement && !t.classList.contains('go')) return;
        e.preventDefault();
        go();
        return;
      }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = CHARACTERS.findIndex(c => c.id === skin);
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      selectSkin(CHARACTERS[(i + dir + CHARACTERS.length) % CHARACTERS.length].id);
    });
    if (!name.value) name.focus();
  });
}

function flash(btn: HTMLButtonElement, text: string) {
  const prev = btn.dataset.label ?? btn.textContent ?? '';
  if (!btn.dataset.label) btn.dataset.label = prev;
  btn.textContent = text;
  window.setTimeout(() => { btn.textContent = btn.dataset.label ?? prev; }, 1200);
}

function mountPreview(canvas: HTMLCanvasElement, getSkin: () => string): () => void {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch {
    return () => {};
  }
  if (!renderer.getContext()) { renderer.dispose(); return () => {}; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
  camera.position.set(0.2, 1.18, 5.9);
  camera.lookAt(0, 0.86, 0);
  scene.add(new THREE.HemisphereLight(0xb7c4ea, 0x2a2018, 0.9));
  scene.add(new THREE.AmbientLight(0x8a93a8, 0.45));
  const key = new THREE.PointLight(0xfff1dd, 70, 18, 2);
  key.position.set(1.8, 2.6, 2.6);
  scene.add(key);
  const rim = new THREE.PointLight(0xff3b3b, 28, 12, 2);
  rim.position.set(-1.8, 1.7, -1.1);
  scene.add(rim);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1.15, 40),
    new THREE.MeshStandardMaterial({ color: 0x141824, roughness: 0.82, metalness: 0.2 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.74, 40),
    new THREE.MeshBasicMaterial({ color: 0xff3b3b, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  let current = getSkin();
  let rig = buildSkin(current);
  scene.add(rig.group);
  let raf = 0;
  let alive = true;
  const resize = () => {
    const w = canvas.clientWidth || 260;
    const h = canvas.clientHeight || 360;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  const tick = (t: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    const next = getSkin();
    if (next !== current) {
      scene.remove(rig.group);
      disposeObj(rig.group);
      current = next;
      rig = buildSkin(current);
      scene.add(rig.group);
    }
    // Skins face -Z. Turn them toward the camera (+Z) and drift so the gun stays in frame.
    rig.group.rotation.y = Math.PI - 0.45 + Math.sin(t * 0.00045) * 0.4;
    rig.group.position.y = Math.sin(t * 0.0012) * 0.02;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    disposeObj(rig.group);
    floor.geometry.dispose();
    (floor.material as THREE.Material).dispose();
    ring.geometry.dispose();
    (ring.material as THREE.Material).dispose();
    renderer.dispose();
  };
}

function disposeObj(o: THREE.Object3D) {
  o.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach(m => m.dispose());
    else mat.dispose();
  });
}
