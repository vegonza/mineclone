/**
 * Voxel materials.
 *
 * Three custom shaders share one uniform block and one `sampler2DArray` where
 * every block texture lives in its own layer — no atlas, so no bleeding, and
 * mipmaps just work. Lighting is entirely baked into vertex attributes
 * (ambient occlusion + smoothed sky/block light) and combined here.
 */
import { Color, DoubleSide, FrontSide, ShaderMaterial, Vector3 } from 'three';
import { createTextureArray } from '../core/textures.js';

const VERTEX_SHADER = /* glsl */ `
attribute vec3 aLight;   // x: baked AO brightness, y: sky light, z: block light
attribute vec2 aTile;    // x: texture layer, y: packed face | wave<<3 | corner<<4

uniform float uTime;

varying vec2 vUv;
varying vec3 vLight;
varying float vFogDepth;
flat varying float vLayer;
flat varying float vFace;

void main() {
  int code = int(aTile.y + 0.5);
  int corner = (code >> 4) & 3;

  vUv = vec2(float(((corner + 1) >> 1) & 1), float(corner >> 1));
  vLayer = aTile.x;
  vFace = float(code & 7);
  vLight = aLight;

  vec4 world = modelMatrix * vec4(position, 1.0);

  // Water surface ripple: only the lowered top vertices carry the wave bit.
  if ((code & 8) != 0) {
    world.y += sin(uTime * 1.7 + world.x * 0.8 + world.z * 0.5) * 0.026
             + sin(uTime * 2.6 - world.x * 0.35 + world.z * 0.95) * 0.016;
  }

  vec4 mv = viewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2DArray uTex;
uniform vec3 uSkyColor;
uniform vec3 uTorchColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uDayFactor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlphaTest;

varying vec2 vUv;
varying vec3 vLight;
varying float vFogDepth;
flat varying float vLayer;
flat varying float vFace;

// +X, -X, +Y, -Y, +Z, -Z, cross
const float FACE_SHADE[7] = float[7](0.62, 0.62, 1.0, 0.5, 0.82, 0.82, 0.96);

void main() {
  vec4 texel = texture(uTex, vec3(vUv, vLayer));

  #ifdef ALPHA_TEST
    if (texel.a < uAlphaTest) discard;
  #endif

  // Minecraft-ish falloff: the low end of the light ramp drops away fast.
  float sky = pow(vLight.y, 1.45) * uDayFactor;
  float torch = pow(vLight.z, 1.45);

  vec3 lighting = uSkyColor * sky + uTorchColor * torch + uAmbient;
  lighting = min(lighting, vec3(1.4));

  vec3 color = texel.rgb * lighting * FACE_SHADE[int(vFace + 0.5)] * vLight.x;

  float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
  color = mix(color, uFogColor, fog);

  gl_FragColor = vec4(color, texel.a);

  #include <colorspace_fragment>
}
`;

export class BlockMaterials {
  constructor(renderer) {
    this.texture = createTextureArray(renderer.capabilities.getMaxAnisotropy());

    this.uniforms = {
      uTex: { value: this.texture },
      uTime: { value: 0 },
      uSkyColor: { value: new Color(0xffffff) },
      uTorchColor: { value: new Color(0xffd39a) },
      uAmbient: { value: new Vector3(0.035, 0.036, 0.045) },
      uFogColor: { value: new Color(0x9ec6ff) },
      uDayFactor: { value: 1 },
      uFogNear: { value: 60 },
      uFogFar: { value: 128 },
      uAlphaTest: { value: 0.35 },
    };

    const base = {
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    };

    this.opaque = new ShaderMaterial({ ...base, side: FrontSide });
    this.cutout = new ShaderMaterial({ ...base, side: DoubleSide, defines: { ALPHA_TEST: 1 } });
    this.transparent = new ShaderMaterial({
      ...base,
      side: DoubleSide,
      transparent: true,
      depthWrite: true,
    });

    this.opaque.name = 'voxel-opaque';
    this.cutout.name = 'voxel-cutout';
    this.transparent.name = 'voxel-transparent';
  }

  get(pass) {
    return this[pass];
  }

  dispose() {
    this.texture.dispose();
    this.opaque.dispose();
    this.cutout.dispose();
    this.transparent.dispose();
  }
}
