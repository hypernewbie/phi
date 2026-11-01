#!/bin/sh
# Raw-replay exit fixture: a paced transcript, then the process ends.
# A viewer that attaches mid-stream must still replay every byte,
# including output that arrives while the exit lands.
i=1
while [ "$i" -le 2000 ]; do
    printf 'EXIT_LINE_%04d\r\n' "$i"
    i=$((i + 1))
    if [ $((i % 250)) -eq 0 ]; then sleep 1; fi
done
printf 'EXIT_TAIL_MARK\r\n'
exit 0
