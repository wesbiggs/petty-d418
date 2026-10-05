# PETTY-D418

Speech on a Commodore 64, through the SID's master volume register (`$D418`).
A bridge on a Mac turns text (macOS `say`) or any audio file into 4-bit samples,
loads them into the C64's RAM over a SwiftLink serial link, and tells the C64 to
play them: a ~100-byte loop writes one nibble to `$D418` per timer tick. All of
the signal processing is on the bridge; the C64 only pokes a register.

It is a sibling of [PETTY](https://github.com/wesbiggs/petty) and uses its
framing (one-byte opcodes, FRAME/ACK flow control, the same SwiftLink setup), so
it could be folded into PETTY's protocol later. See
[bridge/src/protocol.js](bridge/src/protocol.js): it reuses PETTY's `FRAME` (8)
and `POKE` (15) and adds `RATE` (16), `PLAY` (17), `MODE` (18) and `UNPACK` (19),
plus a `DONE` reply.

```
say / audio file → resample, tilt, compress → 4-bit → POKE into C64 RAM ══ TCP / serial ══► C64
                                                                         RATE, PLAY  →  nibble → $D418 at 8 kHz
```

## Run it in VICE

Requires cc65, VICE 3.x (`x64sc`) and Node 20+ (no npm packages). macOS for `say`;
`--file` also needs ffmpeg or afconvert unless the file is a WAV.

```bash
make                                   # build/d418.prg
make bridge ARGS='--say "Hello"'       # terminal 1: speak once (no ARGS: speak each line you type)
make vice                              # terminal 2: VICE with an emulated SwiftLink on TCP 6464
```

Start the bridge first. Options: `--voice NAME` (`say -v '?'`), `--tts 'command'`, `--file clip.mp3`,
`--rate HZ` (default 8000, up to about 12000), `--ntsc`, `--lut linear|sid6581|sid8580`,
`--shape none|first|second|mild`, `--dither LSBS`, `--emphasis A`, `--compress 0-1`,
`--window N` (frames in flight), `--serial DEV --baud N` for real hardware.
`--lines N` plays a sample every N raster lines with the display left on (see
[Screen on](#screen-on)): `--lines 1` is 15.6 kHz on a PAL machine, `--lines 2` 7.8 kHz;
`--phase N` places the timer within the line (default 4, found by sweeping).
`--dry --out x.wav` writes what the C64 would play without any C64, to listen with `afplay`.

`--tts 'command'` speaks with any program instead of `say`: the text goes to its standard input, and it writes a WAV to `{out}`
(or to its standard output if the command has no `{out}`), for example
`--tts 'piper -m ~/voices/en_GB-alba-medium.onnx -f {out}'`. Other audio formats are converted with ffmpeg.

`make SID=1` runs VICE with an 8580 (default is a 6581), and `make DC=n` sets how
many voices hold a DC level (below; default 3).

## Testing without listening

```bash
make test                                                          # unit tests
node bridge/scripts/capture.js -- --say "Hello"                    # play in VICE, record its sound, score it
node bridge/scripts/capture.js --sid 1 -- --staircase              # a calibration signal
node bridge/scripts/calibrate.js build/capture/vice.wav            # measure the volume steps
node bridge/scripts/shapes.js                                      # compare noise shaping / compression by A-weighted noise
node bridge/scripts/sweep-phase.js -- --lines 1                    # score every --phase
```

`capture.js` runs the bridge and VICE (a window opens), records VICE's sound with
`-soundrecdev wav` and compares it with the bridge's preview. On a spoken
phrase the recording correlates at 0.99 or better with the plan: the C64 plays what
the bridge meant. `score.js` prints two numbers: the recording sampled at each sample's
own time (only meaningful up to 8 kHz, where VICE's 48 kHz output resolves the steps), and
a speech-band comparison (both signals low-passed at 3.4 kHz) that works at any rate. The band
SNR is 15-30 dB at 15.6 kHz, and I have not found why it varies that much between identical
runs (it may be the host: VICE records its sound in real time). Don't use `-warp`: VICE then
writes an empty recording.

## Screen on

By default the screen is blanked while a clip plays. With `--lines N` it stays on, and
the client locks its timer to the raster instead.

Why the blanking mattered: with the display on, a badline (every 8th raster line) stops
the CPU for about 43 of a line's 63 cycles, so a sample written there is late. In VICE
that costs about 6 dB of speech-band SNR at 8 kHz (11.6 dB against 17.6 dB blanked) with
the timer free-running. The lock avoids it: the client finds the start of a raster
line to the cycle (a 64-cycle loop reads `$D012` against the 63-cycle lines, so its
read slides one cycle later each pass until the line number jumps by 2), starts the timer a
chosen number of cycles later, and uses a period of a whole number of lines. Every write then
falls at the same cycle of its line, after the badline stall on the badlines. Only the
cycle within the line (`--phase`) matters, and 4 is best on a PAL VICE.

`--lines 1` (15.6 kHz) leaves too little time between writes for packed
nibbles, so the C64 first unpacks them in place to one sample per byte (`UNPACK`), and a clip is
at most 48,896 samples: 3.1 s. `--lines 2` and up keep the packed loop: 6.2 s at 7.8 kHz.

This does not depend on the video mode: the lock only needs the timer in step with the
raster. `--bitmap` switches the VIC to a hi-res bitmap screen while playing, and the
result matches text mode. What would break it is anything else that steals cycles
at changing places: sprites (2 cycles a line each), or a raster effect that changes
`D011`'s Y scroll mid-frame. I have not tried it inside PETTY's hi-res client itself.

## What the SID does with `$D418`

Measured on VICE's reSID (`calibrate.js`):

- **The volume steps are almost linear** on both chips: slightly compressed at the
  ends. `dsp.js` has the measured tables (`sid6581`, `sid8580`) so the quantizer
  can allow for them.
- **The swing is small unless a voice holds a DC level.** The volume register scales
  what the voices output, and silent voices output nearly nothing. With the
  voices off the swing is 29% of full scale on a 6581 and only 4% on an 8580.
  The client therefore holds all three voices at their highest pulse level (test
  bit set, sustain 15): 92% on a 6581 and 22% on an 8580, loud enough to be useful. (VICE's
  "8580 + digiboost" model plays at 35% with no voices, and less with them.) Real chips vary a lot.
- **The output is AC coupled** (a high-pass near 16 Hz), so a held level droops to
  zero in about 10 ms. Speech doesn't care.
- **Noise shaping and dither make it worse.** At 8 kHz there is no room above
  speech to push noise into, and the ear is most sensitive at 2-4 kHz.
  `shapes.js` finds plain rounding best: 10 dB A-weighted SNR against 5 dB for
  first-order shaping and negative for second-order. Dither costs 3-7 dB more.
  The default is plain rounding; the options remain for listening tests.

## Streaming: a 2-bit code, in real time

Playing from RAM means loading first, and a long text would pause between clips. `--stream`
plays as it goes: speech of any length starts at once and runs at the speed of the sample clock.

```bash
make bridge ARGS='--stream --say "A whole paragraph of text..."'
make vice
```

**The code** ([bridge/src/codec.js](bridge/src/codec.js)). Each sample is 2 bits, a sign and a size. The C64
keeps an accumulator (7 bits; its top 4 are the volume) and a step index: `acc += or -= step * (small or large)`,
saturating, and the index goes up after a large code and down after a small one. The bridge's encoder does the
work: a Viterbi search for the code sequence whose output is closest to the signal, in blocks of 256 samples with
128 of lookahead, each block restarting from the state the committed path ended in (committing sample by sample
from the best path so far leaves lasting offsets, because the decoder integrates). It runs about 4 times faster
than real time in JavaScript, and the encoder is a generator, so streaming starts after the first block.

**On the C64** ([c64/d418.s](c64/d418.s), `stream`). Four samples to a byte, so the loop is four copies, with the work
spread over them to fit a sample (123 cycles at 8 kHz): copy 1 takes the byte fetched earlier, 2 counts it, 3 fetches
the next from the buffer and sends a credit, 4 stops if that was the last. Every copy writes the volume first, so the
write time does not depend on the work, then decodes (52 cycles from two table lookups, `DTAB` and `NIDX`, which the bridge loads) and polls the serial
receiver (9 cycles idle, 25 with a byte). The receiver is polled, not interrupt driven: an interrupt would move a write by up to 45 cycles.

**Flow control.** A SwiftLink has none, so the bridge sends 128 bytes (`STREAM n`, then raw bytes: no FRAME follows) and one more
for each CREDIT byte the C64 sends back when it takes a byte from its 256-byte buffer. The buffer holds about 64 ms. If it runs dry the
C64 plays a quiet filler byte and carries on when data arrives; the stream is then longer, and no bytes are lost.

**Measured in VICE** (the recording against the codec's own output, as for the PCM modes):

| | length | correlation | speech-band SNR |
|---|---|---|---|
| a sentence | 2.7 s | 0.9972 | 18.8 dB |
| a paragraph | 24.3 s, 48,606 bytes | 0.9995 | 24.6 dB |
| the same with the display on (`--lines 2`) | 2.7 s | | 12.7 dB |

A STREAM counts its bytes in 24 bits: up to 16.7 million, over 2 hours at 8 kHz, so speech or music of any realistic length is one stream, with no
pause. (It was 16 bits at first, 32.7 s: the count is what tells the C64 where the stream ends, so it cannot just wrap round; the third byte
costs about 4 cycles in the loop's counting step.) A 48.6 s paragraph, 97,303 bytes, streamed in 48.58 s and scored 0.999 correlation.

The paragraph streamed in 24.27 s: real time. `D418_STALL=1000:300` makes the bridge stop sending for 300 ms after 1000
bytes, to run the buffer dry: the stream completes. The display-on case has not had its phase tuned (`sweep-phase.js`): the lock puts one badline
in each 4-sample group, and which copy it falls in decides whether a write is late.

**The sample clock is CIA 2.** The stream's tick is a change in CIA 2's timer B, which counts timer A's underflows, not CIA 1's
interrupt flag. The flag register of the old 6526 (VICE `-model c64`; `capture.js --model c64`) loses a flag that sets as it
is read, and a locked stream with the display on stalled there; a counter keeps a tick that a late poll would miss.
The packed and expanded one-shot modes still poll the flag. With the display on, a phrase scores 19.6 dB (old CIA) and 17.1 dB (new).

`scripts/codec-eval.js` compares the code with PCM (SNR and A-weighted SNR against the processed speech,
a 5-second phrase, the `sid6581` table):

| | bits | kbit/s | SNR dB | A-weighted dB |
|---|---|---|---|---|
| PCM 4-bit (plain rounding) | 4 | 32 | 12.8 | 9.1 |
| PCM 3-bit | 3 | 24 | 2.1 | 2.3 |
| PCM 2-bit | 2 | 16 | -4.0 | -2.7 |
| **2-bit code** | 2 | 16 | 12.0 | 8.2 |
| 3-bit code | 3 | 24 | 12.6 | 8.9 |

At 8 kHz it is within about 1 dB of 4-bit PCM at half the rate (2 KB/s of a SwiftLink's 3.8). The parameters hardly matter: a grid
over step tables and sizes spans 0.2 dB, and a 7-bit accumulator is as good as 8 or 10 (6 loses 0.2 dB).
At 12 kHz, 3 KB/s, it scores 8.1 against 8.7 for PCM (the rates carry different bandwidths, so the
numbers across rates are not like for like), but 12 kHz does not fit the loop: the worst copy needs about 115 cycles by my count (not measured) against 82.
`--wav DIR` writes each variant as a WAV to listen to; the SNRs are measurements against a signal, not listening.

## Hiss

The 2-bit stream's noise is almost all the 4-bit output's own quantization: 16 levels a step of 0.133 give white noise at -28.4 dB
re full scale, and the codec adds under 1 dB to it. `node bridge/scripts/hiss.js --file clip.mp3` measures it: the error
(output minus the signal it was made from) in 20 ms frames, split by how loud the signal was, and by frequency. On a decaying piano
note recording the error is -27.7 dB overall and **the same in the quietest quarter as in the loudest**
(-28 against -27), the signature of hiss, and the signal is below it above about 2 kHz (-36 and -50 dB
against a noise of -32), which is why it stands out. `--compress` changes nothing (-27.7 to -27.9): it
changes the signal, not the quantizer. The SNR figures elsewhere in this file are the total error, which hiss is most of, but they
do not say it is hiss; this does.

`--weight -0.6` moves the noise. The encoder's search then minimises the error filtered by `1 + a z^-1`, so that error it attenuates is cheap:
a negative `a` puts the noise down in frequency, under the bass that masks it and out of 2-4 kHz, where the ear is most
sensitive. On the piano: 2-3 kHz noise -31.8 to -34.7 dB, 3-4 kHz -32.5 to -36.6, in exchange for 0-0.5 kHz -34.0 to -27.6 (the music
there is -12). `-0.8` goes further (3-4 kHz -37.6, 0-0.5 kHz -24.0). The A-weighted total does not change, and the total noise rises
1.7 dB, so whether it sounds better is for listening to: `--dry --out` writes the result. It does not change what the C64 runs. Off by default.

**Adaptive weights** (`--adapt order:gamma`, e.g. `--adapt 2:0.7`; [bridge/src/noise.js](bridge/src/noise.js)). Instead of one fixed tilt, each 256-sample block
gets the weight `A(z / gamma)` of its own spectral envelope (LPC), as speech codecs use, so that the noise follows the signal's spectrum and is
masked by it; gamma 0 is white, 1 follows the envelope exactly. A beam (states more than 0.02 in cost above the best are dropped) keeps the search cheap:
no loss in quality (noise -21.57 against -21.58 dB without it), and 4 times faster, so the encoder runs at about 0.05 to 0.1 of real time
even with a 10th-order weight. `scripts/hiss.js` compares settings on a clip. **It is not better than the fixed tilt.** On the piano
and on piper speech the adaptive weights trace out the same trade-off: the noise in 2-4 kHz falls (for the piano, order 2, gamma 0.7: 3-4 kHz
-34.6 to -43.3 dB, against -38.6 for `--weight -0.6`) and the noise below 1 kHz rises by the same amount in log terms (0-0.5 kHz -35.8 to -23.7 dB, which
is only 10 dB under the music there). The A-weighted total stays at -28 to -30 dB for every setting. A first-order adaptive tilt is equivalent to the fixed one.
This is what a quantizer's noise allows: shaping moves noise around, and the average of its level over frequency, in dB, cannot go below that of white noise
(the Gerzon-Craven limit). The 4-bit output sets that average at -28 dB, so reducing the noise where it is heard
means raising it somewhere else, and for a steep spectrum like a piano's the somewhere else is soon not masked either. What lowers it overall is
fewer or finer steps (the full-byte output, which did not work in VICE), or a higher output rate, which gives the noise more spectrum to spread over,
or filtering the images above 4 kHz.

## Probing the machine

`node bridge/src/bridge.js --probe` (with the client running) asks the C64 what it is. The client only measures; the bridge decides
([bridge/src/probe.js](bridge/src/probe.js)), so a better rule needs no 6502 change.

- **Video standard:** the cycles in one frame, timed with a CIA timer between two visits to the same raster line.
  PAL is 19656, PAL-N 20280, NTSC 17095, old NTSC 16768; the bridge picks the nearest. Right on all of VICE's `c64`, `ntsc`,
  `oldntsc` and `drean` models, within about 10 cycles.
- **SID model:** voice 3's oscillator is started from zero and read back (`$D41B`) 255 cycles later, at three speeds, for seven
  waveforms. The combined waveforms differ between the chips: at the fast speed saw+triangle reads `38` on VICE's 6581 and `f8`
  on its 8580, and pulse+saw reads `7e` against `fd`. The bridge compares six readings with stored signatures, and
  was right for all 12 combinations of VICE's video and SID models (`scripts/probe-vice.js`). "8580 with digiboost" reads the
  same as the 8580. The signatures are reSID's: **real chips differ from the model and from each other, and I have not
  tried one**, so `describeProbe` also prints the raw readings and how far they are from each signature.

## The full `$D418` byte (experiment, not adopted)

`$D418` has the volume in bits 0-3 and the filter modes and a voice 3 mute above. With voices routed through the filter, each of the 256
bytes could give a different level, as c64cast describes. `--staircase256` plays every byte against a reference byte,
`scripts/calibrate256.js` measures the 256 levels, and `--profile FILE` makes the stream write a 128-byte ladder of them
(`OUTTAB`) in place of the volume nibble, with `--regs d417=03,...` to set up the SID first.

In VICE's 6581 (and about a third as much swing on its 8580) there are 60-125 different levels, in a ladder whose largest gap is half a
volume step. In the model that is worth about 3 dB for the 2-bit code (SNR 12.0 to 15.1 dB, A-weighted 8.1 to 10.5: more than 4-bit PCM scores).
**In VICE itself the gain does not appear**: scored against the speech, the stream with the ladder is about 1 to 1.5 dB *worse* than with
the nibble (11.4 against 12.6 dB speech-band SNR with only the voice 3 mute, similar with the filter), and the plan-against-recording
score drops from about 19 dB to 13. My guess, not tested, is that levels from the mute and the filter bits take longer to settle
than one 125 us sample, so each depends on the one before, which a table cannot say. On real chips the filter varies much more. So the
stream writes the volume nibble, and the ladder code is an experiment.

## Real hardware

- **Bandwidth.** 4-bit samples at 8 kHz are 4 KB/s, more than a 38400-baud
  SwiftLink carries (3.8 KB/s), so the clip is loaded first and played from RAM.
  Loading takes about as long as playing (2.9 s for 2.7 s of speech in VICE, which limits
  the emulated link to 38400 baud too). A clip is at most 48,896 bytes: 12 s at 8 kHz. Longer text
  is split at the quietest point near the limit and played in pieces, with a load pause between.
- **Timing.** Playback is polled, not interrupt driven: interrupts are off, the
  screen is blanked (no badlines) and CIA 1 timer A paces the writes, so a sample is
  written 0-6 cycles late. The 7-cycle polling jitter is not audible. An NTSC machine needs `--ntsc`.
- **The keyboard is dead while it plays**, and without `--lines` so is the screen. The
  client runs with BASIC ROM banked out, because samples extend through `$A000`-`$BFFF`.
- **NTSC** (65 cycles a line) is untested: build with `make LINE_CYCLES=65`, use `--ntsc`, and
  sweep `--phase` again.

## Layout

| Path | What |
|---|---|
| `c64/d418.s` | ca65 client: NMI serial receive, command decoder, playback loop |
| `bridge/src/bridge.js` | TCP server or serial port, job queue, frame pacing |
| `bridge/src/protocol.js` | encoder, message parser, reference decoder |
| `bridge/src/dsp.js` | resample, tilt, compress, quantize, split |
| `bridge/src/speech.js` | `say`, audio file loading, the whole chain |
| `bridge/src/wav.js` | WAV reader and writer |
| `bridge/src/probe.js` | what PROBE's measurements say about the machine |
| `bridge/src/codec.js` | the 2-bit stream code: encoder, decoder, client tables |
| `bridge/scripts/` | `capture`, `score`, `calibrate`, `calibrate256`, `shapes`, `sweep-phase`, `codec-eval`, `probe-vice` |

## Not done yet

- S.A.M.-style formant output (the SID's voices as three formants, parameters streamed
  at 50 Hz) as a second mode.
- Streaming above 8 kHz, or tuned with the display on.
- A model of the full `$D418` byte that includes how long the levels take to settle (see above).
- `--probe` on a real machine, and a calibration from a recording of one (a measured `--lut` or `--profile`).
- Using RAM under the KERNAL (`$E000`) for longer clips.
- Real-hardware tests, and measuring a real 6581 and 8580 for the tables.
