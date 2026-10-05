// Turning speech into 4-bit samples for the SID's volume register: band-limit
// and resample, tilt and compress it so it survives 16 levels, then quantize
// with noise shaping. Samples are floats in -1..1.

// Resample from `from` to `to` Hz through a Blackman-windowed sinc low-pass at
// `cutoff` Hz (default: 45% of the lower rate, so nothing aliases).
export function resample(x, from, to, cutoff = 0.45 * Math.min(from, to)) {
  const f = cutoff / from;                 // cutoff in cycles per source sample
  const half = Math.ceil(4 / f);           // 4 lobes of the sinc each side, in source samples
  const n = Math.floor(x.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * from / to;
    const j0 = Math.max(0, Math.ceil(t - half)), j1 = Math.min(x.length - 1, Math.floor(t + half));
    let sum = 0;
    for (let j = j0; j <= j1; j++) {
      const d = t - j, a = Math.PI * d / half;
      const w = 0.42 + 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
      const s = d === 0 ? 1 : Math.sin(2 * Math.PI * f * d) / (2 * Math.PI * f * d);
      sum += x[j] * w * s * 2 * f;
    }
    out[i] = sum;
  }
  return out;
}

// y[n] = x[n] - a * x[n-1]: brightens speech, which 4-bit quantization noise
// and the SID's volume click otherwise leave dull.
export function preEmphasis(x, a) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - a * (i ? x[i - 1] : 0);
  return out;
}

// Even out the loudness, because quiet syllables are lost in 4 bits: an
// envelope follower sets a gain that pulls levels toward `target` by `amount`
// (0 = off, 1 = full), up by at most `maxGain`; then a soft limiter and a
// peak normalisation to `peak`.
export function compress(x, rate, { amount = 0.6, target = 0.3, maxGain = 8, peak = 0.97 } = {}) {
  const attack = Math.exp(-1 / (0.005 * rate)), release = Math.exp(-1 / (0.12 * rate));
  const out = new Float32Array(x.length);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? attack * env + (1 - attack) * a : release * env + (1 - release) * a;
    const gain = Math.min(maxGain, Math.pow(target / (env + 1e-4), amount));
    out[i] = Math.tanh(x[i] * gain);
  }
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] *= peak / max;
  return out;
}

// What each of the 16 volume settings outputs, in -1..1 (level 0 is -1).
// sid6581 and sid8580 are VICE's (reSID's) chips measured with the client's
// three DC voices on (scripts/calibrate.js). Both are close to linear, a bit
// compressed at the ends. Real chips differ from each other and from the model.
export const LUTS = {
  linear: Array.from({ length: 16 }, (_, k) => (k - 7.5) / 7.5),
  sid6581: [-1.000, -0.853, -0.707, -0.564, -0.422, -0.282, -0.142, -0.005, 0.132, 0.265, 0.397, 0.525, 0.650, 0.770, 0.887, 1.000],
  sid8580: [-1.000, -0.872, -0.745, -0.615, -0.485, -0.355, -0.225, -0.091, 0.043, 0.176, 0.311, 0.446, 0.582, 0.720, 0.859, 1.000],
};

// Noise-shaping filters: the quantizer's error e is fed back as
// u[n] = x[n] - sum(h[k] * e[n-k]), so the noise is e filtered by
// 1 - sum(h[k] z^-k): zero at DC, pushed up toward the Nyquist frequency.
export const SHAPES = {
  none: [],
  first: [1],
  second: [2, -1],
  mild: [0.5],
};

// Quantize x to 16 levels (0-15) of `lut`, with noise shaping `shape` (a name
// in SHAPES or a coefficient list) and `dither` (TPDF, in LSBs; 0 = off).
export function quantize4(x, { lut = LUTS.linear, shape = 'second', dither = 0 } = {}) {
  const h = typeof shape === 'string' ? SHAPES[shape] : shape;
  if (!h) throw new Error(`unknown noise shaping ${shape}`);
  const step = 2 / 15;
  const out = new Uint8Array(x.length);
  const err = new Float64Array(h.length);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < x.length; i++) {
    let u = x[i];
    for (let k = 0; k < h.length; k++) u -= h[k] * err[k];
    if (dither) u += (rnd() - rnd()) * dither * step;
    let q = 0, best = Infinity;
    for (let k = 0; k < 16; k++) {
      const d = Math.abs(lut[k] - u);
      if (d < best) { best = d; q = k; }
    }
    for (let k = h.length - 1; k > 0; k--) err[k] = err[k - 1];
    if (h.length) err[0] = Math.max(-step, Math.min(step, lut[q] - u)); // a clipped sample must not wind the filter up
    out[i] = q;
  }
  return out;
}

// What the SID plays for `nibbles`, as floats.
export const reconstruct = (nibbles, lut = LUTS.linear) => Float32Array.from(nibbles, n => lut[n]);

// Cut points that keep each piece within `max` samples, at the quietest
// 10 ms found in the last `search` seconds of a piece (where the pause
// between words is). Returns [start, end) pairs.
export function splitQuiet(x, rate, max, search = 2) {
  const pieces = [];
  const win = Math.max(1, Math.round(rate * 0.01));
  let start = 0;
  while (x.length - start > max) {
    let cut = start + max, best = Infinity;
    for (let p = start + max - win; p > start + max - search * rate && p > start; p -= win) {
      let e = 0;
      for (let k = p; k < p + win; k++) e += x[k] * x[k];
      if (e < best) { best = e; cut = p + (win >> 1); }
    }
    pieces.push([start, cut]);
    start = cut;
  }
  pieces.push([start, x.length]);
  return pieces;
}
