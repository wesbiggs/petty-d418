#!/usr/bin/env node
// Scores delta codes (src/codec.js) against plain PCM on a phrase: for each
// config, the bridge's Viterbi encoder picks the codes, the reference decoder
// plays them, and the output is compared with the target by SNR and A-weighted
// SNR. Rows with fewer bits per sample than 4-bit PCM are what a SwiftLink can
// stream in real time (8 kHz at 2 bits is 2 KB/s of its 3.8).
//
//   node bridge/scripts/codec-eval.js [--say "text" | --file clip.wav] [--rate 8000] [--grid]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LUTS, quantize4, reconstruct } from '../src/dsp.js';
import { decodeLevels, encode, geometric, makeCodec } from '../src/codec.js';
import { loadAudio, prepare, say } from '../src/speech.js';
import { snr } from '../src/metrics.js';
import { timerFor } from '../src/protocol.js';
import { writeWav } from '../src/wav.js';

const { values: opt } = parseArgs({ options: {
  say: { type: 'string', default: 'The quick brown fox jumps over the lazy dog. Hello, I am a Commodore sixty four.' },
  file: { type: 'string' },
  rate: { type: 'string', default: '8000' },
  lut: { type: 'string', default: 'sid6581' },
  grid: { type: 'boolean', default: false },
  wav: { type: 'string' },
  ladder: { type: 'string' },
  block: { type: 'string', default: '256' },
  look: { type: 'string', default: '128' },
} });

const audio = opt.file ? loadAudio(opt.file) : say(opt.say);
const { rate } = timerFor(Number(opt.rate));
const lut = LUTS[opt.lut];
const { target } = prepare(audio, rate, { lut: opt.lut });
console.log(`${target.length} samples at ${rate.toFixed(0)} Hz, ${opt.lut}\n`);
console.log('codec'.padEnd(44) + 'bits  kbit/s   SNR dB  A-wtd dB  time');

if (opt.wav) mkdirSync(opt.wav, { recursive: true });
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
const row = (name, bits, y, ms = 0) => {
  if (opt.wav) writeFileSync(`${opt.wav}/${slug(name)}.wav`, writeWav(y, rate));
  const m = snr(target, y, rate);
  console.log(`${name.padEnd(44)}${String(bits).padStart(4)}  ${(bits * rate / 1000).toFixed(1).padStart(6)}  ${m.snr.toFixed(1).padStart(7)}  ${m.aSnr.toFixed(1).padStart(8)}  ${ms ? (ms / 1000).toFixed(1) + ' s' : ''}`);
  return m;
};

// PCM at 4, 3 and 2 bits: the levels of the 16 that are evenly spaced, plain rounding.
for (const bits of [4, 3, 2]) {
  const pick = Array.from({ length: 1 << bits }, (_, k) => Math.round(k * 15 / ((1 << bits) - 1)));
  const sub = pick.map(k => lut[k]);
  const y = Float32Array.from(target, v => sub.reduce((b, c) => Math.abs(c - v) < Math.abs(b - v) ? c : b));
  row(`PCM ${bits}-bit, plain rounding`, bits, y);
}

const run = (name, params, levels = lut) => {
  const codec = makeCodec(params);
  const t0 = Date.now();
  const codes = encode(codec, target, levels, Number(opt.block), Number(opt.look));
  const y = decodeLevels(codec, codes, levels);
  return { m: row(name, params.bits, y, Date.now() - t0), params };
};

const two = (s0, ratio, n, small, large, accBits = 8) => ({
  bits: 2, accBits, steps: geometric(s0, ratio, n), mags: [small, large], idxDelta: [-1, 1], idx0: 0,
});
const three = (s0, ratio, n, accBits = 8) => ({
  bits: 3, accBits, steps: geometric(s0, ratio, n), mags: [0.3, 0.8, 1.6, 3], idxDelta: [-1, 0, 1, 2], idx0: 0,
});

const best = { bits: 2, accBits: 7, steps: [2, 3.4, 5.8, 9.8, 16.7, 28.4].map(v => v / 2), mags: [0.5, 1.5], idxDelta: [-1, 1] };
if (opt.ladder) {
  // The output ladder measured by calibrate256.js --json: 128 bytes of $D418 whose levels are close to evenly spaced.
  const { levels, ladder } = JSON.parse(readFileSync(opt.ladder, 'utf8'));
  const measured = ladder.map(b => levels[b]);
  // the 16 volume levels (bytes 0-15), scaled to span -1..1 as the ladder does, so that only the resolution differs
  const raw16 = Array.from({ length: 16 }, (_, k) => levels[k]);
  const lo = Math.min(...raw16), hi = Math.max(...raw16);
  const ref16 = raw16.map(v => 2 * (v - lo) / (hi - lo) - 1);
  run('2-bit code, 16 volume levels (this chip)', best, ref16);
  run('2-bit code, 128-level ladder of whole bytes', best, measured);
} else if (opt.grid) {
  const results = [];
  for (const s0 of [2, 3, 4]) for (const ratio of [1.4, 1.7, 2]) for (const n of [6, 8]) for (const [small, large] of [[0.5, 1.5], [0.7, 1.4], [0.4, 2]]) {
    results.push(run(`2-bit s0=${s0} x${ratio} n=${n} mags ${small}/${large}`, two(s0, ratio, n, small, large)));
  }
  results.sort((a, b) => b.m.aSnr - a.m.aSnr);
  console.log('\nbest by A-weighted SNR:');
  for (const r of results.slice(0, 5)) console.log(JSON.stringify(r.params.steps.map(v => +v.toFixed(1))), r.params.mags, r.m.aSnr.toFixed(1));
} else {
  run('2-bit, 6 steps 2-28 (7-bit acc)', { bits: 2, accBits: 7, steps: [2, 3.4, 5.8, 9.8, 16.7, 28.4].map(v => v / 2), mags: [0.5, 1.5], idxDelta: [-1, 1] });
  run('2-bit, steps 3 x1.7 (n=8)', two(3, 1.7, 8, 0.5, 1.5));
  run('3-bit, steps 3 x1.7 (n=8)', three(3, 1.7, 8));
}
