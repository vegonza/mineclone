/**
 * Ad-hoc visual probe. Boots the game, runs a snippet of JS in the page to pose
 * the camera, then writes a screenshot.
 *
 *   node scripts/shot.mjs --out /tmp/look.png --pos -12,72,-12 --look 0.9,-0.2 \
 *                         --time 0.36 --debug --settle 2500
 *
 * Everything is optional; with no flags you get the spawn point at mid-morning.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boot, sleep } from './harness.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
const nums = (v) => (v ? v.split(',').map(Number) : null);

const out = flag('out', '/tmp/shot.png');
const pos = nums(flag('pos'));
const look = nums(flag('look'));
const time = flag('time') === null ? 0.36 : Number(flag('time'));
const seed = Number(flag('seed', '1337'));
const settle = Number(flag('settle', '2500'));
const mode = Number(flag('mode', '0'));
const probe = flag('probe', null); // e.g. "-9,66,-14" → prints the block there

const { page, close } = await boot({ seed });
try {
  await page.evaluate(
    ({ pos, look, time, debug, mode }) => {
      const { player, sky } = window.mineclon;
      sky.setTime(time);
      sky.frozen = true;
      window.mineclon.setCameraMode(mode);
      player.flying = true;
      player.velocity.set(0, 0, 0);
      if (pos) player.position.set(pos[0], pos[1], pos[2]);
      if (look) {
        player.yaw = look[0];
        player.pitch = look[1];
      }
      document.getElementById('debug').hidden = !debug;
    },
    { pos, look, time, debug: has('debug'), mode },
  );

  await sleep(settle);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await page.screenshot());
  console.log(`wrote ${out}`);

  if (probe) {
    const [x, y, z] = probe.split(',').map(Number);
    const info = await page.evaluate(
      ({ x, y, z }) => {
        const { world, blocks } = window.mineclon;
        const names = {};
        for (const [k, v] of Object.entries(blocks)) if (typeof v === 'number') names[v] = k;
        const column = [];
        for (let yy = y - 2; yy <= y + 10; yy++) {
          const id = world.getBlock(x, yy, z);
          column.push(`${yy}: ${names[id] ?? id}`);
        }
        return column;
      },
      { x, y, z },
    );
    console.log(info.join('\n'));
  }
} finally {
  await close();
}
