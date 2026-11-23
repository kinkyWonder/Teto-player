/** GLSL of the 3D visualizer (shared by the live visualizer and the "3D" cover renderer). */
export const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

export const FS = (steps: number) => `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 R;
uniform float T, B, M, H, E, K, MIXV;
uniform int SA, SB;
uniform float SP[24];
uniform vec3 C1, C2, C3;
#define STEPS ${steps}
#define PI 3.14159265

mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float spec(float x){ x = clamp(x, 0., 1.) * 23.; int i = int(x); return mix(SP[i], SP[min(i + 1, 23)], fract(x)); }
vec3 pal(float t){
  t = fract(t) * 3.;
  return t < 1. ? mix(C1, C2, t) : t < 2. ? mix(C2, C3, t - 1.) : mix(C3, C1, t - 2.);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5); }
float h1(float n){ return fract(sin(n) * 43758.5453); }
float n3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  float n = dot(i, vec3(1., 57., 113.));
  return mix(mix(mix(h1(n), h1(n + 1.), f.x), mix(h1(n + 57.), h1(n + 58.), f.x), f.y),
             mix(mix(h1(n + 113.), h1(n + 114.), f.x), mix(h1(n + 170.), h1(n + 171.), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= .5; } return s; }
float stars(vec2 q, float th){ vec2 g = floor(q); float h = hash(g); return step(th, h) * smoothstep(.45, 0., length(fract(q) - .5 - (vec2(hash(g + 3.1), hash(g + 7.7)) - .5) * .5)) * (.4 + .6 * h); }

/* 0 — nebula: flying through glowing gas clouds, the core flares with the bass */
vec3 s0(vec2 uv){
  vec3 ro = vec3(0., 0., T * .7), rd = normalize(vec3(uv, 1.3));
  rd.xy *= rot(T * .03 + sin(T * .07) * .3);
  vec3 col = vec3(stars(uv * 70. + T * .3, .975)) * (.5 + H);
  float tr = 1., t = .4;
  for (int i = 0; i < STEPS / 2 + 6; i++) {
    vec3 p = ro + rd * t;
    p.xy *= rot(p.z * .05);
    float d = fbm(p * .5 + vec3(0., 0., T * .04));
    float den = smoothstep(.42 - B * .14, .9, d);
    if (den > .01) {
      vec3 c = pal(d * 1.4 + p.z * .015 + T * .01) * (1. + K * 1.6 + spec(fract(d * 2.)) * .8);
      c += C2 * exp(-length(p.xy) * 1.1) * (.5 + B * 1.8);
      col += c * den * tr * .11;
      tr *= 1. - den * .14;
      if (tr < .04) break;
    }
    t += .2 + t * .025;
  }
  return col * (.7 + E * .6);
}

/* 1 — black hole: an accretion disk bent by gravity around a dark horizon */
vec3 s1(vec2 uv){
  vec3 p = vec3(0., .55 + sin(T * .08) * .25, -7.), v = normalize(vec3(uv, 1.7));
  v.yz *= rot(-.07);
  v.xz *= rot(sin(T * .05) * .15);
  float rs = .62 + B * .1;
  vec3 col = vec3(0.); float glow = 0.; bool fell = false;
  for (int i = 0; i < STEPS + 24; i++) {
    float r = length(p);
    if (r < rs) { fell = true; break; }
    v = normalize(v - p * (rs * 1.15 / (r * r * r)) * .16);
    vec3 np = p + v * max(.05, (r - rs) * .14);
    if (p.y * np.y < 0.) {
      vec3 q = mix(p, np, p.y / (p.y - np.y));
      float rq = length(q.xz);
      if (rq > rs * 1.5 && rq < rs * 6.5) {
        float ang = atan(q.z, q.x);
        float u = (rq - rs * 1.5) / (rs * 5.);
        float band = .55 + .45 * sin(rq * 10. - T * 2.4 + ang * 3. + spec(u) * 4.);
        band *= .7 + .3 * sin(ang * 7. - T * 1.3 + rq * 3.);
        float fall = smoothstep(1., 0., u) * smoothstep(0., .06, u);
        vec3 c = pal(u * .6 + T * .02) * band * fall * (1.2 + K * 1.6 + spec(fract(ang / 6.2831 + .5)) * 1.5);
        c *= .45 + .9 * smoothstep(-1., 1., sin(ang + 1.2));
        col += c * (1. - clamp(length(col) * .35, 0., .9));
      }
    }
    glow += .0025 / (abs(r - rs * 1.25) + .04);
    p = np;
    if (r > 16.) break;
  }
  if (!fell) {
    vec2 sp = vec2(atan(v.z, v.x), asin(clamp(v.y, -1., 1.))) * 40.;
    col += vec3(stars(sp, .97)) * .9;
  }
  col += pal(.55 + T * .01) * glow * .22 * (.6 + B * 1.4);
  return col;
}

/* 2 — neon tunnel: a hexagonal corridor of light panels that flash with the spectrum */
vec3 s2(vec2 uv){
  uv *= rot(sin(T * .1) * .4);
  uv += vec2(sin(T * .3), cos(T * .23)) * .04;
  float a = atan(uv.y, uv.x), r = length(uv);
  const float N = 6.;
  float an = mod(a + T * .05, 2. * PI / N) - PI / N;
  float pr = r * cos(an) / cos(PI / N);
  float z = .32 / (pr + .002) + T * 1.8;
  float u = fract((a + PI) / (2. * PI)) * N * 3.;
  float seg = floor(u), su = fract(u);
  float ring = fract(z * .5);
  float rings = smoothstep(.05, 0., abs(ring - .5)) * (1. + K);
  float corner = smoothstep(.035, 0., abs(abs(an) - PI / N) * 1.5);
  float sv = spec(fract(seg / (N * 3.)));
  float lit = step(h1(seg * 7.1 + floor(z * .5) * 3.3), sv * (.8 + B * .9));
  float panel = smoothstep(.5, .38, abs(su - .5)) * smoothstep(.5, .35, abs(ring - .5)) * lit;
  vec3 col = pal(z * .025 + seg * .03) * (rings * 1.2 + panel * .9 + corner * .8);
  col *= smoothstep(0., .5, pr) * (1. - smoothstep(14., 30., z - T * 1.8));
  col += pal(T * .04 + .5) * .05 / (r + .04) * (.6 + B * 1.8);
  return col;
}

/* 3 — kaleidoscopic crystal (KIFS fold) */
float kifs(vec3 p){
  p.xz *= rot(T * .13); p.xy *= rot(T * .09);
  float s = 1.;
  for (int i = 0; i < 5; i++) {
    p = abs(p) - vec3(.55 + B * .22, .85, .45 + M * .3);
    p.xy *= rot(.55 + sin(T * .1) * .3);
    p.yz *= rot(.35 + H * .4);
    p *= 1.38; s *= 1.38;
  }
  return (length(p.xz) - .1) / s;
}
vec3 s3(vec2 uv){
  vec3 ro = vec3(0., 0., -4.2), rd = normalize(vec3(uv, 1.25));
  float t = 0.; vec3 col = vec3(0.);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = kifs(p);
    d = abs(d) * .7 + .006;
    col += pal(length(p) * .25 + T * .02) * (.0012 + .0025 * K) / d * exp(-t * .2);
    t += d;
    if (t > 10.) break;
  }
  return col * (.5 + E * .9);
}

/* 4 — pulsar: ridge lines of sound in perspective (a moving "Unknown Pleasures") */
vec3 s4(vec2 uv){
  uv.x += sin(T * .11) * .05;
  vec3 col = vec3(0.);
  float occl = -9.;
  const int L = 30;
  for (int i = 0; i < L; i++) {
    float fi = float(i), z = fi / float(L);
    float sc = 1. - z * .6;
    float x = uv.x / sc;
    float y0 = -.5 + z * .82;
    float env = exp(-x * x * 7.) * smoothstep(.95, .7, abs(x));
    float ph = fi * 1.9 + T * .7;
    float w = (sin(x * 12. + ph) * .5 + .5) * (sin(x * 29. - ph * 1.4) * .5 + .5);
    float s = spec(fract(abs(x) * .8 + z * .35));
    float yl = y0 + env * (w * .09 + s * .2 * (1. + B) + K * .03) * sc;
    float vis = step(occl, yl) * step(abs(x), .95);
    float d = abs(uv.y - yl);
    float line = smoothstep(.0045 * sc + .0025, 0., d) * vis;
    col += pal(z * .55 + T * .02) * line * (1.4 - z * .7);
    col += pal(z * .55 + .2) * .0006 / (d + .004) * vis * (1. - z) * (.4 + B);
    occl = max(occl, yl);
  }
  return col;
}

vec3 scene(int s, vec2 uv){
  if (s == 0) return s0(uv);
  if (s == 1) return s1(uv);
  if (s == 2) return s2(uv);
  if (s == 3) return s3(uv);
  return s4(uv);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - .5 * R) / R.y;
  uv *= 1. - K * .025;
  vec3 c = scene(SA, uv);
  if (MIXV > .001) c = mix(c, scene(SB, uv), MIXV);
  c = 1. - exp(-c * 1.15);                         // tone map
  c *= 1. - .35 * dot(uv * .8, uv * .8);           // vignette
  c += (hash(gl_FragCoord.xy + fract(T) * 91.) - .5) * .018; // dither / grain
  o = vec4(pow(max(c, 0.), vec3(.95)), 1.);
}`;
