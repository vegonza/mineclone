/**
 * Mineclon — an infinite voxel sandbox in the browser.
 * Boot, game loop, and the glue between world / player / renderer / UI.
 */
import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';

import { REACH, RENDER_DISTANCE, SEA_LEVEL } from './core/constants.js';
import * as Blocks from './core/blocks.js';
import { AIR, BEDROCK, BLOCKS, IS_SOLID, isReplaceable } from './core/blocks.js';
import { hashSeed } from './core/noise.js';

import { World } from './world/world.js';
import { EditStore } from './persistence/db.js';

import { BlockMaterials } from './render/materials.js';
import { Sky } from './render/sky.js';
import { Particles } from './render/particles.js';
import { BlockHighlight } from './render/highlight.js';
import { ViewModel } from './render/viewmodel.js';
import { Avatar } from './render/avatar.js';

import { Player } from './player/player.js';
import { Controls } from './player/controls.js';
import { raycastVoxels } from './player/raycast.js';

import { Hud } from './ui/hud.js';
import { Inventory } from './ui/inventory.js';
import { AudioEngine } from './audio/audio.js';

const CAMERA_MODES = ['First person', 'Third person', 'Front view'];
const BASE_FOV = 74;

// ── Seed plumbing ───────────────────────────────────────────────────────────

function readSeed() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('seed') ?? new URLSearchParams(location.hash.slice(1)).get('seed');
  const raw = fromUrl ?? localStorage.getItem('mineclon:seed') ?? String(Math.floor(Math.random() * 1e9));
  localStorage.setItem('mineclon:seed', raw);
  return { raw, value: /^\d+$/.test(raw) ? Number(raw) >>> 0 : hashSeed(raw) };
}

function gotoSeed(raw) {
  localStorage.setItem('mineclon:seed', raw);
  location.search = `?seed=${encodeURIComponent(raw)}`;
}

/**
 * Walks outward from the origin looking for dry land. Falls back to the water
 * surface, so an all-ocean seed still spawns you somewhere sane.
 */
function findGoodSpawn(world) {
  const step = 13;
  let fallback = null;

  for (let ring = 0; ring <= 8; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
        const x = dx * step;
        const z = dz * step;
        const p = world.findSpawn(x, z);
        if (!p) continue;
        if (p.y > SEA_LEVEL + 1 && p.y < 108) return p;
        if (!fallback) fallback = p;
      }
    }
  }

  return fallback ?? new Vector3(0.5, SEA_LEVEL + 2, 0.5);
}

const FACINGS = ['south (+Z)', 'west (-X)', 'north (-Z)', 'east (+X)'];

function facing(yaw) {
  return FACINGS[Math.round(-yaw / (Math.PI / 2)) & 3];
}

function formatTime(t) {
  const minutes = Math.round(t * 24 * 60) % 1440;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  const canvas = document.getElementById('game');
  const loadingEl = document.getElementById('loading');
  const loadingFill = document.querySelector('.loading-fill');
  const menuEl = document.getElementById('menu');
  const menuFooter = document.getElementById('menu-footer');
  const seedInput = document.getElementById('seed-input');

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.autoClear = false;
  // We draw the world and the view model as two passes, so stats must survive
  // across both render() calls.
  renderer.info.autoReset = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.08, 3000);
  camera.position.set(0.5, 100, 0.5);

  const { raw: seedRaw, value: seed } = readSeed();
  seedInput.value = seedRaw;

  const materials = new BlockMaterials(renderer);
  const sky = new Sky(scene);
  const particles = new Particles(scene, materials.texture);
  const highlight = new BlockHighlight(scene);
  const avatar = new Avatar(scene);
  const viewModel = new ViewModel(materials.texture);
  viewModel.setAspect(window.innerWidth / window.innerHeight);

  const store = await EditStore.open(seed);
  const world = new World(seed, {
    getMaterial: (pass) => materials.get(pass),
    renderDistance: RENDER_DISTANCE,
    store,
  });
  scene.add(world.group);

  const player = new Player(world);
  player.position.set(0.5, 100, 0.5);

  const hud = new Hud();
  const audio = new AudioEngine();
  const inventory = new Inventory((id) => {
    hud.setSlot(hud.selected, id);
    hud.showHeldName();
    audio.click();
    closeInventory();
  });

  // ── State ─────────────────────────────────────────────────────────────────

  let playing = false;
  let spawned = false;
  let loaded = false;
  let cameraMode = 0;
  let menuYaw = 0;
  let lastFootPhase = 0;
  let wasInWater = false;
  let fps = 60;
  let elapsed = 0;
  let lastFrameTime = performance.now();

  /** Zeroed input so the player still settles onto the ground behind the menu. */
  const IDLE_INPUT = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };

  const tmpVec = new Vector3();
  const eye = new Vector3();
  const dir = new Vector3();

  const playerLight = () => {
    const l = world.getLightAt(
      Math.floor(player.position.x),
      Math.floor(player.position.y + 1),
      Math.floor(player.position.z),
    );
    const skyL = (l >> 4) / 15;
    const blockL = (l & 15) / 15;
    return Math.min(1, Math.max(skyL * sky.dayFactor, blockL * 0.95) * 1.05 + 0.06);
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  function getTarget() {
    player.eyePosition(eye);
    player.lookDirection(dir);
    return raycastVoxels(world, eye, dir, REACH);
  }

  function breakBlock() {
    const hit = getTarget();
    viewModel.trigger();
    if (!hit) return;
    if (hit.block === BEDROCK) {
      hud.toast('Bedrock cannot be broken');
      return;
    }
    const light = Math.max(0.45, ((world.getLightAt(hit.x, hit.y + 1, hit.z) >> 4) / 15) * sky.dayFactor);
    particles.burst(hit.x, hit.y, hit.z, hit.block, light);
    audio.breakBlock(BLOCKS[hit.block].sound);
    world.setBlock(hit.x, hit.y, hit.z, AIR);
  }

  function placeBlock() {
    const hit = getTarget();
    viewModel.trigger();
    if (!hit) return;

    const held = hud.heldBlock;
    if (held == null || held === AIR) return;

    let { x, y, z } = hit;
    if (!isReplaceable(hit.block)) {
      x += hit.nx;
      y += hit.ny;
      z += hit.nz;
    }

    if (!isReplaceable(world.getBlock(x, y, z))) return;
    if (IS_SOLID[held] && player.intersectsBlock(x, y, z)) return;
    if (!world.isLoadedAt(x, z)) return;

    if (world.setBlock(x, y, z, held)) audio.placeBlock(BLOCKS[held].sound);
  }

  function pickBlock() {
    const hit = getTarget();
    if (!hit) return;
    const slot = hud.slots.indexOf(hit.block);
    if (slot >= 0) hud.select(slot);
    else hud.setSlot(hud.selected, hit.block);
    hud.showHeldName();
  }

  function openMenu() {
    playing = false;
    controls.exitLock();
    menuEl.hidden = false;
    hud.hide();
    menuYaw = player.yaw;
  }

  function startPlaying() {
    if (!loaded) return;
    menuEl.hidden = true;
    inventory.hide();
    hud.show();
    playing = true;
    audio.resume();
    controls.requestLock();
  }

  function openInventory() {
    if (!playing) return;
    inventory.show();
    controls.exitLock();
  }

  function closeInventory() {
    if (!inventory.open) return;
    inventory.hide();
    if (playing) controls.requestLock();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  const controls = new Controls(canvas, player, {
    onBreak: breakBlock,
    onPlace: placeBlock,
    onPick: pickBlock,
    onSelectSlot: (i) => hud.select(i),
    onScrollSlot: (d) => hud.scroll(d),
    onToggleFly: () => {
      player.flying = !player.flying;
      if (player.flying) player.velocity.y = 0;
      hud.toast(player.flying ? 'Flight enabled' : 'Flight disabled', 1.2);
    },
    onToggleDebug: () => hud.toggleDebug(),
    onCycleCamera: () => {
      cameraMode = (cameraMode + 1) % 3;
      hud.toast(CAMERA_MODES[cameraMode], 1.2);
    },
    onToggleInventory: () => (inventory.open ? closeInventory() : openInventory()),
    onPause: () => {
      if (inventory.open) closeInventory();
      else if (playing) openMenu();
    },
    onLockLost: () => {
      if (playing && !inventory.open) openMenu();
    },
    onCanvasClick: () => {
      if (loaded && !menuEl.hidden && !inventory.open) startPlaying();
      else if (playing) controls.requestLock();
    },
    onSkipTime: () => {
      sky.setTime(sky.timeOfDay + 0.12);
      hud.toast(`Time ${formatTime(sky.timeOfDay)}`, 1.2);
    },
    onFreezeTime: () => {
      sky.frozen = !sky.frozen;
      hud.toast(sky.frozen ? 'Time frozen' : 'Time running', 1.2);
    },
    onRespawn: () => {
      player.respawn();
      hud.toast('Respawned', 1.2);
    },
  });

  // ── Menu wiring ───────────────────────────────────────────────────────────

  document.getElementById('btn-play').addEventListener('click', () => {
    audio.resume();
    startPlaying();
  });
  document.getElementById('btn-regen').addEventListener('click', () => {
    gotoSeed(String(Math.floor(Math.random() * 1e9)));
  });
  document.getElementById('btn-reset').addEventListener('click', async () => {
    await store.clear();
    location.reload();
  });
  seedInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && seedInput.value.trim()) gotoSeed(seedInput.value.trim());
  });

  window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    viewModel.setAspect(aspect);
    renderer.setSize(window.innerWidth, window.innerHeight);
    particles.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  });
  window.addEventListener('beforeunload', () => store.flush());

  // ── Per-frame subsystems ──────────────────────────────────────────────────

  function updateCamera(dt) {
    if (!playing) {
      menuYaw += dt * 0.05;
      player.yaw = menuYaw;
      player.pitch = -0.12;
    }

    player.eyePosition(eye);

    if (cameraMode === 0 && playing) {
      const b = player.bobAmount;
      eye.y += Math.sin(player.bobPhase * 2) * 0.042 * b;
      const sway = Math.cos(player.bobPhase) * 0.048 * b;
      eye.x += Math.cos(player.yaw) * sway;
      eye.z -= Math.sin(player.yaw) * sway;
    }

    player.lookDirection(dir);

    if (cameraMode === 0) {
      camera.position.copy(eye);
      camera.lookAt(tmpVec.copy(eye).add(dir));
    } else {
      // Behind the player, or in front of them looking back.
      const sign = cameraMode === 1 ? -1 : 1;
      const rayDir = tmpVec.copy(dir).multiplyScalar(sign).normalize();
      const wanted = 4.4;
      const hit = raycastVoxels(world, eye, rayDir, wanted);
      const dist = hit ? Math.max(0.5, hit.distance - 0.3) : wanted;
      camera.position.copy(eye).addScaledVector(rayDir, dist);
      camera.lookAt(eye);
    }

    const targetFov = BASE_FOV + player.fovBoost * 7 + (player.headInWater ? -6 : 0);
    if (Math.abs(camera.fov - targetFov) > 0.005) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 9);
      camera.updateProjectionMatrix();
    }
  }

  function updateEnvironment() {
    const u = materials.uniforms;
    u.uTime.value = elapsed;
    u.uDayFactor.value = sky.dayFactor;
    u.uSkyColor.value.copy(sky.skyColor).lerp(sky.sunColor, 0.4).multiplyScalar(1.1);
    u.uTorchColor.value.setRGB(1.0, 0.66, 0.36);

    const far = RENDER_DISTANCE * 16;
    if (player.headInWater) {
      u.uFogColor.value.setRGB(0.02, 0.09, 0.2).multiplyScalar(0.35 + sky.dayAmount * 0.65);
      u.uFogNear.value = 0.2;
      u.uFogFar.value = 20;
      u.uAmbient.value.set(0.03, 0.05, 0.09);
    } else {
      u.uFogColor.value.copy(sky.fogColor);
      u.uFogNear.value = far * 0.5;
      u.uFogFar.value = far * 0.97;
      u.uAmbient.value.set(0.032, 0.033, 0.042);
    }
    hud.setUnderwater(player.headInWater);
  }

  function updateFeedback() {
    if (!playing) return;

    if (player.onGround && player.bobAmount > 0.15) {
      const phase = Math.floor(player.bobPhase / Math.PI);
      if (phase !== lastFootPhase) {
        lastFootPhase = phase;
        const below = world.getBlock(
          Math.floor(player.position.x),
          Math.floor(player.position.y - 0.1),
          Math.floor(player.position.z),
        );
        if (below !== AIR) audio.footstep(BLOCKS[below].sound);
      }
    }

    if (player.inWater !== wasInWater) {
      wasInWater = player.inWater;
      if (player.inWater) audio.splash();
    }
  }

  function updateDebug() {
    if (!hud.debugVisible) return;
    const p = player.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    const light = world.getLightAt(bx, by, bz);
    const info = renderer.info.render;

    hud.updateDebug([
      `Mineclon · ${fps.toFixed(0)} fps · ${(info.triangles / 1000).toFixed(0)}k tris · ${info.calls} draws`,
      `xyz    ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `block  ${bx} ${by} ${bz}   chunk ${bx >> 4} ${bz >> 4}`,
      `facing ${facing(player.yaw)}   pitch ${(player.pitch * 57.2958).toFixed(0)}°`,
      `biome  ${world.getBiomeName(bx, bz)}`,
      `light  sky ${light >> 4} · block ${light & 15}   daylight ${(sky.dayFactor * 100) | 0}%`,
      `time   ${formatTime(sky.timeOfDay)}${sky.frozen ? '  (frozen)' : ''}`,
      `state  ${player.flying ? 'flying' : player.onGround ? 'grounded' : 'airborne'}${player.inWater ? ' · swimming' : ''}`,
      `chunks ${world.chunks.size} loaded · ${world.busy} pending`,
      `seed   ${seedRaw}`,
    ]);
  }

  function updateLoading() {
    if (loaded) return;
    const progress = Math.min(0.99, world.loadProgress * 0.8 + (1 - Math.min(1, world.busy / 40)) * 0.2);
    loadingFill.style.width = `${(progress * 100).toFixed(0)}%`;
    menuFooter.textContent = `generating · ${world.chunks.size} chunks`;

    if (spawned && world.loadProgress >= 0.999 && world.busy <= 3) {
      loaded = true;
      loadingFill.style.width = '100%';
      loadingEl.classList.add('fade');
      setTimeout(() => {
        loadingEl.hidden = true;
      }, 420);
      menuFooter.textContent = `seed ${seedRaw} · ${world.chunks.size} chunks loaded`;
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  function frame() {
    requestAnimationFrame(frame);

    const now = performance.now();
    const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;
    elapsed += dt;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

    world.update(player.position.x, player.position.y, player.position.z);

    if (!spawned && world.loadProgress >= 0.985 && world.isLoadedAt(0, 0)) {
      const spawn = findGoodSpawn(world);
      player.position.copy(spawn);
      player.spawn.copy(spawn);
      player.velocity.set(0, 0, 0);
      player.yaw = 0.6;
      spawned = true;
    }

    updateLoading();

    if (spawned) {
      if (playing) {
        controls.update(dt);
        player.update(dt, controls.input);
      } else {
        player.update(dt, IDLE_INPUT);
      }
    }

    updateCamera(dt);
    sky.update(dt, elapsed, camera);
    updateEnvironment();
    updateFeedback();
    particles.update(dt, world);
    hud.update(dt);

    const light = playerLight();
    avatar.setVisible(cameraMode !== 0 && playing);
    avatar.update(player.position, player.yaw, player.pitch, player.bobPhase, player.bobAmount, light);

    viewModel.visible = playing && cameraMode === 0;
    viewModel.setBlock(hud.heldBlock ?? 1);
    viewModel.update(dt, { light, bobAmount: player.bobAmount, bobPhase: player.bobPhase });

    if (playing) {
      const hit = getTarget();
      if (hit) highlight.showAt(hit.x, hit.y, hit.z);
      else highlight.hide();
    } else {
      highlight.hide();
    }

    renderer.info.reset();
    renderer.clear();
    renderer.render(scene, camera);
    viewModel.render(renderer);

    updateDebug();
  }

  hud.hide();
  frame();

  window.mineclon = {
    world, player, sky, renderer, materials, hud, store, camera,
    blocks: Blocks,
    startPlaying,
    getTarget,
    actions: { breakBlock, placeBlock, pickBlock },
    setCameraMode: (m) => { cameraMode = m % 3; },
    get playing() { return playing; },
    get loaded() { return loaded; },
    get spawned() { return spawned; },
  };
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) {
    el.hidden = false;
    el.classList.remove('fade');
    el.innerHTML = `<div class="loading-inner"><div class="loading-title">Failed to start:<br>${String(err?.message ?? err)}</div></div>`;
  }
});
