/** Dumps the tile-layer mapping and each layer's average colour. */
import { boot } from './harness.mjs';

const { page, close } = await boot({ seed: 1337 });
try {
  const info = await page.evaluate(() => {
    const { blocks, materials } = window.mineclon;
    const { TILE_NAMES, BLOCK_TILES, BLOCKS } = blocks;

    const tex = materials.opaque.uniforms.uTex.value;
    const data = tex.image.data;
    const size = tex.image.width * tex.image.height * 4;

    const avg = (layer) => {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const off = layer * size;
      for (let i = 0; i < size; i += 4) {
        r += data[off + i]; g += data[off + i + 1]; b += data[off + i + 2]; a += data[off + i + 3];
        n++;
      }
      return [r / n, g / n, b / n, a / n].map((v) => Math.round(v));
    };

    const layers = TILE_NAMES.map((name, i) => ({ i, name, avg: avg(i) }));

    const faces = (id) => {
      const out = [];
      for (let f = 0; f < 6; f++) {
        const layer = BLOCK_TILES[id * 6 + f];
        out.push(`${f}:${layer}=${TILE_NAMES[layer]}`);
      }
      return out.join('  ');
    };

    const interesting = ['BIRCH_LEAVES', 'OAK_LEAVES', 'BIRCH_LOG', 'OAK_LOG', 'GRASS', 'STONE'];
    const blockFaces = interesting.map((n) => `${n} (id ${blocks[n]}) → ${faces(blocks[n])}`);

    return {
      layerCount: tex.image.depth,
      tileCount: TILE_NAMES.length,
      layers,
      blockFaces,
      blockCount: BLOCKS.length,
    };
  });

  console.log(`texture array depth ${info.layerCount}, TILE_NAMES ${info.tileCount}, blocks ${info.blockCount}\n`);
  for (const l of info.layers) console.log(`  ${String(l.i).padStart(2)}  ${l.name.padEnd(18)} avg rgba ${l.avg.join(',')}`);
  console.log();
  for (const b of info.blockFaces) console.log('  ' + b);
} finally {
  await close();
}
