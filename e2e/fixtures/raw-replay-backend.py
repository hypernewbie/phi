#!/usr/bin/env python3
"""Raw-replay fixture backend for e2e/terminal-raw-replay.spec.ts.

Emits a styled prefix, a ~3 MiB burst (multi-page replay), a ~30 MiB
burst (past the 32 MiB total the gate requires), and an ending whose
rendering depends on modes set in the prefix (insert mode, yellow SGR).
Gate files under $HOME pace the phases; flag files report progress.
"""

import os
import sys
import time

HOME = os.environ["HOME"]
MIB = 1024 * 1024


def gate(name):
    path = os.path.join(HOME, name)
    while not os.path.exists(path):
        time.sleep(0.02)


def flag(name):
    with open(os.path.join(HOME, name), "w") as handle:
        handle.write("go\n")


def out(data):
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def burst(tag, total):
    written = 0
    line = 0
    chunk = []
    chunk_size = 0
    while written < total:
        text = "%s %08d filler text for throughput filler text\r\n" % (
            tag,
            line,
        )
        raw = text.encode("ascii")
        chunk.append(raw)
        chunk_size += len(raw)
        line += 1
        if chunk_size >= MIB:
            out(b"".join(chunk))
            written += chunk_size
            chunk = []
            chunk_size = 0
    if chunk:
        out(b"".join(chunk))
        written += chunk_size
    return written


# Prefix: styles, modes, cursor addressing, saved cursor, alternate
# screen, and Unicode. Insert mode and yellow SGR stay set on purpose:
# the ending depends on them ~33 MiB later.
out(b"\x1b[2J\x1b[H")
out(b"\x1b[1;34mPREFIX_BLUE_BOLD\x1b[0m\r\n")
out("prefix unicode: \u4f60\u597d \U0001f642 e\u0301\r\n".encode("utf-8"))
out(b"\x1b[4h")  # insert mode on
out(b"\x1b[33m")  # yellow on, no reset
out(b"\x1b7")  # save cursor
out(b"\x1b[5;20HUSES_CURSOR_ADDRESSING")
out(b"\x1b8")  # restore cursor
out(b"\x1b[?1049h\x1b[HALT_PREFIX_SCREEN\x1b[?1049l")
out(b"PREFIX_READY\r\n")
flag("prefix-done")

gate("go-phase1")
burst("BURST1", 3 * MIB)
flag("done-phase1")

gate("go-phase2")
burst("BURST2", 30 * MIB)
# Ending: alternate-screen transition after the burst, cursor movement
# whose result depends on insert mode, and text whose color depends on
# the yellow SGR from the prefix (no SGR is emitted here).
out(b"\x1b[?1049h\x1b[HSECOND_ALT_SCREEN\x1b[?1049l")
out(b"\x1b[3;10H")
out(b"INSERTED_MID_LINE")
out(b" END_YELLOW_STILL ")
out("ending unicode: \u4e16\u754c \U0001f30d n\u0303\r\n".encode("utf-8"))
out(b"\x1b[0m")
out(b"\x1b[4l")
out(b"END_MARK\r\n")
flag("done-phase2")

# Split boundaries: two sequential pairs, each straddled by a fresh
# attach. A split SGR completes with no bytes interleaved (anything
# between the fragments aborts the sequence in any correct terminal),
# then a split emoji completes the same way. The spec replays each
# prefix, then releases the remainder over the live stream.
emoji = "\U0001f642".encode("utf-8")
out(b"SPLIT_SGR_PREFIX\x1b[38;2;25")
flag("split1-ready")
gate("split1-go")
out(b"5;0;0mSPLIT_SGR_OK\x1b[0m\r\n")
flag("done-split1")
out(b"SPLIT_EMOJI_PREFIX" + emoji[:2])
flag("split2-ready")
gate("split2-go")
out(emoji[2:] + b"SPLIT_EMOJI_OK\r\n")
flag("done-split2")

while True:
    time.sleep(1)
