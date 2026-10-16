"""Sending email: the sign-up verification codes (auth/email_codes.py).

One transport, chosen by what is configured:

    SMTP_USER + SMTP_PASSWORD   SMTP with STARTTLS (port 587) or TLS (465). Gmail: SMTP_HOST
                                smtp.gmail.com (the default) and an app password
                                (Google Account → Security → 2-Step Verification → App passwords).
    RESEND_API_KEY              Resend's HTTPS API, for hosts that block outgoing SMTP ports
                                (Render's free plan does). EMAIL_FROM must be on a domain verified
                                with Resend.
    neither                     development: the message is written to the log instead.

EMAIL_FROM (or SMTP_FROM) is the sender; it defaults to SMTP_USER.
"""

from __future__ import annotations

import json
import logging
import os
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage

log = logging.getLogger(__name__)

_TIMEOUT_S = 15
_RESEND_URL = "https://api.resend.com/emails"


class EmailNotSent(Exception):
    pass


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def transport() -> str:
    """"smtp", "resend" or "log"."""
    if _env("SMTP_USER") and _env("SMTP_PASSWORD"):
        return "smtp"
    if _env("RESEND_API_KEY"):
        return "resend"
    return "log"


def _sender() -> str:
    return _env("EMAIL_FROM") or _env("SMTP_FROM") or _env("SMTP_USER") or "Squirrel Social <no-reply@localhost>"


def send_email(to: str, subject: str, text: str) -> None:
    """Send one plain-text email. Raises EmailNotSent when the configured transport fails."""
    kind = transport()
    if kind == "log":
        log.warning("email not configured (set SMTP_USER/SMTP_PASSWORD or RESEND_API_KEY); "
                    "would send to %s: %s\n%s", to, subject, text)
        return
    try:
        if kind == "smtp":
            _send_smtp(to, subject, text)
        else:
            _send_resend(to, subject, text)
    except (OSError, smtplib.SMTPException, urllib.error.URLError, ValueError) as exc:
        log.error("sending email via %s failed: %s", kind, exc)
        raise EmailNotSent(str(exc)) from exc


def _send_smtp(to: str, subject: str, text: str) -> None:
    message = EmailMessage()
    message["From"] = _sender()
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    host = _env("SMTP_HOST") or "smtp.gmail.com"
    port = int(_env("SMTP_PORT") or 587)
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=_TIMEOUT_S, context=context) as smtp:
            smtp.login(_env("SMTP_USER"), _env("SMTP_PASSWORD"))
            smtp.send_message(message)
        return
    with smtplib.SMTP(host, port, timeout=_TIMEOUT_S) as smtp:
        smtp.starttls(context=context)
        smtp.login(_env("SMTP_USER"), _env("SMTP_PASSWORD"))
        smtp.send_message(message)


def _send_resend(to: str, subject: str, text: str) -> None:
    body = json.dumps({"from": _sender(), "to": [to], "subject": subject, "text": text}).encode()
    request = urllib.request.Request(
        _RESEND_URL, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {_env('RESEND_API_KEY')}",
            "Content-Type": "application/json",
            # Cloudflare fronts Resend and blocks the default Python-urllib agent
            # from data-centre IPs with 403 / error code 1010. Any real UA passes.
            "User-Agent": "squirrel-exercise/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
            if response.status >= 300:
                raise ValueError(f"Resend answered {response.status}")
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Resend answered {exc.code}: {exc.read().decode()[:500]}") from exc