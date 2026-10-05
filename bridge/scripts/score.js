#!/usr/bin/env node
// Compares a recording of what VICE played (-soundrecdev wav) with the
// bridge's own preview of it (--out): finds where the playback starts, takes
// the recording at each sample's own time (the SID holds a level for a whole
// sample), and prints the correlation and the SNR after the best gain. The
// emulated SID's output is AC coupled and not exactly linear, so this shows
// how closely the chip follows the plan, not how good the speech sounds.
//
//   node bridge/scripts/score.js preview.wav vice.wav

import { existsSync, readFileSync } from 'node:fs';
import { parseWav } from '../src/wav.js';
import { resample } from '../src/dsp.js';

const [refPath, recPath] = process.argv.slice(2);
if (!recPath) { console.error('usage: score.js preview.wav recording.wav'); process.exit(1); }

const ref = parseWav(readFileSync(refPath));
if (existsSync(`${refPath}.rate`)) ref.rate = Number(readFileSync(`${refPath}.rate`, 'utf8')); // the exact rate: the header is whole Hz
const { rate: fs, pcm: y } = parseWav(readFileSync(recPath));
// The chip's output is AC coupled (reSID's external filter is a high-pass at
// about 16 Hz), so the plan is high-passed too.
const a = Math.exp(-2 * Math.PI * 16 / ref.rate);
const x = new Float32Array(ref.pcm.length);
for (let i = 1; i < x.length; i++) x[i] = a * (x[i - 1] + ref.pcm[i] - ref.pcm[i - 1]);
const step = fs / ref.rate;

// The last sample that moves after half a second of digital silence: the
// client's first write, a frame before the first sample.
const quiet = Math.round(fs * 0.5);
let run = 0, start = -1;
for (let i = 0; i < y.length; i++) {
  if (Math.abs(y[i]) < 1e-5) run++;
  else { if (run >= quiet) start = i; run = 0; }
}
if (start < 0) { console.error('no playback found in the recording'); process.exit(1); }

// y at the middle of each of x's samples, `off` recording samples after `start`.
const n = Math.min(x.length, Math.floor((y.length - start) / step) - 4);
function fit(off) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const xv = x[i], yv = y[Math.round(start + off + (i + 0.6) * step)];
    sx += xv; sy += yv; sxx += xv * xv; sxy += xv * yv; syy += yv * yv;
  }
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  return { off, r: cov / Math.sqrt(vx * vy), gain: cov / vx, snr: 10 * Math.log10(cov * cov / vx / (vy - cov * cov / vx)) };
}
let best = null;
for (let off = -60; off <= 2500; off++) {
  const f = fit(off);
  if (!best || f.r > best.r) best = f;
}
console.log(`playback starts at ${(start / fs).toFixed(3)} s (offset ${best.off} samples)`);
console.log(`correlation ${best.r.toFixed(4)}, SNR ${best.snr.toFixed(1)} dB, gain ${best.gain.toFixed(3)} (preview 1.0 = ${best.gain.toFixed(3)} of VICE full scale)`);

// The same in the speech band: both signals low-passed at 3.4 kHz, so that what
// is measured is what speech needs, and a recording at 48 kHz can follow a
// 15.6 kHz sample rate, whose steps it does not resolve. A sample written late
// shows up as error here too. The alignment is searched to a 48 kHz sample,
// because a delay of a fraction of an 8 kHz sample already costs SNR at 3 kHz.
const CUT = 3400;
const lp = (sig, from) => resample(sig, from, fs, CUT);
const bx = lp(x, ref.rate), by = resample(y.subarray(Math.max(0, start - Math.round(fs * 0.1))), fs, fs, CUT);
const origin = Math.round(fs * 0.1) - Math.max(0, Math.round(fs * 0.1) - start);
function bandFit(lag, from, to, stride) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, m = 0;
  for (let i = from; i < to; i += stride) {
    const j = origin + lag + i;
    if (j < 0 || j >= by.length) continue;
    const xv = bx[i], yv = by[j];
    sx += xv; sy += yv; sxx += xv * xv; sxy += xv * yv; syy += yv * yv; m++;
  }
  const cov = sxy - sx * sy / m, vx = sxx - sx * sx / m, vy = syy - sy * sy / m;
  return { lag, r: cov / Math.sqrt(vx * vy), snr: 10 * Math.log10(cov * cov / vx / (vy - cov * cov / vx)) };
}
const nb = Math.min(bx.length, by.length - origin - 2400);
let coarse = null;
for (let lag = -240; lag <= 2400; lag += 6) { // coarse: every 6th sample of 48 kHz
  const f = bandFit(lag, 0, nb, 6);
  if (!coarse || f.r > coarse.r) coarse = f;
}
let fine = null;
for (let lag = coarse.lag - 8; lag <= coarse.lag + 8; lag++) {
  const f = bandFit(lag, 0, nb, 1);
  if (!fine || f.r > fine.r) fine = f;
}

// A delay of a fraction of a recording sample, which the alignment above cannot
// remove, would cost SNR at 3 kHz and say nothing about the playback. So fit
// y ~ a x + b x' + c (x' the slope of x: a first-order delay) at the best
// whole-sample lag, and take the SNR of what is left over.
function delayFit(lag) {
  const rows = [];
  for (let i = 1; i < nb - 1; i++) {
    const j = origin + lag + i;
    if (j < 0 || j >= by.length) continue;
    rows.push([bx[i], (bx[i + 1] - bx[i - 1]) / 2, 1, by[j]]);
  }
  // normal equations, 3 x 3
  const A = Array.from({ length: 3 }, () => new Float64Array(4));
  let yy = 0, ysum = 0;
  for (const r of rows) {
    for (let p = 0; p < 3; p++) { for (let q = 0; q < 3; q++) A[p][q] += r[p] * r[q]; A[p][3] += r[p] * r[3]; }
    yy += r[3] * r[3]; ysum += r[3];
  }
  for (let c = 0; c < 3; c++) { // Gauss-Jordan
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let q = c; q < 4; q++) A[r][q] -= f * A[c][q];
    }
  }
  const [a, b, c] = [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  let res = 0, vy = yy - ysum * ysum / rows.length;
  for (const r of rows) res += (r[3] - (a * r[0] + b * r[1] + c)) ** 2;
  return { snr: 10 * Math.log10(vy / res), delay: -b / a }; // delay in recording samples
}
const df = delayFit(fine.lag);
console.log(`speech band (<3.4 kHz): correlation ${fine.r.toFixed(4)}, SNR ${fine.snr.toFixed(1)} dB; after a fractional delay of ${df.delay.toFixed(2)} samples: ${df.snr.toFixed(1)} dB`);
