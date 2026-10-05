#!/usr/bin/env node
// Looks for hiss: noise that stays about as loud while the signal fades. For each
// setting, what the 2-bit code (or 4-bit PCM) plays is compared with the signal
// it was made from, frame by frame (20 ms), and the error is split by how loud the
// signal was at the time, and by frequency. Hiss shows as an error that is as large
// in the quiet frames as in the loud ones, and as sound in frames where the
// signal is near silence. Levels are dB relative to full scale (1.0 = 0 dB).
//
//   node bridge/scripts/hiss.js --file ~/Downloads/clip.mp3 [--tts 'piper ...' --say "text"]

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { LUTS, quantize4, reconstruct } from '../src/dsp.js';
import { STREAM_CODEC, decodeLevels, encode, makeCodec } from '../src/codec.js';
import { aWeight, fft } from '../src/metrics.js';
import { loadAudio, prepare, say, speakWith } from '../src/speech.js';
import { timerFor } from '../src/protocol.js';
import { lpcWeights } from '../src/noise.js';

const { values: opt } = parseArgs({ options: {
  file: { type: 'string' }, say: { type: 'string' }, tts: { type: 'string' },
  rate: { type: 'string', default: '8000' }, seconds: { type: 'string', default: '12' }, beam: { type: 'string', default: '0.02' },
} });
const expand = p => p.replace(/^~/, homedir());
const audio = opt.file ? loadAudio(expand(opt.file)) : opt.tts ? speakWith(opt.tts, opt.say ?? 'Hello.') : say(opt.say ?? 'Hello.');
const { rate } = timerFor(Number(opt.rate));
const lut = LUTS.sid6581;
const db = x => 20 * Math.log10(Math.max(x, 1e-9));
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));

// Noise power in a band (Hz), as dB re full scale, from one long FFT.
function bandDb(x, lo, hi) {
  let n = 1; while (n < x.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  let p = 0;
  for (let k = Math.ceil(lo * n / rate); k < Math.min(n / 2, hi * n / rate); k++) p += re[k] ** 2 + im[k] ** 2;
  return db(Math.sqrt(2 * p) / x.length); // amplitude of a sine with the same power: dB re full scale
}
function aWeightedDb(x) {
  let n = 1; while (n < x.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  let p = 0;
  for (let k = 1; k < n / 2; k++) p += (re[k] ** 2 + im[k] ** 2) * aWeight(k * rate / n);
  return db(Math.sqrt(2 * p) / x.length);
}

// How much of the noise is not masked by the signal: in each 20 ms frame and each 500 Hz band to 4 kHz, the
// noise is "unmasked" when it is within 10 dB of the signal in that band (or louder). Returns the share of
// such cells, and how far over that line they are on average (dB).
function unmasked(target, err) {
  const N = 256, hop = 160, hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N));
  const bandPower = (x, s) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * hann[i];
    fft(re, im);
    return Array.from({ length: 8 }, (_, b) => { let p = 0; for (let k = Math.ceil(b * 500 * N / rate); k < Math.ceil((b + 1) * 500 * N / rate); k++) p += re[k] ** 2 + im[k] ** 2; return p / N; });
  };
  let cells = 0, bad = 0, over = 0;
  for (let s = 0; s + N <= target.length; s += hop) {
    const sp = bandPower(target, s), np = bandPower(err, s);
    for (let b = 0; b < 8; b++) {
      if (sp[b] < 1e-9) continue; // nothing there to mask or to hear
      cells++;
      const excess = 10 * Math.log10(np[b] / sp[b]) + 10;
      if (excess > 0) { bad++; over += excess; }
    }
  }
  return { share: bad / cells, mean: bad ? over / bad : 0 };
}

function analyze(label, target, out, seconds = null) {
  const err = Float32Array.from(target, (v, i) => out[i] - v);
  const frame = Math.round(rate * 0.02), frames = [];
  for (let s = 0; s + frame <= target.length; s += frame) {
    frames.push({ sig: rms(target.subarray(s, s + frame)), noise: rms(err.subarray(s, s + frame)), out: rms(out.subarray(s, s + frame)) });
  }
  const sorted = [...frames].sort((a, b) => a.sig - b.sig), q = Math.floor(sorted.length / 4);
  const group = (a, b) => { const g = sorted.slice(a, b); return { sig: db(rms(g.map(f => f.sig))), noise: db(rms(g.map(f => f.noise))) }; };
  const quiet = group(0, q), loud = group(3 * q, sorted.length);
  const idle = frames.filter(f => db(f.sig) < -50);
  return {
    label, noise: db(rms(err)), aNoise: aWeightedDb(err), unmasked: unmasked(target, err), seconds,
    quietSig: quiet.sig, quietNoise: quiet.noise, loudSig: loud.sig, loudNoise: loud.noise,
    idleFrames: idle.length / frames.length, idleOut: idle.length ? db(rms(idle.map(f => f.out))) : null,
    bands: [[0, 500], [500, 1000], [1000, 2000], [2000, 3000], [3000, 4000]].map(([a, b]) => bandDb(err, a, b)),
    sigBands: [[0, 500], [500, 1000], [1000, 2000], [2000, 3000], [3000, 4000]].map(([a, b]) => bandDb(target, a, b)),
  };
}

const maxSamples = Math.round(Number(opt.seconds) * rate);
const rows = [];
const codec = makeCodec(STREAM_CODEC);
const { target: full } = prepare(audio, rate, { lut: 'sid6581', compress: 0.3 });
const target = full.subarray(0, maxSamples);
rows.push(analyze('4-bit PCM, plain rounding', target, reconstruct(quantize4(target, { lut, shape: 'none' }), lut)));
const timed = (label, weight, beam = Infinity) => {
  const t0 = Date.now();
  const codes = encode(codec, target, lut, 256, 128, weight, beam);
  const seconds = (Date.now() - t0) / 1000;
  rows.push(analyze(label, target, decodeLevels(codec, codes, lut), seconds / (target.length / rate)));
};
timed('2-bit code, plain error', []);
timed('  fixed weight [-0.6]', [-0.6]);
const adaptive = (gamma, order = 10, floor = 1e-3) => lpcWeights(target, { order, gamma, floor });
timed('  adaptive tilt (order 1), gamma 0.6', adaptive(0.6, 1), Number(opt.beam));
timed('  adaptive tilt (order 1), gamma 0.8', adaptive(0.8, 1), Number(opt.beam));
timed('  adaptive, order 2, gamma 0.7', adaptive(0.7, 2), Number(opt.beam));
timed('  adaptive, order 2, gamma 0.7, floor 1e-2', adaptive(0.7, 2, 1e-2), Number(opt.beam));
timed('  adaptive, order 10, gamma 0.5', adaptive(0.5, 10), Number(opt.beam));
const f = v => v === null ? '   -  ' : v.toFixed(1).padStart(6);
console.log(`${(maxSamples / rate).toFixed(1)} s at ${rate.toFixed(0)} Hz; dB re full scale\n`);
console.log('setting'.padEnd(34) + 'noise  A-wtd | unmasked: cells  excess | encode time (x real time)');
for (const r of rows) {
  console.log(`${r.label.padEnd(34)}${f(r.noise)}${f(r.aNoise)} |${(r.unmasked.share * 100).toFixed(1).padStart(15)}%${r.unmasked.mean.toFixed(1).padStart(6)} dB | ${r.seconds === null ? '' : r.seconds.toFixed(2)}`);
}
console.log('\nnoise by frequency (dB re full scale), then the signal:');
console.log('setting'.padEnd(34) + ['0-.5k', '.5-1k', '1-2k', '2-3k', '3-4k'].map(s => s.padStart(7)).join(''));
for (const r of rows) console.log(r.label.padEnd(34) + r.bands.map(v => f(v).padStart(7)).join(''));
console.log('signal'.padEnd(34) + rows[0].sigBands.map(v => f(v).padStart(7)).join(''));
