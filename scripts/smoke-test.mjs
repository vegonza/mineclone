/**
 * Headless smoke test.
 *
 * Boots the production build in Chromium (SwiftShader), waits for the world to
 * finish generating, then exercises terrain, lighting, raycasting, block
 * editing and physics. Writes screenshots to ./shots.
 *
 *   npm run build && npm run smoke
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const PORT = 4178;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SHOTS = new URL('../shots/', import.meta.url).pathname;

const CHROME_PATHS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/brave'];
const executablePath = CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chromium binary found.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('preview server never came up');
}

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});

let browser;
try {
  await waitForServer(APP_URL);
  await mkdir(SHOTS, { recursive: true });

  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader-webgl',
      '--ignore-gpu-blocklist',
      '--window-size=1280,720',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

  /** @type {string[]} */
  const errors = [];
  // Chromium's SwiftShader probe intentionally loses a context on startup, and
  // it grumbles about ReadPixels stalls — neither says anything about our code.
  const IGNORE = /CONTEXT_LOST_WEBGL|Context Lost|Context Restored|GL Driver Message|ReadPixels|AudioContext|autoplay|favicon/i;
  page.on('console', (msg) => {
    const text = msg.text();
    if (IGNORE.test(text)) return;
    // Three.js reports shader compile/link failures through console.error.
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`[${msg.type()}] ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

  console.log("\n▸ loading", APP_URL);
  const t0 = Date.now();
  await page.goto(`${APP_URL}?seed=1337`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction('window.mineclon && window.mineclon.loaded === true', { timeout: 180000, polling: 250 });
  const loadMs = Date.now() - t0;
  console.log(`▸ world ready in ${(loadMs / 1000).toFixed(1)}s\n`);

  // ── Assertions ────────────────────────────────────────────────────────────

  const stats = await page.evaluate(() => {
    const { world, player, renderer } = window.mineclon;
    return {
      chunks: world.chunks.size,
      meshes: world.group.children.length,
      triangles: renderer.info.render.triangles,
      draws: renderer.info.render.calls,
      spawn: player.position.toArray().map((v) => +v.toFixed(2)),
      spawnBiome: world.getBiomeName(Math.floor(player.position.x), Math.floor(player.position.z)),
    };
  });

  console.log('World');
  check('chunks streamed', stats.chunks > 200, `${stats.chunks} chunks`);
  check('meshes uploaded', stats.meshes > 150, `${stats.meshes} meshes`);
  check('geometry rendered', stats.triangles > 50000, `${(stats.triangles / 1000).toFixed(0)}k triangles, ${stats.draws} draws`);
  check('spawn is above sea level', stats.spawn[1] > 62, `y=${stats.spawn[1]} in ${stats.spawnBiome}`);

  // Terrain sanity: surface exists, bedrock at the bottom, biomes vary.
  const terrain = await page.evaluate(() => {
    const { world, blocks } = window.mineclon;
    let surfaces = 0;
    let bedrock = 0;
    let solidUnderground = 0;
    let total = 0;
    const biomes = new Set();
    const found = new Set();

    for (let x = -60; x < 60; x += 4) {
      for (let z = -60; z < 60; z += 4) {
        total++;
        biomes.add(world.getBiomeName(x, z));
        if (world.getBlock(x, 0, z) === blocks.BEDROCK) bedrock++;
        if (world.getBlock(x, 20, z) !== blocks.AIR) solidUnderground++;
        for (let y = 120; y > 2; y--) {
          const b = world.getBlock(x, y, z);
          if (b !== blocks.AIR) {
            found.add(b);
            surfaces++;
            break;
          }
        }
      }
    }
    return { surfaces, bedrock, solidUnderground, total, biomes: [...biomes], distinct: found.size };
  });

  console.log('\nTerrain');
  check('every column has a surface', terrain.surfaces === terrain.total, `${terrain.surfaces}/${terrain.total}`);
  check('bedrock floor present', terrain.bedrock === terrain.total, `${terrain.bedrock}/${terrain.total}`);
  check('underground is mostly solid', terrain.solidUnderground > terrain.total * 0.7, `${terrain.solidUnderground}/${terrain.total}`);
  check('caves carved out', terrain.solidUnderground < terrain.total, `${terrain.total - terrain.solidUnderground} air pockets at y=20`);
  check('multiple biomes generated', terrain.biomes.length >= 2, terrain.biomes.join(', '));
  check('varied surface blocks', terrain.distinct >= 3, `${terrain.distinct} distinct block types`);

  // Lighting: open sky is bright, deep underground is dark, shade is in between.
  const light = await page.evaluate(() => {
    const { world, player, blocks } = window.mineclon;
    const x = Math.floor(player.position.x);
    const z = Math.floor(player.position.z);

    let openSky = 0;
    let dark = 0;
    let samples = 0;
    for (let dx = -24; dx <= 24; dx += 8) {
      for (let dz = -24; dz <= 24; dz += 8) {
        samples++;
        if ((world.getLightAt(x + dx, 120, z + dz) >> 4) === 15) openSky++;
        if ((world.getLightAt(x + dx, 8, z + dz) >> 4) === 0) dark++;
      }
    }

    // Roof a cell over and it should go dark; remove the roof and it recovers.
    const px = x + 40;
    const py = 100;
    const pz = z + 40;
    const beforeRoof = world.getLightAt(px, py, pz) >> 4;
    world.setBlock(px, py + 1, pz, blocks.STONE);
    for (let i = 0; i < 60; i++) world.processLight(400000);
    const shaded = world.getLightAt(px, py, pz) >> 4;
    world.setBlock(px, py + 1, pz, blocks.AIR);
    for (let i = 0; i < 60; i++) world.processLight(400000);
    const restored = world.getLightAt(px, py, pz) >> 4;

    return { openSky, dark, samples, beforeRoof, shaded, restored };
  });

  console.log('\nLighting');
  check('open sky is fully lit', light.openSky === light.samples, `${light.openSky}/${light.samples} at y=120`);
  check('deep underground is pitch dark', light.dark === light.samples, `${light.dark}/${light.samples} at y=8`);
  check('placing a roof casts shade', light.beforeRoof === 15 && light.shaded < 15, `${light.beforeRoof} → ${light.shaded}`);
  check('removing the roof restores sunlight', light.restored === 15, `→ ${light.restored}`);

  // Raycast + block editing round-trip.
  const editing = await page.evaluate(async () => {
    const { world, player, actions } = window.mineclon;
    window.mineclon.startPlaying();
    await new Promise((r) => requestAnimationFrame(r));

    // Aim straight down at the block under our feet.
    player.pitch = -Math.PI / 2 + 0.02;
    const hit = window.mineclon.getTarget();
    if (!hit) return { hit: false };

    const before = world.getBlock(hit.x, hit.y, hit.z);
    actions.breakBlock();
    const afterBreak = world.getBlock(hit.x, hit.y, hit.z);

    const held = window.mineclon.hud.heldBlock;
    actions.placeBlock();
    const afterPlace = world.getBlock(hit.x, hit.y, hit.z);

    return { hit: true, before, afterBreak, afterPlace, held };
  });

  console.log('\nInteraction');
  check('raycast finds a block', editing.hit === true);
  check('breaking clears the block', editing.afterBreak === 0, `id ${editing.before} → ${editing.afterBreak}`);
  check('placing restores a block', editing.afterPlace === editing.held, `placed id ${editing.afterPlace}`);

  // A light-emitting block must light its surroundings, and un-light them when removed.
  const emissive = await page.evaluate(() => {
    const { world, player, blocks } = window.mineclon;
    const glow = blocks.GLOWSTONE;
    const x = Math.floor(player.position.x) + 2;
    const y = Math.floor(player.position.y) + 3;
    const z = Math.floor(player.position.z);

    const drain = () => {
      for (let i = 0; i < 60; i++) world.processLight(400000);
    };

    world.setBlock(x, y, z, glow);
    drain();
    const self = world.getLightAt(x, y, z) & 15;
    const near = world.getLightAt(x + 1, y, z) & 15;
    const far = world.getLightAt(x + 6, y, z) & 15;

    world.setBlock(x, y, z, 0);
    drain();
    const after = world.getLightAt(x + 1, y, z) & 15;
    return { self, near, far, after };
  });

  console.log('\nBlock light');
  check('emitter is at full brightness', emissive.self === 15, `level ${emissive.self}`);
  check('emitter lights adjacent cell', emissive.near >= 13, `level ${emissive.near}`);
  check('light falls off with distance', emissive.far < emissive.near, `level ${emissive.far} six blocks away`);
  check('removing the emitter clears light', emissive.after === 0, `level ${emissive.after}`);

  // Physics: gravity, landing, and no tunnelling through the floor or walls.
  const physics = await page.evaluate(async () => {
    const { player, world, blocks } = window.mineclon;
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    // Clear a shaft above the spawn so nothing catches us on the way down.
    player.respawn();
    const bx = Math.floor(player.position.x);
    const by = Math.floor(player.position.y);
    const bz = Math.floor(player.position.z);
    for (let y = 1; y <= 12; y++) {
      for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) world.setBlock(bx + x, by + y, bz + z, blocks.AIR);
    }
    for (let i = 0; i < 30; i++) world.processLight(400000);

    const start = player.position.y;
    player.flying = false;
    player.position.y = start + 8;
    player.velocity.set(0, 0, 0);
    for (let i = 0; i < 180; i++) await frame();
    const landed = player.position.y;
    const onGround = player.onGround;

    // Ram a wall at full sprint: we must be stopped by it, not pass through.
    world.setBlock(bx + 2, by, bz, blocks.STONE);
    world.setBlock(bx + 2, by + 1, bz, blocks.STONE);
    player.position.set(bx + 0.5, by + 0.02, bz + 0.5);
    player.velocity.set(0, 0, 0);
    for (let i = 0; i < 90; i++) {
      player.velocity.x = 30;
      await frame();
    }
    const wallX = player.position.x;

    return { start, landed, onGround, wallX, wallAt: bx + 2 };
  });

  console.log('\nPhysics');
  check('player falls and lands', physics.onGround === true, `y ${(physics.start + 8).toFixed(2)} → ${physics.landed.toFixed(2)}`);
  check('lands exactly on the spawn block', Math.abs(physics.landed - physics.start) < 0.1, `Δ ${(physics.landed - physics.start).toFixed(3)}`);
  check(
    'a wall stops a sprinting player',
    physics.wallX > physics.wallAt - 0.45 && physics.wallX < physics.wallAt - 0.25,
    `stopped at x=${physics.wallX.toFixed(2)}, wall at ${physics.wallAt}`,
  );

  // ── Screenshots ───────────────────────────────────────────────────────────

  const settle = (ms) => sleep(ms);

  // An aerial vista at mid-morning.
  await page.evaluate(() => {
    const { player, sky } = window.mineclon;
    sky.setTime(0.36);
    sky.frozen = true;
    player.respawn();
    player.flying = true;
    player.position.y += 22;
    player.velocity.set(0, 0, 0);
    player.pitch = -0.24;
    player.yaw = 0.9;
    document.getElementById('debug').hidden = false;
  });
  await settle(2200);
  await page.screenshot({ path: `${SHOTS}day.png` });

  // Standing on the ground, third-person.
  await page.evaluate(() => {
    const { player } = window.mineclon;
    player.flying = false;
    player.respawn();
    player.pitch = -0.05;
    player.yaw = 0.9;
    window.mineclon.setCameraMode(1);
  });
  await settle(1400);
  await page.screenshot({ path: `${SHOTS}thirdperson.png` });

  // Sunset, looking west from the air.
  await page.evaluate(() => {
    const { player, sky } = window.mineclon;
    window.mineclon.setCameraMode(0);
    player.flying = true;
    player.position.y += 20;
    player.velocity.set(0, 0, 0);
    player.yaw = -Math.PI / 2;
    player.pitch = 0.02;
    sky.setTime(0.742);
  });
  await settle(2000);
  await page.screenshot({ path: `${SHOTS}sunset.png` });

  await page.evaluate(() => window.mineclon.sky.setTime(0.03));
  await settle(1800);
  await page.screenshot({ path: `${SHOTS}night.png` });

  // A glowstone/torch-lit underground chamber.
  await page.evaluate(() => {
    const { player, world, sky, blocks } = window.mineclon;
    sky.setTime(0.36);
    const bx = Math.floor(player.position.x);
    const by = 34;
    const bz = Math.floor(player.position.z);

    for (let y = 0; y < 6; y++) {
      for (let z = -6; z <= 6; z++) {
        for (let x = -6; x <= 6; x++) world.setBlock(bx + x, by + y, bz + z, blocks.AIR);
      }
    }
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) world.setBlock(bx + x, by - 1, bz + z, blocks.STONE_BRICKS);
    }
    world.setBlock(bx + 4, by + 2, bz + 4, blocks.GLOWSTONE);
    world.setBlock(bx - 4, by, bz + 3, blocks.TORCH);
    world.setBlock(bx - 3, by, bz - 4, blocks.TORCH);
    for (let i = 0; i < 120; i++) world.processLight(500000);

    player.flying = true;
    player.position.set(bx - 5.5, by + 1.4, bz - 5.5);
    player.velocity.set(0, 0, 0);
    player.pitch = -0.06;
    player.yaw = -Math.PI / 4 - Math.PI;
  });
  await settle(3000);
  await page.screenshot({ path: `${SHOTS}cave.png` });

  // Underwater, out in the ocean.
  const dove = await page.evaluate(async () => {
    const { player, world, sky, blocks } = window.mineclon;
    sky.setTime(0.4);
    const cx = Math.floor(player.position.x);
    const cz = Math.floor(player.position.z);

    const DEPTH = 58; // water from here up to sea level → room to float in
    const deepWater = (x, z) => {
      if (!world.isLoadedAt(x, z)) return false;
      for (let y = DEPTH; y <= 62; y++) if (world.getBlock(x, y, z) !== blocks.WATER) return false;
      return true;
    };

    let best = null;
    let bestD = Infinity;
    for (let z = cz - 130; z <= cz + 130; z += 2) {
      for (let x = cx - 130; x <= cx + 130; x += 2) {
        const d = (x - cx) ** 2 + (z - cz) ** 2;
        if (d >= bestD || !deepWater(x, z)) continue;
        best = [x, z];
        bestD = d;
      }
    }
    if (!best) return false;

    // Face back towards the shore so there is something to look at.
    player.flying = false;
    player.position.set(best[0] + 0.5, 61, best[1] + 0.5);
    player.velocity.set(0, 0, 0);
    player.pitch = 0.05;
    player.yaw = Math.atan2(-(cx - best[0]), -(cz - best[1]));
    return true;
  });
  if (dove) {
    await settle(2500);
    await page.screenshot({ path: `${SHOTS}underwater.png` });
  }
  check('found water to swim in', dove === true);

  // Steady-state frame rate under SwiftShader (a CPU rasteriser — expect low).
  const perf = await page.evaluate(async () => {
    const frames = 60;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(r));
    return (frames * 1000) / (performance.now() - t0);
  });

  console.log('\nRuntime');
  check('render loop keeps running', perf > 1, `${perf.toFixed(1)} fps (software rasteriser)`);

  const realErrors = errors.filter((e) => !/Download the React|favicon|AudioContext|autoplay/i.test(e));
  console.log('\nConsole');
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 6).join(' | ') || 'clean');

  console.log(`\n${failures === 0 ? '\u001b[32mAll checks passed\u001b[0m' : `\u001b[31m${failures} check(s) failed\u001b[0m`}`);
  console.log(`Screenshots → ${SHOTS}\n`);
} catch (err) {
  console.error('\nSmoke test crashed:', err);
  failures++;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

process.exit(failures === 0 ? 0 : 1);
