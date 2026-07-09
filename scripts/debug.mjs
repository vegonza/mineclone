import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const PORT = 4179;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const executablePath = ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/brave'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = Number(process.argv[2] ?? 25000);

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});

await sleep(2500);

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--mute-audio'],
});

const page = await browser.newPage();
await page.setViewport({ width: 800, height: 500 });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
page.on('requestfailed', (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`${APP_URL}?seed=1337`, { waitUntil: 'domcontentloaded' });

for (let i = 0; i < Math.ceil(WAIT / 5000); i++) {
  await sleep(5000);
  const state = await page.evaluate(() => {
    if (!window.mineclon) return { boot: false };
    const { world } = window.mineclon;
    return {
      boot: true,
      loaded: window.mineclon.loaded,
      spawned: window.mineclon.spawned,
      progress: +world.loadProgress.toFixed(3),
      requests: world.generationRequests,
      generated: world.generatedCount,
      chunks: world.chunks.size,
      dirty: world.dirtyMeshes.size,
      pendingMesh: world.meshResults.length,
      poolQueued: world.pool.queued,
      meshes: world.group.children.length,
      tris: window.mineclon.renderer.info.render.triangles,
      sun: world.sunAdd.size,
      sunRem: world.sunRemove.size,
      playerY: +window.mineclon.player.position.y.toFixed(1),
    };
  }).catch((e) => ({ evalError: String(e) }));
  console.log(`t=${(i + 1) * 5}s`, JSON.stringify(state));
}

await page.screenshot({ path: new URL('../shots/debug.png', import.meta.url).pathname }).catch(() => {});
await browser.close();
server.kill('SIGTERM');
process.exit(0);
