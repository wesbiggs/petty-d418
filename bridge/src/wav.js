// Minimal WAV reading and writing: 16-bit PCM or 32-bit float, any number of
// channels (mixed down to mono). The reader tolerates the wrong chunk sizes
// that a recorder leaves in the header when it is killed.

export function parseWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'data') {
      if (size === 0 || size === 0xFFFFFFFF || body + size > buf.length) size = buf.length - body;
      data = buf.subarray(body, body + size);
      break;
    }
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt or data chunk');
  const { channels, bits } = fmt;
  const float = fmt.tag === 3 || (fmt.tag === 0xFFFE && bits === 32);
  if (!(bits === 16 || (float && bits === 32))) throw new Error(`unsupported WAV format (tag ${fmt.tag}, ${bits} bits)`);
  const bytes = bits / 8, n = Math.floor(data.length / (bytes * channels));
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      sum += float ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
    }
    pcm[i] = sum / channels;
  }
  return { rate: fmt.rate, pcm };
}

// 16-bit mono WAV of samples in -1..1.
export function writeWav(pcm, rate) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(Math.round(rate), 24);
  buf.writeUInt32LE(Math.round(rate) * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return buf;
}
