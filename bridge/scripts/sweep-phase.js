#!/usr/bin/env node
// Tries each --phase (where in a raster line the client starts its timer, in
// 5-cycle steps) in VICE and prints how well the recording matches the plan.
// The writes should fall just after a badline's stolen cycles, so the good
// phases are a band; the table shows where it is.
//
//   node bridge/scripts/sweep-phase.js [--from 0] [--to 12] [--sid 0] -- --lines 1 [--say "..."]

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const dashes = process.argv.indexOf('--');
const own = dashes < 0 ? process.argv.slice(2) : process.argv.slice(2, dashes);
const rest = dashes < 0 ? [] : process.argv.slice(dashes + 1);
const { values: opt } = parseArgs({ args: own, options: {
  from: { type: 'string', default: '0' }, to: { type: 'string', default: '12' }, sid: { type: 'string', default: '0' },
} });
const capture = fileURLToPath(new URL('./capture.js', import.meta.url));
const say = rest.includes('--say') ? [] : ['--say', 'Hello. I am a Commodore sixty four.'];

for (let phase = Number(opt.from); phase <= Number(opt.to); phase++) {
  const r = spawnSync('node', [capture, '--sid', opt.sid, '--', ...say, ...rest, '--phase', String(phase)], { encoding: 'utf8' });
  const m = /band[^:]*: correlation ([-\d.]+), SNR ([-\d.]+) dB; after a fractional delay of [-\d.]+ samples: ([-\d.]+) dB/.exec(r.stdout);
  console.log(`phase ${String(phase).padStart(2)} (${String(phase * 5).padStart(2)} cycles)  ${m ? `speech band: correlation ${m[1]}  SNR ${m[2]} dB, ${m[3]} dB with the delay removed` : 'no result: ' + (r.stderr || '').split('\n').slice(-3).join(' ')}`);
}
