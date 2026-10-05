#!/usr/bin/env node
// Runs the client in VICE and has the bridge PROBE it, for each combination
// of VICE machine model and SID model: what the client measures, and what the
// bridge makes of it.
//
//   node bridge/scripts/probe-vice.js [--models c64,ntsc,oldntsc,drean] [--sids 0,1,2]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: {
  models: { type: 'string', default: 'c64,ntsc' },
  sids: { type: 'string', default: '0,1' },
  prg: { type: 'string', default: 'build/d418.prg' },
  port: { type: 'string', default: '6464' },
} });
const bridge = fileURLToPath(new URL('../src/bridge.js', import.meta.url));

function once(model, sid) {
  return new Promise(resolve => {
    let out = '';
    const b = spawn('node', [bridge, '--port', opt.port, '--probe'], { stdio: ['ignore', 'pipe', 'inherit'] });
    b.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => b.kill(), 60000);
    setTimeout(() => {
      const vice = spawn('x64sc', [
        '-model', model, '-acia1', '-acia1mode', '1', '-acia1base', '0xDE00', '-acia1irq', '1', '-myaciadev', '0',
        '-rsdev1', `127.0.0.1:${opt.port}`, '+rsdev1ip232', '-rsdev1baud', '38400', '-sidmodel', sid, '+warp', '-autostart', opt.prg,
      ], { stdio: 'ignore' });
      b.on('exit', () => { clearTimeout(timer); vice.kill(); vice.once('exit', () => resolve(out.trim())); });
    }, 700);
  });
}

for (const model of opt.models.split(',')) {
  for (const sid of opt.sids.split(',')) {
    console.log(`== VICE -model ${model} -sidmodel ${sid}`);
    console.log(await once(model, sid) || '(no answer)');
  }
}
