/**
 * Chunk worker: terrain generation + meshing, off the main thread.
 * One of these runs per hardware thread (see WorkerPool in world.js).
 */
import { WorldGen } from './generator.js';
import { meshChunk } from './mesher.js';

/** @type {WorldGen|null} */
let gen = null;

self.onmessage = (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      gen = new WorldGen(msg.seed);
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'generate': {
      const { blocks, biomes, heights } = gen.generateChunk(msg.cx, msg.cz);
      self.postMessage(
        { type: 'generated', cx: msg.cx, cz: msg.cz, blocks, biomes, heights },
        [blocks.buffer, biomes.buffer, heights.buffer],
      );
      break;
    }

    case 'mesh': {
      const result = meshChunk(msg.blocks, msg.light, msg.cx, msg.cz);
      const transfer = [];
      for (const key of ['opaque', 'cutout', 'transparent']) {
        const r = result[key];
        if (r) transfer.push(r.positions.buffer, r.light.buffer, r.tile.buffer, r.indices.buffer);
      }
      self.postMessage({ type: 'meshed', cx: msg.cx, cz: msg.cz, revision: msg.revision, ...result }, transfer);
      break;
    }
  }
};
