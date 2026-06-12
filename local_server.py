import json
import os
import urllib.parse
import urllib.request
import hashlib
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_UPSTREAM_API = os.environ.get("UPSTREAM_API_BASE", "https://sash-board-2-0.vercel.app/api/query")
ALLOWED_TABLES = {
    "events",
    "v_daily_summary",
    "v_campaign_funnel",
    "v_geo_summary",
    "meta_ads_daily",
    "v_meta_ads_daily_summary",
}

EVENT_MAP = {
    "page_view": "PageView",
    "form_submit": "Lead",
    "quote_confirmed": "Lead",
    "bath_quiz_lead": "Lead",
    "phone_click": "Contact",
    "chat_click": "Contact",
    "prize_wheel_claim": "CompleteRegistration",
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

    def do_OPTIONS(self):
        if self.path.startswith("/api/capi"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        if self.path.startswith("/api/capi"):
            self.handle_capi()
            return
        self.send_json(404, {"error": "Not found"})

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

    def hash_value(self, value: str):
        if not value:
            return None
        return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()

    def event_time_unix(self, value):
        if not value:
            return int(time.time())
        try:
            # Accept ISO timestamps and fallback to now if parsing fails.
            return int(time.mktime(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")))
        except Exception:
            return int(time.time())

    def handle_capi(self):
        pixel_id = os.environ.get("META_PIXEL_ID", "").strip()
        access_token = os.environ.get("META_CAPI_ACCESS_TOKEN", "").strip()
        test_event_code = os.environ.get("META_CAPI_TEST_EVENT_CODE", "").strip()

        if not pixel_id or not access_token:
            self.send_json(500, {"error": "Missing META_PIXEL_ID or META_CAPI_ACCESS_TOKEN"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self.send_json(400, {"error": "Invalid JSON body"})
            return

        incoming_type = body.get("event_type")
        event_name = EVENT_MAP.get(incoming_type)
        if not event_name:
            self.send_json(400, {"error": "Unsupported event_type"})
            return

        user_data = {
            "client_ip_address": (self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]),
            "client_user_agent": body.get("user_agent") or self.headers.get("User-Agent"),
            "fbp": body.get("fbp") or None,
            "fbc": body.get("fbc") or None,
            "external_id": self.hash_value(f"{body.get('site_id', '')}:{body.get('visitor_id', '')}:{body.get('session_id', '')}"),
        }

        custom_data = {
            "event_type": incoming_type,
            "site_id": body.get("site_id"),
            "page_path": body.get("page_path"),
            "utm_source": body.get("utm_source"),
            "utm_medium": body.get("utm_medium"),
            "utm_campaign": body.get("utm_campaign"),
        }

        payload = {
            "data": [{
                "event_name": event_name,
                "event_time": self.event_time_unix(body.get("event_time") or body.get("ts")),
                "event_id": body.get("event_id") or str(uuid.uuid4()),
                "action_source": "website",
                "event_source_url": body.get("page_url"),
                "user_data": user_data,
                "custom_data": custom_data,
            }]
        }

        if test_event_code:
            payload["test_event_code"] = test_event_code

        url = f"https://graph.facebook.com/v20.0/{pixel_id}/events?access_token={urllib.parse.quote(access_token)}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                code = resp.getcode()
                self.send_response(code)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read() or b'{"error":"Meta CAPI request failed"}'
            self.send_response(err.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            self.send_json(500, {"error": "Meta CAPI request failed"})


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
