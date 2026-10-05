// Measuring how far a decoded signal is from its target: plain SNR, and SNR of
// the error after A-weighting (IEC), which follows the ear: least sensitive
// below a few hundred Hz, most at 2-4 kHz.

// In-place radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = i + k + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

// IEC A-weighting, as a power gain at f Hz.
export function aWeight(f) {
  const f2 = f * f, c = 12194 ** 2;
  const r = c * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + c));
  return r * r;
}

export function weightedPower(x, rate) {
  let n = 1; while (n < x.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  let p = 0;
  for (let k = 1; k < n / 2; k++) p += (re[k] ** 2 + im[k] ** 2) * aWeight(k * rate / n);
  return p;
}


// SNR in dB of `y` against the target `x`, plain and A-weighted.
export function snr(x, y, rate) {
  const e = Float64Array.from(x, (v, i) => y[i] - v);
  const power = a => a.reduce((s, v) => s + v * v, 0);
  return { snr: 10 * Math.log10(power(x) / power(e)), aSnr: 10 * Math.log10(weightedPower(x, rate) / weightedPower(e, rate)) };
}
