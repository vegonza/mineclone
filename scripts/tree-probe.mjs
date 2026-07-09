import { WorldGen } from '../src/world/generator.js';
import { BLOCKS } from '../src/core/blocks.js';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY } from '../src/core/constants.js';

const gen = new WorldGen(1337);
const idx = (x, y, z) => x + z * CHUNK_SX + y * CHUNK_SX * CHUNK_SZ;
const name = (id) => BLOCKS[id].name;

let bare = 0;
let total = 0;

for (let cz = -2; cz <= 2; cz++) {
  for (let cx = -2; cx <= 2; cx++) {
    const { blocks } = gen.generateChunk(cx, cz);
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        for (let y = 1; y < CHUNK_SY - 2; y++) {
          const id = blocks[idx(x, y, z)];
          if (!/log/.test(name(id))) continue;
          const below = blocks[idx(x, y - 1, z)];
          if (/log/.test(name(below))) continue; // only trunk bases

          // Walk up the trunk and see what caps it.
          let t = y;
          while (t < CHUNK_SY - 1 && /log/.test(name(blocks[idx(x, t + 1, z)]))) t++;
          total++;

          let leafy = false;
          for (let d = 1; d <= 3 && t + d < CHUNK_SY; d++) {
            if (/leaves/.test(name(blocks[idx(x, t + d, z)]))) leafy = true;
          }
          if (leafy) continue;

          bare++;
          if (bare <= 6) {
            const col = [];
            for (let yy = y - 1; yy <= t + 3; yy++) col.push(`${yy}:${name(blocks[idx(x, yy, z)])}`);
            console.log(`chunk ${cx},${cz} local ${x},${z}  trunk ${y}..${t}\n   ${col.join('  ')}`);
          }
        }
      }
    }
  }
}

console.log(`\n${bare}/${total} trunks have no leaves above them`);
