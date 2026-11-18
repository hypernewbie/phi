#!/usr/bin/env python3
"""Run phi-cmd against a real phi server and a real backend process.

No model prompts: the control surface is exercised with a pi session
spawned against a stub-free pi binary when available, and otherwise the
REST/pane/exit-code paths are verified with the coders the server ships
(bash panes spawn with no credentials). Mirrors scripts/test-phic-native.py
in isolation: no caller env, no caller backend state, a scratch HOME.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHI_CMD = ROOT / "temp" / "phi-cmd-bin" / "phi-cmd"
FAILURES = []


def check(name, cond, detail=""):
    status = "ok" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_ready(url, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + "/healthz", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def run(argv, expect=0):
    proc = subprocess.run([str(PHI_CMD)] + argv, capture_output=True, text=True, timeout=120)
    check(
        f"exit {expect}: phi-cmd {' '.join(argv[:3])}…",
        proc.returncode == expect,
        f"rc={proc.returncode} stderr={proc.stderr.strip()[:300]}",
    )
    return proc


def main():
    if not PHI_CMD.exists():
        print(f"phi-cmd binary missing: {PHI_CMD} (build it first)", file=sys.stderr)
        return 1
    run_dir = Path(tempfile.mkdtemp(prefix="phi-cmd-it-"))
    home = run_dir / "home"
    work = run_dir / "work"
    work.mkdir(parents=True)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "TMPDIR": str(run_dir),
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    for d in (home / ".config", run_dir):
        d.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(work)], env=env, check=True)
    (work / "it.txt").write_text("fixture\n")
    subprocess.run(["git", "-C", str(work), "add", "it.txt"], env=env, check=True)
    subprocess.run(
        ["git", "-C", str(work), "-c", "user.name=IT", "-c", "user.email=it@invalid",
         "commit", "-qm", "fixture"], env=env, check=True)
    (work / "it.txt").write_text("changed\n")

    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        [str(ROOT / "temp" / "phi-cmd-it" / "phi"), "--port", str(port), "-ip", "127.0.0.1",
         "--web", str(ROOT / "web")],
        env=env, cwd=str(work), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_ready(origin):
            check("server ready", False, "healthz never answered")
            return 1
        check("server ready", True)
        profiles = home / ".config" / "phi-client" / "profiles.json"
        profiles.parent.mkdir(parents=True, exist_ok=True)
        profiles.write_text(json.dumps({"profiles": [
            {"id": "it", "name": "IT Server", "origin": origin}]}))

        base = ["--profiles", str(profiles)]

        # servers: configured + probed
        proc = run(base + ["servers", "--json"])
        try:
            rows = json.loads(proc.stdout)["servers"]
            check("servers row", len(rows) == 1 and rows[0]["health"] == "up"
                  and rows[0]["id"] == "it", proc.stdout[:200])
        except Exception as e:
            check("servers json", False, str(e))

        # status: coders at minimum
        proc = run(base + ["status", "--json"])
        check("status coders", '"coders"' in proc.stdout and '"pi"' in proc.stdout)

        # tabs: bash tab exists, empty sessions list is honest
        proc = run(base + ["tabs", "--json"])
        check("tabs json", '"tabs"' in proc.stdout)

        # sessions: valid empty page
        proc = run(base + ["sessions", "--coder", "bash", "--json"])
        check("sessions empty ok", '"sessions"' in proc.stdout)

        # git: real repo through the real server
        proc = run(base + ["git", "status"])
        check("git status", "it.txt" in proc.stdout, proc.stdout[:200])
        proc = run(base + ["git", "diff"])
        check("git diff", "+changed" in proc.stdout, proc.stdout[:200])

        # run: command executes on the backend host
        proc = run(base + ["run", "echo phi-cmd-it"])
        check("run output", "phi-cmd-it" in proc.stdout, proc.stdout[:200])

        # raw: version endpoint
        proc = run(base + ["raw", "GET", "/api/version"])
        check("raw version", "status: 200" in proc.stdout, proc.stdout[:200])

        # input over a real pane: spawn a bash pane via the API, type into it
        spawn = subprocess.run(
            ["curl", "-s", "-X", "POST", origin + "/api/terminals",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"coder": "bash", "cwd": str(work)})],
            capture_output=True, text=True, timeout=30)
        pane_id = ""
        try:
            pane_id = json.loads(spawn.stdout).get("pane_id", "")
        except Exception:
            pass
        if pane_id:
            run(base + ["input", "--pane", pane_id, "echo pane-it > pane.txt\\r"])
            deadline = time.time() + 15
            wrote = False
            while time.time() < deadline and not wrote:
                wrote = (work / "pane.txt").exists()
                time.sleep(0.3)
            check("pane input wrote file", wrote, "echo never produced pane.txt")
        else:
            check("bash pane spawn", False, spawn.stdout[:200])

        # exit codes
        run(base + ["--server", "nosuch", "status"], expect=3)
        run(base + ["bogus"], expect=2)
        run(base + ["send"], expect=2)
        run(["--profiles", str(run_dir / "none.json"), "servers"], expect=2)

        # model set honesty without a live chat session or pane
        proc = run(base + ["model", "set", "x"], expect=1)
        check("model set honest", proc.returncode == 1)

    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(run_dir, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}: {FAILURES}")
        return 1
    print("phi-cmd integration: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
