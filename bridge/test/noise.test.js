import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autocorrelation, levinson, lpcWeights } from '../src/noise.js';
import { decodeLevels, encode, makeCodec } from '../src/codec.js';
import { LUTS } from '../src/dsp.js';

// A first-order autoregressive signal, x[n] = rho x[n-1] + noise, from a fixed pseudo-random source.
function ar1(rho, n) {
  let seed = 7, prev = 0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  return Float32Array.from({ length: n }, () => (prev = rho * prev + rnd()));
}

test('levinson finds the predictor of an AR(1) signal: A(z) = 1 - rho z^-1', () => {
  const x = ar1(0.9, 20000);
  const a = levinson(autocorrelation(x, 0, x.length, 2), 2);
  assert.ok(Math.abs(a[1] + 0.9) < 0.03, `a1 ${a[1]}`);
  assert.ok(Math.abs(a[2]) < 0.05, `a2 ${a[2]}`);
});

test('lpcWeights follows the tilt of the signal, and is zero for silence', () => {
  const lowpass = ar1(0.9, 4096), white = ar1(0, 4096);
  const w = lpcWeights(lowpass, { order: 1, gamma: 1, floor: 0 })(1000)[0];
  assert.ok(w < -0.8, `lowpass weight ${w}`); // a bass-heavy signal: weigh high frequencies, push noise down
  assert.ok(Math.abs(lpcWeights(white, { order: 1, gamma: 1, floor: 0 })(1000)[0]) < 0.1);
  assert.deepEqual(lpcWeights(new Float32Array(2000), { order: 3 })(500), [0, 0, 0]);
  const strong = lpcWeights(lowpass, { order: 2, gamma: 1 })(1000), soft = lpcWeights(lowpass, { order: 2, gamma: 0.5 })(1000);
  assert.ok(Math.abs(soft[0]) < Math.abs(strong[0]) && Math.abs(soft[1]) <= Math.abs(strong[1]) + 1e-9);
});

test('adaptive weights and a beam still give a decodable stream that tracks the signal', () => {
  const c = makeCodec({ bits: 2, accBits: 7, steps: [1, 1.7, 2.9, 4.9, 8.35, 14.2], mags: [0.5, 1.5], idxDelta: [-1, 1] });
  const x = Float32Array.from({ length: 2000 }, (_, i) => 0.6 * Math.sin(i * 0.04) + 0.2 * Math.sin(i * 0.7));
  const codes = encode(c, x, LUTS.linear, 128, 48, lpcWeights(x, { order: 4, gamma: 0.6, block: 128 }), 0.02);
  assert.equal(codes.length, 2000);
  const y = decodeLevels(c, codes, LUTS.linear);
  const snr = 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.reduce((a, v, i) => a + (v - y[i]) ** 2, 0));
  assert.ok(snr > 5, `snr ${snr}`);
});
