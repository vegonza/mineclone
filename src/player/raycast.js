import { AIR, WATER, PASS_OF, PASS_NONE } from '../core/blocks.js';

/**
 * Amanatides & Woo voxel traversal.
 *
 * Steps cell-by-cell along the ray, so it is exact and costs O(distance)
 * regardless of how large the world is.
 *
 * @returns {{ x:number, y:number, z:number, nx:number, ny:number, nz:number, block:number, distance:number } | null}
 */
export function raycastVoxels(world, origin, dir, maxDistance = 5, filter = defaultFilter) {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = Math.sign(dir.x);
  const stepY = Math.sign(dir.y);
  const stepZ = Math.sign(dir.z);

  // Distance along the ray to the next voxel boundary on each axis.
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;

  const boundary = (p, step) => (step > 0 ? Math.floor(p) + 1 - p : p - Math.floor(p));

  let tMaxX = stepX !== 0 ? boundary(origin.x, stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? boundary(origin.y, stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? boundary(origin.z, stepZ) * tDeltaZ : Infinity;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  // The cell containing the origin is deliberately skipped: you can't target
  // the block your head is inside.
  while (t <= maxDistance) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDistance) break;

    const block = world.getBlock(x, y, z);
    if (filter(block)) return { x, y, z, nx, ny, nz, block, distance: t };
  }

  return null;
}

function defaultFilter(id) {
  return id !== AIR && id !== WATER && PASS_OF[id] !== PASS_NONE;
}

/** Only stops at blocks you can stand on — used by the spawn finder. */
export const solidFilter = (id) => id !== AIR && id !== WATER;
