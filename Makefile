BUILD := build
PRG   := $(BUILD)/d418.prg
PORT  ?= 6464
# Voices held at their highest level, to make the volume steps louder (0-3)
DC    ?= 3
# Cycles per raster line: 63 on a PAL machine, 65 on an NTSC one (untested)
LINE_CYCLES ?= 63
# VICE's SID model: 0 = 6581, 1 = 8580, 2 = 8580 with digiboost
SID   ?= 0

# VICE: SwiftLink cartridge (6551 at $DE00, NMI) on RS-232 device 1, which
# is a raw TCP connection to the bridge (as in PETTY).
VICE_FLAGS := -acia1 -acia1mode 1 -acia1base 0xDE00 -acia1irq 1 \
              -myaciadev 0 -rsdev1 127.0.0.1:$(PORT) +rsdev1ip232 -rsdev1baud 38400 \
              -sidmodel $(SID)

.PHONY: all clean bridge vice test

all: $(PRG)

$(PRG): c64/d418.s c64/d418.cfg | $(BUILD)
	ca65 -D DC_VOICES=$(DC) -D LINE_CYCLES=$(LINE_CYCLES) -I c64 -l $(BUILD)/d418.lst -o $(BUILD)/d418.o c64/d418.s
	ld65 -C c64/d418.cfg -m $(BUILD)/d418.map -o $@ $(BUILD)/d418.o

$(BUILD):
	mkdir -p $@

# Terminal 1: the bridge. make bridge ARGS='--say "hello"'; with no text it
# speaks each line you type.
bridge:
	node bridge/src/bridge.js --port $(PORT) $(ARGS)

# Terminal 2: the emulator
vice: $(PRG)
	x64sc $(VICE_FLAGS) -autostart $(PRG)

test:
	cd bridge && node --test

clean:
	rm -rf $(BUILD)
