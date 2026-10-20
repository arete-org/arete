"""Consent to the terms, the privacy policy and the processing of health data.

Arete processes special-category data (HRV, sleep, resting heart rate,
stress: GDPR article 9), which needs the athlete's explicit consent before
anything is imported, stored or sent to a model.

Consent belongs to the **athlete**, recorded with the **login** that gave it.
The data and every job (daily sync, briefing, evening message, automations,
the coach) are per athlete, and an athlete's logins are one person (a second
login is attached deliberately, ``docs/multi-athlete.md``): one withdrawal
must stop everything that reads that athlete's data, whichever login gave it.

``app.athlete_consents`` is append-only history, kept as proof of consent
(article 7(1)): each acceptance adds a row, a withdrawal stamps the rows in
force. Consent is current when a row in force carries both current text
versions; publishing a new version (``TERMS_VERSION``/``PRIVACY_VERSION``)
asks everyone again. Nothing is deleted on withdrawal: processing stops until
the athlete consents again.

Required with sign-in on (``ARETE_AUTH=clerk``), and for every processing
step (jobs, automations, Slack) on a MotherDuck database even without it: a
Docker stack without sign-in shares production's database, and its workers
must honour a withdrawal made there. Only a local file without accounts is
the athlete's own installation, with no third party to consent to. Timestamps are naive UTC, written from this clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from arete.config import config
from arete.dataio.db import db_connection, write_idempotent

#: The published texts' versions (``frontend/src/legal/*.md`` carry them in
#: their header; ``tests/test_consent.py`` keeps them aligned). A new version
#: asks every athlete again before any further processing.
TERMS_VERSION = "2026-10-draft-1"
PRIVACY_VERSION = "2026-10-draft-1"

#: Every refusal of processing says this, at the API and in Slack.
CONSENT_REQUIRED_DETAIL = (
    "Accepte les conditions d'utilisation, la politique de confidentialité et le "
    "traitement de tes données de santé pour utiliser Arete."
)


class ConsentError(Exception):
    """The consent cannot be recorded as asked; ``status`` is its HTTP answer."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Consent:
    """One recorded consent, in force or withdrawn."""

    terms_version: str
    privacy_version: str
    health_data: bool
    consented_at: datetime
    withdrawn_at: datetime | None

    def to_dict(self) -> dict:
        def utc(value: datetime | None) -> datetime | None:
            return value.replace(tzinfo=UTC) if value is not None else None

        return {
            "terms_version": self.terms_version,
            "privacy_version": self.privacy_version,
            "health_data": self.health_data,
            "consented_at": utc(self.consented_at),
            "withdrawn_at": utc(self.withdrawn_at),
        }


def required() -> bool:
    """Whether processing needs consent: with sign-in on, or on a shared
    MotherDuck database (a stack without sign-in may run beside production)."""
    return config.auth_provider == "clerk" or config.is_remote_db


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


#: The one definition of a consent row ``c`` that allows processing: in force,
#: with the health-data consent, to the texts this server publishes. Any such
#: row counts, whatever was recorded after it: a rollback to older texts finds
#: the consent given to them still in force. Every reader uses it: the
#: middleware, ``/auth/me``, the scheduler and the automation dispatch. An
#: erased athlete's rows stay as proof (``account_deletion.KEPT_TABLES``) but
#: allow nothing: another instance may still hold its login for a moment.
_IN_FORCE = (
    "c.withdrawn_at IS NULL AND c.health_data "
    "AND c.terms_version = ? AND c.privacy_version = ? "
    "AND EXISTS (SELECT 1 FROM app.athletes ca WHERE ca.id = c.athlete_id)"
)


def _in_force_params() -> list:
    return [TERMS_VERSION, PRIVACY_VERSION]


def _shown(athlete_id: int) -> tuple[bool, Consent | None]:
    """(current, the consent to show) in one query.

    The consent shown is the one in force when there is one, else the last
    recorded: by id, one sequence, never by the writing instance's clock.
    """
    with db_connection() as con:
        row = con.execute(
            "SELECT c.terms_version, c.privacy_version, c.health_data, "
            f"c.consented_at, c.withdrawn_at, ({_IN_FORCE}) AS in_force "
            "FROM app.athlete_consents c WHERE c.athlete_id = ? "
            "ORDER BY in_force DESC, c.id DESC LIMIT 1",
            [*_in_force_params(), athlete_id],
        ).fetchone()
    if row is None:
        return False, None
    return bool(row[5]), Consent(*row[:5])


def latest(athlete_id: int) -> Consent | None:
    """The consent in force, else the last recorded; None if never given."""
    return _shown(athlete_id)[1]


def is_current(athlete_id: int) -> bool:
    """Whether a consent to the current texts is in force (one query)."""
    sql, params = in_force_sql("?")
    with db_connection() as con:
        row = con.execute(f"SELECT {sql}", [athlete_id, *params]).fetchone()
    return bool(row and row[0])


def allows_processing(athlete_id: int) -> bool:
    """Whether the athlete's data may be imported, processed or sent to a model."""
    return not required() or is_current(athlete_id)


def in_force_sql(athlete: str) -> tuple[str, list]:
    """A SQL predicate: the athlete (an expression) has current consent.

    For the scheduler's trusted queries; ``processing_sql`` adds the case
    where no consent is required. Qualify a column (``a.id``): a bare ``id``
    would name the consent row's own.
    """
    return (
        "EXISTS (SELECT 1 FROM app.athlete_consents c "
        f"WHERE c.athlete_id = {athlete} AND {_IN_FORCE})",
        _in_force_params(),
    )


def in_force_since_sql(athlete: str) -> tuple[str, list]:
    """A SQL expression: when the consent in force for the athlete was given
    (naive UTC), NULL without one. What it allows starts there: an activity
    registered before it never triggers a job afterwards."""
    return (
        "(SELECT max(c.consented_at) FROM app.athlete_consents c "
        f"WHERE c.athlete_id = {athlete} AND {_IN_FORCE})",
        _in_force_params(),
    )


def processing_sql(athlete: str) -> tuple[str, list]:
    """A SQL predicate: the athlete's data may be processed by a job."""
    sql, params = in_force_sql(athlete)
    return f"(NOT ? OR {sql})", [required(), *params]


def processing_of(athlete_id: int) -> tuple[str, list]:
    """``processing_sql`` for one known athlete, bound: for a statement that
    must not act once consent is withdrawn (the scheduler's claim)."""
    return (
        "(NOT ? OR EXISTS (SELECT 1 FROM app.athlete_consents c "
        f"WHERE c.athlete_id = ? AND {_IN_FORCE}))",
        [required(), athlete_id, *_in_force_params()],
    )


def give(
    athlete_id: int,
    user_id: int | None,
    *,
    terms_version: str,
    privacy_version: str,
    terms_accepted: bool,
    health_data: bool,
) -> Consent:
    """Record the athlete's acceptance of the texts they were shown.

    Refused for texts that are not the current ones (the page is older than
    the server), and without both explicit agreements: Arete cannot work
    without processing health data.
    """
    if terms_version != TERMS_VERSION or privacy_version != PRIVACY_VERSION:
        raise ConsentError(
            "Les textes ont changé depuis l'ouverture de la page : recharge-la "
            "pour lire la nouvelle version."
        )
    if not terms_accepted:
        raise ConsentError(
            "Accepte les conditions d'utilisation et la politique de "
            "confidentialité pour utiliser Arete.",
            422,
        )
    if not health_data:
        raise ConsentError(
            "Le consentement explicite au traitement des données de santé est "
            "nécessaire pour utiliser Arete.",
            422,
        )
    with db_connection() as con:
        row = con.execute(
            "INSERT INTO app.athlete_consents (athlete_id, user_id, terms_version, "
            "privacy_version, health_data, consented_at) VALUES (?, ?, ?, ?, ?, ?) "
            "RETURNING terms_version, privacy_version, health_data, consented_at, "
            "withdrawn_at",
            [athlete_id, user_id, terms_version, privacy_version, True, _now()],
        ).fetchone()
    assert row is not None
    return Consent(*row)


def withdraw(athlete_id: int, user_id: int | None) -> None:
    """Withdraw every consent in force, recording the login that did; the
    data stays, its processing stops. Safe to rerun on a write conflict: it
    only stamps the rows still in force."""
    write_idempotent(
        "UPDATE app.athlete_consents SET withdrawn_at = ?, withdrawn_by = ? "
        "WHERE athlete_id = ? AND withdrawn_at IS NULL RETURNING id",
        [_now(), user_id, athlete_id],
    )


def state(athlete_id: int | None) -> dict:
    """What ``/auth/me`` reports: whether consent is required, current (the
    same predicate as every other reader), and the texts' versions to accept."""
    current, consent = _shown(athlete_id) if athlete_id is not None else (False, None)
    return {
        "required": required(),
        "current": current,
        "terms_version": TERMS_VERSION,
        "privacy_version": PRIVACY_VERSION,
        "latest": consent.to_dict() if consent is not None else None,
    }
