#!/usr/bin/env node
// Measures the SID's output for every byte written to $D418 (not only the
// volume nibble) from a recording of `bridge.js --staircase256` (capture.js
// records it; add --regs to set up the filter). The output is AC coupled, so
// each level is measured as the step to and from a reference byte, so
// the two edges can be averaged and no error builds up from level to level. Prints
// them scaled to -1..1, how many are really different, and how fine a ladder
// they make: the resolution the stream could use if it wrote whole bytes.
//
//   node bridge/scripts/calibrate256.js build/capture/vice.wav [--rate 8010.146] [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseWav } from '../src/wav.js';

const { values: opt, positionals: [path] } = parseArgs({ allowPositionals: true, options: {
  rate: { type: 'string', default: String(985248 / 123) },
  json: { type: 'string' },
} });
if (!path) { console.error('usage: calibrate256.js recording.wav [--rate HZ] [--json out.json]'); process.exit(1); }
const { rate: fs, pcm: y } = parseWav(readFileSync(path));
const per = 32 * fs / Number(opt.rate);
const REFERENCE = 8; // as in bridge.js

// The client's first write (volume 8) follows half a second of silence, and the first sample (a 15) comes up
// to a frame later. The biggest step in the whole signal is the second, 15 down to 0: that edge, one plateau
// after the first sample's, fixes where every other one is.
const quiet = Math.round(fs * 0.5);
let run = 0, onset = -1;
for (let i = 0; i < y.length; i++) {
  if (Math.abs(y[i]) < 1e-5) run++;
  else { if (run >= quiet) onset = i; run = 0; }
}
if (onset < 0) { console.error('no playback found'); process.exit(1); }
let fall = onset;
for (let i = onset; i < onset + Math.round(fs * 0.12); i++) if (y[i + 2] - y[i - 1] < y[fall + 2] - y[fall - 1]) fall = i;
const first = fall - per;

// The plateaus, 32 samples each, are 15, 0, then the reference and v for v = 0..255, and a last reference.
// Edge k is the step into plateau k: into v at k = 3 + 2v (from the reference), and out of it at 4 + 2v.
const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += y[i]; return s / (b - a); };
const jump = k => { const t = Math.round(first + k * per); return avg(t + 4, t + 14) - avg(t - 14, t - 4); };
const out = new Float64Array(256), disagree = new Float64Array(256); // out[v]: v relative to the reference byte
for (let v = 0; v < 256; v++) {
  if (v === REFERENCE) continue;
  const into = jump(3 + 2 * v), away = jump(4 + 2 * v); // +(v - ref) and -(v - ref)
  out[v] = (into - away) / 2;
  disagree[v] = (into + away) / 2;
}
const lo = Math.min(...out), hi = Math.max(...out), range = hi - lo;
const lvl = Array.from(out, v => 2 * (v - lo) / range - 1);
const noise = Math.sqrt(disagree.reduce((a, b) => a + b * b, 0) / 255) / range; // the two edges' disagreement

console.log(`swing ${range.toFixed(4)} of VICE full scale; the step in and the step out differ by ${(noise * 100).toFixed(2)}% of it`);
console.log('levels by byte value (rows: high nibble = the filter bits; columns: volume), scaled to -1..1:');
for (let h = 0; h < 16; h++) console.log(h.toString(16) + 'x ' + Array.from({ length: 16 }, (_, l) => lvl[h * 16 + l].toFixed(2).padStart(5)).join(' '));

// a ladder: the sorted levels, and the largest gap between neighbours
const sorted = lvl.map((v, b) => ({ v, b })).sort((a, b) => a.v - b.v);
const gaps = sorted.slice(1).map((e, i) => e.v - sorted[i].v);
const tol = Math.max(0.004, 4 * noise);
const distinct = sorted.filter((e, i) => i === 0 || e.v - sorted[i - 1].v > tol).length;
const nibble = lvl.slice(0, 16), nr = Math.max(...nibble) - Math.min(...nibble);
console.log(`\n${distinct} levels differ from their neighbours by more than ${tol.toFixed(3)}; the largest gap in the sorted ladder is ${Math.max(...gaps).toFixed(3)}`);
console.log(`the volume nibble alone (bytes 0-15) spans ${nr.toFixed(2)} of the range in steps of ${(nr / 15).toFixed(3)}`);

// 128 evenly spaced targets, each given the nearest byte
const ladder = Array.from({ length: 128 }, (_, a) => {
  const target = -1 + 2 * a / 127;
  let best = sorted[0];
  for (const e of sorted) if (Math.abs(e.v - target) < Math.abs(best.v - target)) best = e;
  return { byte: best.b, level: best.v, err: best.v - target };
});
const rms = Math.sqrt(ladder.reduce((s, e) => s + e.err * e.err, 0) / 128);
console.log(`128 evenly spaced targets over the full range: rms error ${rms.toFixed(4)}, worst ${Math.max(...ladder.map(e => Math.abs(e.err))).toFixed(4)} (one step of an even 16-level ladder is ${(2 / 15).toFixed(3)})`);
if (opt.json) writeFileSync(opt.json, JSON.stringify({ levels: lvl, ladder: ladder.map(e => e.byte), swing: range }));
