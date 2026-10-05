# Terminal history

Phi keeps terminal output in `~/.phi/recordings/`. Each logical pane has a private append-only file. Output and resize records stay available after process exit and normal Phi restart. Recording files can contain secrets printed by your tools. Files use owner-only permissions; do not share them as ordinary debug logs.

`replay_buffer_bytes` limits the in-memory replay cache. It does not limit retained output. Hot WebSocket attachment still sends a small head and optional checkpoint, not the full recording. HTTP history reads and parser batches are bounded. A failed recording write holds the PTY read loop for retry rather than publishing bytes that have no retained copy.

A compact checkpoint provides fast first paint. Without a checkpoint, Phi replays the retained prefix unless the journal certifies a plain ASCII CRLF boundary with enough following lines to replace the live buffer. An arbitrary tail offset is not a valid terminal state.

Scroll up at the loaded boundary to retrieve omitted history. Each request is at most 2 MiB, and xterm keeps at most 10,000 scrollback rows plus its viewport. Replay markers associate source byte frontiers with retained rows. Adjacent pages overlap those rows, including when output has very short lines. The same path handles mouse wheels, native scrolling, and downward touch gestures.

While you read an older page, live output stays in the recording and does not overwrite your view. Returning to latest restores the saved live state and replays its retained delta. A same-epoch reconnect finishes in-flight replay before transferring socket ownership. A new epoch discards the old reading state.

Each recording has one mutex owner, shared by cold reads and live writes. Opening and recovery are serialized before that owner is published. Recovery refuses ambiguous middle corruption, including a committed suffix followed by a torn final append; it does not delete that suffix.

Phi checks recording epochs, spans, and body sizes before parsing. Temporary failures retry. If recovery still fails, Phi reconnects without skipping the missing interval. Checkpoints preserve terminal continuation state and rewind over incomplete UTF-8 characters. Unsupported checkpoint state falls back to recording replay.

The regression suite covers client recovery, real xterm continuation, browser scrolling, backend retention, and restart. These tests do not certify every possible terminal command, operating-system failure, or native tool version.

Recordings are not automatically deleted when the replay cache fills or a process exits. To remove them manually, stop Phi first, then remove the relevant recording files. Doing so deliberately removes retained history.
