// A small adaptive delta code for the SID volume register, to stream speech
// in real time over a link too slow for 4-bit samples (a 38400-baud SwiftLink
// carries 3.8 KB/s; 4-bit samples at 8 kHz are 4).
//
// The C64 side is a few table lookups per sample. Its state is an
// accumulator `acc` (accBits wide) and a step index `idx`. A code is `bits`
// bits: the top one is the sign, the rest select a magnitude m. Then
//
//   acc += sign ? -d : +d      where d = DELTA[idx][m] (saturating at 0 and the top)
//   idx += IDX[m]              (clamped to 0..N-1)
//   output = acc >> (accBits - 4)         the volume nibble
//
// so the step grows after large codes and shrinks after small ones. The
// accumulator is finer than the 4-bit output, so a small step moves the output
// only now and then. That is a form of noise shaping that costs nothing.
//
// The bridge does the work, in the encoder: a Viterbi search over the
// decoder's states for the code sequence whose output is closest to the
// target, and not a quantizer that follows the signal sample by sample.

// params: { bits, accBits, steps: [per idx, in acc units], mags: [per
// magnitude, multiples of steps[idx]], idxDelta: [per magnitude], idx0 }
export function makeCodec(params) {
  const { bits, accBits, steps, mags, idxDelta } = params;
  const nm = 1 << (bits - 1), N = steps.length, size = 1 << accBits;
  if (mags.length !== nm || idxDelta.length !== nm) throw new Error(`${bits}-bit codes need ${nm} magnitudes`);
  const delta = new Int32Array(N * nm);
  for (let i = 0; i < N; i++) for (let m = 0; m < nm; m++) delta[i * nm + m] = Math.max(1, Math.round(steps[i] * mags[m]));
  const ncodes = 1 << bits;
  const states = size * N;
  if (states * ncodes > 65535) throw new Error('too many states for the search');
  // next[state * ncodes + code]; state = acc * N + idx
  const next = new Uint16Array(states * ncodes);
  for (let acc = 0; acc < size; acc++) {
    for (let idx = 0; idx < N; idx++) {
      for (let code = 0; code < ncodes; code++) {
        const sign = code >> (bits - 1), m = code & (nm - 1);
        const d = delta[idx * nm + m];
        const a = sign ? Math.max(0, acc - d) : Math.min(size - 1, acc + d);
        const i = Math.min(N - 1, Math.max(0, idx + idxDelta[m]));
        next[(acc * N + idx) * ncodes + code] = a * N + i;
      }
    }
  }
  return { ...params, nm, N, size, ncodes, states, delta, next, shift: accBits - 4, start: (size >> 1) * N + (params.idx0 ?? 0) };
}

// The output level for each accumulator value: `lut` is either one entry per
// volume nibble (16) or one per accumulator value.
export function accLevels(codec, lut) {
  return lut.length === codec.size ? lut : Array.from({ length: codec.size }, (_, a) => lut[a >> codec.shift]);
}

// codes -> the output level of each sample (through accLevels)
export function decodeLevels(codec, codes, lut) {
  const levels = accLevels(codec, lut), out = new Float32Array(codes.length);
  let s = codec.start;
  for (let t = 0; t < codes.length; t++) {
    s = codec.next[s * codec.ncodes + codes[t]];
    out[t] = levels[Math.floor(s / codec.N)];
  }
  return out;
}

// codes -> volume nibbles
export function decode(codec, codes) {
  const out = new Uint8Array(codes.length);
  let s = codec.start;
  for (let t = 0; t < codes.length; t++) {
    s = codec.next[s * codec.ncodes + codes[t]];
    out[t] = Math.floor(s / codec.N) >> codec.shift;
  }
  return out;
}

// target (floats, -1..1) -> codes whose decoded output, through `lut`, is
// closest in squared error. A Viterbi search over every (acc, idx) state, in
// blocks: each block of `block` samples is searched with `look` samples of
// lookahead, its best path is committed, and the next block starts from the
// state that path ended in. (Deciding sample by sample from the best path so
// far is no good: the decoder integrates, so one code from a different path
// than its neighbours leaves a lasting offset.) A generator, so that a stream
// can start before the whole signal is encoded: it yields the codes of each block.
//
// `weight` = [a1, a2, ...] makes the cost the energy of the error filtered by
// 1 + a1 z^-1 + a2 z^-2 ..., so that error the filter attenuates is cheap and the
// search puts the noise there. Negative a1 (-0.6) attenuates low frequencies and
// weighs high ones, so the noise moves down in frequency, under the bass of
// music or speech that masks it, and away from 2-4 kHz where it is most
// audible; positive a1 does the opposite. Each state remembers the errors of
// the path that reached it, which is an approximation: the search is no longer exact.
// `weight` can also be a function of the position of a block (noise.js lpcWeights)
// that gives its coefficients, all the same length. `beam`: states whose cost is more than
// this above the best are dropped at each step, which makes a long weight affordable.
export function* encodeBlocks(codec, target, lut, block = 256, look = 128, weight = [], beam = Infinity) {
  const { next, states, ncodes, N, shift } = codec;
  const level = new Float64Array(states);
  const levels = accLevels(codec, lut);
  for (let s = 0; s < states; s++) level[s] = levels[Math.floor(s / N)];
  const T = target.length;
  const back = new Uint16Array((block + look) * states); // per time: previous state * ncodes + code
  let cost = new Float64Array(states), nxt = new Float64Array(states);
  let state = codec.start;
  const weightAt = typeof weight === 'function' ? weight : () => weight;
  let w = weightAt(0);
  const M = w.length;
  let hist = new Float64Array(states * M), nhist = new Float64Array(states * M); // each state's last M errors
  let past = new Float64Array(M); // the committed path's last M errors
  for (let pos = 0; pos < T; pos += block) {
    const end = Math.min(T, pos + block + look), n = end - pos;
    if (pos) w = weightAt(pos);
    cost.fill(Infinity);
    cost[state] = 0;
    for (let m = 0; m < M; m++) hist[state * M + m] = past[m];
    for (let k = 0; k < n; k++) {
      nxt.fill(Infinity);
      const x = target[pos + k], col = k * states;
      let limit = Infinity;
      if (beam < Infinity) {
        let lo = Infinity;
        for (let s = 0; s < states; s++) if (cost[s] < lo) lo = cost[s];
        limit = lo + beam;
      }
      for (let s = 0; s < states; s++) {
        const c0 = cost[s];
        if (c0 === Infinity || c0 > limit) continue;
        let fb = 0; // the weighted past of this path's error, the same for each code
        for (let m = 0; m < M; m++) fb += w[m] * hist[s * M + m];
        for (let code = 0; code < ncodes; code++) {
          const ns = next[s * ncodes + code], e = level[ns] - x;
          const we = e + fb;
          const c = c0 + we * we;
          if (c < nxt[ns]) {
            nxt[ns] = c;
            back[col + ns] = s * ncodes + code;
            if (M) { nhist[ns * M] = e; for (let m = 1; m < M; m++) nhist[ns * M + m] = hist[s * M + m - 1]; }
          }
        }
      }
      [cost, nxt] = [nxt, cost];
      [hist, nhist] = [nhist, hist];
    }
    let st = 0;
    for (let s = 1; s < states; s++) if (cost[s] < cost[st]) st = s;
    const path = new Uint8Array(n);
    for (let k = n - 1; k >= 0; k--) {
      const v = back[k * states + st];
      path[k] = v % ncodes;
      st = (v - path[k]) / ncodes;
    }
    const keep = pos + block >= T ? n : block; // the last block takes what the lookahead covered
    const codes = path.subarray(0, keep);
    for (let k = 0; k < keep; k++) {
      state = next[state * ncodes + codes[k]];
      if (M) { past.copyWithin(1, 0, M - 1); past[0] = level[state] - target[pos + k]; }
    }
    yield codes;
  }
}

export function encode(codec, target, lut, block = 256, look = 128, weight = [], beam = Infinity) {
  const codes = new Uint8Array(target.length);
  let at = 0;
  for (const chunk of encodeBlocks(codec, target, lut, block, look, weight, beam)) { codes.set(chunk, at); at += chunk.length; }
  return codes;
}

// The code the C64 client decodes (c64/d418.s): 2-bit codes, a 7-bit
// accumulator (the volume is its top 4 bits), six step sizes.
export const STREAM_CODEC = {
  bits: 2, accBits: 7, steps: [1, 1.7, 2.9, 4.9, 8.35, 14.2], mags: [0.5, 1.5], idxDelta: [-1, 1], idx0: 0,
};

// What the stream writes to $D418 for each accumulator value: the volume
// nibble by default, or `bytes` (one per accumulator value) for a profile that
// uses the filter bits too.
export function outTable(codec, bytes = null) {
  if (bytes && bytes.length !== codec.size) throw new Error(`an output table needs ${codec.size} entries`);
  return Uint8Array.from({ length: codec.size }, (_, a) => bytes ? bytes[a] : a >> codec.shift);
}

// The two 24-byte tables the client indexes by idx * 4 + code: the signed
// move of the accumulator, and the next idx * 4. (The client starts from
// acc = 64, idx = 0, as makeCodec's `start` does.)
export function clientTables(codec) {
  if (codec.bits !== 2 || codec.accBits !== 7 || codec.N > 6 || (codec.idx0 ?? 0) !== 0) throw new Error('the client decodes 2-bit codes with a 7-bit accumulator and up to 6 steps');
  const dtab = new Uint8Array(24), nidx = new Uint8Array(24);
  for (let idx = 0; idx < codec.N; idx++) {
    for (let code = 0; code < 4; code++) {
      const sign = code >> 1, m = code & 1;
      const d = codec.delta[idx * 2 + m];
      if (d > 63) throw new Error('a step too big for a 7-bit accumulator');
      dtab[idx * 4 + code] = sign ? (256 - d) & 255 : d;
      nidx[idx * 4 + code] = Math.min(codec.N - 1, Math.max(0, idx + codec.idxDelta[m])) * 4;
    }
  }
  return { dtab, nidx };
}

// `bits`-bit codes (1, 2 or 4), first one in the high bits of a byte.
export function packCodes(codes, bits) {
  if (![1, 2, 4].includes(bits)) throw new Error(`cannot pack ${bits}-bit codes into bytes`);
  const per = 8 / bits;
  const out = new Uint8Array(Math.ceil(codes.length / per));
  for (let i = 0; i < codes.length; i++) out[(i / per) | 0] |= codes[i] << (8 - bits - (i % per) * bits);
  return out;
}

// Geometric step table: n steps from `first` to `first * ratio ** (n - 1)`.
export const geometric = (first, ratio, n) => Array.from({ length: n }, (_, i) => first * ratio ** i);
