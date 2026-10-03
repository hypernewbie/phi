# Terminal history

Phi keeps terminal output in `~/.phi/recordings/`. Each logical pane has a private append-only file. Output and resize records stay available after process exit and normal Phi restart. Recording files can contain secrets printed by your tools. Files use owner-only permissions; do not share them as ordinary debug logs.

`replay_buffer_bytes` limits the in-memory replay cache. It does not limit retained output. Hot WebSocket attachment still sends a small head and optional checkpoint, not the full recording. HTTP history reads and parser batches are bounded. A failed recording write holds the PTY read loop for retry rather than publishing bytes that have no retained copy.

A compact checkpoint provides fast first paint. Scroll up at the loaded boundary to retrieve omitted history. The same path handles mouse wheels, native scrolling, and downward touch gestures. Loading history keeps live frames held until the replay is complete.

Phi checks recording epochs, spans, and body sizes before parsing. Temporary failures retry. If recovery still fails, Phi reconnects without skipping the missing interval. Checkpoints preserve terminal continuation state and rewind over incomplete UTF-8 characters. Unsupported checkpoint state falls back to recording replay.

The regression suite covers client recovery, real xterm continuation, browser scrolling, backend retention, and restart. These tests do not certify every possible terminal command, operating-system failure, or native tool version.

Recordings are not automatically deleted when the replay cache fills or a process exits. To remove them manually, stop Phi first, then remove the relevant recording files. Doing so deliberately removes retained history.
