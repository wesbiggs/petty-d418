// Wire protocol between the bridge and the C64 client. It is PETTY's framing:
// one-byte opcodes with their arguments inline, a FRAME at the end of each
// group that the C64 answers with ACK, and the bridge keeping a bounded
// number of bytes in flight so the client's 256-byte receive buffer never
// overflows. The opcodes here keep PETTY's numbers (FRAME = 8, POKE = 15),
// so this can be folded into PETTY's protocol; PETTY's screen commands (1-7,
// 9-14) are ignored by this client.
//
// Host -> C64:
//   08                 FRAME  end of frame; C64 answers ACK
//   0F lo hi n d1..dn  POKE   write n bytes (0 = 256) at lo + 256 * hi. The
//                             bridge uses it to load samples at SAMPLE_BASE: each
//                             byte holds two 4-bit samples, the first in the
//                             high nibble
//   10 lo hi           RATE   CIA timer latch: a sample lasts latch + 1 cycles
//   11 lo hi lo hi     PLAY   play the bytes start..end-1 (end exclusive); the
//                             C64 answers DONE when it has played them
//   12 flags delay     MODE   how PLAY runs. LOCK (1): keep the display on and
//                             start the timer `delay` * 5 cycles into a raster line,
//                             so a timer period of a whole number of lines puts
//                             every write at the same cycle of its line (otherwise
//                             the screen is blanked while playing). EXPAND (2): the
//                             samples are one per byte (0-15), not two; PLAY then
//                             needs whole 256-byte pages. BITMAP (4): test only,
//                             switch the VIC to a hi-res bitmap while playing
//   13 lo hi n_lo n_hi UNPACK n packed bytes at lo + 256 * hi + n become the 2n
//                             samples, one per byte, at lo + 256 * hi (so the wire
//                             carries them packed)
//   14 n_lo n_hi n_ex  STREAM play n bytes (24 bits: up to 16.7 million, over 2 hours at 8 kHz) of 2-bit codes (4 samples each, first code
//                             in the high bits; see codec.js) that follow the command
//                             as raw bytes, then answer DONE. The C64 takes them as
//                             they come, and answers CREDIT for each byte it takes
//                             from its buffer. The bridge sends STREAM_WINDOW bytes
//                             and one more for each CREDIT, so that the 256-byte
//                             buffer never overflows (a SwiftLink has no flow
//                             control). A FRAME must not follow: the C64 would take
//                             it for data. The tables at DTAB and NIDX come first.
//   15                 PROBE  measure the machine and answer PROBE (below)
//
// C64 -> host:
//   01                 ACK    frame processed
//   03                 HELLO  client (re)started
//   05                 DONE   PLAY or STREAM finished
//   06                 CREDIT STREAM: one byte taken from the buffer
//   07 c_lo c_hi r1..r21 PROBE the cycles in a video frame (16 bits), and 21 readings of
//                             voice 3's oscillator (7 waveforms at 3 speeds): see probe.js

export const OP = { FRAME: 8, POKE: 15, RATE: 16, PLAY: 17, MODE: 18, UNPACK: 19, STREAM: 20, PROBE: 21 };
export const MODE = { LOCK: 1, EXPAND: 2, BITMAP: 4 };
export const MSG = { ACK: 1, KEY: 2, HELLO: 3, HELLO_ON: 4, DONE: 5, CREDIT: 6, PROBE: 7 };

// C64->host message lengths, opcode included.
export const MSG_LEN = { [MSG.ACK]: 1, [MSG.KEY]: 3, [MSG.HELLO]: 1, [MSG.HELLO_ON]: 2, [MSG.DONE]: 1, [MSG.CREDIT]: 1, [MSG.PROBE]: 24 };

// Where the client keeps samples: $1000 up to its receive buffer at $CF00.
export const SAMPLE_BASE = 0x1000;
export const SAMPLE_END = 0xCD00; // the stream's tables are above
export const OUTTAB = 0xCD00; // 128 bytes: what the stream writes to $D418 for each accumulator value
export const DTAB = 0xCE00;
export const NIDX = 0xCE40;
export const STREAM_WINDOW = 128; // bytes of a stream the C64 holds: the bridge keeps this many in flight
export const SAMPLE_BYTES = SAMPLE_END - SAMPLE_BASE;

export const CPU_HZ = { pal: 985248, ntsc: 1022727 };
export const LINE_CYCLES = { pal: 63, ntsc: 65 };

// The CIA latch for about `rate` samples per second, and the exact rate that
// gives. A sample must outlast the client's work between writes: the packed
// loop needs about 80 cycles (12 kHz), the expanded one (a sample per raster
// line, 15.6 kHz) 60.
export function timerFor(rate, cpuHz = CPU_HZ.pal) {
  const cycles = Math.round(cpuHz / rate);
  if (cycles < 60 || cycles > 0x10000) throw new Error(`${rate} Hz is out of range (${cycles} cycles per sample)`);
  return { latch: cycles - 1, rate: cpuHz / cycles };
}

// The same for a sample every `lines` raster lines.
export function lineTimer(lines, ntsc = false) {
  const cycles = (ntsc ? LINE_CYCLES.ntsc : LINE_CYCLES.pal) * lines;
  return { latch: cycles - 1, rate: (ntsc ? CPU_HZ.ntsc : CPU_HZ.pal) / cycles };
}

export const encodeRate = latch => [OP.RATE, latch & 0xFF, latch >> 8];
export const encodeMode = (flags, delay = 0) => [OP.MODE, flags, delay];
export const encodeProbe = () => [OP.PROBE];
export const MAX_STREAM_BYTES = 0xFFFFFF;
export const encodeStream = n => {
  if (!(n >= 1 && n <= MAX_STREAM_BYTES)) throw new Error(`a stream is 1 to ${MAX_STREAM_BYTES} bytes`);
  return [OP.STREAM, n & 0xFF, (n >> 8) & 0xFF, n >> 16];
};
export const encodePoke = (addr, data) => [OP.POKE, addr & 0xFF, addr >> 8, data.length & 0xFF, ...data];
export const encodeUnpack = (addr, n) => [OP.UNPACK, addr & 0xFF, addr >> 8, n & 0xFF, n >> 8];
export const encodePlay = (start, end) => [OP.PLAY, start & 0xFF, start >> 8, end & 0xFF, end >> 8];

// Two 4-bit samples per byte, the first in the high nibble. An odd last
// sample is paired with the middle level, which is no step. `multiple`: pad
// with middle levels to a whole number of that many bytes.
export function packNibbles(nibbles, multiple = 1) {
  const bytes = Math.ceil(((nibbles.length + 1) >> 1) / multiple) * multiple;
  const out = new Uint8Array(bytes).fill(0x88);
  for (let i = 0; i < nibbles.length; i++) {
    out[i >> 1] = i & 1 ? (out[i >> 1] & 0xF0) | (nibbles[i] & 15) : (nibbles[i] & 15) << 4 | (out[i >> 1] & 15);
  }
  return out;
}

export function unpackNibbles(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  bytes.forEach((b, i) => { out[2 * i] = b >> 4; out[2 * i + 1] = b & 15; });
  return out;
}

// POKEs that load `data` at `addr`, grouped in frames of at most `budget`
// bytes each (a POKE costs 4 bytes, FRAME 1).
export function encodeLoad(data, addr = SAMPLE_BASE, budget = 120) {
  const per = budget - 5;
  if (per < 1) throw new Error('frame budget too small');
  if (addr + data.length > SAMPLE_END) throw new Error(`${data.length} bytes at $${addr.toString(16)} overflow the sample buffer`);
  const frames = [];
  for (let k = 0; k < data.length; k += per) {
    const chunk = data.subarray(k, k + per), a = addr + k;
    frames.push([OP.POKE, a & 0xFF, a >> 8, chunk.length & 0xFF, ...chunk, OP.FRAME]);
  }
  return frames;
}

// Incremental parser for the C64->host stream: feed bytes, get messages.
export class MessageParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buf = [];
  }

  feed(bytes) {
    for (const b of bytes) {
      this.buf.push(b);
      const len = MSG_LEN[this.buf[0]];
      if (len === undefined) { this.buf.length = 0; continue; } // noise: resync
      if (this.buf.length === len) {
        const [type, ...args] = this.buf;
        this.buf.length = 0;
        this.onMessage(type, args);
      }
    }
  }
}

// Reference implementation of the C64 side, used by tests: memory, the
// timer latch and a list of what was played.
export class Decoder {
  constructor() {
    this.mem = new Uint8Array(0x10000);
    this.latch = 122;
    this.flags = 0;
    this.delay = 0;
    this.frames = 0;
    this.plays = [];
    this.streams = []; // the byte counts of STREAMs (their data is not decoded)
  }

  feed(bytes) {
    let i = 0;
    const next = () => bytes[i++];
    while (i < bytes.length) {
      switch (next()) {
        case OP.FRAME: this.frames++; break;
        case OP.POKE: {
          let addr = next() | next() << 8;
          const n = next() || 256;
          for (let k = 0; k < n; k++) this.mem[addr++ & 0xFFFF] = next();
          break;
        }
        case OP.RATE: this.latch = next() | next() << 8; break;
        case OP.MODE: this.flags = next(); this.delay = next(); break;
        case OP.UNPACK: {
          const base = next() | next() << 8, n = next() | next() << 8;
          this.mem.set(unpackNibbles(this.mem.slice(base + n, base + 2 * n)), base);
          break;
        }
        case OP.PROBE: break;
        case OP.STREAM: this.streams.push(next() | next() << 8 | next() << 16); break;
        case OP.PLAY: {
          const start = next() | next() << 8, end = next() | next() << 8;
          const bytes = this.mem.subarray(start, end);
          this.plays.push({ latch: this.latch, flags: this.flags, delay: this.delay,
            samples: this.flags & MODE.EXPAND ? bytes.map(b => b & 15) : unpackNibbles(bytes) });
          break;
        }
        default: throw new Error(`bad opcode at ${i - 1}`);
      }
    }
  }
}
