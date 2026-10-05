// What the C64's PROBE measurements say about the machine. The client only
// measures (client.s, op_probe); what the numbers mean is decided here, so a
// better rule needs no new 6502 code.

// Cycles in a video frame -> the machine's video standard. The CPU runs
// 63 cycles to a raster line on PAL, 65 on NTSC (64 on the oldest NTSC chips).
export const REGIONS = [
  { name: 'PAL', frame: 19656, lineCycles: 63, cpuHz: 985248 },
  { name: 'PAL-N', frame: 20280, lineCycles: 65, cpuHz: 1023440 },
  { name: 'NTSC', frame: 17095, lineCycles: 65, cpuHz: 1022727 },
  { name: 'NTSC (old)', frame: 16768, lineCycles: 64, cpuHz: 1022727 },
];

export function classifyRegion(frameCycles) {
  let best = REGIONS[0];
  for (const r of REGIONS) if (Math.abs(r.frame - frameCycles) < Math.abs(best.frame - frameCycles)) best = r;
  return { ...best, error: frameCycles - best.frame };
}

// Voice 3's oscillator at the fast speed (the first six waveforms of the 21
// readings), for each SID model, as VICE's reSID reports them. The other
// readings change with the video standard, and these do not. reSID's combined
// waveforms are modelled on real chips, but real chips differ from the model
// and from each other, so these are what to compare against, not exact values:
// the two that tell the models apart are saw+triangle and pulse+saw, which are
// weak on a 6581 and strong on an 8580. VICE's "8580 with digiboost" reads the
// same as the 8580.
export const SID_SIGNATURES = {
  '6581': [0x53, 0x29, 0x38, 0xff, 0x00, 0x7e],
  '8580': [0x51, 0x28, 0xf8, 0xff, 0x00, 0xfd],
};

// The model whose signature the readings are closest to (the sum of the
// differences), and how clearly: 1 is no better than the other, 0 an exact match.
// `model` is null when the readings are further from both than the two are from
// each other, as for a chip that is neither.
export function classifySid(readings) {
  const dist = sig => sig.reduce((a, v, i) => a + Math.abs(v - readings[i]), 0);
  const entries = Object.entries(SID_SIGNATURES).map(([model, sig]) => ({ model, d: dist(sig) })).sort((a, b) => a.d - b.d);
  const between = SID_SIGNATURES['6581'].reduce((a, v, i) => a + Math.abs(v - SID_SIGNATURES['8580'][i]), 0);
  const [best, other] = entries;
  return { model: best.d > between ? null : best.model, distance: best.d, ratio: other.d ? best.d / other.d : 0 };
}

export function describeProbe(bytes) {
  const cycles = bytes[0] | bytes[1] << 8;
  const readings = bytes.slice(2, 23);
  const region = classifyRegion(cycles);
  const sid = classifySid(readings);
  return `frame ${cycles} cycles: ${region.name} (${region.error >= 0 ? '+' : ''}${region.error})\n` +
    ['fast', 'medium', 'slow'].map((n, k) => `voice 3 ${n.padEnd(6)} (tri, saw, saw+tri, pulse, pulse+tri, pulse+saw, all): ${readings.slice(k * 7, k * 7 + 7).map(v => v.toString(16).padStart(2, '0')).join(' ')}`).join('\n') + '\n' +
    `SID: ${sid.model ? `${sid.model} (distance ${sid.distance}, ${(sid.ratio * 100).toFixed(0)}% of the other's)` : `unknown (distance ${sid.distance})`}`;
}
