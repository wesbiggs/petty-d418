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

const { values: opt } = parseArgs({ options: {
  file: { type: 'string' }, say: { type: 'string' }, tts: { type: 'string' },
  rate: { type: 'string', default: '8000' }, seconds: { type: 'string', default: '12' },
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

function analyze(label, target, out) {
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
    label, noise: db(rms(err)), aNoise: aWeightedDb(err),
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
for (const [label, weight] of [
  ['2-bit code, plain error', []],
  ['  weight [-0.3]', [-0.3]],
  ['  weight [-0.6]', [-0.6]],
  ['  weight [-0.8]', [-0.8]],
  ['  weight [-0.95]', [-0.95]],
  ['  weight [-1.0, 0.3]', [-1.0, 0.3]],
  ['  weight [0.6] (noise up: worse)', [0.6]],
]) rows.push(analyze(label, target, decodeLevels(codec, encode(codec, target, lut, 256, 128, weight), lut)));
const f = v => v === null ? '   -  ' : v.toFixed(1).padStart(6);
console.log(`${(maxSamples / rate).toFixed(1)} s at ${rate.toFixed(0)} Hz; dB re full scale\n`);
console.log('setting'.padEnd(34) + 'noise  A-wtd | quietest quarter: signal noise | loudest: signal noise | idle output');
for (const r of rows) {
  console.log(`${r.label.padEnd(34)}${f(r.noise)}${f(r.aNoise)} |${f(r.quietSig).padStart(24)}${f(r.quietNoise)} |${f(r.loudSig).padStart(21)}${f(r.loudNoise)} | ${r.idleOut === null ? 'no silent frames' : `${f(r.idleOut)} dB in ${(r.idleFrames * 100).toFixed(0)}% of frames`}`);
}
console.log('\nnoise by frequency (dB re full scale), then the signal:');
console.log('setting'.padEnd(34) + ['0-.5k', '.5-1k', '1-2k', '2-3k', '3-4k'].map(s => s.padStart(7)).join(''));
for (const r of rows) console.log(r.label.padEnd(34) + r.bands.map(v => f(v).padStart(7)).join(''));
console.log('signal'.padEnd(34) + rows[0].sigBands.map(v => f(v).padStart(7)).join(''));
