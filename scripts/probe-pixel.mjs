/**
 * Reproduces the `day.png` pose, then reports which block sits under a list of
 * screen pixels. Usage: node scripts/probe-pixel.mjs 200,525 230,530
 */
import { writeFile } from 'node:fs/promises';
import { boot, sleep } from './harness.mjs';

const pixels = process.argv.slice(2).map((s) => s.split(',').map(Number));
if (!pixels.length) pixels.push([640, 360]);

const { page, close } = await boot({ seed: 1337 });
try {
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
  await sleep(2500);
  await writeFile('/tmp/pose.png', await page.screenshot());

  const results = await page.evaluate((pixels) => {
    const { world, camera, blocks } = window.mineclon;
    const names = {};
    for (const [k, v] of Object.entries(blocks)) if (typeof v === 'number') names[v] = k;

    const V = camera.position.constructor;
    const out = [];
    for (const [px, py] of pixels) {
      const ndc = new V((px / window.innerWidth) * 2 - 1, -((py / window.innerHeight) * 2 - 1), 0.5);
      ndc.unproject(camera);
      const dir = ndc.sub(camera.position).normalize();

      let hit = null;
      const p = camera.position.clone();
      for (let t = 0; t < 300; t += 0.05) {
        const x = Math.floor(p.x + dir.x * t);
        const y = Math.floor(p.y + dir.y * t);
        const z = Math.floor(p.z + dir.z * t);
        if (y < 0 || y > 255) break;
        const id = world.getBlock(x, y, z);
        if (id !== blocks.AIR && id !== blocks.WATER) {
          hit = { px, py, x, y, z, block: names[id] ?? id, dist: +t.toFixed(1) };
          break;
        }
      }
      out.push(hit ?? { px, py, block: 'nothing' });
    }
    return out;
  }, pixels);

  for (const r of results) console.log(JSON.stringify(r));
} finally {
  await close();
}
