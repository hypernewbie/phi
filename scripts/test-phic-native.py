#!/usr/bin/env python3
"""Run installed backends through phic in an isolated native tmux terminal.

No model prompts or user credentials. tmux is a test dependency, never a
phic runtime dependency. Tests startup, repeated client views, detach, and
historical reattachment without provider prompts.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode2", help="Path to an already installed OpenCode 2 executable")
    parser.add_argument("--coders", default="bash,pi,codex,claude,opencode,opencode-mini-native")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    tmux_bin = shutil.which("tmux")
    if not tmux_bin:
        parser.error("tmux is required for this native test")
    run = Path(tempfile.mkdtemp(prefix="phic-native-"))
    home, work = run / "home", run / "work"
    (home / ".phi" / "backends").mkdir(parents=True)
    work.mkdir()
    (work / "temp").mkdir()
    (work / "temp" / "native.md").write_text("# PHIC_MD_NATIVE_VIEW\n\nThis paragraph remains readable across the full terminal viewport rather than a narrow side panel.\n\n**Phi** Markdown works.\n\n- one\n- two\n")
    # No provider credentials, SSH agent, or caller backend state is inherited.
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL")}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
               XDG_DATA_HOME=str(home / ".local/share"), XDG_CACHE_HOME=str(home / ".cache"),
               TERM="xterm-256color", COLORTERM="truecolor",
               SHELL=shutil.which("bash") or "/bin/sh", PS1="PHIC NATIVE work $ ",
               GIT_CONFIG_NOSYSTEM="1")
    subprocess.run(["git", "init", "-q", str(work)], env=env, check=True)
    (work / "native.txt").write_text("original fixture\n")
    subprocess.run(["git", "-C", str(work), "add", "native.txt"], env=env, check=True)
    subprocess.run(["git", "-C", str(work), "-c", "user.name=Phic Native",
                    "-c", "user.email=phic-native@invalid", "commit", "-qm", "native fixture"], env=env, check=True)
    (work / "native.txt").write_text("changed fixture\n")
    coders = args.coders.split(",")
    for coder in coders:
        if coder in ("bash", "pi", "codex", "claude") and not shutil.which(coder):
            parser.error(f"requested backend {coder} is not installed")
    opencode = None
    config = {"pi_offline": True}
    if any(c.startswith("opencode") for c in coders):
        if not args.opencode2:
            parser.error("OpenCode tests require --opencode2; legacy installations are never replaced")
        opencode = str(Path(args.opencode2).resolve(strict=True))
        version = subprocess.check_output([opencode, "--version"], env=env, text=True, timeout=10)
        if not re.search(r"\bv?2\.", version):
            parser.error("--opencode2 must point to OpenCode 2")
        subprocess.run([opencode, "service", "set", "port", str(free_port())],
                       env=env, cwd=work, check=True, timeout=10, capture_output=True)
        config["opencode_command"] = opencode
        (home / ".phi/backends/opencode-mini-native.json").write_text(json.dumps({
            "id": "opencode-mini-native", "name": "OpenCode Mini Native", "command": opencode,
            "args": ["mini"], "session_source": "none", "input_mode": "direct"}))
    (home / ".phi/config.json").write_text(json.dumps(config))
    (home / ".phi/backends/bash.json").write_text(json.dumps({
        "id": "bash", "args": ["--noprofile", "--norc"]}))
    (home / ".phi/backends/pi.json").write_text(json.dumps({
        "id": "pi", "args": ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates"]}))
    server_bin, client_bin = run / "phi", run / "phic"
    subprocess.run(["go", "build", "-o", str(server_bin), "."], cwd=root, check=True)
    subprocess.run(["go", "build", "-o", str(client_bin), "./cmd/phic"], cwd=root, check=True)
    url = "http://127.0.0.1:" + str(free_port())
    log = open(run / "server.log", "wb")
    server = subprocess.Popen([str(server_bin), "--ip", "127.0.0.1", "--port", url.rsplit(":", 1)[1]],
                              cwd=work, env=env, stdout=log, stderr=log)
    socket_path = str(run / "tmux.sock")

    def tmux(*argv, check=True):
        proc = subprocess.run([tmux_bin, "-S", socket_path, "-f", "/dev/null", *argv],
                              env=env, capture_output=True, timeout=5)
        if check and proc.returncode:
            detail = proc.stderr.decode("utf-8", "replace").strip() or proc.stdout.decode("utf-8", "replace").strip()
            raise RuntimeError(f"tmux {' '.join(argv)} failed ({proc.returncode}): {detail}")
        return proc

    # Keep a persistent anchor session alive so the tmux server does not
    # asynchronously exit when client sessions detach between views and reattach.
    tmux("start-server")
    tmux("set-option", "-s", "exit-empty", "off", check=False)
    tmux("new-session", "-d", "-s", "_anchor", "sleep", "86400")

    def api(path):
        with urllib.request.urlopen(url + path, timeout=3) as response:
            return json.load(response)

    def snapshot(name):
        cells = tmux("capture-pane", "-e", "-p", "-t", name, check=False)
        if cells.returncode:
            return None
        cursor = tmux("display-message", "-p", "-t", name,
                      "#{cursor_x} #{cursor_y} #{alternate_on} #{cursor_flag}", check=False)
        return {"cells": cells.stdout.decode("utf-8", "replace"),
                "cursor": cursor.stdout.decode("utf-8", "replace").strip()}

    def terminal_equal(actual, expected):
        result = subprocess.run(["node", str(root / "scripts/phic-native-screen-compare.mjs")],
                                input=json.dumps([actual, expected]), text=True, capture_output=True,
                                cwd=root, check=True, timeout=10)
        return json.loads(result.stdout)["equal"]

    def settled(name, timeout=10):
        previous, stable = None, 0
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = snapshot(name)
            stable = stable + 1 if current is not None and current == previous else 0
            previous = current
            if stable >= 8:
                return current
            time.sleep(.1)
        raise RuntimeError(f"{name} did not settle")

    def wait_view(name, marker):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            capture = tmux("capture-pane", "-p", "-t", name, check=False)
            if marker in capture.stdout.decode("utf-8", "replace"):
                return
            time.sleep(.05)
        raise RuntimeError(f"{name} never displayed {marker}")

    expected = {
        "bash": r"work [%$#]", "pi": r"(?i)(no models available|ctrl.c/ctrl.d|v1\.)",
        "codex": r"(?i)(welcome to codex|sign in|openai codex|select.*account|login)",
        "claude": r"(?i)(choose the text style|claude code)",
        "opencode": r"(?i)(ask anything|opencode|sign in|provider)",
        "opencode-mini-native": r"(?i)(opencode|ask anything|provider|model|prompt)",
    }
    report = []
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(url + "/healthz", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if server.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Phi failed to start; see server.log")
            time.sleep(.05)
        for coder in coders:
            name = coder.replace("-", "_")
            started = time.monotonic()
            tmux("new-session", "-d", "-s", name, "-x", "120", "-y", "36", str(client_bin),
                 "--server", url, "--new", "--coder", coder, str(work))
            tape, previous, stable, ready = "", "", 0, False
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                capture = tmux("capture-pane", "-p", "-t", name, check=False)
                if capture.returncode:
                    break
                tape = capture.stdout.decode("utf-8", "replace")
                stable = stable + 1 if tape.strip() and tape == previous else 0
                previous = tape
                if stable >= 8 and re.search(expected[coder], tape):
                    ready = True
                    break
                time.sleep(.1)
            (run / (coder + ".screen.txt")).write_text(tape)
            panes = [p for p in api("/api/terminals") if p.get("coder") == coder]
            pane = panes[-1] if panes else None
            views = []
            if ready and coder == "bash":
                # Keep an unfinished command in Readline. No Enter, execution,
                # or model prompt: menus must preserve the editable input line.
                tmux("send-keys", "-t", name, "-l", "printf PHIC_UNSUBMITTED")
                wait_view(name, "PHIC_UNSUBMITTED")
            reference = settled(name) if ready else None
            for key, marker, leave in [("?", "phic help", "Escape"), ("s", "SESSIONS", "Escape"),
                                       ("w", "Worktree", "Escape"), ("h", "Recording", "Escape"),
                                       ("b", "Φ", "Escape"), ("?", "phic help", "Escape")]:
                if reference is None:
                    break
                try:
                    tmux("send-keys", "-t", name, "C-]", key)
                    wait_view(name, marker)
                    view = snapshot(name)
                    if key == "s":
                        plain = re.sub(r"\x1b\[[0-9;]*m", "", view["cells"])
                        if "New Session" not in plain or "▣" not in plain:
                            raise RuntimeError("console lost its persistent session/tab controls")
                    (run / f"{coder}.{key if key != '?' else 'help'}.{len(views)}.view.json").write_text(json.dumps(view, indent=2))
                    tmux("send-keys", "-t", name, leave)
                    restored = settled(name)
                    equal = terminal_equal(restored, reference)
                    views.append({"key": key, "restored": equal})
                    (run / f"{coder}.return.{len(views)}.json").write_text(json.dumps({"expected": reference, "actual": restored}, indent=2))
                    if not equal:
                        break
                except (RuntimeError, subprocess.CalledProcessError) as error:
                    views.append({"key": key, "restored": False, "error": str(error)})
                    break
            coder_click = None
            if ready and coder == "bash" and all(v["restored"] for v in views):
                try:
                    rows = tmux("capture-pane", "-p", "-t", name).stdout.decode("utf-8", "replace").splitlines()
                    x = rows[1].index("[c]") + 1
                    tmux("send-keys", "-t", name, "-l", f"\x1b[<0;{x};2M\x1b[<0;{x};2m")
                    wait_view(name, "Enter confirm   Esc cancel")
                    rows = tmux("capture-pane", "-p", "-t", name).stdout.decode("utf-8", "replace").splitlines()
                    y, row = next((y, row) for y, row in enumerate(rows) if "› " in row)
                    x = row.index("› ") + 3
                    tmux("send-keys", "-t", name, "-l", f"\x1b[<0;{x};{y + 1}M\x1b[<0;{x};{y + 1}m")
                    wait_view(name, "PHIC_UNSUBMITTED")
                    # Context selection deliberately keeps chrome focus. Return
                    # explicitly before comparing the backend cursor/display.
                    tmux("send-keys", "-t", name, "C-]", "t", "Escape")
                    actual = settled(name)
                    (run / "coder-click.view.json").write_text(json.dumps({"expected": reference, "actual": actual}, indent=2))
                    coder_click = terminal_equal(actual, reference)
                except (RuntimeError, ValueError, StopIteration, subprocess.CalledProcessError) as error:
                    coder_click = False
                    (run / "coder-click-error.txt").write_text(str(error))
            redraw = None
            if ready and coder == "bash" and all(v["restored"] for v in views):
                tmux("send-keys", "-t", name, "C-]", "R")
                wait_view(name, "PHIC_UNSUBMITTED")
                actual = settled(name)
                (run / "refresh.view.json").write_text(json.dumps({"expected": reference, "actual": actual}, indent=2))
                redraw = terminal_equal(actual, reference)
            markdown_view = None
            if ready and coder == "bash" and all(v["restored"] for v in views):
                try:
                    tmux("send-keys", "-t", name, "C-]", "M")
                    wait_view(name, "native.md")
                    tmux("send-keys", "-t", name, "Enter")
                    wait_view(name, "PHIC_MD_NATIVE_VIEW")
                    md_view = snapshot(name)
                    (run / "markdown.view.json").write_text(json.dumps(md_view, indent=2))
                    plain = re.sub(r"\x1b\[[0-9;]*m", "", md_view["cells"])
                    if "the full terminal viewport rather than a narrow side panel." not in plain:
                        raise RuntimeError("Markdown still wraps in a thin side panel")
                    # Click the actual Unicode close glyph in the real client TTY.
                    tmux("send-keys", "-t", name, "-l", "\x1b[<0;118;2M\x1b[<0;118;2m")
                    wait_view(name, "Enter view")
                    tmux("send-keys", "-t", name, "C-]", "d")
                    wait_view(name, "PHIC_UNSUBMITTED")
                    markdown_view = terminal_equal(settled(name), reference)
                except (RuntimeError, subprocess.CalledProcessError) as error:
                    markdown_view = False
                    (run / "markdown.failed.json").write_text(json.dumps(snapshot(name), indent=2))
                    (run / "markdown-error.txt").write_text(str(error))
            close_click_undo = None
            if ready and coder == "bash" and all(v["restored"] for v in views):
                def click_control(label):
                    line = tmux("capture-pane", "-p", "-t", name).stdout.decode("utf-8", "replace").splitlines()[2]
                    column = line.rfind(label)
                    if column < 0:
                        raise RuntimeError(f"missing clickable control {label}")
                    # SGR mouse packets enter the real client TTY, not its model.
                    x = column + 2
                    tmux("send-keys", "-t", name, "-l", f"\x1b[<0;{x};3M\x1b[<0;{x};3m")
                try:
                    click_control("[x] close")
                    wait_view(name, "closed tab;")
                    click_control("[u] undo")
                    wait_view(name, "PHIC_UNSUBMITTED")
                    close_click_undo = terminal_equal(settled(name), reference)
                except (RuntimeError, subprocess.CalledProcessError) as error:
                    close_click_undo = False
                    (run / "close-click-error.txt").write_text(str(error))
            tmux("send-keys", "-t", name, "C-]", "q", check=False)
            detached, alive = False, False
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = next((p for p in api("/api/terminals") if pane and p["id"] == pane["id"]), None)
                alive = current is not None
                detached = bool(current and current.get("ActiveWSCount", 0) == 0)
                if detached:
                    break
                time.sleep(.05)
            reattached = False
            if ready and detached and pane and all(v["restored"] for v in views):
                resumed_name = name + "_reattach"
                tmux("new-session", "-d", "-s", resumed_name, "-x", "120", "-y", "36", str(client_bin),
                     "--server", url, "--pane", pane["id"])
                try:
                    # Require an actual backend marker before the settle check;
                    # a stable empty terminal is not a successful reattachment.
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        capture = tmux("capture-pane", "-p", "-t", resumed_name, check=False)
                        if re.search(expected[coder], capture.stdout.decode("utf-8", "replace")):
                            break
                        time.sleep(.05)
                    else:
                        raise RuntimeError("reattachment never painted the backend marker")
                    restored = settled(resumed_name, timeout=20)
                    reattached = terminal_equal(restored, reference)
                    (run / f"{coder}.reattach.json").write_text(json.dumps({"expected": reference, "actual": restored}, indent=2))
                    tmux("send-keys", "-t", resumed_name, "C-]", "q", check=False)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        current = next((p for p in api("/api/terminals") if p["id"] == pane["id"]), None)
                        if current and current.get("ActiveWSCount", 0) == 0:
                            break
                        time.sleep(.05)
                    else:
                        reattached = False
                except (RuntimeError, subprocess.CalledProcessError) as error:
                    (run / f"{coder}.reattach-error.txt").write_text(str(error))
            row = {"coder": coder, "elapsed": round(time.monotonic() - started, 3), "ready": ready,
                   "views": views, "reattached": reattached,
                   "detached": detached, "backend_survives_detach": alive, "close_click_undo": close_click_undo, "markdown_view": markdown_view, "redraw": redraw, "coder_click": coder_click, "pane": pane}
            report.append(row)
            print(json.dumps({k: v for k, v in row.items() if k != "pane"}), flush=True)
    finally:
        tmux("kill-server", check=False)
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.close()
        if opencode:
            try:
                subprocess.run([opencode, "service", "stop"], env=env, cwd=work, timeout=10, capture_output=True)
            except subprocess.TimeoutExpired:
                pass
        (run / "report.json").write_text(json.dumps(report, indent=2))
        print("Evidence:", run)
    return 0 if len(report) == len(coders) and all(
        r["ready"] and len(r["views"]) == 6 and all(v["restored"] for v in r["views"])
        and r["reattached"] and r["detached"] and r["backend_survives_detach"]
        and (r["coder"] != "bash" or (r["close_click_undo"] is True and r["markdown_view"] is True and r["redraw"] is True and r["coder_click"] is True)) for r in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
