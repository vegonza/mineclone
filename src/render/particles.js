/**
 * GPU point-sprite particles for block breaking.
 *
 * Each particle samples a random 4×4 texel window of the broken block's tile,
 * so the debris genuinely looks like chips of that block.
 */
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, NormalBlending, Points, ShaderMaterial } from 'three';
import { BLOCK_TILES, IS_SOLID } from '../core/blocks.js';
import { GRAVITY } from '../core/constants.js';

const MAX_PARTICLES = 600;

const VERT = /* glsl */ `
attribute float aLayer;
attribute vec2 aUvMin;
attribute float aSize;
attribute float aLight;

uniform float uPixelRatio;

varying float vLayer;
varying vec2 vUvMin;
varying float vLight;

void main() {
  vLayer = aLayer;
  vUvMin = aUvMin;
  vLight = aLight;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * 300.0 / max(-mv.z, 0.1);
}
`;

const FRAG = /* glsl */ `
uniform sampler2DArray uTex;

varying float vLayer;
varying vec2 vUvMin;
varying float vLight;

void main() {
  vec2 uv = vUvMin + gl_PointCoord * 0.22;
  vec4 texel = texture(uTex, vec3(uv, vLayer));
  if (texel.a < 0.4) discard;
  gl_FragColor = vec4(texel.rgb * vLight, 1.0);

  #include <colorspace_fragment>
}
`;

export class Particles {
  constructor(scene, textureArray) {
    this.count = 0;
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.layers = new Float32Array(MAX_PARTICLES);
    this.uvMin = new Float32Array(MAX_PARTICLES * 2);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.lights = new Float32Array(MAX_PARTICLES);

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('aLayer', new BufferAttribute(this.layers, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('aUvMin', new BufferAttribute(this.uvMin, 2).setUsage(DynamicDrawUsage));
    geo.setAttribute('aSize', new BufferAttribute(this.sizes, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('aLight', new BufferAttribute(this.lights, 1).setUsage(DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = null;

    this.geometry = geo;
    this.material = new ShaderMaterial({
      uniforms: {
        uTex: { value: textureArray },
        uPixelRatio: { value: window.devicePixelRatio || 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: NormalBlending,
      transparent: false,
      depthWrite: true,
    });

    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    scene.add(this.points);
  }

  /** Spawns a puff of debris at the centre of the given block. */
  burst(bx, by, bz, blockId, light = 1, amount = 22) {
    const layer = BLOCK_TILES[blockId * 6 + 2];
    for (let i = 0; i < amount && this.count < MAX_PARTICLES; i++) {
      const p = this.count++;
      this.positions[p * 3] = bx + 0.15 + Math.random() * 0.7;
      this.positions[p * 3 + 1] = by + 0.15 + Math.random() * 0.7;
      this.positions[p * 3 + 2] = bz + 0.15 + Math.random() * 0.7;

      const a = Math.random() * Math.PI * 2;
      const s = 1.2 + Math.random() * 2.4;
      this.velocities[p * 3] = Math.cos(a) * s * 0.6;
      this.velocities[p * 3 + 1] = 2.2 + Math.random() * 3.2;
      this.velocities[p * 3 + 2] = Math.sin(a) * s * 0.6;

      this.maxLife[p] = 0.55 + Math.random() * 0.55;
      this.life[p] = this.maxLife[p];
      this.layers[p] = layer;
      this.uvMin[p * 2] = Math.random() * 0.78;
      this.uvMin[p * 2 + 1] = Math.random() * 0.78;
      this.sizes[p] = 0.045 + Math.random() * 0.05;
      this.lights[p] = light;
    }
  }

  update(dt, world) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._swapRemove(i);
        continue;
      }

      const vi = i * 3;
      this.velocities[vi + 1] -= GRAVITY * 0.55 * dt;

      for (let axis = 0; axis < 3; axis++) {
        const next = this.positions[vi + axis] + this.velocities[vi + axis] * dt;
        const probe = [this.positions[vi], this.positions[vi + 1], this.positions[vi + 2]];
        probe[axis] = next;
        const solid = IS_SOLID[world.getBlock(Math.floor(probe[0]), Math.floor(probe[1]), Math.floor(probe[2]))];
        if (solid) {
          this.velocities[vi + axis] *= -0.24;
          if (axis === 1) {
            this.velocities[vi] *= 0.68;
            this.velocities[vi + 2] *= 0.68;
          }
        } else {
          this.positions[vi + axis] = next;
        }
      }

      // Shrink as they die out.
      this.sizes[i] *= 1 - dt * 0.55;
      i++;
    }

    const geo = this.geometry;
    geo.setDrawRange(0, this.count);
    if (this.count > 0) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aLayer.needsUpdate = true;
      geo.attributes.aUvMin.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aLight.needsUpdate = true;
    }
  }

  _swapRemove(i) {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.positions[i * 3 + k] = this.positions[last * 3 + k];
      this.velocities[i * 3 + k] = this.velocities[last * 3 + k];
    }
    this.uvMin[i * 2] = this.uvMin[last * 2];
    this.uvMin[i * 2 + 1] = this.uvMin[last * 2 + 1];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.layers[i] = this.layers[last];
    this.sizes[i] = this.sizes[last];
    this.lights[i] = this.lights[last];
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.points.parent?.remove(this.points);
  }
}
