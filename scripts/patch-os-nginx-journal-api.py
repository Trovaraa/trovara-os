#!/usr/bin/env python3
"""Fix os.trovara.farm nginx so /api/*.jpg proxies to the API (^~), not static files."""
from __future__ import annotations

import re
import shutil
import time
from pathlib import Path

PATH = Path("/etc/nginx/sites-enabled/os.trovara.farm.conf")


def main() -> None:
    text = PATH.read_text()
    stamp = time.strftime("%Y%m%d%H%M%S")
    bak = PATH.with_name(f"os.trovara.farm.conf.bak-journal-api-{stamp}")
    shutil.copy2(PATH, bak)
    print(f"backup {bak}")

    # Drop the combined regex proxy (loses to static-extension for .jpg).
    text, n = re.subn(
        r"\n\s*location ~ \^\./\(api\|auth\|public\|shop\)/ \{.*?\n\s*\}\n",
        "\n",
        text,
        count=1,
        flags=re.S,
    )
    print(f"removed_combined {n}")

    proxy_common = """
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 12M;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=(self), payment=()" always;
    add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'" always;
    add_header Cache-Control "no-store, no-cache, must-revalidate" always;
"""

    api_auth_shop = f"""
  # API/auth/shop: ^~ wins over static-extension regex so /api/.../*.jpg hits the API.
  location ^~ /api/ {{{proxy_common}  }}

  location ^~ /auth/ {{{proxy_common}  }}

  location ^~ /shop/ {{{proxy_common}  }}
"""

    # Remove any existing ^~ /api|/auth|/shop blocks so we re-insert cleanly before static.
    for loc in ("/api/", "/auth/", "/shop/"):
        while True:
            marker = f"location ^~ {loc}"
            start = text.find(marker)
            if start < 0:
                break
            # walk back to include leading whitespace/newline
            line_start = text.rfind("\n", 0, start) + 1
            end = text.find("\n  }\n", start)
            if end < 0:
                raise SystemExit(f"unclosed block for {loc}")
            text = text[:line_start] + text[end + 5 :]
            print(f"removed existing ^~ {loc}")

    m = re.search(r"\n\s*location ~\* \^\.\+\\\.\(css\|js\|jpg", text)
    if not m:
        raise SystemExit("static extension location not found")
    text = text[: m.start()] + "\n" + api_auth_shop + text[m.start() :]

    api_pos = text.find("location ^~ /api/")
    static_pos = text.find("location ~*")
    combined = text.find("location ~ ^/(api|auth|public|shop)/")
    print(f"api_pos={api_pos} static_pos={static_pos} combined={combined}")
    if api_pos < 0 or static_pos < 0 or api_pos > static_pos or combined >= 0:
        raise SystemExit("ordering invalid after patch")
    if "location ^~ /public/" not in text:
        raise SystemExit("missing ^~ /public/")

    PATH.write_text(text)
    print(f"wrote {PATH}")


if __name__ == "__main__":
    main()
