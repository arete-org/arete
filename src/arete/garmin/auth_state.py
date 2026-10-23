"""Bounded JSON continuation for the pinned Garmin SDK's multi-request MFA.

Never pickle a live client or retain the password. Only the challenge cookies
and SDK MFA fields cross workers. Consume before contacting Garmin so an
ambiguous completion cannot be replayed automatically.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from garminconnect import Garmin

from arete.dataio.db import transaction

MFA_TTL_SECONDS = 600
MAX_MFA_BYTES = 128 * 1024
MAX_MFA_COOKIES = 128
FIELDS = (
    "_mfa_login_params",
    "_mfa_post_headers",
    "_mfa_service_url",
    "_mfa_flow",
    "_mfa_method",
)
DDL = """
CREATE TABLE IF NOT EXISTS app.garmin_login_challenges (
    id INTEGER PRIMARY KEY CHECK (id=1),
    payload VARCHAR NOT NULL,
    expires_at TIMESTAMP NOT NULL
);
"""


def serialize(api: Garmin) -> str:
    client: Any = api.client
    session = client._mfa_session
    cookies = getattr(session.cookies, "jar", session.cookies)
    cookie_rows = [
        {
            "name": c.name,
            "value": c.value,
            "domain": c.domain,
            "path": c.path,
            "secure": c.secure,
            "expires": c.expires,
        }
        for c in cookies
    ]
    if len(cookie_rows) > MAX_MFA_COOKIES:
        raise ValueError("Garmin MFA cookie limit exceeded")
    widget = getattr(client, "_widget_last_resp", None)
    payload = json.dumps(
        {
            "version": 1,
            "fields": {
                key: getattr(client, key) for key in FIELDS if hasattr(client, key)
            },
            "cookies": cookie_rows,
            "headers": dict(session.headers),
            "impersonate": getattr(session, "impersonate", None),
            "widget_html": widget.text if widget is not None else None,
        }
    )
    if len(payload.encode()) > MAX_MFA_BYTES:
        raise ValueError("Garmin MFA state limit exceeded")
    return payload


def restore(payload: str) -> Garmin:
    import requests
    from garminconnect import Garmin

    assert len(payload.encode()) <= MAX_MFA_BYTES
    state = json.loads(payload)
    assert state["version"] == 1 and state["fields"].keys() <= set(FIELDS)
    assert len(state["cookies"]) <= MAX_MFA_COOKIES
    session: Any
    if state["impersonate"]:
        from curl_cffi import requests as cffi_requests

        session = cffi_requests.Session(impersonate=state["impersonate"])
    else:
        session = requests.Session()
    session.headers.update(state["headers"])
    jar = getattr(session.cookies, "jar", session.cookies)
    for cookie in state["cookies"]:
        jar.set_cookie(requests.cookies.create_cookie(**cookie))
    api = Garmin(retry_attempts=0)
    client: Any = api.client
    for key, value in state["fields"].items():
        setattr(client, key, value)
    client._mfa_session = session
    client._mfa_pending = True
    if state["widget_html"] is not None:
        response = requests.Response()
        response.status_code = 200
        response._content = state["widget_html"].encode()
        response.encoding = "utf-8"
        client._widget_last_resp = response
    return api


def save(api: Garmin) -> None:
    payload = serialize(api)
    with transaction() as con:
        con.execute(
            "INSERT OR REPLACE INTO app.garmin_login_challenges(id,payload,expires_at) "
            "VALUES(1,?,current_timestamp + ? * INTERVAL '1 second') RETURNING id",
            [payload, MFA_TTL_SECONDS],
        )


def consume() -> Garmin | None:
    with transaction() as con:
        row = con.execute(
            "DELETE FROM app.garmin_login_challenges WHERE "
            "athlete_id=getvariable('arete_athlete_id') RETURNING payload,expires_at > current_timestamp"
        ).fetchone()
    return restore(row[0]) if row and row[1] else None


def clear() -> None:
    with transaction() as con:
        con.execute(
            "DELETE FROM app.garmin_login_challenges WHERE athlete_id=getvariable('arete_athlete_id')"
        )
