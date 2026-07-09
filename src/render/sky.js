/**
 * Sky dome, sun, moon, stars and drifting clouds.
 *
 * The dome is a unit sphere pinned to the camera and drawn with depth testing
 * off, so it is effectively infinite. Sun/moon discs, the horizon haze and the
 * star field are all computed analytically from the view direction.
 */
import {
  BackSide, CanvasTexture, Color, DoubleSide, Mesh, PlaneGeometry, RepeatWrapping,
  ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { Perlin, clamp, smoothstep } from '../core/noise.js';
import { DAY_LENGTH } from '../core/constants.js';

const CLOUD_Y = 142;
const CLOUD_SPAN = 3000;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uMoonColor;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uTime;

varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;

  vec3 col = up >= 0.0
    ? mix(uHorizon, uZenith, pow(up, 0.55))
    : mix(uHorizon, uGround, pow(-up, 0.4));

  // Stars, fading in as the sun sets and out near the horizon.
  float starMask = smoothstep(-0.01, 0.22, up) * pow(uNight, 2.0);
  if (starMask > 0.002) {
    vec3 cell = floor(dir * 300.0);
    float n = hash13(cell);
    float star = smoothstep(0.9974, 0.9996, n);
    float twinkle = 0.72 + 0.28 * sin(uTime * 1.8 + n * 120.0);
    col += vec3(0.92, 0.95, 1.0) * star * starMask * twinkle;
  }

  float sd = dot(dir, uSunDir);
  col += uSunColor * smoothstep(0.99855, 0.99925, sd) * 1.7;
  col += uSunColor * pow(max(sd, 0.0), 110.0) * 0.32;
  col += uSunColor * pow(max(sd, 0.0), 5.0) * 0.05 * max(uSunDir.y + 0.25, 0.0);

  float md = dot(dir, -uSunDir);
  col += uMoonColor * smoothstep(0.99905, 0.99955, md) * 1.25 * uNight;
  col += uMoonColor * pow(max(md, 0.0), 220.0) * 0.18 * uNight;

  gl_FragColor = vec4(col, 1.0);

  #include <colorspace_fragment>
}
`;

const CLOUD_VERT = /* glsl */ `
varying vec2 vWorld;
varying float vDist;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xz;
  vec4 mv = viewMatrix * world;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uTime;
uniform float uOpacity;
uniform float uFade;

varying vec2 vWorld;
varying float vDist;

void main() {
  vec2 uv = vWorld / 340.0 + vec2(uTime * 0.0035, uTime * 0.0012);
  vec4 c = texture2D(uMap, uv);
  float a = c.a * uOpacity;
  if (a < 0.02) discard;

  float horizon = 1.0 - smoothstep(uFade * 0.35, uFade, vDist);
  a *= horizon;

  vec3 col = mix(uColor * (0.72 + 0.28 * c.r), uFogColor, smoothstep(uFade * 0.2, uFade, vDist) * 0.8);
  gl_FragColor = vec4(col, a);

  #include <colorspace_fragment>
}
`;

function makeCloudTexture(seed = 7) {
  const size = 256;
  const perlin = new Perlin(seed);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);

  const scale = 4 / size;
  const sample = (x, y) => perlin.fbm2(x * scale, y * scale, 4);

  // Seamless tiling: cross-fade the four wrapped copies of the noise field.
  const tileable = (x, y) => {
    const wx = x / size;
    const wy = y / size;
    return (
      sample(x, y) * (1 - wx) * (1 - wy) +
      sample(x - size, y) * wx * (1 - wy) +
      sample(x, y - size) * (1 - wx) * wy +
      sample(x - size, y - size) * wx * wy
    );
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = tileable(x, y);
      const density = clamp(smoothstep(0.0, 0.22, n), 0, 1);
      const i = (y * size + x) * 4;
      const shade = 205 + density * 50;
      img.data[i] = shade;
      img.data[i + 1] = shade;
      img.data[i + 2] = shade;
      img.data[i + 3] = Math.round(density * 230);
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const COL = {
  zenithDay: new Color(0x3f7ee0),
  horizonDay: new Color(0xa8cdff),
  zenithNight: new Color(0x02040c),
  horizonNight: new Color(0x0a1020),
  groundDay: new Color(0x6f89a8),
  groundNight: new Color(0x05070d),
  sunsetHorizon: new Color(0xff8b45),
  sunsetZenith: new Color(0x2c4c96),
  sunDay: new Color(0xfff6dd),
  sunSet: new Color(0xffb066),
  moon: new Color(0xd8e2ff),
};

export class Sky {
  /** @param {import('three').Scene} scene */
  constructor(scene) {
    this.timeOfDay = 0.32; // just after sunrise
    this.frozen = false;

    this.sunDirection = new Vector3(0, 1, 0);
    this.dayAmount = 1;
    this.dayFactor = 1;
    this.fogColor = new Color(0xa8cdff);
    this.skyColor = new Color(0xa8cdff);
    this.sunColor = new Color(0xfff6dd);

    this.uniforms = {
      uHorizon: { value: new Color() },
      uZenith: { value: new Color() },
      uGround: { value: new Color() },
      uSunColor: { value: new Color() },
      uMoonColor: { value: COL.moon.clone() },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uTime: { value: 0 },
    };

    this.dome = new Mesh(
      new SphereGeometry(1, 32, 20),
      new ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this.cloudUniforms = {
      uMap: { value: makeCloudTexture() },
      uColor: { value: new Color(0xffffff) },
      uFogColor: { value: new Color(0xa8cdff) },
      uTime: { value: 0 },
      uOpacity: { value: 0.85 },
      uFade: { value: CLOUD_SPAN * 0.42 },
    };

    this.clouds = new Mesh(
      new PlaneGeometry(CLOUD_SPAN, CLOUD_SPAN),
      new ShaderMaterial({
        uniforms: this.cloudUniforms,
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.renderOrder = 3;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);

    this._tmp = new Color();
  }

  setTime(t) {
    this.timeOfDay = ((t % 1) + 1) % 1;
  }

  /** Advances the cycle and refreshes every derived colour. */
  update(dt, elapsed, camera) {
    if (!this.frozen) this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH) % 1;

    const angle = (this.timeOfDay - 0.25) * Math.PI * 2;
    this.sunDirection.set(Math.cos(angle), Math.sin(angle), 0.18).normalize();

    const h = this.sunDirection.y;
    // A wide transition band keeps dawn and dusk lingering instead of snapping.
    this.dayAmount = smoothstep(-0.24, 0.14, h);
    // Never fully black: a little moonlight keeps the world readable.
    this.dayFactor = 0.11 + 0.89 * this.dayAmount;

    // Sunset/sunrise is strongest when the sun sits on the horizon.
    const sunset = smoothstep(0.34, 0.0, Math.abs(h)) * smoothstep(-0.3, -0.02, h);

    const horizon = this._tmp.copy(COL.horizonNight).lerp(COL.horizonDay, this.dayAmount);
    this.uniforms.uHorizon.value.copy(horizon).lerp(COL.sunsetHorizon, sunset * 0.85);

    const zenith = this._tmp.copy(COL.zenithNight).lerp(COL.zenithDay, this.dayAmount);
    this.uniforms.uZenith.value.copy(zenith).lerp(COL.sunsetZenith, sunset * 0.5);

    this.uniforms.uGround.value.copy(COL.groundNight).lerp(COL.groundDay, this.dayAmount);
    this.uniforms.uSunColor.value.copy(COL.sunDay).lerp(COL.sunSet, sunset);
    this.uniforms.uSunDir.value.copy(this.sunDirection);
    this.uniforms.uNight.value = 1 - this.dayAmount;
    this.uniforms.uTime.value = elapsed;

    // Fog matches the horizon so chunks dissolve into the sky.
    this.fogColor.copy(this.uniforms.uHorizon.value).lerp(this.uniforms.uZenith.value, 0.22);
    this.skyColor.copy(this.uniforms.uHorizon.value);
    this.sunColor.copy(this.uniforms.uSunColor.value);

    this.cloudUniforms.uTime.value = elapsed;
    this.cloudUniforms.uColor.value.setRGB(1, 1, 1).multiplyScalar(clamp(0.16 + this.dayAmount, 0.16, 1));
    this.cloudUniforms.uFogColor.value.copy(this.fogColor);
    this.cloudUniforms.uOpacity.value = 0.82;

    this.dome.position.copy(camera.position);
    this.clouds.position.set(camera.position.x, CLOUD_Y, camera.position.z);
  }

  dispose() {
    this.dome.geometry.dispose();
    this.dome.material.dispose();
    this.clouds.geometry.dispose();
    this.clouds.material.dispose();
    this.cloudUniforms.uMap.value.dispose();
  }
}
