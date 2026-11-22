#!/usr/bin/env python3
"""Example Phi quota aggregator (Snapshot v1).

Stdlib only. Serves a generic quota snapshot as specified in
docs/quota-format.md:

    python3 quota-aggregator.example.py
    # GET http://127.0.0.1:8765/quota

Replace the fake fetch_*() functions with your own provider calls. The only
rule: emit the generic shape (label + remaining_percent | used_percent |
used+total | text, optional resets_at). Never copy anyone's private
aggregator — this template is all you need.
"""

import json
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def fetch_cluster_a():
    # Pretend this calls your real provider API.
    return {
        "id": "cluster-a",
        "title": "cluster · zone a",
        "rows": [
            {
                "label": "Weekly",
                "remaining_percent": 72,
                "resets_at": (
                    datetime.now(timezone.utc) + timedelta(days=2)
                ).isoformat(),
            },
            {
                "label": "Burst",
                "used_percent": 25,
                "note": "peak hours only",
            },
        ],
    }


def fetch_weights():
    return {
        "id": "weights",
        "title": "weights",
        "rows": [
            {
                "label": "Session",
                "used": 0.24,
                "total": 12.0,
                "unit": "USD",
                "resets_at": int(
                    (datetime.now(timezone.utc) + timedelta(hours=5)).timestamp()
                ),
            },
            {"label": "Notice", "text": "all systems nominal"},
        ],
    }


def snapshot():
    return {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "sections": [fetch_cluster_a(), fetch_weights()],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the example quiet
        pass

    def do_GET(self):
        if self.path != "/quota":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(snapshot()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        # The Phi overlay fetches from the browser: allow it cross-origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("serving snapshot v1 on http://127.0.0.1:8765/quota")
    server.serve_forever()
