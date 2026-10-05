#!/usr/bin/env node
// Plays something on the C64 in VICE, records VICE's sound output, and scores
// it against what the bridge meant to play (see score.js). The bridge's
// own options follow `--`; VICE shows its window, and is closed when the
// bridge is done.
//
//   node bridge/scripts/capture.js [--sid 0|1|2] [--prg build/d418.prg] [--out DIR] -- --say "Hello"

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const dashes = process.argv.indexOf('--');
const own = dashes < 0 ? process.argv.slice(2) : process.argv.slice(2, dashes);
const bridgeArgs = dashes < 0 ? [] : process.argv.slice(dashes + 1);
const { values: opt } = parseArgs({
  args: own,
  options: {
    sid: { type: 'string', default: '0' },
    prg: { type: 'string', default: 'build/d418.prg' },
    out: { type: 'string', default: 'build/capture' },
    port: { type: 'string', default: '6464' },
    warp: { type: 'boolean', default: false },
  },
});

mkdirSync(opt.out, { recursive: true });
rmSync(`${opt.out}/preview.wav`, { force: true }); // a signal with no preview (a calibration) must not be scored against an old one
const here = p => fileURLToPath(new URL(p, import.meta.url));
const preview = `${opt.out}/preview.wav`, recording = `${opt.out}/vice.wav`;

const bridge = spawn('node', [here('../src/bridge.js'), '--port', opt.port, '--out', preview, ...bridgeArgs], { stdio: 'inherit' });
const exited = new Promise(resolve => bridge.on('exit', resolve));
await new Promise(r => setTimeout(r, 800));

const vice = spawn('x64sc', [
  '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
  '-rsdev1', `127.0.0.1:${opt.port}`, '+rsdev1ip232', '-rsdev1baud', '38400',
  '-sidmodel', opt.sid, '-soundrecdev', 'wav', '-soundrecarg', recording,
  opt.warp ? '-warp' : '+warp', '-autostart', opt.prg,
], { stdio: 'ignore' });
vice.on('exit', () => bridge.kill());

const code = await exited;
await new Promise(r => setTimeout(r, 1000)); // the tail of the sound
vice.kill();
await new Promise(r => vice.once('exit', r));
if (code !== 0) process.exit(code ?? 1);
if (existsSync(preview)) spawnSync('node', [here('./score.js'), preview, recording], { stdio: 'inherit' });
