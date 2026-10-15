#!/usr/bin/env python3
"""Sample Linux DRM engine time for ONE GPU process (no root required).

Usage: python3 scripts/profile-intel-gpu.py --pid GPU_PID --seconds 30 \
           --label normal --output /tmp/phi-gpu-normal.json

Find GPU_PID with `pgrep -af 'phi.*--type=gpu-process'`. Engine percentages
are engine-time deltas / monotonic wall time, NOT CPU percentages or VRAM
allocation. Duplicate fds for one DRM client are counted once. Whole-device
intel_gpu_top measurements include other apps and should be reported separately.
"""

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import time


def parse_fdinfo(text):
    fields = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
    if "drm-client-id" not in fields:
        return None
    key = (fields.get("drm-pdev", "").strip(), fields["drm-client-id"].strip())
    engines = {}
    for name, value in fields.items():
        if name.startswith("drm-engine-"):
            amount, unit = value.split()
            if unit == "ns":
                engines[name.removeprefix("drm-engine-")] = int(amount)
    return key, engines


def engine_times(pid):
    clients = {}
    for fd in Path(f"/proc/{pid}/fdinfo").iterdir():
        try:
            parsed = parse_fdinfo(fd.read_text())
        except FileNotFoundError:
            continue  # fds can close during a sample
        if parsed is None:
            continue
        key, engines = parsed
        previous = clients.setdefault(key, {})
        for engine, value in engines.items():
            previous[engine] = max(previous.get(engine, 0), value)
    if not clients or not any(clients.values()):
        raise RuntimeError(f"PID {pid} exposes no DRM engine-time counters")
    return clients


def engine_delta(before, after, elapsed_ns):
    # New/replaced DRM clients have no baseline: fail rather than silently
    # reporting a misleading 0% after a GPU-process/device reset.
    if before.keys() != after.keys():
        raise RuntimeError("DRM clients changed during capture; repeat the run")
    totals = {}
    for client, engines in after.items():
        if engines.keys() != before[client].keys():
            raise RuntimeError("DRM engines changed during capture")
        for engine, value in engines.items():
            delta = value - before[client][engine]
            if delta < 0:
                raise RuntimeError("DRM counter reset during capture")
            totals[engine] = totals.get(engine, 0) + delta
    return {engine: ns / elapsed_ns * 100 for engine, ns in totals.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--interval", type=float, default=1)
    parser.add_argument("--label", default="unlabelled")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.pid <= 0:
        parser.error("pid must be positive")
    if not all(math.isfinite(v) and v > 0 for v in (args.seconds, args.interval)):
        parser.error("seconds and interval must be finite and positive")
    # Linux stat field 22 uniquely identifies this process incarnation.
    stat = Path(f"/proc/{args.pid}/stat")
    start_ticks = stat.read_text().rsplit(")", 1)[1].split()[19]
    command = Path(f"/proc/{args.pid}/comm").read_text().strip()
    before = engine_times(args.pid)
    start = previous = time.monotonic_ns()
    samples = []
    while time.monotonic_ns() - start < args.seconds * 1e9:
        remaining = max(0, args.seconds - (time.monotonic_ns() - start) / 1e9)
        time.sleep(min(args.interval, remaining))
        after = engine_times(args.pid)
        now = time.monotonic_ns()
        if stat.read_text().rsplit(")", 1)[1].split()[19] != start_ticks:
            raise RuntimeError("GPU process restarted during capture")
        samples.append({
            "seconds": (now - previous) / 1e9,
            "engine_busy_percent": engine_delta(before, after, now - previous),
        })
        before, previous = after, now
    duration = sum(sample["seconds"] for sample in samples)
    names = samples[0]["engine_busy_percent"]
    summary = {}
    for name in names:
        values = [s["engine_busy_percent"][name] for s in samples]
        summary[name] = {
            "mean_percent": sum(
                s["seconds"] * s["engine_busy_percent"][name] for s in samples
            ) / duration,
            "median_percent": statistics.median(values),
            "min_percent": min(values),
            "max_percent": max(values),
        }
    result = {
        "label": args.label, "pid": args.pid, "command": command,
        "kernel": os.uname().release, "duration_seconds": duration,
        "engine_summary": summary, "samples": samples,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"label": args.label, "engine_summary": summary}))


if __name__ == "__main__":
    main()
