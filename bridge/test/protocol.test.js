import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CPU_HZ, Decoder, MODE, MSG, MessageParser, OP, SAMPLE_BASE, SAMPLE_END, encodeLoad, encodeMode, encodePlay, encodeRate, encodeStream, encodeUnpack, lineTimer, packNibbles, timerFor, unpackNibbles } from '../src/protocol.js';

test('nibbles pack high first and unpack again', () => {
  const nibbles = Uint8Array.from([1, 2, 15, 0, 7]);
  assert.deepEqual([...packNibbles(nibbles)], [0x12, 0xF0, 0x78]); // an odd last sample gets the middle level
  assert.equal(packNibbles(nibbles, 4).length, 4);
  assert.deepEqual([...packNibbles(nibbles, 4)], [0x12, 0xF0, 0x78, 0x88]);
  assert.deepEqual([...unpackNibbles(packNibbles(nibbles))].slice(0, 5), [...nibbles]);
});

test('timerFor gives a latch one less than the cycles per sample', () => {
  const t = timerFor(8000);
  assert.equal(t.latch, 122);
  assert.ok(Math.abs(t.rate - CPU_HZ.pal / 123) < 1e-9);
  assert.equal(timerFor(8000, CPU_HZ.ntsc).latch, 127);
  assert.throws(() => timerFor(20000), /out of range/);
});

test('load frames end in FRAME, fit the budget, and reproduce the data in memory', () => {
  const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 255);
  const frames = encodeLoad(data, SAMPLE_BASE, 120);
  for (const f of frames) {
    assert.ok(f.length <= 120);
    assert.equal(f.at(-1), OP.FRAME);
  }
  const d = new Decoder();
  for (const f of frames) d.feed(f);
  assert.equal(d.frames, frames.length);
  assert.deepEqual([...d.mem.subarray(SAMPLE_BASE, SAMPLE_BASE + 1000)], [...data]);
});

test('a 256-byte POKE is sent as n = 0', () => {
  const [f] = encodeLoad(new Uint8Array(251), SAMPLE_BASE, 256);
  assert.equal(f.length, 256);
  assert.equal(f[3], 251);
  const d = new Decoder();
  d.feed(Uint8Array.from([OP.POKE, 0, 0x20, 0, ...new Array(256).fill(9)]));
  assert.equal(d.mem[0x20FF], 9);
});

test('loading past the sample buffer is refused', () => {
  assert.throws(() => encodeLoad(new Uint8Array(10), SAMPLE_END - 5), /overflow/);
});

test('RATE and PLAY make the reference decoder play what was loaded', () => {
  const d = new Decoder();
  const bytes = Uint8Array.from([0x12, 0x34]);
  for (const f of encodeLoad(bytes)) d.feed(f);
  d.feed(Uint8Array.from([...encodeRate(122), ...encodePlay(SAMPLE_BASE, SAMPLE_BASE + 2), OP.FRAME]));
  assert.equal(d.plays.length, 1);
  assert.equal(d.plays[0].latch, 122);
  assert.deepEqual([...d.plays[0].samples], [1, 2, 3, 4]);
});

test('the message parser handles split input and resyncs after noise', () => {
  const got = [];
  const p = new MessageParser((t, a) => got.push([t, ...a]));
  p.feed([MSG.ACK, MSG.KEY]);
  p.feed([5, 1, 0xEE, MSG.DONE, MSG.HELLO_ON]);
  p.feed([3]);
  assert.deepEqual(got, [[MSG.ACK], [MSG.KEY, 5, 1], [MSG.DONE], [MSG.HELLO_ON, 3]]);
});

test('lineTimer: a sample every n raster lines', () => {
  assert.equal(lineTimer(1).latch, 62);
  assert.ok(Math.abs(lineTimer(1).rate - 15638.86) < 0.01);
  assert.equal(lineTimer(2).latch, 125);
  assert.equal(lineTimer(1, true).latch, 64);
});

test('UNPACK expands packed bytes in place, one sample per byte', () => {
  const d = new Decoder();
  const nibbles = Uint8Array.from({ length: 512 }, (_, i) => (i * 5 + (i >> 3)) & 15);
  const bytes = packNibbles(nibbles, 128);
  for (const f of encodeLoad(bytes, SAMPLE_BASE + bytes.length)) d.feed(f);
  d.feed(Uint8Array.from([...encodeUnpack(SAMPLE_BASE, bytes.length), ...encodeMode(MODE.LOCK | MODE.EXPAND, 9),
    ...encodeRate(62), ...encodePlay(SAMPLE_BASE, SAMPLE_BASE + 2 * bytes.length)]));
  assert.deepEqual([...d.mem.subarray(SAMPLE_BASE, SAMPLE_BASE + 512)], [...nibbles]);
  assert.equal(d.plays[0].samples.length, 512);
  assert.equal(d.plays[0].flags, 3);
  assert.equal(d.plays[0].delay, 9);
  assert.deepEqual([...d.plays[0].samples], [...nibbles]);
});

test('STREAM carries a 24-bit byte count', async () => {
  const { MAX_STREAM_BYTES } = await import('../src/protocol.js');
  assert.deepEqual(encodeStream(5364), [OP.STREAM, 0xF4, 0x14, 0]);
  assert.deepEqual(encodeStream(100000), [OP.STREAM, 0xA0, 0x86, 0x01]);
  assert.deepEqual(encodeStream(MAX_STREAM_BYTES), [OP.STREAM, 255, 255, 255]);
  assert.throws(() => encodeStream(0), /1 to/);
  assert.throws(() => encodeStream(MAX_STREAM_BYTES + 1), /1 to/);
  const d = new Decoder();
  d.feed(Uint8Array.from(encodeStream(100000)));
  assert.deepEqual(d.streams, [100000]);
});
