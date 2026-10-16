"""Deep-link + download routes.

  • GET /join                  — Android → Play Store, iOS → App Store, anything else → landing page.
  • GET /invite/{token}        — same routing; Play gets an install referrer carrying the invite.
  • GET /w/{code}              — a shared-workout invite (Workout with Partner): an installed app opens
                                 it at /workout/join/{code}; otherwise the same store routing as /join.
  • GET /join/qr.svg           — the download QR code (optionally for an invite: ?invite=<token>).
  • GET /join/poster           — printable "Scan to join us" poster.
  • POST /api/invites          — (auth) mint a personal invite link.
  • GET /.well-known/apple-app-site-association, /.well-known/assetlinks.json
                               — Universal Links / App Links, so an installed app opens these URLs
                                 directly and the server routing above only ever sees non-installs.
"""

from __future__ import annotations

import html
import json
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from backend import config
from backend.auth.deps import current_user
from backend.deeplinks.invites import create_invite, read_invite
from backend.deeplinks.qr import qr_svg
from backend.nearby import notifications as copy
from backend.nearby.store import display_name

router = APIRouter()

_IOS_UA = re.compile(r"iphone|ipad|ipod", re.I)
_ANDROID_UA = re.compile(r"android", re.I)
# Paths an installed app should claim via Universal Links / App Links.
APP_LINK_PATHS = ["/join", "/join/*", "/invite/*", "/nearby", "/nearby/*", "/w/*"]


def join_url(invite: str | None = None) -> str:
    return f"{config.PUBLIC_BASE_URL}/invite/{invite}" if invite else f"{config.PUBLIC_BASE_URL}/join"


def play_store_url(invite: str | None) -> str:
    if not invite:
        return config.PLAY_STORE_URL
    referrer = quote(f"utm_source=squirrel_invite&invite={invite}", safe="")
    sep = "&" if "?" in config.PLAY_STORE_URL else "?"
    return f"{config.PLAY_STORE_URL}{sep}referrer={referrer}"


def _route(request: Request, invite: str | None, inviter_name: str | None, *, open_app: str | None = None) -> Response:
    ua = request.headers.get("user-agent", "")
    headers = {"Cache-Control": "no-store", "Vary": "User-Agent"}
    if _ANDROID_UA.search(ua):
        return RedirectResponse(play_store_url(invite), status_code=302, headers=headers)
    if _IOS_UA.search(ua):
        return RedirectResponse(config.APP_STORE_URL, status_code=302, headers=headers)
    return HTMLResponse(_landing_html(invite, inviter_name, open_app=open_app), headers=headers)


@router.get("/join", include_in_schema=False)
def join(request: Request) -> Response:
    return _route(request, None, None)


@router.get("/invite/{token}", include_in_schema=False)
def invite(token: str, request: Request) -> Response:
    record = read_invite(token)
    if record is None:   # unknown / expired invites still get people to the app
        return _route(request, None, None)
    return _route(request, token, display_name(record["inviter"]))


@router.get("/w/{code}", include_in_schema=False)
def shared_workout_invite(code: str, request: Request) -> Response:
    """Only reached when the app isn't installed (an installed app claims /w/* as a Universal/App
    Link). Nothing about the session is looked up or shown here: the code is checked by the app."""
    clean = code.strip().upper()
    target = f"{config.APP_SCHEME}://workout/join/{clean}" if re.fullmatch(r"[A-Z0-9]{4,16}", clean) else None
    return _route(request, None, None, open_app=target)


@router.get("/join/qr.svg", include_in_schema=False)
def join_qr(invite: str | None = None) -> Response:
    target = join_url(invite if invite and read_invite(invite) else None)
    return Response(qr_svg(target), media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=300"})


@router.get("/join/poster", include_in_schema=False)
def join_poster() -> HTMLResponse:
    return HTMLResponse(_poster_html())


@router.post("/api/invites", status_code=status.HTTP_201_CREATED)
def new_invite(user_id: str = Depends(current_user)) -> dict:
    record = create_invite(user_id)
    return {
        "token": record["token"],
        "url": join_url(record["token"]),
        "qr_svg_url": f"{config.PUBLIC_BASE_URL}/join/qr.svg?invite={record['token']}",
        "expires_at": record["expires_at"],
    }


@router.get("/.well-known/apple-app-site-association", include_in_schema=False)
def apple_app_site_association() -> JSONResponse:
    return JSONResponse({
        "applinks": {
            "details": [
                {"appIDs": config.IOS_APP_IDS, "components": [{"/": p} for p in APP_LINK_PATHS]},
            ],
        },
    })


@router.get("/.well-known/assetlinks.json", include_in_schema=False)
def assetlinks() -> JSONResponse:
    return JSONResponse([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": config.ANDROID_PACKAGE,
            "sha256_cert_fingerprints": config.ANDROID_CERT_SHA256,
        },
    }])


# --- pages -------------------------------------------------------------------

_STYLE = """
:root { --bg:#fbf7f0; --ink:#1b1b1b; --muted:#5d574e; --accent:#c8641e; --card:#ffffff; --line:#e7dfd2; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16140f; --ink:#f4efe6; --muted:#b3aa9c; --accent:#f08a3c; --card:#211e18; --line:#37322a; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
       font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:440px; margin:0 auto; padding:40px 16px; text-align:center; }
.brand { font-weight:800; letter-spacing:.14em; font-size:22px; }
h1 { font-size:26px; line-height:1.25; margin:24px 0 8px; }
p { color:var(--muted); margin:0 0 24px; }
.qr { background:#fff; border:1px solid var(--line); border-radius:16px; padding:12px; display:inline-block; }
.qr svg { display:block; width:220px; height:220px; }
.cta { display:block; margin:12px 0; padding:14px 18px; border-radius:12px; font-weight:700;
       text-decoration:none; background:var(--accent); color:#fff; letter-spacing:.04em; }
.cta.secondary { background:transparent; color:var(--ink); border:1px solid var(--line); }
.tagline { margin-top:28px; font-style:italic; color:var(--muted); }
"""


def _landing_html(invite: str | None, inviter_name: str | None, *, open_app: str | None = None) -> str:
    esc = html.escape
    target = join_url(invite)
    app_store_js = json.dumps(config.APP_STORE_URL).replace("</", "<\\/")
    open_app = open_app or (f"{config.APP_SCHEME}://invite/{invite}" if invite else f"{config.APP_SCHEME}://nearby")
    heading = f"{esc(inviter_name)} invited you to Squirrel Social 🐿️" if inviter_name else esc(copy.ACQUISITION_TITLE)
    # iPadOS Safari reports a desktop UA, so a touch-capable "Mac" is sent to the App Store client-side.
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join Squirrel Social</title>
<meta property="og:title" content="{esc(copy.ACQUISITION_TITLE)}">
<meta property="og:description" content="{esc(copy.ACQUISITION_BODY)}">
<meta property="og:url" content="{esc(target)}">
<style>{_STYLE}</style>
</head><body><main>
<div class="brand">SQUIRREL 🐿️</div>
<h1>{heading}</h1>
<p>{esc(copy.ACQUISITION_BODY)}</p>
<div class="qr">{qr_svg(target)}</div>
<a class="cta" href="{esc(config.APP_STORE_URL)}">Download on the App Store</a>
<a class="cta" href="{esc(play_store_url(invite))}">Get it on Google Play</a>
<a class="cta secondary" href="{esc(open_app)}">Already have it? Open Squirrel Social</a>
<div class="tagline">{esc(copy.TAGLINE)}</div>
</main>
<script>
if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) {{
  location.replace({app_store_js});
}}
</script>
</body></html>"""


def _poster_html() -> str:
    esc = html.escape
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Squirrel Poster</title>
<style>{_STYLE}
main {{ border:2px solid var(--ink); border-radius:24px; margin-top:32px; }}
.qr svg {{ width:280px; height:280px; }}
@media print {{ :root {{ --bg:#fff; --ink:#000; }} main {{ margin-top:0; }} }}
</style>
</head><body><main>
<div class="brand">SQUIRREL 🐿️</div>
<h1>Scan to join us</h1>
<div class="qr">{qr_svg(join_url())}</div>
<div class="tagline">{esc(copy.TAGLINE)}</div>
</main></body></html>"""
