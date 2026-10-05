import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LUTS, SHAPES, compress, quantize4, reconstruct, resample, splitQuiet } from '../src/dsp.js';
import { parseWav, writeWav } from '../src/wav.js';

const sine = (hz, rate, n, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const rms = x => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

test('resample keeps an in-band tone and removes an out-of-band one', () => {
  const keep = resample(sine(1000, 22050, 22050), 22050, 8000).subarray(200, 7800);
  assert.ok(Math.abs(rms(keep) - 0.5 / Math.SQRT2) < 0.01, `rms ${rms(keep)}`);
  const drop = resample(sine(6000, 22050, 22050), 22050, 8000).subarray(200, 7800);
  assert.ok(rms(drop) < 0.01, `rms ${rms(drop)}`);
});

test('quantize4 uses only 0-15 and stays within one step without shaping', () => {
  const x = sine(300, 8000, 4000, 0.9);
  const q = quantize4(x, { shape: 'none' });
  assert.ok(q.every(v => v <= 15));
  const y = reconstruct(q);
  assert.ok(x.every((v, i) => Math.abs(v - y[i]) <= 1 / 15 + 1e-6));
});

test('noise shaping moves the error to high frequencies', () => {
  const x = sine(200, 8000, 8000, 0.8);
  const lowBand = shape => { // error energy below 1 kHz, by a crude moving average
    const e = reconstruct(quantize4(x, { shape })).map((v, i) => v - x[i]);
    const s = []; for (let i = 8; i < e.length; i += 8) s.push(e.slice(i - 8, i).reduce((a, b) => a + b, 0) / 8);
    return rms(s);
  };
  assert.ok(lowBand('first') < lowBand('none') / 1.5);
});

test('a clipped input does not wind the shaping filter up', () => {
  const q = quantize4(new Float32Array(500).fill(3), { shape: 'second' });
  assert.ok(q.slice(-100).every(v => v === 15));
  const back = quantize4(new Float32Array(50).fill(0), { shape: 'second' });
  assert.ok(Math.abs(LUTS.linear[back[49]]) < 0.2);
});

test('compress lifts quiet passages toward loud ones and peaks at 0.97', () => {
  const quiet = sine(200, 8000, 8000, 0.02), loud = sine(200, 8000, 8000, 0.6);
  const out = compress(Float32Array.from([...quiet, ...loud]), 8000);
  assert.ok(Math.max(...out.map(Math.abs)) <= 0.97 + 1e-6);
  assert.ok(rms(out.subarray(6000, 8000)) > 4 * rms(Float32Array.from([...quiet]).subarray(6000, 8000)));
});

test('splitQuiet cuts in the pause, within the limit', () => {
  const x = new Float32Array(30000);
  x.set(sine(300, 8000, 12000), 0);
  x.set(sine(300, 8000, 10000), 20000);
  const pieces = splitQuiet(x, 8000, 16000);
  assert.equal(pieces.length, 2);
  assert.ok(pieces[0][1] >= 12000 && pieces[0][1] <= 20000);
  assert.equal(pieces[1][1], 30000);
  assert.ok(pieces.every(([s, e]) => e - s <= 16000));
});

test('WAV files round trip, and a recorder\'s bad sizes are tolerated', () => {
  const x = sine(440, 8000, 800);
  const wav = writeWav(x, 8000);
  const back = parseWav(wav);
  assert.equal(back.rate, 8000);
  assert.ok(back.pcm.every((v, i) => Math.abs(v - x[i]) < 1e-3));
  wav.writeUInt32LE(0x6c6c6c6c, 4);
  wav.writeUInt32LE(0x6c6c6c6c, 40);
  assert.equal(parseWav(wav).pcm.length, 800);
});

test('every shape in SHAPES quantizes', () => {
  for (const shape of Object.keys(SHAPES)) assert.equal(quantize4(sine(300, 8000, 100), { shape }).length, 100);
});

test('speakWith runs a TTS program: text on stdin, WAV at {out} or on stdout', async () => {
  const { speakWith } = await import('../src/speech.js');
  const script = new URL('../fixtures/tts-sine.js', import.meta.url).pathname;
  const viaFile = speakWith(`${process.execPath} ${script} {out}`, 'hello there');
  assert.equal(viaFile.rate, 22050);
  assert.equal(viaFile.pcm.length, Math.round(22050 * 0.01 * 'hello there'.length));
  const viaStdout = speakWith(`${process.execPath} ${script}`, 'hello  there\n');
  assert.equal(viaStdout.pcm.length, viaFile.pcm.length); // whitespace is collapsed
  assert.throws(() => speakWith('exit 3', 'x'), /tts command failed \(3\)/);
  assert.throws(() => speakWith('echo not a wav', 'x'), /not a WAV/);
});
