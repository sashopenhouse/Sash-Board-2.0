import json
import os
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_UPSTREAM_API = os.environ.get("UPSTREAM_API_BASE", "https://sash-board-2-0.vercel.app/api/query")
ALLOWED_TABLES = {
    "events",
    "v_daily_summary",
    "v_campaign_funnel",
    "v_geo_summary",
}


def load_dotenv(path: str) -> None:
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


class LocalApiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/query"):
            self.handle_query()
            return
        super().do_GET()

    def send_json(self, code: int, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_query(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        table = query.get("table", [""])[0]
        raw_params = query.get("params", [""])[0]

        if not table or table not in ALLOWED_TABLES:
            self.send_json(400, {"error": "Invalid table"})
            return

        supabase_url = os.environ.get("SUPABASE_URL", "").strip()
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()

        if supabase_url and service_key:
            base_url = supabase_url.rstrip("/")
            if base_url.lower().endswith("/rest/v1"):
                base_url = base_url[:-8]
            params = raw_params.lstrip("?").lstrip("&")
            upstream_url = f"{base_url}/rest/v1/{table}"
            if params:
                upstream_url += f"?{params}"
            headers = {
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
            }
        else:
            encoded_params = {
                "table": table,
                "params": raw_params,
            }
            upstream_url = f"{DEFAULT_UPSTREAM_API}?{urllib.parse.urlencode(encoded_params)}"
            headers = {}

        req = urllib.request.Request(upstream_url, headers=headers, method="GET")

        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                code = resp.getcode()
                content_type = resp.headers.get("Content-Type", "application/json")
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read() or b'{"error":"Upstream request failed"}'
            self.send_response(err.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            self.send_json(500, {"error": "Upstream request failed"})


def main():
    load_dotenv(os.path.join(ROOT, ".env.local"))
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), LocalApiHandler)
    print(f"Local dashboard server running at http://{host}:{port}")
    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"):
        print("API mode: direct Supabase")
    else:
        print(f"API mode: upstream proxy ({DEFAULT_UPSTREAM_API})")
    server.serve_forever()


if __name__ == "__main__":
    main()
