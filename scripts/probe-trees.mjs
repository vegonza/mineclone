/** Finds logs that are exposed to the open sky (i.e. bare trunks) and photographs one. */
import { writeFile } from 'node:fs/promises';
import { boot, sleep } from './harness.mjs';

const { page, close } = await boot({ seed: 1337 });
try {
  const found = await page.evaluate(() => {
    const { world, blocks } = window.mineclon;
    const names = {};
    for (const [k, v] of Object.entries(blocks)) if (typeof v === 'number') names[v] = k;
    const isLog = (id) => /_LOG$/.test(names[id] ?? '');
    const isLeaf = (id) => /_LEAVES$/.test(names[id] ?? '');

    const hits = [];
    for (let z = -60; z <= 60; z++) {
      for (let x = -60; x <= 60; x++) {
        if (!world.isLoadedAt(x, z)) continue;
        for (let y = 60; y < 100; y++) {
          if (!isLog(world.getBlock(x, y, z))) continue;
          // A trunk block with nothing but sky above it.
          let clear = true;
          for (let d = 1; d <= 4; d++) {
            const id = world.getBlock(x, y + d, z);
            if (id !== blocks.AIR) { clear = false; break; }
          }
          if (!clear) continue;
          let leafNear = false;
          for (let dy = -1; dy <= 2 && !leafNear; dy++)
            for (let dz = -2; dz <= 2 && !leafNear; dz++)
              for (let dx = -2; dx <= 2; dx++)
                if (isLeaf(world.getBlock(x + dx, y + dy, z + dz))) { leafNear = true; break; }
          hits.push({ x, y, z, kind: names[world.getBlock(x, y, z)], leafNear });
        }
      }
    }
    return hits;
  });

  console.log(`exposed log tops: ${found.length}`);
  for (const h of found.slice(0, 12)) console.log(' ', JSON.stringify(h));

  const bare = found.filter((h) => !h.leafNear);
  console.log(`of which fully bare (no leaves within 2): ${bare.length}`);

  const target = bare[0] ?? found[0];
  if (target) {
    await page.evaluate((t) => {
      const { player, sky } = window.mineclon;
      sky.setTime(0.36);
      sky.frozen = true;
      player.flying = true;
      player.velocity.set(0, 0, 0);
      player.position.set(t.x + 8.5, t.y + 1.5, t.z + 8.5);
      player.yaw = Math.atan2(8, 8) + Math.PI; // look back at the trunk
      player.pitch = -0.1;
      document.getElementById('debug').hidden = false;
    }, target);
    await sleep(2500);
    await writeFile('/tmp/bare-trunk.png', await page.screenshot());
    console.log('wrote /tmp/bare-trunk.png for', target);
  }
} finally {
  await close();
}
