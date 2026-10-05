; PETTY-D418 - sample player for the C64 SID volume register
;
; Receives commands from the bridge over a SwiftLink (6551 ACIA at $DE00,
; NMI), keeps 4-bit samples in RAM, and plays them by writing them to the
; SID's master volume ($D418) at a rate the bridge sets. The framing is
; PETTY's: see bridge/src/protocol.js.

; --- hardware ---------------------------------------------------------------
SCREEN      = $0400
RBUF        = $CF00             ; 256-byte receive ring buffer

ACIA_DATA   = $DE00
ACIA_STATUS = $DE01
ACIA_CMD    = $DE02
ACIA_CTRL   = $DE03

SID         = $D400
SID_VOL     = $D418
VIC_CTRL1   = $D011
VIC_RASTER  = $D012
BORDER      = $D020
BGCOLOR     = $D021
CIA1_TALO   = $DC04
CIA1_TAHI   = $DC05
CIA1_ICR    = $DC0D
CIA1_CRA    = $DC0E

; KERNAL
NMIVEC      = $0318
KEYCOUNT    = $C6
BLNSW       = $CC

; protocol
OP_FRAME    = 8
OP_POKE     = 15
OP_RATE     = 16
OP_PLAY     = 17
OP_MODE     = 18
OP_UNPACK   = 19
OP_STREAM   = 20
OP_PROBE    = 21
NUM_OPS     = 22

MODE_LOCK   = 1                 ; keep the display on, timer locked to the raster
MODE_EXPAND = 2                 ; samples are one per byte, not two
MODE_BITMAP = 4                 ; test: show a bitmap (hi-res) screen while playing

MSG_ACK     = 1
MSG_HELLO   = 3
MSG_DONE    = 5
MSG_CREDIT  = 6                 ; a stream byte was taken from the buffer
MSG_PROBE   = 7                 ; the answer to PROBE

DTAB        = $CE00             ; the delta code's tables, loaded by the bridge:
NIDX        = $CE40             ; see bridge/src/codec.js
OUTTAB      = $CD00             ; the byte written to $D418 for each accumulator value (128)

; --- zero page (BASIC's area; BASIC is not running) -------------------------
count       = $19
rptr        = $1A               ; ring buffer read index
wptr        = $1B               ; ring buffer write index (NMI)
dst         = $FB               ; POKE destination, then the play pointer
endp        = $FD               ; play end (exclusive)
sp          = $10               ; UNPACK: source,
dp          = $12               ; destination,
cnt         = $14               ; and count
dst1        = $16               ; playing one sample a byte: dst + 1
tmp         = $18
prev        = $1C               ; the last raster line read
acc         = $20               ; the stream decoder's accumulator,
idx4        = $21               ; step index * 4,
cur         = $22               ; the byte of codes being played,
nxtb        = $23               ; the next one,
outv        = $24               ; and the volume to write at the next tick
rlo         = $25               ; bytes of the stream still to fetch
rhi         = $26
rex         = $2B               ; and the third byte of the count
eof         = $27               ; the byte being played is the last
under       = $28               ; times the buffer ran dry
need        = $29               ; bytes to buffer before starting
streaming   = $2A

; --- BASIC stub: 10 SYS2061 -------------------------------------------------
.segment "LOADADDR"
        .word $0801

.segment "CODE"
        .word @next, 10
        .byte $9E, "2061", 0
@next:  .word 0

start:
        .assert start = 2061, error, "SYS address mismatch"
        sei
        lda #$36                ; BASIC ROM off: the samples run up to $CF00, over it
        sta $01
        lda #0
        sta rptr
        sta wptr
        sta BORDER
        sta BGCOLOR
        sta SID_VOL
        tax
:       sta SID,x               ; every SID register to zero
        inx
        cpx #$19
        bne :-
        lda #1
        sta BLNSW
        jsr init_voices
        jsr init_screen
        lda #<nmi
        sta NMIVEC
        lda #>nmi
        sta NMIVEC+1
        jsr init_acia
        cli
        ldx #MSG_READY
        jsr message
        lda #MSG_HELLO
        jsr send

; --- main loop: decode commands forever ------------------------------------
cmdloop:
        jsr rb_get
        cmp #NUM_OPS
        bcs cmdloop
        asl
        tax
        lda optable+1,x
        pha
        lda optable,x
        pha
        rts

optable:
        .word cmdloop-1         ; 0
.repeat 7
        .word cmdloop-1         ; 1-7: PETTY's screen commands, ignored
.endrep
        .word op_frame-1        ; 8
.repeat 6
        .word cmdloop-1         ; 9-14
.endrep
        .word op_poke-1         ; 15
        .word op_rate-1         ; 16
        .word op_play-1         ; 17
        .word op_mode-1         ; 18
        .word op_unpack-1       ; 19
        .word op_stream-1       ; 20
        .word op_probe-1        ; 21

op_frame:
        lda #MSG_ACK
        jsr send
        jmp cmdloop

; POKE lo hi n d1..dn: n bytes (0 = 256) to lo + 256 * hi.
op_poke:
        jsr rb_get
        sta dst
        jsr rb_get
        sta dst+1
        jsr rb_get
        sta count
        ldx #MSG_LOADING
        jsr message
        ldy #0
:       jsr rb_get              ; clobbers X only
        sta (dst),y
        iny
        dec count
        bne :-
        jmp cmdloop

; RATE lo hi: the CIA timer latch, so a sample lasts latch + 1 cycles.
op_rate:
        jsr rb_get
        sta rate
        jsr rb_get
        sta rate+1
        jmp cmdloop

; MODE flags delay: how PLAY runs (MODE_*), and for MODE_LOCK the delay loop
; count (5 cycles each) that places the timer's underflows within a raster line.
op_mode:
        jsr rb_get
        sta flags
        jsr rb_get
        sta delay
        jmp cmdloop

; UNPACK lo hi n_lo n_hi: n packed bytes at lo + 256 * hi + n become 2n samples,
; one per byte, from lo + 256 * hi. The packed bytes are read from the top end
; while the samples are written from the bottom, which never overwrites a byte
; that has not been read yet.
op_unpack:
        jsr rb_get
        sta dp
        jsr rb_get
        sta dp+1
        jsr rb_get
        sta cnt
        jsr rb_get
        sta cnt+1
        lda dp                  ; sp = dp + count
        clc
        adc cnt
        sta sp
        lda dp+1
        adc cnt+1
        sta sp+1
        ldx #MSG_LOADING
        jsr message
        ldy #0
@next:  lda (sp),y
        tax
        lsr
        lsr
        lsr
        lsr
        sta (dp),y              ; y = 0: the high nibble
        txa
        and #$0F
        iny
        sta (dp),y              ; y = 1: the low nibble
        dey
        inc sp
        bne :+
        inc sp+1
:       lda dp
        clc
        adc #2
        sta dp
        bcc :+
        inc dp+1
:       lda cnt
        bne :+
        dec cnt+1
:       dec cnt
        lda cnt
        ora cnt+1
        bne @next
        jmp cmdloop

; PLAY start_lo start_hi end_lo end_hi: play the bytes start..end-1, two
; samples each (high nibble first), then answer DONE.
op_play:
        jsr rb_get
        sta dst
        jsr rb_get
        sta dst+1
        jsr rb_get
        sta endp
        jsr rb_get
        sta endp+1
        jsr play
        ldx #MSG_READY
        jsr message
        lda #MSG_DONE
        jsr send
        jmp cmdloop

; STREAM n_lo n_hi n_ex: play n bytes (24 bits) of codes (4 samples each; see codec.js) that
; follow, as they arrive, then answer DONE. The bridge sends 128 bytes, and
; one more for each MSG_CREDIT it gets back, so the buffer (256 bytes) never
; overflows; there is no flow control on a SwiftLink to rely on. While it runs
; the receiver is polled in the playback loop, not interrupt driven, so a byte
; cannot disturb the timing of a write.
op_stream:
        jsr rb_get
        sta rlo
        jsr rb_get
        sta rhi
        jsr rb_get
        sta rex
        lda #128                ; start when min(128, n) bytes are in
        ldx rex
        bne :+
        ldx rhi
        bne :+
        cmp rlo
        bcc :+
        lda rlo
:       sta need
        lda rlo                 ; n - 1 are left to fetch once the first is taken
        bne @dl
        lda rhi
        bne @dh
        dec rex
@dh:    dec rhi
@dl:    dec rlo
        ldx #MSG_LOADING
        jsr message
        lda #%00001011          ; no receive interrupts
        sta ACIA_CMD
@fill:  lda wptr
        sec
        sbc rptr
        cmp need
        bcs @go
        lda ACIA_STATUS
        and #$08
        beq @fill
        lda ACIA_DATA
        ldx wptr
        sta RBUF,x
        inc wptr
        jmp @fill
@go:    lda #1
        sta streaming
        jsr play
        lda #0
        sta streaming
        lda #%00001001          ; receive interrupts on again
        sta ACIA_CMD
        ldx #MSG_READY
        jsr message
        lda #MSG_DONE
        jsr send
        jmp cmdloop

; PROBE: measure what the bridge needs to know about the machine, and send
; MSG_PROBE, then 2 + 21 bytes. The client only measures; the bridge decides.
;   cycles in one frame, 16 bits: about 19656 on a PAL machine, 17095 on an
;     NTSC one (16768 on an old one, 20280 on a PAL-N one)
;   voice 3's oscillator read back ($D41B) 255 cycles after it is started
;     from zero, at three speeds, with the waveforms triangle, saw, saw +
;     triangle, pulse, pulse + triangle, pulse + saw, and all three:
;     combined waveforms differ between SID models
op_probe:
        sei
        lda #$7F                ; no CIA interrupts, only the flag
        sta CIA1_ICR
        lda #$FF                ; timer A counts down from $FFFF
        sta CIA1_TALO
        sta CIA1_TAHI
:       lda VIC_RASTER          ; line $80
        cmp #$80
        bne :-
        lda #%00010001          ; start, continuous, force load
        sta CIA1_CRA
:       lda VIC_RASTER          ; leave it
        cmp #$80
        beq :-
:       lda VIC_RASTER          ; and meet it again, a frame later
        cmp #$80
        bne :-
        lda CIA1_TAHI
        sta tmp
        ldx CIA1_TALO
        lda #$FF                ; elapsed = $FFFF - the timer
        sec
        sbc tmp
        sta probe+1
        txa
        eor #$FF
        sta probe
        lda #0
        sta cnt                 ; the reading being made
        sta count               ; the speed
@pos:   ldx count
        lda postab,x
        sta tmp
        ldy #0                  ; the waveform
@wave:  lda #$FF                ; voice 3 free-running, at one of three speeds
        sta $D40E
        lda tmp
        sta $D40F
        lda #$00
        sta $D410
        lda #$01                ; pulse width $0100
        sta $D411
        lda #0
        sta $D413
        lda #$F0
        sta $D414
        lda wavetab,y
        ora #$08                ; test: the oscillator is held at zero
        sta $D412
        lda wavetab,y
        sta $D412               ; ...and let go
        ldx #50
:       dex
        bne :-
        lda $D41B
        ldx cnt
        sta probe+2,x
        inc cnt
        iny
        cpy #7
        bne @wave
        inc count
        lda count
        cmp #3
        bne @pos
        lda #0                  ; voice 3 as it was
        sta $D40E
        sta $D40F
        jsr init_voices
        lda #$25                ; KERNAL's 60 Hz timer
        sta CIA1_TALO
        lda #$40
        sta CIA1_TAHI
        lda #%00010001
        sta CIA1_CRA
        lda #$81
        sta CIA1_ICR
        lda CIA1_ICR
        cli
        lda #MSG_PROBE
        jsr send
        ldx #0
:       lda probe,x
        jsr send
        inx
        cpx #23
        bne :-
        jmp cmdloop

wavetab:
        .byte $10, $20, $30, $40, $50, $60, $70
postab: .byte $FF, $A0, $50     ; high byte of voice 3's frequency (the low byte is $FF)

; --- playback ----------------------------------------------------------------

; Interrupts are off, and CIA 1's timer A paces the writes: each sample waits for
; the timer's underflow flag, which is polled in a 7-cycle loop.
;
; With the display on, badlines (every 8th raster line) stop the CPU for about 43
; of a line's 63 cycles, so a sample whose write falls there is late. MODE_LOCK
; starts the timer at a chosen cycle of a raster line, so that when its period
; is a whole number of lines the underflows keep that cycle in every line. Placed
; just after the stall ends, the write happens at about the same cycle on a
; badline as on any other line. Without MODE_LOCK the display is blanked, and
; there are no badlines.
play:
        sei
        lda #5
        sta BORDER
        lda #8                  ; the middle level, so the first sample is no big step
        sta SID_VOL
        lda flags
        and #MODE_LOCK
        bne @lock
        lda #$0B                ; display off
        sta VIC_CTRL1
        beq :+
@lock:  lda flags
        and #MODE_BITMAP
        beq :+
        lda #$3B                ; hi-res bitmap, display on: badlines as in text mode
        sta VIC_CTRL1
:       lda #$7F                ; no CIA interrupts, only the flag
        sta CIA1_ICR
        lda rate
        sta CIA1_TALO
        lda rate+1
        sta CIA1_TAHI
:       lda VIC_RASTER          ; line $F9: below the display, no badline
        cmp #$F9
        bne :-
        lda flags
        and #MODE_LOCK
        beq @free
        jsr slide
@free:  ldx delay
        beq :++
:       dex
        bne :-
:       lda #%00010001          ; start, continuous, force load
        sta CIA1_CRA
        lda CIA1_ICR            ; clear the flag
        lda streaming
        beq :+
        jmp stream
:       lda flags
        and #MODE_EXPAND
        bne @expanded

        ; two samples to a byte, high nibble first
@byte:  ldy #0
        lda (dst),y
        tax
        lsr
        lsr
        lsr
        lsr
@w1:    ldy CIA1_ICR            ; the flag reads (and clears) as 1
        beq @w1
        sta SID_VOL
        txa
        and #$0F
@w2:    ldy CIA1_ICR
        beq @w2
        sta SID_VOL
        inc dst
        bne :+
        inc dst+1
:       lda dst
        cmp endp
        bne @byte
        lda dst+1
        cmp endp+1
        bne @byte
        beq play_done

        ; one sample to a byte, whole pages: with so little to do between writes
        ; this keeps up with a sample a raster line. dst1 = dst + 1 lets the
        ; fetch of the next sample come before the index wraps, so INY's flags
        ; tell the end of a page.
@expanded:
        lda dst
        clc
        adc #1
        sta dst1
        lda dst+1
        adc #0
        sta dst1+1
        ldy #0
        lda (dst),y
@wait:  ldx CIA1_ICR
        beq @wait
        sta SID_VOL
        lda (dst1),y            ; the next sample
        iny
        bne @wait
        sta tmp                 ; the first sample of the next page
        inc dst+1
        inc dst1+1
        lda dst+1
        cmp endp+1
        beq play_done
        lda tmp
        jmp @wait

play_done:
        lda #0
        sta SID_VOL
        lda #$25                ; KERNAL's 60 Hz timer
        sta CIA1_TALO
        lda #$40
        sta CIA1_TAHI
        lda #%00010001
        sta CIA1_CRA
        lda #$81
        sta CIA1_ICR
        lda CIA1_ICR
        lda #$1B                ; display on
        sta VIC_CTRL1
        lda #0
        sta BORDER
        cli
        rts

; Waits until a raster line starts, to the cycle: a loop of exactly LINE_CYCLES + 1
; cycles reads the raster line once an iteration, so its read slides one cycle
; later in the line each time. A read at the last cycle of a line is followed, a
; loop later, by one at the first cycle of the line after next: the line number
; jumps by 2 (or by 202, mod 256, over the end of the frame: from line 311 to 1).
; Returns with that read 19 cycles behind, so at the same cycle of the line on
; every run. It runs in the lines below the display, which have no badlines:
; 111 of them from line $F9 to line 47. NTSC lines are 65 cycles: assemble with
; LINE_CYCLES = 65.
.ifndef LINE_CYCLES
LINE_CYCLES = 63
.endif
; An iteration is 18 (body) + 4 (the second compare) + 2 (LDX) + 5 * PADN - 1 (the
; pad loop) + 2 per NOP + 3 (JMP) = 26 + 5 * PADN + 2 * PADNOPS.
.if LINE_CYCLES = 63
PADN = 6
.else
PADN = 8
.endif
PADNOPS = (LINE_CYCLES + 1 - 26 - 5 * PADN) / 2
slide:
        lda VIC_RASTER
        sta prev
@loop:  lda VIC_RASTER          ; 4
        tax                     ; 2
        sec                     ; 2
        sbc prev                ; 3
        stx prev                ; 3
        cmp #2                  ; 2
        beq @out                ; 2 (3 when taken)
        cmp #202                ; 2
        beq @out                ; 2
        ldx #PADN               ; 2
@pad:   dex                     ; 2
        bne @pad                ; 3 (2 on the last)
  .repeat PADNOPS
        nop
  .endrep
        jmp @loop               ; 3
@out:   rts

; --- the stream loop ---------------------------------------------------------
;
; Each sample is a 2-bit code (sign, size) that moves an accumulator by a step
; that adapts to the codes; the top 4 bits of the accumulator are the volume.
; DTAB[idx4 + code] is the signed move, NIDX[idx4 + code] the next idx4.
; Four samples to a byte, so the loop is four copies, and the work is spread
; over them so each fits in a sample (123 cycles at 8 kHz):
;   1: take the byte fetched earlier        2: count it    3: fetch the next, and
;   send a credit                           4: stop if that was the last
; Every copy writes the volume first, so the write time does not depend on the
; work, and polls the receiver last.

.macro TICK
:       ldx CIA1_ICR            ; the timer's flag
        beq :-
        lda outv
        sta SID_VOL
.endmacro

.macro DECODE                   ; 49 cycles
        asl cur                 ; the sign
        lda #0
        rol
        asl cur                 ; the size
        rol                     ; A = sign * 2 + size
        ora idx4
        tay
        lda acc
        clc
        adc DTAB,y
        bpl :+
        cmp #$C0                ; below 0 or above 127: saturate
        lda #127
        bcc :+
        lda #0
:       sta acc
        lda NIDX,y
        sta idx4
        lda acc
        lsr
        lsr
        lsr
        sta outv
.endmacro

.macro RXPOLL                   ; 9 cycles with nothing, 25 with a byte
        lda ACIA_STATUS
        and #$08
        beq :+
        lda ACIA_DATA
        ldx wptr
        sta RBUF,x
        inc wptr
:
.endmacro

stream:
        ldx rptr                ; the first byte
        lda RBUF,x
        inc rptr
        sta nxtb
        lda #MSG_CREDIT
        sta ACIA_DATA
        lda #64                 ; the decoder's start state: the encoder's too
        sta acc
        lda #0
        sta idx4
        sta eof
        sta under
        lda #8
        sta outv
@group:
        TICK                    ; copy 1
        lda nxtb
        sta cur
        DECODE
        RXPOLL

        TICK                    ; copy 2: count the byte to fetch
        DECODE
        RXPOLL
        lda rlo
        ora rhi
        ora rex
        bne :+
        jmp @last
:       lda rlo
        bne @dl2
        lda rhi
        bne @dh2
        dec rex
@dh2:   dec rhi
@dl2:   dec rlo
@copy3:
        TICK                    ; copy 3: fetch it
        DECODE
        RXPOLL
        lda rptr
        cmp wptr
        beq @dry
        tax
        inc rptr
        lda RBUF,x
        sta nxtb
        lda #MSG_CREDIT
        sta ACIA_DATA
@copy4:
        TICK                    ; copy 4
        DECODE
        RXPOLL
        lda eof
        bne @out
        jmp @group
@out:   jmp play_done

@last:  lda #1                  ; nothing left to fetch: this byte is the last
        sta eof
        jmp @copy3

; The buffer is empty: play a quiet filler byte, and count the byte as not
; yet fetched.
@dry:   lda eof
        bne :++
        inc rlo
        bne :+
        inc rhi
        bne :+
        inc rex
:       lda #$22
        sta nxtb
        inc under
:       jmp @copy4

; --- serial ------------------------------------------------------------------

; Next received byte in A, flags set from it. Clobbers X.
rb_get:
        ldx rptr
        cpx wptr
        beq rb_get
        inc rptr                ; before the load, so Z/N reflect the byte
        lda RBUF,x
        rts

; Transmit A (waits for the transmit register to empty).
send:
        pha
:       lda ACIA_STATUS
        and #$10
        beq :-
        pla
        sta ACIA_DATA
        rts

nmi:
        pha
        txa
        pha
        lda ACIA_STATUS         ; also acknowledges the interrupt
        and #$08                ; receive register full?
        beq :+
        lda ACIA_DATA
        ldx wptr
        sta RBUF,x
        inc wptr
:       pla
        tax
        pla
        rti

init_acia:
        sta ACIA_STATUS         ; programmed reset
        lda #%00011111          ; 1 stop, 8 bits, internal clock, 19200 (38400 on SwiftLink)
        sta ACIA_CTRL
        lda #%00001001          ; no parity, RTS low, TX irq off, RX irq on, DTR on
        sta ACIA_CMD
        lda ACIA_DATA           ; discard anything pending
        rts

; The volume register scales what the voices output, and on the 6581 the
; voices output a DC level even when silent, which is all the swing there is
; to play with. A voice held on its highest pulse level (test bit set,
; sustain at maximum) adds a bigger one, so the same volume steps are louder.
; DC_VOICES (make DC=n) says how many voices do that.
.ifndef DC_VOICES
DC_VOICES = 1
.endif

init_voices:
.if DC_VOICES > 0
        ldx #0
:       lda #$FF
        sta SID+2,x             ; pulse width $0FFF
        lda #$0F
        sta SID+3,x
        lda #$F0
        sta SID+6,x             ; sustain 15
        lda #$49                ; test, pulse, gate
        sta SID+4,x
        txa
        clc
        adc #7
        tax
        cpx #7 * DC_VOICES
        bne :-
.endif
        rts

; --- screen ------------------------------------------------------------------

.repeat 26, i
.charmap 65 + i, 1 + i          ; upper case letters are screen codes 1-26
.endrepeat
.repeat 26, i
.charmap 97 + i, 1 + i
.endrepeat

init_screen:
        ldx #0
        lda #32
:       sta SCREEN,x
        sta SCREEN+$100,x
        sta SCREEN+$200,x
        sta SCREEN+$2E8,x
        inx
        bne :-
        ldx #0
:       lda banner,x
        beq :+
        sta SCREEN,x
        inx
        bne :-
:       rts

banner: .byte "PETTY-D418: 4-BIT SID VOLUME SAMPLES", 0

; Show message X (an offset into messages) on the third row.
message:
        ldy #0
:       lda messages,x
        sta SCREEN+80,y
        inx
        iny
        cpy #12
        bne :-
        rts

messages:
MSG_READY   = * - messages
        .byte "READY       "
MSG_LOADING = * - messages
        .byte "LOADING     "

rate:   .word 123 - 1           ; 8 kHz on a PAL machine
flags:  .byte 0
delay:  .byte 0
probe:  .res 23                 ; PROBE's answer
