"""Single entry point to Garmin Connect, built on ``garminconnect``.

Owns authentication (tokens on disk, optional MFA) and exposes the handful of
Garmin endpoints Arete needs. Everything else in ``arete.garmin`` goes through
this class, so swapping the underlying library again only touches this file.

Tokens live in one directory (``ARETE_GARMIN_TOKENS_DIR``, default
``data/garmin_tokens``) as ``garmin_tokens.json``.
"""

from __future__ import annotations

import io
import logging
import time
import zipfile
from datetime import date
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import parse_qsl, urlsplit

from garminconnect import Garmin, GarminConnectAuthenticationError

from arete.config import config
from arete.dataio import mirror
from arete.garmin import token_store

if TYPE_CHECKING:
    from arete.garmin.sync_budget import SyncBudget

logger = logging.getLogger(__name__)

TOKEN_FILE = "garmin_tokens.json"


def default_token_dir() -> Path:
    return config.garmin_tokens_dir


class GarminAuthError(RuntimeError):
    """No usable Garmin session (no tokens, expired, or login refused)."""


class GarminClient:
    """Authenticated access to Garmin Connect for one user."""

    MAX_PENDING_MFA = 128
    MFA_TTL_SECONDS = 600
    _pending_mfa: dict[Path, tuple[float, Garmin]] = {}
    _mfa_lock = Lock()

    def __init__(
        self,
        token_dir: str | Path | None = None,
        *,
        sync_budget: SyncBudget | None = None,
    ):
        self.token_dir = Path(token_dir) if token_dir else default_token_dir()
        self._api: Garmin | None = None
        self.sync_budget = sync_budget
        # Explicit directories support standalone CLI clients; application logins
        # use a durable continuation so the next request may land on any worker.
        self._durable_auth = token_dir is None

    # ------------------------------------------------------------------ auth
    @property
    def token_file(self) -> Path:
        return self.token_dir / TOKEN_FILE

    def has_tokens(self) -> bool:
        # Every token use starts here, and the SDK rewrites the file whenever it
        # refreshes the session, even during a GET: have the request flush it.
        mirror.mark_dirty()
        if self._durable_auth and config.is_remote_db:
            return token_store.hydrate(self.token_file)
        return self.token_file.exists()

    def connect(self) -> Garmin:
        """Return an authenticated API, restoring the saved session.

        Raises GarminAuthError when no valid session can be restored.
        """
        if self._api is not None:
            return self._api
        if not self.has_tokens():
            raise GarminAuthError(
                f"No Garmin tokens at {self.token_file}. Log in first "
                "(Settings > System, or scripts/garmin_login.py)."
            )
        api = Garmin(retry_attempts=0)
        if self.sync_budget is not None:
            # Load locally, then replace this client's transport only. The SDK's
            # normal transport refreshes/replays 401s outside our request budget.
            api.client.load(str(self.token_dir))
            api.client._run_request = self._sync_request
            api._load_social_profile = self._sync_load_profile
            self._api = api
            if api.client.di_refresh_token and api.client._token_expires_soon():
                # One proactive refresh is counted too; never replay a refused GET.
                api.client._http_post = self._sync_refresh_token
                api.client._refresh_di_token()
                api.client.dump(str(self.token_dir))
                if self._durable_auth and config.is_remote_db:
                    token_store.save(self.token_file)
            return api
        try:
            api.login(str(self.token_dir))
        except Exception as e:
            if isinstance(e, GarminConnectAuthenticationError):
                # Garmin refused the session (a network error or a rate limit
                # is not a refusal): the status then asks to reconnect.
                self._record_refusal()
            raise GarminAuthError(f"Garmin session could not be restored: {e}") from e
        self._api = api
        if token_store.needs_account(self.token_file):
            # Tokens saved before the account was recorded, or refused before:
            # this working session records whose account it opens.
            self._remember_account(api)
        return api

    def _sync_load_profile(self) -> None:
        """The SDK's lazy profile lookup normally retries three times."""
        from arete.garmin.sync_budget import SyncStopped

        assert self._api is not None and self.sync_budget is not None
        try:
            profile = self._api.client.connectapi("/userprofile-service/socialProfile")
            name = profile.get("displayName") if isinstance(profile, dict) else None
            if not isinstance(name, str) or not name.strip():
                raise ValueError("Profil Garmin sans identifiant utilisable.")
        except Exception as exc:
            self.sync_budget.stopped = (
                self.sync_budget.stopped
                or "Profil Garmin indisponible ; vérification interrompue."
            )
            raise SyncStopped(self.sync_budget.stopped) from exc
        self._api.display_name = name
        self._api.full_name = profile.get("fullName", "")
        profile_id = profile.get("profileId")
        self._api.profile_id = profile_id if isinstance(profile_id, int) else None

    def _sync_refresh_token(self, url: str, **kwargs: Any) -> Any:
        from arete.garmin.sync_budget import SyncRateLimited, SyncStopped

        assert self._api is not None and self.sync_budget is not None
        assert url == self._api.client._di_token_url
        kwargs["timeout"] = self.sync_budget.before_request()
        response = self._api.client._api_session.request(
            "POST", url, allow_redirects=False, **kwargs
        )
        if response.status_code == 429:
            self.sync_budget.rate_limited = True
            self.sync_budget.stopped = (
                "Garmin limite les requêtes. Nouvelle vérification dans 15 minutes."
            )
            raise SyncRateLimited(self.sync_budget.stopped)
        if not 200 <= response.status_code < 300:
            self.sync_budget.stopped = (
                "Renouvellement Garmin refusé ; reconnecte le compte."
            )
            raise SyncStopped(self.sync_budget.stopped)
        return response

    def _sync_request(self, method: str, path: str, **kwargs: Any) -> Any:
        from arete.garmin.sync_budget import SyncRateLimited, SyncStopped

        assert self.sync_budget is not None and self._api is not None
        assert method == "GET", "Sync transport is read-only"
        endpoint = urlsplit(path)
        assert not endpoint.scheme and not endpoint.netloc and ".." not in path
        budget = self.sync_budget
        timeout = budget.before_request()
        client = self._api.client
        headers = client.get_api_headers()
        headers.update(kwargs.pop("headers", {}))
        kwargs.pop("timeout", None)
        try:
            response = client._api_session.request(
                method,
                f"{client._connectapi}/{path.lstrip('/')}",
                headers=headers,
                timeout=timeout,
                allow_redirects=False,
                **kwargs,
            )
        except Exception as exc:
            budget.errors.append(type(exc).__name__)
            raise
        if response.status_code == 429:
            budget.rate_limited = True
            budget.stopped = (
                "Garmin limite les requêtes. Nouvelle vérification dans 15 minutes."
            )
            raise SyncRateLimited(budget.stopped)
        if response.status_code in {401, 403}:
            budget.stopped = (
                "Session Garmin refusée. Reconnecte Garmin dans les réglages."
            )
            self._record_refusal()
            raise SyncStopped(budget.stopped)
        if not 200 <= response.status_code < 300:
            budget.errors.append(f"Garmin HTTP {response.status_code}")
            raise ConnectionError(budget.errors[-1])
        return response

    def is_authenticated(self) -> bool:
        try:
            self.connect()
            return True
        except GarminAuthError:
            return False

    def login(self, email: str, password: str) -> str:
        """Start a login. Returns "ok" or "needs_mfa" (then call complete_mfa)."""
        api = Garmin(email, password, return_on_mfa=True, retry_attempts=0)
        status, _ = api.login()
        if status == "needs_mfa":
            if self._durable_auth:
                from arete.garmin import auth_state

                auth_state.save(api)
                return "needs_mfa"
            with self._mfa_lock:
                now = time.monotonic()
                stale = [
                    key
                    for key, (expires, _) in self._pending_mfa.items()
                    if expires < now
                ]
                for key in stale:
                    del self._pending_mfa[key]
                if len(self._pending_mfa) >= self.MAX_PENDING_MFA:
                    raise GarminAuthError("Too many pending Garmin logins.")
                self._pending_mfa[self.token_dir.resolve()] = (
                    now + self.MFA_TTL_SECONDS,
                    api,
                )
            return "needs_mfa"
        self._save(api)
        return "ok"

    def complete_mfa(self, code: str) -> None:
        if self._durable_auth:
            from arete.garmin import auth_state

            api = auth_state.consume()
            if api is None:
                raise GarminAuthError(
                    "La connexion MFA a expiré. Recommence la connexion Garmin."
                )
            api.resume_login({}, code)
            self._save(api)
            return
        with self._mfa_lock:
            pending = self._pending_mfa.pop(self.token_dir.resolve(), None)
        if pending is None or pending[0] < time.monotonic():
            raise GarminAuthError("No login waiting for an MFA code.")
        api = pending[1]
        api.resume_login({}, code)
        self._save(api)

    def _save(self, api: Garmin) -> None:
        mirror.mark_dirty()
        self.token_dir.mkdir(parents=True, exist_ok=True)
        api.client.dump(str(self.token_dir))
        if self.token_file.exists():
            self.token_file.chmod(0o600)  # session tokens: owner-only
        if self._durable_auth:
            from arete.garmin import auth_state

            auth_state.clear()
            if config.is_remote_db:
                token_store.save(self.token_file)
        self._remember_account(api)
        self._api = api
        logger.info("Garmin tokens saved to %s", self.token_file)

    def _remember_account(self, api: Garmin) -> None:
        """Record whose account the tokens open, for the status endpoint.

        The tokens are already saved: a failure here only costs the name.
        """
        # username is only known right after a credential login; fall back to
        # the profile name so the UI can still show who is connected.
        name = api.username or api.full_name or api.display_name
        try:
            token_store.save_account(
                self.token_file,
                name if isinstance(name, str) else None,
                remote=self._durable_auth and config.is_remote_db,
            )
        except Exception:
            logger.warning("Could not record the Garmin account", exc_info=True)

    def _record_refusal(self) -> None:
        try:
            token_store.refused(
                self.token_file, remote=self._durable_auth and config.is_remote_db
            )
        except Exception:
            logger.warning("Could not record the Garmin refusal", exc_info=True)

    def logout(self) -> None:
        mirror.mark_dirty()
        if self._durable_auth:
            from arete.garmin import auth_state

            auth_state.clear()
            if config.is_remote_db:
                token_store.delete(self.token_file)
        with self._mfa_lock:
            self._pending_mfa.pop(self.token_dir.resolve(), None)
        if self.token_file.exists():
            self.token_file.unlink()
        (self.token_dir / token_store.ACCOUNT_FILE).unlink(missing_ok=True)
        self._api = None
        logger.info("Garmin tokens removed from %s", self.token_dir)

    # ------------------------------------------------------------------ data
    def profile(self) -> dict[str, Any]:
        api = self.connect()
        return {
            "display_name": api.display_name,
            "full_name": api.full_name,
            # username is only known right after a credential login; fall back to the
            # profile name so the UI can still show who is connected
            "user_email": api.username or api.full_name or api.display_name,
        }

    def activities(self, start: date, end: date) -> list[dict[str, Any]]:
        """Activity summaries between two dates (inclusive), newest first."""
        return cast(
            list[dict[str, Any]],
            self.connect().get_activities_by_date(start.isoformat(), end.isoformat()),
        )

    def activity_page(self, offset: int, limit: int) -> list[dict[str, Any]]:
        """Fetch one history page; never let the SDK paginate the whole archive."""
        raw = self.connect().get_activities(start=offset, limit=limit)
        if not isinstance(raw, list) or len(raw) > limit:
            raise ValueError("Invalid Garmin activity page")
        if not all(isinstance(item, dict) for item in raw):
            raise ValueError("Invalid Garmin activity in page")
        return raw

    def download_fit(self, activity_id: int | str) -> bytes | None:
        """Original FIT bytes for an activity (Garmin ships them zipped)."""
        raw = bytes(
            self.connect().download_activity(
                str(activity_id), dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL
            )
        )
        if raw[:2] != b"PK":  # not a zip: assume it is already the FIT payload
            return raw
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for name in zf.namelist():
                if name.lower().endswith(".fit"):
                    return zf.read(name)
        logger.warning("No .fit member in download for activity %s", activity_id)
        return None

    def hrv(self, day: date) -> dict[str, Any] | None:
        return cast(dict[str, Any] | None, self.connect().get_hrv_data(day.isoformat()))

    def sleep(self, day: date) -> dict[str, Any] | None:
        return cast(
            dict[str, Any] | None, self.connect().get_sleep_data(day.isoformat())
        )

    def stress(self, day: date) -> dict[str, Any] | None:
        return cast(
            dict[str, Any] | None, self.connect().get_stress_data(day.isoformat())
        )

    def body_battery(self, day: date) -> list[dict[str, Any]]:
        return cast(
            list[dict[str, Any]], self.connect().get_body_battery(day.isoformat()) or []
        )

    def steps(self, day: date) -> list[dict[str, Any]]:
        d = day.isoformat()
        return cast(list[dict[str, Any]], self.connect().get_daily_steps(d, d) or [])

    def lactate_threshold(self) -> dict[str, Any] | None:
        """Latest running threshold Garmin measured: heart rate, speed, date."""
        raw = self.connect().get_lactate_threshold(latest=True)
        if not isinstance(raw, dict):
            return None
        return cast(dict[str, Any] | None, raw.get("speed_and_heart_rate") or None)

    def resting_hr(self, day: date) -> dict[str, Any] | None:
        return cast(dict[str, Any] | None, self.connect().get_rhr_day(day.isoformat()))

    def workout_request(
        self, method: str, path: str, *, timeout: float, payload: Any = None
    ) -> Any:
        """One HTTP request, including on auth failure; no hidden SDK replay.

        The pinned SDK's normal request method refreshes tokens and retries 401s.
        Load tokens locally and use its authenticated session/headers directly so
        the export service's 12-request budget also bounds actual HTTP requests.
        Refreshing an expired login stays an explicit account action.
        """
        if method not in {"GET", "POST", "PUT", "DELETE"}:
            raise AssertionError("Unsupported workout operation")
        if self._api is None:
            if not self.has_tokens():
                raise PermissionError(
                    "Connecte Garmin dans les réglages avant l’export."
                )
            api = Garmin(retry_attempts=0)
            api.client.load(
                str(self.token_dir)
            )  # Local file read, no profile requests.
            self._api = api
        client = self._api.client
        endpoint = urlsplit(path)
        assert (
            not endpoint.scheme
            and not endpoint.netloc
            and endpoint.path.startswith("/")
        )
        response = client._api_session.request(
            method,
            f"{client._connectapi}/{endpoint.path.lstrip('/')}",
            headers=client.get_api_headers(),
            params=dict(parse_qsl(endpoint.query)),
            timeout=timeout,
            allow_redirects=False,
            **({"json": payload} if payload is not None else {}),
        )
        if response.status_code == 404:
            raise LookupError("Objet Garmin introuvable (404).")
        if response.status_code in {401, 403}:
            raise PermissionError(
                "Session Garmin expirée ou refusée. Reconnecte le compte dans les réglages avant de reprendre."
            )
        if not 200 <= response.status_code < 300:
            raise RuntimeError(
                f"Garmin HTTP {response.status_code} ; aucune nouvelle tentative automatique."
            )
        return response.json() if response.content else {}

    def workout_devices(self) -> list[dict]:
        return cast(
            list[dict],
            self.workout_request(
                "GET", "/device-service/deviceregistration/devices", timeout=15.0
            ),
        )

    # Garmin's own training metrics (Training Readiness, status, predictions…)

    def training_readiness(self, day: date) -> dict[str, Any] | None:
        """The morning Training Readiness reading (after the wake-up reset)."""
        return cast(
            dict[str, Any] | None,
            self.connect().get_morning_training_readiness(day.isoformat()),
        )

    def training_status(self, day: date) -> dict[str, Any] | None:
        return cast(
            dict[str, Any] | None, self.connect().get_training_status(day.isoformat())
        )

    def max_metrics(self, day: date) -> Any:
        """VO2max estimates (a list of per-sport entries on most accounts)."""
        return self.connect().get_max_metrics(day.isoformat())

    def race_predictions(self) -> dict[str, Any] | None:
        """Latest 5K / 10K / half / marathon predictions, in seconds."""
        return cast(dict[str, Any] | None, self.connect().get_race_predictions())

    def endurance_score(self, day: date) -> dict[str, Any] | None:
        return cast(
            dict[str, Any] | None, self.connect().get_endurance_score(day.isoformat())
        )

    # Structured workouts: created in the library, then put on the calendar

    def upload_workout(self, payload: dict[str, Any]) -> dict[str, Any]:
        return cast(dict[str, Any], self.connect().upload_workout(payload))

    def schedule_workout(self, workout_id: str, day: date) -> dict[str, Any]:
        return cast(
            dict[str, Any], self.connect().schedule_workout(workout_id, day.isoformat())
        )

    def unschedule_workout(self, schedule_id: str) -> Any:
        return self.connect().unschedule_workout(schedule_id)

    def delete_workout(self, workout_id: str) -> Any:
        return self.connect().delete_workout(workout_id)

    def hill_score(self, day: date) -> dict[str, Any] | None:
        return cast(
            dict[str, Any] | None, self.connect().get_hill_score(day.isoformat())
        )
