"""Identity at the HTTP boundary: who is calling, and whether they may.

Off by default (``ARETE_AUTH`` unset): the API is as open as a self-hosted
instance behind its own network. With ``ARETE_AUTH=clerk`` every request
except the public paths needs a Clerk session token (``Authorization:
Bearer``), or the long-lived ``ARETE_API_KEY`` that scripts and the MCP
server use. Each Clerk account owns a private athlete. The first verified
configured owner email keeps the original athlete; other accounts get empty
training data. The scope wraps the entire response, including SSE and workers.
Administration routes need an administrator (the owner is one by right);
naming administrators needs the owner. A resolved account is reused for
``ACCOUNT_TTL_SECONDS`` (30 s): a deactivation or role change applies at once
on the instance that made it and within that bound on every other instance.

Pure ASGI middleware, like the mirror's: the coach streams, and a
``BaseHTTPMiddleware`` would sit between the stream and the client. The Clerk
SDK and PyJWT are imported inside the verification so a cold boot does not pay
for them. With ``CLERK_JWT_KEY`` (the instance's PEM public key) a session token
is verified offline; without it the SDK fetches Clerk's JWKS on each new
instance and every five minutes. A key that does not load fails closed (503).
"""

from __future__ import annotations

import functools
import hmac
import logging
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta
from typing import Any

import anyio
import duckdb
from fastapi import APIRouter, HTTPException, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from arete.config import config
from arete.services import users as user_service
from arete.services.athlete_scope import athlete_scope
from arete.services.users import API_KEY_USER, OWNER_ATHLETE_ID, AppUser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

#: Reachable without a credential: the health probe, what the browser needs
#: before signing in, OAuth callbacks (their own state), the cron (its own
#: secret), Slack events (their own signature) and the API schema (no data in it).
PUBLIC_PATHS = frozenset(
    {
        "/health",
        "/auth/config",
        "/strava/callback",
        "/cron/daily-sync",
        "/cron/checkin",
        "/cron/evening",
        "/cron/automations",
        "/slack/events",
        "/openapi.json",
    }
)
PUBLIC_PREFIXES = ("/docs", "/redoc")
#: Where a signed-in account goes before it has an athlete.
ACCOUNT_PATHS = frozenset({"/auth/me"})

NO_ATHLETE_DETAIL = (
    "Aucun athlète n'est associé à ce compte. Demande l'accès au propriétaire "
    "de cette instance."
)


class AuthError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def auth_enabled() -> bool:
    return config.auth_provider == "clerk"


def auth_misconfigured() -> str | None:
    """Why the enforced mode cannot work; None when it can (or is off)."""
    if not auth_enabled():
        return None
    if not config.clerk_secret_key:
        return "CLERK_SECRET_KEY manquante"
    if not config.clerk_publishable_key:
        return "clé publique Clerk manquante"
    if config.clerk_jwt_key and not _jwt_key_is_usable(config.clerk_jwt_key):
        return "CLERK_JWT_KEY illisible (clé publique PEM RSA attendue)"
    return None


@functools.lru_cache(maxsize=4)
def _jwt_key_is_usable(pem: str) -> bool:
    """Whether the SDK can verify with this key, parsed as it will parse it.

    A key that does not load would turn every session into a 401 that looks
    like a sign-in problem: refuse it as a misconfiguration instead.
    """
    from jwt.algorithms import RSAAlgorithm
    from jwt.exceptions import InvalidKeyError

    try:
        # The SDK strips line breaks before handing the key to PyJWT.
        RSAAlgorithm(RSAAlgorithm.SHA256).prepare_key(re.sub(r"[\r\n]", "", pem))
    except (InvalidKeyError, ValueError, TypeError):
        return False
    return True


def is_public(path: str) -> bool:
    if path.startswith("/api/"):  # the deployment keeps the prefix in front
        path = path[4:]
    return path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)


def is_account_path(path: str) -> bool:
    if path.startswith("/api/"):
        path = path[4:]
    return path in ACCOUNT_PATHS


# ---------------------------------------------------------------- Clerk --
def _verify_session_token(token: str) -> dict[str, Any]:
    """Clerk session JWT → claims (signature, expiry, optional ``azp``)."""
    from clerk_backend_api.security import (
        TokenVerificationError,
        VerifyTokenOptions,
        verify_token,
    )

    # With the instance's public key the SDK verifies offline; without it,
    # it fetches Clerk's JWKS on each new instance and every five minutes.
    options = VerifyTokenOptions(
        secret_key=config.clerk_secret_key,
        jwt_key=config.clerk_jwt_key or None,
        authorized_parties=list(config.auth_origins) or None,
    )
    try:
        return verify_token(token, options)
    except TokenVerificationError as e:
        raise AuthError(401, "Session invalide ou expirée.") from e


def _fetch_clerk_profile(clerk_user_id: str) -> tuple[str, str | None, bool]:
    """(primary e-mail, display name) of a Clerk user, once per new account."""
    from clerk_backend_api import Clerk

    with Clerk(bearer_auth=config.clerk_secret_key) as clerk:
        user = clerk.users.get(user_id=clerk_user_id)
    addresses = {
        getattr(a, "id", None): getattr(a, "email_address", None)
        for a in (getattr(user, "email_addresses", None) or [])
    }
    email = addresses.get(getattr(user, "primary_email_address_id", None)) or next(
        (a for a in addresses.values() if a), None
    )
    if not email:
        raise AuthError(403, "Ce compte n'a pas d'adresse e-mail.")
    parts = (getattr(user, "first_name", None), getattr(user, "last_name", None))
    name = " ".join(p for p in parts if p) or None
    primary = next(
        (
            a
            for a in (getattr(user, "email_addresses", None) or [])
            if getattr(a, "email_address", None) == email
        ),
        None,
    )
    verified = (
        getattr(getattr(primary, "verification", None), "status", None) == "verified"
    )
    return str(email), name, verified


def resolve_user(authorization: str | None) -> AppUser:
    """The account behind a bearer credential; raises ``AuthError``."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthError(401, "Connexion requise.")
    token = authorization[7:].strip()
    if not token:
        raise AuthError(401, "Connexion requise.")
    key = config.api_key
    if key and hmac.compare_digest(token, key):
        if not user_service.athlete_is_active(OWNER_ATHLETE_ID):
            raise AuthError(403, "Cet athlète a été désactivé.")
        return API_KEY_USER
    claims = _verify_session_token(token)
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise AuthError(401, "Session invalide ou expirée.")
    user, athlete_active = _resolve_account(subject)
    if user.deleted_at is not None or (
        user.athlete_id is not None and not athlete_active
    ):
        raise AuthError(403, "Ce compte a été désactivé.")
    return user


# ------------------------------------------------------- account cache --
#: How long a resolved account is reused. A dashboard sends a dozen requests
#: at once, and each used to read the login and its athlete. This is also the
#: bound for revocation: a deactivation or role change made on another
#: instance is refused or applied here within this many seconds; on the
#: instance that made it, at once (``forget_accounts``). Keep it <= 60 s.
ACCOUNT_TTL_SECONDS = 30.0
#: Entries kept per instance; the least recently used goes first.
ACCOUNT_CACHE_SIZE = 256
_clock = time.monotonic
_accounts: OrderedDict[str, tuple[float, AppUser, bool]] = OrderedDict()
_accounts_lock = threading.Lock()
#: Bumped by ``forget_accounts`` so a read that started before an
#: administration change cannot store its now stale answer afterwards.
_accounts_generation = 0


def forget_accounts() -> None:
    """Drop every cached account, after an administration change here."""
    global _accounts_generation
    with _accounts_lock:
        _accounts.clear()
        _accounts_generation += 1


def _resolve_account(subject: str) -> tuple[AppUser, bool]:
    """(login, athlete is live) for a verified subject: cached, or one query.

    A new or stale profile is refreshed from Clerk first, then read back.
    """
    now = _clock()
    with _accounts_lock:
        entry = _accounts.get(subject)
        if entry is not None and now - entry[0] < ACCOUNT_TTL_SECONDS:
            _accounts.move_to_end(subject)
            return entry[1], entry[2]
        generation = _accounts_generation
    account = user_service.get_account(subject)
    if account is None or _profile_is_stale(account[0]):
        _refresh_profile(subject)
        account = user_service.get_account(subject)
        assert account is not None, "a refreshed account must exist"
    with _accounts_lock:
        if generation == _accounts_generation:
            # Timed from before the read: the TTL bounds the data's age.
            _accounts[subject] = (now, *account)
            _accounts.move_to_end(subject)
            while len(_accounts) > ACCOUNT_CACHE_SIZE:
                _accounts.popitem(last=False)
    return account


#: One profile refresh at a time per instance: a dashboard sends a dozen
#: requests at once, and each would fetch Clerk and rewrite the same row.
_refresh_lock = threading.Lock()


def _profile_is_stale(user: AppUser) -> bool:
    return user.profile_synced_at is None or (
        datetime.now() - user.profile_synced_at > timedelta(hours=1)
    )


def _refresh_profile(subject: str) -> AppUser:
    """Provision or refresh the account from Clerk, once for a burst.

    Another instance may write the same row at the same moment: its write wins
    and is read back, rather than answering 503 for a conflict.
    """
    with _refresh_lock:
        user = user_service.get_user(subject)
        if user is not None and not _profile_is_stale(user):
            return user
        email, name, verified = _fetch_clerk_profile(subject)
        try:
            return user_service.upsert_user(subject, email, name, verified=verified)
        except (duckdb.TransactionException, duckdb.ConstraintException):
            user = user_service.get_user(subject)
            if user is None:
                raise
            logger.info("Account %s was refreshed concurrently", user.id)
            return user


# ----------------------------------------------------------- middleware --
class AuthMiddleware:
    """Refuse every non-public request without a valid credential."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not auth_enabled():
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if is_public(path):
            await self.app(scope, receive, send)
            return
        problem = auth_misconfigured()
        if problem:
            logger.error("Authentication enabled but unusable: %s", problem)
            response = JSONResponse(
                {"detail": "Authentification mal configurée sur le serveur."},
                status_code=503,
            )
            await response(scope, receive, send)
            return
        authorization = Headers(scope=scope).get("authorization")
        try:
            # Token verification may fetch Clerk's keys (without CLERK_JWT_KEY),
            # and the account read is a database round trip: both leave the
            # event loop free.
            user = await anyio.to_thread.run_sync(resolve_user, authorization)
        except AuthError as e:
            headers = {"WWW-Authenticate": "Bearer"} if e.status == 401 else None
            response = JSONResponse(
                {"detail": e.detail}, status_code=e.status, headers=headers
            )
            await response(scope, receive, send)
            return
        except Exception:  # noqa: BLE001 - identity provider or database down
            logger.warning("Authentication failed unexpectedly", exc_info=True)
            response = JSONResponse(
                {"detail": "Service d'identité indisponible."}, status_code=503
            )
            await response(scope, receive, send)
            return
        if user.athlete_id is None and not is_account_path(path):
            response = JSONResponse({"detail": NO_ATHLETE_DETAIL}, status_code=403)
            await response(scope, receive, send)
            return
        scope.setdefault("state", {})["user"] = user
        if user.athlete_id is None:
            await self.app(scope, receive, send)
        else:
            with athlete_scope(user.athlete_id):
                await self.app(scope, receive, send)


# --------------------------------------------------------------- routes --
def current_user(request: Request) -> AppUser:
    """The signed-in account, or the implicit owner when auth is off."""
    user = getattr(request.state, "user", None)
    if isinstance(user, AppUser):
        return user
    if auth_enabled():
        raise HTTPException(status_code=401, detail="Connexion requise.")
    return AppUser(
        id=0, clerk_user_id="", email="", name=None, athlete_id=OWNER_ATHLETE_ID
    )


def require_admin(request: Request) -> AppUser:
    """An administrator, the owner included; anyone else is refused."""
    user = current_user(request)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs.")
    return user


def require_owner(request: Request) -> AppUser:
    """The owner of the instance (athlete 1), who alone names administrators."""
    user = current_user(request)
    if not user.is_owner:
        raise HTTPException(
            status_code=403, detail="Réservé au propriétaire de cette instance."
        )
    return user


def clerk_account(request: Request) -> str:
    """The caller's Clerk user id; empty for the API key or with auth off.

    Features that act on the person's own accounts at a provider (their
    Google calendar) need a real signed-in user, not the athlete's key.
    """
    user = current_user(request)
    if user.clerk_user_id == API_KEY_USER.clerk_user_id:
        return ""
    return user.clerk_user_id


@router.get("/config")
def auth_config() -> dict[str, Any]:
    """What the browser needs before signing in; public."""
    enabled = auth_enabled()
    return {
        "enabled": enabled,
        "publishable_key": config.clerk_publishable_key or None if enabled else None,
    }


@router.get("/me")
def me(request: Request) -> dict[str, Any]:
    """The signed-in account; reachable before an athlete is attached."""
    return current_user(request).to_dict()
