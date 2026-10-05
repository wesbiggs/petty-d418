#!/usr/bin/env node
// Compares noise shaping, dither and compression settings on one phrase (or
// audio file) by how much A-weighted quantization noise each leaves, relative
// to the signal. A-weighting follows the ear, which is least sensitive to the
// lowest frequencies and most to 2-4 kHz: at 8 kHz there is not much room
// above the speech to push noise into. Lower noise (more dB) is better, but
// the number is no substitute for listening: write the candidates with
// bridge.js --dry --out and play them.
//
//   node bridge/scripts/shapes.js [--say "text" | --file clip.wav] [--rate 8000]

import { parseArgs } from 'node:util';
import { SHAPES, LUTS, quantize4, reconstruct } from '../src/dsp.js';
import { prepare, loadAudio, say } from '../src/speech.js';
import { timerFor } from '../src/protocol.js';
import { weightedPower } from '../src/metrics.js';

const { values: opt } = parseArgs({ options: {
  say: { type: 'string', default: 'Hello. I am a Commodore sixty four, and this is how I sound.' },
  file: { type: 'string' },
  rate: { type: 'string', default: '8000' },
  lut: { type: 'string', default: 'sid6581' },
} });

const audio = opt.file ? loadAudio(opt.file) : say(opt.say);
const { rate } = timerFor(Number(opt.rate));
const lut = LUTS[opt.lut];
console.log(`rate ${rate.toFixed(1)} Hz, ${opt.lut}\n`);
console.log('compress  emphasis  shape   dither  A-weighted SNR (dB)   total noise rms');
for (const compressAmount of [0.4, 0.6, 0.8]) {
  for (const emphasis of [0, 0.4]) {
    const { target } = prepare(audio, rate, { compress: compressAmount, emphasis, lut: opt.lut });
    const sig = weightedPower(target, rate);
    for (const shape of Object.keys(SHAPES)) {
      for (const dither of [0, 1]) {
        const e = reconstruct(quantize4(target, { lut, shape, dither }), lut).map((v, i) => v - target[i]);
        const snr = 10 * Math.log10(sig / weightedPower(e, rate));
        const rms = Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length);
        console.log(`${String(compressAmount).padEnd(9)} ${String(emphasis).padEnd(9)} ${shape.padEnd(7)} ${String(dither).padEnd(6)}  ${snr.toFixed(1).padStart(8)}              ${rms.toFixed(3)}`);
      }
    }
  }
}
