// Where the encoder should put its noise: under the signal's own spectrum, which
// masks it. The weight for a block of the signal is the whitening filter
// A(z) of its spectral envelope (LPC, by Levinson-Durbin), with its poles pulled
// in by `gamma`: A(z / gamma) = 1 + a1 gamma z^-1 + a2 gamma^2 z^-2 + ... An
// encoder that minimises the energy of the error after this filter leaves
// an error whose spectrum is the envelope's (flattened as gamma falls: 0 is
// white noise). The envelope is floored at `floor` times the signal power, so a
// spectrum with a 50 dB drop is not followed all the way down.

// Autocorrelation of x[from, to) under a Hann window, lags 0..order.
export function autocorrelation(x, from, to, order) {
  const n = to - from, w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = from + i;
    w[i] = j >= 0 && j < x.length ? x[j] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n)) : 0;
  }
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += w[i] * w[i - lag];
    r[lag] = s;
  }
  return r;
}

// Levinson-Durbin: a[1..order] of A(z) = 1 + sum a_k z^-k from the autocorrelation r.
export function levinson(r, order) {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  if (err <= 0) return a;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) break;
  }
  return a;
}

// The weight function for encodeBlocks: given where a block starts, the filter coefficients
// [w1, ..., w_order] of A(z / gamma) for the signal around it (`ahead` samples of the
// next block count too, since the search looks that far).
export function lpcWeights(target, { order = 10, gamma = 0.9, floor = 1e-3, window = 512, block = 256 } = {}) {
  const zeros = new Array(order).fill(0);
  return pos => {
    const from = pos + (block >> 1) - (window >> 1);
    const r = autocorrelation(target, from, from + window, order);
    if (!(r[0] > 1e-9)) return zeros; // silence: nothing to follow
    r[0] *= 1 + floor;
    const a = levinson(r, order);
    return Array.from({ length: order }, (_, k) => a[k + 1] * gamma ** (k + 1));
  };
}
