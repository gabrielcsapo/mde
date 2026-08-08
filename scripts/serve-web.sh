#!/bin/bash
# Serves the web demo and tests. ES modules and wasm both need a real origin, so this
# cannot be opened as a file:// URL.
#
# Caching is disabled outright. Browsers cache ES modules and stylesheets hard, and a
# demo or a test page silently running yesterday's code is worse than no page at all —
# it cost real debugging time before this existed.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/build-web.sh
cd web
PORT="${1:-8731}"
echo "==> http://localhost:$PORT/demo/index.html"
echo "==> http://localhost:$PORT/test/index.html"
exec python3 - "$PORT" <<'PY'
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), NoCacheHandler).serve_forever()
PY
