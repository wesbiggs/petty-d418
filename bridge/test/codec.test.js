import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accLevels, clientTables, decode, decodeLevels, encode, encodeBlocks, geometric, makeCodec, outTable, packCodes } from '../src/codec.js';
import { LUTS, reconstruct } from '../src/dsp.js';

const params = { bits: 2, accBits: 7, steps: [1, 1.7, 2.9, 4.9, 8.3, 14.2], mags: [0.5, 1.5], idxDelta: [-1, 1] };
const sine = (hz, n, amp = 0.6) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / 8000));
const snr = (x, y) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.reduce((a, v, i) => a + (v - y[i]) ** 2, 0));

test('the decoder saturates at both ends and keeps its step index in range', () => {
  const c = makeCodec(params);
  const up = decode(c, new Uint8Array(200).fill(1)); // sign 0, large
  assert.equal(up.at(-1), 15);
  const down = decode(c, new Uint8Array(200).fill(3)); // sign 1, large
  assert.equal(down.at(-1), 0);
  assert.ok(up.every(v => v <= 15));
});

test('the same codes always decode to the same output', () => {
  const c = makeCodec(params);
  const codes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + (i >> 2)) & 3);
  assert.deepEqual([...decode(c, codes)], [...decode(c, codes)]);
});

test('the encoder follows a sine at 2 bits a sample, across block boundaries', () => {
  const c = makeCodec(params);
  const x = sine(300, 1500);
  const codes = encode(c, x, LUTS.linear, 100, 40); // blocks of 100: many boundaries
  assert.equal(codes.length, 1500);
  const y = reconstruct(decode(c, codes), LUTS.linear);
  assert.ok(snr(x, y) > 10, `snr ${snr(x, y)}`);
});

test('blocks and lookahead barely matter: the committed path is one path', () => {
  const c = makeCodec(params);
  const x = sine(200, 1200);
  const a = reconstruct(decode(c, encode(c, x, LUTS.linear, 64, 32)), LUTS.linear);
  const b = reconstruct(decode(c, encode(c, x, LUTS.linear, 400, 100)), LUTS.linear);
  assert.ok(Math.abs(snr(x, a) - snr(x, b)) < 3);
});

test('packCodes puts the first code in the high bits', () => {
  assert.deepEqual([...packCodes(Uint8Array.from([1, 2, 3, 0, 3]), 2)], [0b01101100, 0b11000000]);
  assert.throws(() => packCodes(Uint8Array.from([5, 2]), 3), /cannot pack/);
});

test('geometric makes a table', () => {
  assert.deepEqual(geometric(2, 2, 4), [2, 4, 8, 16]);
});

test('the blocks add up to the signal, whatever its length (the last one is never repeated)', () => {
  const c = makeCodec(params);
  for (const len of [50, 100, 101, 230, 301, 339, 340, 341, 500]) {
    const total = [...encodeBlocks(c, sine(200, len), LUTS.linear, 100, 40)].reduce((a, b) => a + b.length, 0);
    assert.equal(total, len, `length ${len}`);
  }
});

test('clientTables: 24 entries, signed moves and the next index times four', () => {
  const { dtab, nidx } = clientTables(makeCodec({ bits: 2, accBits: 7, steps: [1, 1.7, 2.9, 4.9, 8.35, 14.2], mags: [0.5, 1.5], idxDelta: [-1, 1] }));
  assert.equal(dtab.length, 24);
  assert.deepEqual([...dtab.subarray(0, 4)], [1, 2, 255, 254]); // idx 0: +small, +large, -small, -large
  assert.deepEqual([...nidx.subarray(0, 4)], [0, 4, 0, 4]);      // down is clamped at 0
  assert.deepEqual([...nidx.subarray(20, 24)], [16, 20, 16, 20]); // from the top step: small goes down, large stays
});

test('output levels: one per nibble expands to one per accumulator value', () => {
  const c = makeCodec(params);
  const levels = accLevels(c, LUTS.linear);
  assert.equal(levels.length, 128);
  assert.equal(levels[0], LUTS.linear[0]);
  assert.equal(levels[127], LUTS.linear[15]);
  assert.equal(levels[8], LUTS.linear[1]); // 8 >> 3
  const own = Array.from({ length: 128 }, (_, a) => a / 64 - 1);
  assert.equal(accLevels(c, own), own); // a table with one per value is used as it is
});

test('decodeLevels agrees with decode through the nibble table', () => {
  const c = makeCodec(params);
  const codes = encode(c, sine(250, 600), LUTS.linear, 100, 40);
  assert.deepEqual([...decodeLevels(c, codes, LUTS.linear)], [...reconstruct(decode(c, codes), LUTS.linear)]);
});

test('outTable is the volume nibble unless a ladder is given', () => {
  const c = makeCodec(params);
  const t = outTable(c);
  assert.equal(t.length, 128);
  assert.deepEqual([t[0], t[7], t[8], t[127]], [0, 0, 1, 15]);
  assert.deepEqual([...outTable(c, Uint8Array.from({ length: 128 }, (_, i) => 255 - i)).subarray(0, 3)], [255, 254, 253]);
  assert.throws(() => outTable(c, [1, 2, 3]), /128 entries/);
});

test('a negative error weight moves the encoder\'s noise down in frequency', () => {
  const c = makeCodec(params);
  const x = Float32Array.from({ length: 1500 }, (_, i) => 0.5 * Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.31 + 1));
  const roughness = codes => { // energy of the error's first difference, relative to the error's own: high for high-frequency noise
    const y = decodeLevels(c, codes, LUTS.linear), e = Array.from(y, (v, i) => v - x[i]);
    const d = e.slice(1).map((v, i) => v - e[i]);
    return d.reduce((a, v) => a + v * v, 0) / e.reduce((a, v) => a + v * v, 0);
  };
  const plain = roughness(encode(c, x, LUTS.linear, 128, 48));
  const weighted = roughness(encode(c, x, LUTS.linear, 128, 48, [-0.8]));
  assert.ok(weighted < plain, `weighted ${weighted} plain ${plain}`);
  assert.equal(encode(c, x, LUTS.linear, 128, 48, [-0.8]).length, 1500);
});
