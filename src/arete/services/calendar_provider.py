"""Bounded HTTP adapters: Google credentials from Clerk, the Calendar API.

No provider credentials are persisted or exposed to the model. A session reuses
one short-lived token only for the current operation, so disconnects/revocations
are checked on the next operation even across separate serverless instances.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from time import monotonic
from typing import TYPE_CHECKING
from urllib.parse import quote

from arete.services.calendar_models import (
    HTTP_TIMEOUT_SECONDS,
    MAX_OPERATION_SECONDS,
    MAX_RESPONSE_BYTES,
    MAX_RESPONSE_CHUNKS,
    SCOPES,
    CalendarError,
)
from arete.services.google_tokens import (
    GoogleToken,
    GoogleTokenUnavailable,
    google_access_token,
)

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger(__name__)

#: The token works but lacks the calendar scopes: the browser must ask Google.
SCOPES_MISSING = "Autorise l’accès à Google Calendar pour ce compte."


class CalendarHTTP:
    def __init__(self, client: httpx.Client, deadline: float):
        self.client = client
        self.deadline = deadline

    def request(self, method: str, url: str, *, write: bool = False, **kwargs) -> dict:
        import httpx  # here, not at module level: the API boot skips httpx

        remaining = self.deadline - monotonic()
        if remaining <= 0:
            raise CalendarError("Délai Calendar dépassé.", 504)
        try:
            with self.client.stream(
                method, url, timeout=min(HTTP_TIMEOUT_SECONDS, remaining), **kwargs
            ) as response:
                body = bytearray()
                for index, chunk in enumerate(response.iter_bytes()):
                    if (
                        index >= MAX_RESPONSE_CHUNKS
                        or len(body) + len(chunk) > MAX_RESPONSE_BYTES
                        or monotonic() > self.deadline
                    ):
                        raise CalendarError(
                            "Réponse Calendar hors limites.", 502, uncertain=write
                        )
                    body.extend(chunk)
                if response.status_code >= 400:
                    status = response.status_code
                    labels = {
                        401: "Connexion expirée : reconnecte Google Calendar.",
                        403: "Permission Google insuffisante.",
                        404: "Événement ou calendrier introuvable.",
                        409: "Conflit Calendar.",
                        410: "Événement déjà supprimé.",
                        412: "Événement modifié depuis la proposition : nouvelle validation nécessaire.",
                        429: "Quota Google Calendar atteint. Réessaie plus tard.",
                    }
                    raise CalendarError(
                        labels.get(status, "Service Calendar indisponible."),
                        status if status in labels else 502,
                        uncertain=write and status >= 500,
                    )
                if not body:
                    return {}
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError("object expected")
                return result
        except (httpx.HTTPError, ValueError) as exc:
            raise CalendarError(
                "Réponse du fournisseur indisponible ou invalide.", 502, uncertain=write
            ) from exc


class ClerkProvider:
    """Google credentials of one signed-in Arete account, held by Clerk.

    Clerk stores the refresh token of the Google account the user signed in
    with and hands out a fresh access token per operation. The calendar scopes
    are granted incrementally from the browser (Clerk's ``reauthorize``), so
    signing in never asks for the calendar.
    """

    def __init__(
        self,
        clerk_user_id: str,
        tokens: Callable[[str], GoogleToken] = google_access_token,
        *,
        transport: httpx.BaseTransport | None = None,
    ):
        self.clerk_user_id = clerk_user_id
        self.tokens = tokens
        self.transport = transport

    @contextmanager
    def session(self, deadline: float | None = None) -> Iterator[CalendarHTTP]:
        import httpx  # here, not at module level: the API boot skips httpx

        limit = min(deadline or float("inf"), monotonic() + MAX_OPERATION_SECONDS)
        with httpx.Client(
            transport=self.transport,
            follow_redirects=False,
            timeout=HTTP_TIMEOUT_SECONDS,
        ) as client:
            yield CalendarHTTP(client, limit)

    def _google_token(self) -> GoogleToken:
        try:
            return self.tokens(self.clerk_user_id)
        except GoogleTokenUnavailable as exc:
            # Provider detail can contain secrets: log it, show a fixed message.
            logger.warning("Google token unavailable: %s", exc)
            raise CalendarError(
                "Compte Google indisponible : reconnecte Google Calendar.", 409
            ) from exc

    def token(self, http: CalendarHTTP) -> str:
        if http.deadline <= monotonic():
            raise CalendarError("Délai Calendar dépassé.", 504)
        google = self._google_token()
        if not google.has_scopes(tuple(SCOPES)):
            raise CalendarError(SCOPES_MISSING, 409)
        return google.token

    def revoke(self, http: CalendarHTTP) -> None:
        """Withdraw the Google grant; the next sign-in asks basic scopes again."""
        token = self._google_token().token
        http.request(
            "POST",
            "https://oauth2.googleapis.com/revoke",
            write=True,
            data={"token": token},
        )


class GoogleCalendar:
    def __init__(self, http: CalendarHTTP, token: str):
        self.http, self.token = http, token

    def call(
        self, method: str, path: str, *, etag: str | None = None, **kwargs
    ) -> dict:
        headers = {"Authorization": f"Bearer {self.token}"}
        if etag:
            headers["If-Match"] = etag
        return self.http.request(
            method,
            "https://www.googleapis.com/calendar/v3/" + path,
            headers=headers,
            write=method in {"PATCH", "DELETE", "PUT"}
            or (method == "POST" and path != "freeBusy"),
            **kwargs,
        )

    @staticmethod
    def events_path(calendar_id: str, event_id: str | None = None) -> str:
        base = "calendars/" + quote(calendar_id, safe="") + "/events"
        return base + "/" + quote(event_id, safe="") if event_id else base
