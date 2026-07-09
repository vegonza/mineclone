/**
 * The block you are holding, drawn in the bottom-right of the screen in its own
 * overlay scene so it never clips into the world. Swings when you use it.
 */
import {
  BufferAttribute, BufferGeometry, Color, PerspectiveCamera, Scene, ShaderMaterial, Mesh, DoubleSide,
} from 'three';
import { BLOCK_TILES, PASS_OF, PASS_CROSS } from '../core/blocks.js';

const VERT = /* glsl */ `
attribute vec2 aTile;
varying vec2 vUv;
flat varying float vLayer;
flat varying float vFace;

void main() {
  int code = int(aTile.y + 0.5);
  int corner = (code >> 4) & 3;
  vUv = vec2(float(((corner + 1) >> 1) & 1), float(corner >> 1));
  vLayer = aTile.x;
  vFace = float(code & 7);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2DArray uTex;
uniform vec3 uLight;

varying vec2 vUv;
flat varying float vLayer;
flat varying float vFace;

const float FACE_SHADE[7] = float[7](0.62, 0.62, 1.0, 0.5, 0.82, 0.82, 0.96);

void main() {
  vec4 texel = texture(uTex, vec3(vUv, vLayer));
  if (texel.a < 0.35) discard;
  gl_FragColor = vec4(texel.rgb * uLight * FACE_SHADE[int(vFace + 0.5)], 1.0);

  #include <colorspace_fragment>
}
`;

// Same corner layout as the chunk mesher: (0,0) (1,0) (1,1) (0,1)
const FACES = [
  { p: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] }, // +X
  { p: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // -X
  { p: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // +Y
  { p: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y
  { p: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +Z
  { p: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // -Z
];

function buildBlockGeometry(blockId) {
  const positions = [];
  const tiles = [];
  const indices = [];

  const push = (corners, layer, faceCode) => {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(corners[i][0] - 0.5, corners[i][1] - 0.5, corners[i][2] - 0.5);
      tiles.push(layer, faceCode | (i << 4));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  if (PASS_OF[blockId] === PASS_CROSS) {
    const layer = BLOCK_TILES[blockId * 6];
    const a = 0.15;
    const b = 0.85;
    push([[a, 0, a], [b, 0, b], [b, 1, b], [a, 1, a]], layer, 6);
    push([[b, 0, a], [a, 0, b], [a, 1, b], [b, 1, a]], layer, 6);
  } else {
    for (let f = 0; f < 6; f++) push(FACES[f].p, BLOCK_TILES[blockId * 6 + f], f);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('aTile', new BufferAttribute(new Uint8Array(tiles), 2, false));
  geo.setIndex(indices);
  return geo;
}

export class ViewModel {
  constructor(textureArray) {
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(68, 1, 0.01, 10);
    this.camera.position.set(0, 0, 0);

    this.material = new ShaderMaterial({
      uniforms: {
        uTex: { value: textureArray },
        uLight: { value: new Color(1, 1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: DoubleSide,
    });

    this.mesh = new Mesh(buildBlockGeometry(1), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.blockId = 1;
    this.swing = 0;
    this.bob = 0;
    this.visible = true;
  }

  setBlock(blockId) {
    if (blockId === this.blockId) return;
    this.blockId = blockId;
    this.mesh.geometry.dispose();
    this.mesh.geometry = buildBlockGeometry(blockId);
    this.swing = Math.max(this.swing, 0.35);
  }

  trigger() {
    this.swing = 1;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt, { light, bobAmount, bobPhase }) {
    this.swing = Math.max(0, this.swing - dt * 3.6);
    this.material.uniforms.uLight.value.setRGB(light, light, light);

    const s = Math.sin(this.swing * Math.PI);
    const bobX = Math.cos(bobPhase) * 0.014 * bobAmount;
    const bobY = Math.abs(Math.sin(bobPhase)) * 0.014 * bobAmount;

    this.mesh.position.set(0.44 + bobX - s * 0.1, -0.42 + bobY - s * 0.22, -0.72 + s * 0.16);
    this.mesh.scale.setScalar(0.36);
    this.mesh.rotation.set(0.16 - s * 0.9, -0.48 + s * 0.35, 0.1 + s * 0.25);
  }

  render(renderer) {
    if (!this.visible) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
