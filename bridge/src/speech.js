// Getting audio in: macOS `say` for text, or any audio file through ffmpeg
// or afconvert; both end up as mono PCM at a known rate. Then the whole
// chain from audio to the packed bytes the C64 plays.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWav } from './wav.js';
import { LUTS, compress, preEmphasis, quantize4, reconstruct, resample } from './dsp.js';
import { packNibbles } from './protocol.js';

const SRC_RATE = 22050;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').trim()}`);
}

// Speak `text` with macOS `say` (`voice`: say -v '?' lists them).
export function say(text, voice) {
  const dir = mkdtempSync(join(tmpdir(), 'd418-'));
  try {
    const file = join(dir, 'say.wav');
    run('say', [...(voice ? ['-v', voice] : []), '-o', file, '--file-format=WAVE', `--data-format=LEI16@${SRC_RATE}`, '--', text]);
    return parseWav(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Speak `text` with any program that makes a WAV: `command` runs in a shell with the
// text on its standard input. Where it has `{out}`, that is replaced by the path
// the program should write the WAV to; with none, the WAV is read from its
// standard output. For piper: `piper -m voice.onnx -f {out}`.
export function speakWith(command, text) {
  const dir = mkdtempSync(join(tmpdir(), 'd418-'));
  try {
    const file = join(dir, 'tts.wav');
    const quoted = `'${file.replaceAll("'", "'\\''")}'`;
    const withOut = command.includes('{out}');
    const r = spawnSync('sh', ['-c', withOut ? command.replaceAll('{out}', quoted) : command], {
      input: text.replace(/\s+/g, ' ').trim() + '\n', maxBuffer: 1 << 30,
    });
    if (r.error) throw new Error(`tts: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tts command failed (${r.status}): ${r.stderr.toString().trim().split('\n').slice(-3).join(' ')}`);
    try {
      return parseWav(withOut ? readFileSync(file) : r.stdout);
    } catch (e) {
      if (!withOut) throw new Error(`tts: what the command printed is not a WAV file (${e.message})`);
      return loadAudio(file); // some other audio format
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Any audio file, converted to mono 16-bit WAV.
export function loadAudio(path) {
  if (!existsSync(path)) throw new Error(`no such file: ${path} (relative paths are from ${process.cwd()}; ~ is not expanded inside quotes)`);
  if (path.toLowerCase().endsWith('.wav')) {
    try { return parseWav(readFileSync(path)); } catch { /* fall through to a converter */ }
  }
  const dir = mkdtempSync(join(tmpdir(), 'd418-'));
  try {
    const file = join(dir, 'in.wav');
    try {
      run('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SRC_RATE), '-c:a', 'pcm_s16le', file]);
    } catch (ffmpegError) {
      try {
        run('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SRC_RATE}`, '-c', '1', path, file]);
      } catch (afconvertError) {
        // afconvert's own message ("wht?") says little: the first converter's is the one to read
        throw new Error(`cannot convert ${path}: ${ffmpegError.message}; then ${afconvertError.message}`);
      }
    }
    return parseWav(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const DEFAULTS = { bandwidth: 0.45, emphasis: 0.4, compress: 0.6, shape: 'none', dither: 0, lut: 'sid6581' };

// audio {rate, pcm} -> what the C64 plays at `rate` Hz (the exact rate its
// timer gives): nibbles (0-15), packed bytes, the float signal the SID
// outputs, and the band-limited, tilted and compressed target it was
// quantized from (for scoring).
export function prepare({ rate: srcRate, pcm }, rate, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let x = resample(pcm, srcRate, rate, o.bandwidth * rate);
  if (o.emphasis) x = preEmphasis(x, o.emphasis);
  x = compress(x, rate, { amount: o.compress });
  const lut = LUTS[o.lut];
  if (!lut) throw new Error(`unknown lut ${o.lut}`);
  const nibbles = quantize4(x, { lut, shape: o.shape, dither: o.dither });
  return { nibbles, bytes: packNibbles(nibbles), preview: reconstruct(nibbles, lut), target: x };
}
