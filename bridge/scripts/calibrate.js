#!/usr/bin/env node
// Measures the SID's volume steps from a recording of the staircase signal
// (`bridge.js --staircase`; capture.js records it). The chip's output is AC
// coupled (a high-pass at about 16 Hz), so a held level droops away: what is
// measured is the jump at each step, level k to k+1 on the way up and back
// down. Summing the jumps gives each level's output, printed scaled to -1..1,
// the form of a LUTS entry in dsp.js.
//
//   node bridge/scripts/capture.js -- --staircase
//   node bridge/scripts/calibrate.js build/capture/vice.wav [rate]

import { readFileSync } from 'node:fs';
import { parseWav } from '../src/wav.js';

const [path, rateArg] = process.argv.slice(2);
if (!path) { console.error('usage: calibrate.js recording.wav [rate]'); process.exit(1); }
const { rate: fs, pcm: y } = parseWav(readFileSync(path));
const rate = Number(rateArg ?? 985248 / 123);
const per = 256 * fs / rate;

// The signal starts at the last sample that moves after half a second of
// digital silence (the client's start-up is the first, and loading the samples
// is silent).
const quiet = Math.round(fs * 0.5);
let run = 0, start = -1;
for (let i = 0; i < y.length; i++) {
  if (Math.abs(y[i]) < 1e-5) run++;
  else { if (run >= quiet) start = i; run = 0; }
}
if (start < 0) { console.error('no playback found in the recording'); process.exit(1); }
// The first step is the steepest rise just after it (the onset is the resampler's pre-ringing).
let steep = 0;
for (let i = start; i < start + 80; i++) if (y[i + 2] - y[i - 1] > y[steep + 2] - y[steep - 1] || steep === 0) steep = i;
start = steep;

const seq = [...Array.from({ length: 16 }, (_, k) => k), ...Array.from({ length: 15 }, (_, k) => 14 - k)];
const plateaus = [...seq, ...seq];
const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += y[i]; return s / (b - a); };
const sum = new Float64Array(15), n = new Float64Array(15);
for (let j = 1; j < plateaus.length; j++) {
  const t = Math.round(start + (j - 1) * per), from = plateaus[j - 1], to = plateaus[j];
  if (Math.abs(to - from) !== 1) continue;
  const jump = avg(t + 4, t + 12) - avg(t - 12, t - 4);
  const k = Math.min(from, to);
  sum[k] += to > from ? jump : -jump;
  n[k]++;
}
const d = Array.from(sum, (v, k) => v / n[k]);
const out = [0];
d.forEach(v => out.push(out.at(-1) + v));
const lo = Math.min(...out), hi = Math.max(...out);
const lut = out.map(v => 2 * (v - lo) / (hi - lo) - 1);
console.log('step   jump');
d.forEach((v, k) => console.log(`${String(k).padStart(2)}->${String(k + 1).padEnd(2)} ${v.toFixed(5).padStart(8)}`));
console.log(`\nswing ${(hi - lo).toFixed(4)} of full scale\n[${lut.map(v => v.toFixed(3)).join(', ')}]`);
