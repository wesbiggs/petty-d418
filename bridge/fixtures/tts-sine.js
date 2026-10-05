// A stand-in for a TTS program: reads text on stdin, writes a 22.05 kHz WAV whose length is
// 10 ms a character (to the file named by argv[2], or to stdout with none).
import { readFileSync, writeFileSync } from 'node:fs';
import { writeWav } from '../src/wav.js';

const text = readFileSync(0, 'utf8').trim();
const n = Math.round(22050 * 0.01 * text.length);
const wav = writeWav(Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / 22050)), 22050);
if (process.argv[2]) writeFileSync(process.argv[2], wav); else process.stdout.write(wav);
