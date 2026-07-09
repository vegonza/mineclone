/** Aims the crosshair at a screen pixel from the `day.png` pose and reports the hit. */
import { writeFile } from 'node:fs/promises';
import { boot, sleep } from './harness.mjs';

const [px, py] = (process.argv[2] ?? '202,524').split(',').map(Number);

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
  });
  await sleep(2000);

  const aimed = await page.evaluate(({ px, py }) => {
    const { player, camera } = window.mineclon;
    const V = camera.position.constructor;
    const ndc = new V((px / window.innerWidth) * 2 - 1, -((py / window.innerHeight) * 2 - 1), 0.5);
    ndc.unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    player.yaw = Math.atan2(-dir.x, -dir.z);
    player.pitch = Math.asin(dir.y);
    return { dir: [dir.x, dir.y, dir.z].map((v) => +v.toFixed(3)), yaw: player.yaw, pitch: player.pitch };
  }, { px, py });
  console.log('aim', JSON.stringify(aimed));

  await sleep(1500);
  const hit = await page.evaluate(() => {
    const { getTarget, blocks, world } = window.mineclon;
    const names = {};
    for (const [k, v] of Object.entries(blocks)) if (typeof v === 'number') names[v] = k;
    const t = getTarget();
    if (!t) return null;
    const around = [];
    for (let dy = 2; dy >= -2; dy--) {
      let row = `y${t.y + dy}: `;
      for (let dz = -1; dz <= 1; dz++) row += `${names[world.getBlock(t.x, t.y + dy, t.z + dz)] ?? '?'} `;
      around.push(row);
    }
    return { x: t.x, y: t.y, z: t.z, block: names[t.block] ?? t.block, normal: [t.nx, t.ny, t.nz], around };
  });
  console.log('hit', JSON.stringify(hit, null, 1));

  await writeFile('/tmp/aim.png', await page.screenshot());
  console.log('wrote /tmp/aim.png');
} finally {
  await close();
}
