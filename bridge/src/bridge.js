#!/usr/bin/env node
// Speaks text (macOS `say`) or plays an audio file on a C64 through the SID's
// volume register. All the signal processing happens here: the bridge
// turns the audio into 4-bit samples, loads them into the C64's RAM over TCP
// (VICE's RS-232, or a WiFi modem) or a serial device, and tells it to play
// them at the right rate. See protocol.js for the wire format.
//
//   node bridge/src/bridge.js --say "Hello, world"   speak once, then exit
//   node bridge/src/bridge.js --file clip.mp3        play a file
//   node bridge/src/bridge.js                        speak each line typed
//   node bridge/src/bridge.js --say "..." --dry --out out.wav   no C64: write what it would play
//   node bridge/src/bridge.js --say "..." --tts 'piper -m voice.onnx -f {out}'   speak with another TTS
//   node bridge/src/bridge.js --say "..." --stream   play it as it is encoded: 2-bit codes, real time

import net from 'node:net';
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DTAB, OUTTAB, MAX_STREAM_BYTES, MODE, MSG, MessageParser, CPU_HZ, NIDX, SAMPLE_BASE, SAMPLE_BYTES, STREAM_WINDOW, encodeLoad, encodeMode, encodePlay, encodePoke, encodeProbe, encodeRate, encodeStream, encodeUnpack, OP, lineTimer, packNibbles, timerFor } from './protocol.js';
import { STREAM_CODEC, clientTables, decodeLevels, encodeBlocks, makeCodec, outTable, packCodes } from './codec.js';
import { describeProbe } from './probe.js';
import { lpcWeights } from './noise.js';
import { DEFAULTS, loadAudio, prepare, say, speakWith } from './speech.js';
import { LUTS, reconstruct, splitQuiet, SHAPES } from './dsp.js';
import { writeWav } from './wav.js';
import { openSerial } from './serial.js';

const { values: opt } = parseArgs({
  options: {
    port: { type: 'string', default: '6464' },
    host: { type: 'string', default: '127.0.0.1' },
    serial: { type: 'string' },
    baud: { type: 'string', default: '38400' },
    say: { type: 'string' },
    file: { type: 'string' },
    staircase: { type: 'boolean', default: false },
    voice: { type: 'string' },
    tts: { type: 'string' },
    rate: { type: 'string', default: '8000' },
    ntsc: { type: 'boolean', default: false },
    lines: { type: 'string' },
    stream: { type: 'boolean', default: false },
    weight: { type: 'string' },
    adapt: { type: 'string' },
    probe: { type: 'boolean', default: false },
    staircase256: { type: 'boolean', default: false },
    regs: { type: 'string' },
    profile: { type: 'string' },
    display: { type: 'boolean', default: false },
    bitmap: { type: 'boolean', default: false },
    phase: { type: 'string', default: '4' },
    shape: { type: 'string', default: DEFAULTS.shape },
    lut: { type: 'string', default: DEFAULTS.lut },
    dither: { type: 'string', default: String(DEFAULTS.dither) },
    emphasis: { type: 'string', default: String(DEFAULTS.emphasis) },
    compress: { type: 'string', default: String(DEFAULTS.compress) },
    window: { type: 'string', default: '2' },
    dry: { type: 'boolean', default: false },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

const log = (...a) => console.error('[d418]', ...a);
const debug = (...a) => opt.verbose && log(...a);

if (!(opt.shape in SHAPES)) {
  console.error(`[d418] unknown --shape ${opt.shape}: use ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

if (!(opt.lut in LUTS)) {
  console.error(`[d418] unknown --lut ${opt.lut}: use ${Object.keys(LUTS).join(', ')}`);
  process.exit(1);
}

const cpuHz = opt.ntsc ? CPU_HZ.ntsc : CPU_HZ.pal;
// --lines N: a sample every N raster lines (PAL: 15.6 kHz for 1, 7.8 for 2),
// with the display left on; the client locks its timer to the raster. One line
// per sample is played from one-sample-per-byte memory (half the clip length).
const lines = opt.lines === undefined ? 0 : Number(opt.lines);
if (opt.lines !== undefined && !(Number.isInteger(lines) && lines >= 1)) {
  console.error(`[d418] --lines ${opt.lines}: use a whole number of raster lines, 1 or more`);
  process.exit(1);
}
const expanded = lines === 1 && !opt.stream && !opt.staircase256;
if (opt.stream && lines === 1) {
  console.error('[d418] --stream needs a sample period of 80 cycles or more: not --lines 1');
  process.exit(1);
}
// --display with --rate: leave the display on without a line-locked period, to hear what badlines do.
const timer = lines ? lineTimer(lines, opt.ntsc) : timerFor(Number(opt.rate), cpuHz);
const dsp = { shape: opt.shape, lut: opt.lut, dither: Number(opt.dither), emphasis: Number(opt.emphasis), compress: Number(opt.compress) };
const IN_FLIGHT = 250; // of the client's 256-byte receive buffer
const FRAME_BUDGET = Math.floor(IN_FLIGHT / Number(opt.window));

// --regs d417=07,d416=ff: SID registers (or any address) to write before playing, as POKEs.
const regPokes = (opt.regs ?? '').split(',').filter(Boolean).flatMap(pair => {
  const m = /^([0-9a-f]{4})=([0-9a-f]{1,2})$/i.exec(pair.trim());
  if (!m) { console.error(`[d418] --regs ${pair}: use hexaddress=hexvalue, like d417=07`); process.exit(1); }
  return encodePoke(parseInt(m[1], 16), [parseInt(m[2], 16)]);
});

// --profile FILE: a measured output ladder (scripts/calibrate256.js --json) for the stream: the $D418
// byte to write for each of the 128 accumulator values, and the level each gives. The SID has to be
// set up as it was when the ladder was measured: give the same --regs.
const profile = opt.profile ? JSON.parse(readFileSync(opt.profile, 'utf8')) : null;
if (profile && (!profile.ladder || profile.ladder.length !== 128)) { console.error('[d418] --profile: not a calibrate256.js --json file'); process.exit(1); }

// What speaks: macOS `say` (--voice), or --tts "command" (a program that reads the text on its standard
// input and writes a WAV to {out}, like `piper -m voice.onnx -f {out}`).
const speak = text => opt.tts ? speakWith(opt.tts, text) : say(text, opt.voice);

// --- the C64 ----------------------------------------------------------------

class Link {
  constructor(stream) {
    this.stream = stream;
    this.inflight = []; // lengths of frames sent and not yet acknowledged
    this.waiting = []; // callbacks for ACK, DONE
    this.onHello = null;
    this.onCredit = null;
    this.credits = 0; // CREDITs received: bytes of a stream the C64 has taken
    this.parser = new MessageParser((type, args) => this.message(type, args));
    stream.on('data', d => this.parser.feed(d));
  }

  message(type, args) {
    if (type === MSG.CREDIT) { this.credits++; this.onCredit?.(); return; } // thousands a second: no log
    if (type === MSG.PROBE) { this.onProbe?.(args); return; }
    debug('C64 ->', Object.keys(MSG).find(k => MSG[k] === type));
    if (type === MSG.ACK) this.inflight.shift();
    if (type === MSG.HELLO) this.onHello?.();
    for (const w of [...this.waiting]) w(type);
  }

  // Resolves when `pred(type)` is true for a message from the C64.
  until(pred) {
    return new Promise((resolve, reject) => {
      const check = type => {
        if (type === 'closed') { this.waiting = this.waiting.filter(w => w !== check); return reject(new Error('C64 disconnected')); }
        if (pred(type)) { this.waiting = this.waiting.filter(w => w !== check); resolve(); }
      };
      this.waiting.push(check);
    });
  }

  closed() { for (const w of [...this.waiting]) w('closed'); }

  // Send a frame (ending in FRAME) once the client's buffer has room.
  async frame(bytes) {
    while (this.inflight.reduce((a, b) => a + b, 0) + bytes.length > IN_FLIGHT) await this.until(t => t === MSG.ACK);
    this.inflight.push(bytes.length);
    this.stream.write(Buffer.from(bytes));
  }

  drain() {
    return this.inflight.length ? this.until(() => this.inflight.length === 0) : Promise.resolve();
  }
}

// Load `bytes` into the C64 and play them.
async function playBytes(link, bytes) {
  // Expanded, the C64 unpacks the bytes in place: the packed half goes at the top.
  const at = expanded ? SAMPLE_BASE + bytes.length : SAMPLE_BASE;
  const frames = encodeLoad(bytes, at, FRAME_BUDGET);
  const t0 = Date.now();
  for (const f of frames) await link.frame(f);
  await link.drain();
  const loadMs = Date.now() - t0;
  if (expanded) {
    await link.frame([...encodeUnpack(SAMPLE_BASE, bytes.length), OP.FRAME]);
    await link.drain(); // the C64 answers when it has unpacked them
  }
  const flags = (lines || opt.display ? MODE.LOCK : 0) | (expanded ? MODE.EXPAND : 0) | (opt.bitmap ? MODE.BITMAP : 0);
  const end = SAMPLE_BASE + bytes.length * (expanded ? 2 : 1);
  const done = link.until(t => t === MSG.DONE);
  await link.frame([...encodeMode(flags, Number(opt.phase)), ...encodeRate(timer.latch), ...encodePlay(SAMPLE_BASE, end), OP.FRAME]);
  log(`loaded ${bytes.length} bytes in ${(loadMs / 1000).toFixed(2)} s, playing ${(bytes.length * 2 / timer.rate).toFixed(2)} s at ${timer.rate.toFixed(0)} Hz`);
  await done;
  await link.drain();
}

// --- streaming: 2-bit codes, played as they are encoded ----------------------

const codec = makeCodec(STREAM_CODEC);
// --weight -0.6: where the encoder puts its noise (see encodeBlocks): negative moves it down in frequency, under the bass.
const errorWeight = (opt.weight ?? '').split(',').filter(Boolean).map(Number);
// --adapt order:gamma[:floor]: weights that follow the signal's spectrum, block by block (noise.js), e.g. 2:0.7.
const adapt = opt.adapt ? (([order, gamma, floor]) => ({ order: Number(order), gamma: Number(gamma), ...(floor ? { floor: Number(floor) } : {}) }))(opt.adapt.split(':')) : null;
if (adapt && !(adapt.order >= 1 && adapt.gamma > 0 && adapt.gamma < 1)) { console.error('[d418] --adapt: order:gamma, like 2:0.7 (order 1 or more, gamma between 0 and 1)'); process.exit(1); }
if (errorWeight.some(Number.isNaN)) { console.error('[d418] --weight: a list of numbers, like -0.6 or -1,0.3'); process.exit(1); }
// D418_STALL=bytes:ms makes the bridge stop sending for a while after that many bytes, to test the C64 running dry.
const stall = process.env.D418_STALL ? { at: Number(process.env.D418_STALL.split(':')[0]), ms: Number(process.env.D418_STALL.split(':')[1]), done: false } : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldToLoop = () => new Promise(r => setImmediate(r));

// Encode `target` (a multiple of 4 samples) into codes, a block at a time.
// With a `link`, the bytes are sent as they are made: STREAM_WINDOW of them,
// and one for each byte the C64 reports taking, so the C64's buffer holds
// about 64 ms and neither overflows nor, if the bridge keeps ahead, runs dry.
async function streamSegment(link, target, lut) {
  const n = target.length / 4;
  const parts = [];
  let fifo = Buffer.alloc(0), sent = 0, scheduled = false, paused = false;
  const flush = () => {
    if (paused) return;
    const k = Math.min(STREAM_WINDOW - (sent - link.credits), fifo.length);
    if (k > 0) {
      link.stream.write(fifo.subarray(0, k));
      fifo = fifo.subarray(k);
      sent += k;
    }
  };
  let done = null, t0 = 0;
  if (link) {
    const { dtab, nidx } = clientTables(codec);
    await link.frame([...encodePoke(DTAB, dtab), ...encodePoke(NIDX, nidx), ...encodePoke(OUTTAB, outTable(codec, profile?.ladder)), OP.FRAME]);
    await link.drain();
    link.credits = 0;
    link.onCredit = () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => { scheduled = false; flush(); });
    };
    done = link.until(t => t === MSG.DONE);
    // No FRAME after STREAM: the C64 would take it for data.
    link.stream.write(Buffer.from([...encodeMode(lines ? MODE.LOCK : 0, Number(opt.phase)), ...encodeRate(timer.latch), ...encodeStream(n)]));
    t0 = Date.now();
    if (opt.verbose) {
      const t = setInterval(() => log(`stream: sent ${sent}/${n}, credits ${link.credits}, queued ${fifo.length}`), 1000);
      t.unref();
    }
  }
  for (const codes of encodeBlocks(codec, target, lut, 256, 128, adapt ? lpcWeights(target, adapt) : errorWeight, adapt ? 0.02 : Infinity)) {
    parts.push(codes);
    if (!link) continue;
    fifo = Buffer.concat([fifo, packCodes(codes, 2)]);
    flush();
    if (stall && sent >= stall.at && !stall.done) { stall.done = true; paused = true; await sleep(stall.ms); paused = false; flush(); } // test: make the C64's buffer run dry
    await yieldToLoop();
    while (fifo.length > 1024) await sleep(5); // no more than about half a second ahead
  }
  if (link) {
    while (sent < n) { await sleep(5); flush(); }
    log(`streamed ${n} bytes, ${(n * 4 / timer.rate).toFixed(2)} s of speech, in ${((Date.now() - t0) / 1000).toFixed(2)} s`);
    await done;
    link.onCredit = null;
  }
  const codes = new Uint8Array(target.length);
  let at = 0;
  for (const c of parts) { codes.set(c, at); at += c.length; }
  return codes;
}

async function performStream(job, link) {
  const audio = job.file ? loadAudio(job.file) : speak(job.text);
  const { target } = prepare(audio, timer.rate, dsp);
  const lut = profile ? profile.ladder.map(b => profile.levels[b]) : LUTS[opt.lut];
  const preview = [];
  for (const [s, e] of splitQuiet(target, timer.rate, MAX_STREAM_BYTES * 4)) { // a STREAM counts bytes in 24 bits
    const seg = new Float32Array(Math.ceil((e - s) / 4) * 4);
    seg.set(target.subarray(s, e));
    const codes = await streamSegment(link, seg, lut);
    // what the C64 plays: its start state first, then each code's output
    preview.push(Float32Array.of(lut[64]), decodeLevels(codec, codes, lut));
  }
  if (opt.out) {
    writeFileSync(opt.out, writeWav(Float32Array.from(preview.flatMap(a => Array.from(a))), timer.rate));
    writeFileSync(`${opt.out}.rate`, String(timer.rate)); // a WAV header holds whole Hz, and a long clip drifts
    // the signal the codes were made from, to score a recording against what was meant and not only the plan
    const targetOut = opt.out.replace(/\.wav$/, '') + '.target.wav';
    writeFileSync(targetOut, writeWav(target, timer.rate));
    writeFileSync(`${targetOut}.rate`, String(timer.rate));
    log(`wrote ${opt.out}`);
  }
}

// --- jobs: text or files to play ---------------------------------------------

// A calibration signal: volume 0, 1, ... 15, then back, each held for 256
// samples, twice.
const staircase = () => {
  const up = Array.from({ length: 16 }, (_, k) => k), down = up.slice(0, 15).reverse();
  const nibbles = Uint8Array.from([...up, ...down, ...up, ...down].flatMap(k => new Array(256).fill(k)));
  return { p: { nibbles, preview: reconstruct(nibbles, LUTS[opt.lut]) }, pieces: [[0, nibbles.length]] };
};

function render(job) {
  if (job.staircase) return staircase();
  const audio = job.file ? loadAudio(job.file) : speak(job.text);
  const p = prepare(audio, timer.rate, dsp);
  const max = expanded ? SAMPLE_BYTES : SAMPLE_BYTES * 2;
  return { p, pieces: splitQuiet(p.target, timer.rate, max) };
}

// Every byte value written to $D418, against a reference byte: 32 samples each of a 15 and a 0 (to find
// the start by), then the reference and each value 0-255 in turn (scripts/calibrate256.js measures the
// step between them, so each level is measured on its own, not by summing many small steps).
const REFERENCE = 8;
const staircase256Bytes = () => Uint8Array.from([
  ...new Array(32).fill(15), ...new Array(32).fill(0),
  ...Array.from({ length: 256 }, (_, v) => v).flatMap(v => [...new Array(32).fill(REFERENCE), ...new Array(32).fill(v)]),
  ...new Array(32).fill(REFERENCE),
]);

// Samples written to $D418 as they are, one a byte: the whole byte, not the volume nibble.
async function playRaw(link, bytes) {
  const padded = new Uint8Array(Math.ceil(bytes.length / 256) * 256).fill(8);
  padded.set(bytes);
  if (padded.length > SAMPLE_BYTES) throw new Error('too long for the sample RAM');
  for (const f of encodeLoad(padded, SAMPLE_BASE, FRAME_BUDGET)) await link.frame(f);
  await link.drain();
  const done = link.until(t => t === MSG.DONE);
  await link.frame([...encodeMode(MODE.EXPAND | (lines ? MODE.LOCK : 0), Number(opt.phase)), ...encodeRate(timer.latch), ...encodePlay(SAMPLE_BASE, SAMPLE_BASE + padded.length), OP.FRAME]);
  log(`playing ${padded.length} raw bytes, ${(padded.length / timer.rate).toFixed(2)} s`);
  await done;
  await link.drain();
}

async function perform(job, link) {
  if (link && regPokes.length) {
    await link.frame([...regPokes, OP.FRAME]);
    await link.drain();
  }
  if (job.staircase256) return link && playRaw(link, staircase256Bytes());
  if (opt.stream) return performStream(job, link);
  const { p, pieces } = render(job);
  if (opt.out) {
    writeFileSync(opt.out, writeWav(p.preview, timer.rate));
    writeFileSync(`${opt.out}.rate`, String(timer.rate));
    log(`wrote ${opt.out}`);
  }
  if (!link) return;
  for (const [s, e] of pieces) await playBytes(link, packNibbles(p.nibbles.subarray(s, e), expanded ? 128 : 1));
}

const jobs = [];
let busy = false;
let link = null;
let ready = false;
let inputDone = false;

async function pump() {
  if (busy || (!opt.dry && !(link && ready))) return;
  busy = true;
  try {
    while (jobs.length) {
      const job = jobs.shift();
      try {
        await perform(job, opt.dry ? null : link);
      } catch (e) {
        log(e.message);
        if (opt.dry) process.exitCode = 1;
        if (!opt.dry && !ready) { jobs.unshift(job); break; } // C64 went away: try again on reconnect
      }
    }
  } finally {
    busy = false;
  }
  if (inputDone && !jobs.length && !opt.keep) process.exit();
}

const add = job => { jobs.push(job); pump(); };

// Ask the C64 what it is, and say what the bridge makes of it.
async function probe(link) {
  const got = new Promise(resolve => { link.onProbe = resolve; });
  link.stream.write(Buffer.from(encodeProbe()));
  console.log(describeProbe(await got));
}

// --- start ----------------------------------------------------------------------

if (opt.probe) { /* below: needs the link */ }
else if (opt.staircase256) { add({ staircase256: true }); inputDone = true; }
else if (opt.staircase) { add({ staircase: true }); inputDone = true; }
else if (opt.say) { add({ text: opt.say }); inputDone = true; }
else if (opt.file) { add({ file: opt.file }); inputDone = true; }
else {
  log(opt.dry ? 'type text to render' : 'type text to speak');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => line.trim() && add({ text: line.trim() }));
  rl.on('close', () => { inputDone = true; pump(); });
}

if (!opt.dry) {
  const attach = stream => {
    link?.closed();
    const l = new Link(stream);
    link = l;
    ready = false;
    l.onHello = () => {
      log('C64 ready');
      ready = true;
      if (opt.probe) probe(l).then(() => process.exit(), e => { log(e.message); process.exit(1); });
      else pump();
    };
    const gone = () => { if (link === l) { ready = false; l.closed(); log('C64 disconnected'); } };
    stream.on('close', gone);
    stream.on('error', gone);
  };
  if (opt.serial) {
    log(`serial ${opt.serial} at ${opt.baud} baud: start the client`);
    attach(openSerial(opt.serial, Number(opt.baud)));
  } else {
    net.createServer(sock => { log('client connected'); attach(sock); }).listen(Number(opt.port), opt.host, () =>
      log(`listening on ${opt.host}:${opt.port}, ${timer.rate.toFixed(1)} Hz (timer latch ${timer.latch}), ${opt.ntsc ? 'NTSC' : 'PAL'}`));
  }
}
