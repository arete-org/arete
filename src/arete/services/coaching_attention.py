"""Rank existing coaching work and reserve bounded delivery, without model calls.

Source rows own answers and approvals. A delivery receipt is never an answer.
DuckDB transactions, not worker locks, arbitrate overlapping scheduler workers.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Literal
from urllib.parse import parse_qs, urlsplit

import duckdb
from pydantic import Field, model_validator

from arete.dataio.db import db_connection, transaction
from arete.dataio.settings import get_user_settings
from arete.services.feature_flags import get_feature_flags
from arete.services.prescriptions import StrictModel
from arete.services.settings import stored_preferences, utc_now, zone_of

MAX_CANDIDATES = 100
MAX_VISIBLE_ITEMS = 3
ATTENTION_SECONDS = 5.0
AttentionKind = Literal["approval", "question", "recap"]
QuestionKind = Literal["perceived_effort", "availability", "missing_context"]


@dataclass(frozen=True)
class AttentionCandidate:
    source_ref: str
    subject_key: str
    kind: AttentionKind
    question_kind: QuestionKind | None
    source_revision: str
    occurred_at: datetime
    expires_at: datetime
    title: str
    url: str

    def __post_init__(self):
        assert self.occurred_at.tzinfo and self.expires_at.tzinfo, (
            "Attention times must be aware"
        )
        assert 0 < len(self.source_ref) <= 100 and 0 < len(self.subject_key) <= 200


def enabled(settings: dict | None = None) -> bool:
    settings = settings if settings is not None else (get_user_settings() or {})
    return (
        get_feature_flags().coaching_attention
        and stored_preferences(
            settings.get("notification_preferences")
        ).coordinated_coaching
    )


def _deadline(started: float) -> None:
    if monotonic() - started > ATTENTION_SECONDS:
        raise TimeoutError("La lecture des priorités a dépassé cinq secondes.")


def candidates(con, settings: dict, now: datetime) -> list[AttentionCandidate]:
    """Bounded source projection, with the missed-session owner's validity rule."""
    zone = zone_of(settings.get("timezone"))
    today = now.astimezone(zone).date()
    end = datetime.combine(
        today + timedelta(days=1), datetime.min.time(), zone
    ).astimezone(UTC)
    # The global LIMIT reads one excess record and fails visibly, rather than
    # hiding an older actionable approval behind a source-specific limit.
    found = con.execute(
        """
        WITH bounds AS (SELECT ?::DATE AS day, ?::TIMESTAMPTZ AS now, ?::TIMESTAMPTZ AS day_end),
        waiting AS (
          SELECT r.id,r.revision,r.definition_json,i.payload_json,i.tool_call_id,i.created_at,i.expires_at,
            row_number() OVER (PARTITION BY r.id ORDER BY i.expires_at,i.id) AS n
          FROM app.visible_automation_runs r JOIN app.visible_automation_interrupts i ON i.run_id=r.id
          WHERE r.state='waiting' AND i.decision_json IS NULL AND i.expires_at>(SELECT now FROM bounds)
        ), combined AS (
          SELECT 'proposal:'||d.id AS ref,
            'plan:'||d.planned_session_id||':revision:'||d.session_revision||':availability' AS subject,
            'approval' AS kind, NULL AS question_kind, d.revision::VARCHAR AS revision,
            d.created_at AT TIME ZONE 'UTC' AS occurred, b.day_end AS expires,
            'Adapter la séance du jour' AS title, '/follow-up?proposal='||d.id AS url
          FROM app.visible_plan_decisions d JOIN app.visible_planned_sessions s ON s.id=d.planned_session_id CROSS JOIN bounds b
          WHERE d.date=b.day AND d.state IN ('pending','discussion') AND (d.snoozed_until IS NULL OR d.snoozed_until<=b.day)
            AND d.session_revision=s.revision AND s.status IN ('pending','modified')
          UNION ALL
          SELECT 'followup:'||f.id,'session:'||f.session_id||':perceived_effort','question','perceived_effort',f.revision::VARCHAR,
            (f.expires_at AT TIME ZONE 'UTC') - INTERVAL 48 HOUR, f.expires_at AT TIME ZONE 'UTC',f.question,'/follow-up?followup='||f.id
          FROM app.visible_coach_followups f JOIN app.visible_actual_sessions s ON s.id=f.session_id CROSS JOIN bounds b
          WHERE f.state='pending' AND s.rpe IS NULL AND f.expires_at AT TIME ZONE 'UTC'>b.now AND (f.snoozed_until IS NULL OR f.snoozed_until<=b.day)
          UNION ALL
          SELECT 'plan_change_set:'||p.id,'plan_change_set:'||p.id,'approval',NULL,p.revision::VARCHAR,p.created_at,p.expires_at,
            'Ajuster le planning ensemble','/planning?change_set='||p.id
          FROM app.visible_plan_change_sets p CROSS JOIN bounds b WHERE p.state='pending' AND p.expires_at>b.now
            AND NOT EXISTS (SELECT 1 FROM json_each(p.items_json,'$.items') j LEFT JOIN app.visible_planned_sessions s ON s.id=CAST(json_extract(j.value,'$.session_id') AS INTEGER)
              WHERE s.id IS NULL OR s.revision<>CAST(json_extract(j.value,'$.revision') AS INTEGER) OR s.status NOT IN ('pending','modified') OR s.date<b.day)
          UNION ALL
          SELECT 'automation_run:'||w.id,
            CASE WHEN json_extract_string(payload_json,'$.name')='apply_plan_changes'
              THEN 'plan_change_set:'||coalesce(try_cast(json_extract_string(payload_json,'$.args.preview_id') AS UUID)::VARCHAR,'')
              ELSE coalesce(c.subject_key,'automation_run:'||w.id) END,
            CASE WHEN json_extract_string(payload_json,'$.name')='ask_athlete' THEN 'question' ELSE 'approval' END,
            CASE WHEN c.subject_key LIKE '%:availability' THEN 'availability' WHEN c.subject_key LIKE '%:missing_context' THEN 'missing_context' ELSE NULL END,w.revision::VARCHAR,w.created_at,w.expires_at,coalesce(json_extract_string(definition_json,'$.title'),'Suivi du coach'),'/follow-up?run='||w.id
          FROM waiting w LEFT JOIN app.visible_coach_attention_claims c ON c.source_ref='automation_run:'||w.id AND c.question_call_id=w.tool_call_id
          WHERE w.n=1 AND (c.subject_key IS NULL OR (c.state='open' AND c.expires_at>(SELECT now FROM bounds)
            AND (c.subject_key NOT LIKE 'plan:%' OR EXISTS (
              SELECT 1 FROM app.visible_planned_sessions s WHERE s.id=try_cast(split_part(c.subject_key,':',2) AS INTEGER)
                AND s.revision=try_cast(split_part(c.subject_key,':',4) AS INTEGER) AND s.status IN ('pending','modified')
            ))))
          UNION ALL
          SELECT 'evening:'||e.id,'evening:'||e.date||':availability','question','availability','1',e.created_at AT TIME ZONE 'UTC',
            CAST(e.date + INTERVAL 2 DAY AS TIMESTAMP) AT TIME ZONE ?, 'Préparer demain avec le coach','/follow-up?evening='||e.id
          FROM app.visible_coach_evening_messages e CROSS JOIN bounds b
          WHERE e.status='ok' AND e.answer IS NULL AND e.date BETWEEN b.day-1 AND b.day
          UNION ALL
          SELECT 'review:'||r.id,'week:'||r.week_start||':recap','recap',NULL,'1',r.created_at AT TIME ZONE 'UTC',
            CAST(r.week_start+INTERVAL 14 DAY AS TIMESTAMP) AT TIME ZONE ?, 'Relire le bilan de la semaine','/planning/semaine'
          FROM app.visible_weekly_reviews r CROSS JOIN bounds b WHERE r.week_start BETWEEN b.day-13 AND b.day-6
        ) SELECT * FROM combined ORDER BY occurred,ref LIMIT ?
        """,
        [today, now, end, str(zone), str(zone), MAX_CANDIDATES + 1],
    ).fetchall()
    if len(found) > MAX_CANDIDATES:
        raise ValueError(
            "Plus de 100 suivis actifs. Ferme des suivis avant de continuer."
        )
    selected = [AttentionCandidate(*row) for row in found]
    # A native approval and its immutable preview are the same decision. Keep
    # the routine's approval entry point only while the preview remains valid.
    change_sets = {
        item.subject_key: item
        for item in selected
        if item.source_ref.startswith("plan_change_set:")
    }
    reviewed = {
        item.subject_key
        for item in selected
        if item.source_ref.startswith("automation_run:")
        and item.subject_key in change_sets
    }
    coordinated = []
    for item in selected:
        if (
            item.source_ref.startswith("plan_change_set:")
            and item.subject_key in reviewed
        ):
            continue
        if item.source_ref.startswith(
            "automation_run:"
        ) and item.subject_key.startswith("plan_change_set:"):
            preview = change_sets.get(item.subject_key)
            if preview is None:
                continue
            item = replace(item, expires_at=min(item.expires_at, preview.expires_at))
        coordinated.append(item)
    selected = coordinated
    proposal_ids = [
        int(item.source_ref.split(":")[1])
        for item in selected
        if item.source_ref.startswith("proposal:")
    ]
    if proposal_ids:
        from arete.services.missed_sessions import trained_on
        from arete.services.plan_repository import MISSED_REPLAN

        missed = {
            f"proposal:{row[0]}"
            for row in con.execute(
                "SELECT id FROM app.visible_plan_decisions WHERE id IN (SELECT unnest(?)) AND readiness_source=?",
                [proposal_ids, MISSED_REPLAN],
            ).fetchall()
        }
        if missed and trained_on(con, today):
            selected = [item for item in selected if item.source_ref not in missed]
    return selected


def ranked(items: list[AttentionCandidate], now: datetime) -> list[AttentionCandidate]:
    assert len(items) <= MAX_CANDIDATES

    def order(item: AttentionCandidate):
        rank = (
            0
            if item.kind == "approval"
            else 1
            if item.question_kind == "availability"
            else 2
            if item.kind == "question"
            else 3
        )
        return (
            rank,
            item.expires_at if item.kind == "approval" else item.occurred_at,
            item.occurred_at,
            item.source_ref,
        )

    unique: dict[str, AttentionCandidate] = {}
    for item in sorted(items, key=order):
        if item.expires_at > now:
            unique.setdefault(item.subject_key, item)
    return list(unique.values())


def projection() -> dict:
    started = monotonic()
    settings = get_user_settings() or {}
    now = utc_now()
    with db_connection() as con:
        selected = ranked(candidates(con, settings, now), now)
    _deadline(started)
    active = enabled(settings)
    return {
        "enabled": active,
        "mode": "active" if active else "observation",
        "primary_ref": selected[0].source_ref if selected else None,
        "items": [
            {
                **asdict(item),
                "occurred_at": item.occurred_at.isoformat(),
                "expires_at": item.expires_at.isoformat(),
            }
            for item in selected[:MAX_VISIBLE_ITEMS]
        ],
        "remaining": max(0, len(selected) - MAX_VISIBLE_ITEMS),
    }


def _resolve(
    con,
    kind: str,
    event_key: str,
    url: str,
    reference: dict | None,
    settings: dict,
    now: datetime,
) -> AttentionCandidate | None:
    available = candidates(con, settings, now)
    source = f"{reference.get('kind')}:{reference.get('id')}" if reference else None
    # Old notification producers still supply authoritative URLs; arbitrary prose
    # is deliberately unclassified and cannot borrow another question's identity.
    query = parse_qs(urlsplit(url).query)
    if not source:
        for name in ("followup", "proposal", "evening", "review"):
            if query.get(name):
                source = f"{name}:{query[name][0]}"
                break
        if query.get("run"):
            source = f"automation_run:{query['run'][0]}"
    if source:
        found = next((item for item in available if item.source_ref == source), None)
        if found is not None:
            return found
        # Finished routine receipts are informative, never reopened questions.
        if source.startswith("automation_run:"):
            row = con.execute(
                "SELECT state FROM app.visible_automation_runs WHERE id=?",
                [source.split(":", 1)[1]],
            ).fetchone()
            if row is None or row[0] not in {"succeeded", "failed", "completed"}:
                return None
        elif not source.startswith("briefing:"):
            return None
    day = now.astimezone(zone_of(settings.get("timezone"))).date()
    subject = f"event:{kind}:{event_key}"
    if kind == "post_session" and urlsplit(url).path.startswith("/log/sessions/"):
        try:
            identifier = int(urlsplit(url).path.rsplit("/", 1)[1])
        except ValueError:
            return None
        row = con.execute(
            "SELECT rpe FROM app.visible_actual_sessions WHERE id=?", [identifier]
        ).fetchone()
        if row is None:
            return None
        subject = (
            f"session:{identifier}:perceived_effort"
            if row[0] is None
            else f"session:{identifier}:recap"
        )
        existing = next(
            (item for item in available if item.subject_key == subject), None
        )
        if existing is not None:
            return existing
        # A dismissed/snoozed follow-up must not be recreated by the post-session push.
        if con.execute(
            "SELECT 1 FROM app.visible_coach_followups WHERE session_id=?", [identifier]
        ).fetchone():
            return None
    elif kind == "checkin":
        row = con.execute(
            "SELECT answered_at FROM app.visible_daily_checkins WHERE date=?", [day]
        ).fetchone()
        if row and row[0]:
            return None
        subject = f"day:{day}:checkin"
    elif kind == "briefing":
        row = con.execute(
            "SELECT id FROM app.visible_coach_briefings WHERE date=? AND status='ok' ORDER BY id DESC LIMIT 1",
            [day],
        ).fetchone()
        if row is None:
            return None
        source, subject = f"briefing:{row[0]}", f"day:{day}:briefing"
    return AttentionCandidate(
        source or f"event:{event_key}",
        subject,
        "question" if kind in {"post_session", "checkin"} else "recap",
        None,
        "1",
        now,
        now + timedelta(days=1),
        "",
        url,
    )


def reserve(
    kind: str, event_key: str, url: str, reference: dict | None, settings: dict
) -> str | None:
    """None permits one delivery event. Unknown outcomes consume the reservation."""
    if kind == "imports" or not enabled(settings):
        return None
    started = monotonic()
    now = utc_now()
    prefs = stored_preferences(settings.get("notification_preferences"))
    day = now.astimezone(zone_of(settings.get("timezone"))).date()
    if prefs.daily_limit == 0:
        return "notifications proactives désactivées"
    try:
        with transaction() as con:
            candidate = _resolve(con, kind, event_key, url, reference, settings, now)
            if candidate is None:
                return "suivi clos, différé ou indisponible"
            active = ranked(candidates(con, settings, now), now)
            priority = next((item for item in active if item.kind == "approval"), None)
            if priority and candidate.kind != "approval":
                # Keep inbox content; don't spend a scarce push while an approval waits.
                return "une décision attend déjà ton attention"
            prior = con.execute(
                "SELECT claimed_at FROM app.visible_coach_attention_claims WHERE subject_key=?",
                [candidate.subject_key],
            ).fetchone()
            if prior and prior[0] is not None:
                return "ce sujet a déjà été annoncé"
            con.execute(
                "INSERT INTO app.coach_attention_days (local_date,created_at) VALUES (?,?) ON CONFLICT DO NOTHING",
                [day, now],
            )
            counted = con.execute(
                "UPDATE app.coach_attention_days SET attempts=attempts+1 WHERE athlete_id=getvariable('arete_athlete_id') AND deleted_at IS NULL AND local_date=? AND attempts<? RETURNING attempts",
                [day, prefs.daily_limit],
            ).fetchone()
            if counted is None:
                return "plafond quotidien de coaching atteint"
            con.execute(
                "INSERT INTO app.coach_attention_claims (subject_key,source_ref,source_revision,kind,state,expires_at,claimed_at,created_at) VALUES (?,?,?,?,'claimed',?,?,?) ON CONFLICT (athlete_id,subject_key) DO UPDATE SET claimed_at=excluded.claimed_at RETURNING subject_key",
                [
                    candidate.subject_key,
                    candidate.source_ref,
                    candidate.source_revision,
                    candidate.kind,
                    candidate.expires_at,
                    now,
                    now,
                ],
            )
            _deadline(started)
    except (duckdb.ConstraintException, duckdb.TransactionException):
        return "envoi déjà réservé par un autre traitement"
    return None


def pending_effort() -> AttentionCandidate | None:
    settings = get_user_settings() or {}
    if not enabled(settings):
        return None
    now = utc_now()
    with db_connection() as con:
        return next(
            (
                item
                for item in ranked(candidates(con, settings, now), now)
                if item.question_kind == "perceived_effort"
            ),
            None,
        )


class QuestionSubject(StrictModel):
    kind: QuestionKind
    source: Literal["session", "plan"]
    id: int = Field(gt=0)
    revision: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def shape(self):
        if self.source == "plan" and self.revision is None:
            raise ValueError("La révision du planning est requise.")
        if self.kind == "perceived_effort" and self.source != "session":
            raise ValueError("Un ressenti porte sur une séance réalisée.")
        return self


def _coordinate_question(run_id: str, call_id: str, raw: dict) -> dict | None:
    """Before native HITL: reuse an owned question or reserve its exact subject.

    Returning None lets the native human interrupt ask the question. A returned
    reference/answer substitutes the duplicate tool call, without another model.
    Unclassified free text never enters this contract.
    """
    from arete.services import coach_followup
    from arete.services.automations import Conflict, _get

    subject = QuestionSubject.model_validate(raw)
    now = utc_now()
    with transaction() as con:
        run = _get(con, "automation_runs", run_id)
        if run["state"] != "running":
            raise Conflict("La mission n’est plus en cours.")
        if subject.source == "session":
            row = con.execute(
                "SELECT rpe,source FROM app.visible_actual_sessions WHERE id=?",
                [subject.id],
            ).fetchone()
            if row is None or row[1] == "strava":
                raise ValueError("Séance indisponible pour ce suivi.")
            canonical = f"session:{subject.id}:{subject.kind}"
            if subject.kind == "perceived_effort":
                if row[0] is not None:
                    return {
                        "state": "answered",
                        "rpe": row[0],
                        "subject_key": canonical,
                    }
                # coach_followup owns the single RPE question and its answer.
                followup = coach_followup.request_session(subject.id, con=con)
                return {
                    "state": followup["state"],
                    "subject_key": canonical,
                    "reference": f"followup:{followup['id']}",
                    "url": f"/follow-up?followup={followup['id']}",
                    "instruction": "Le ressenti se répond dans ce suivi. Ne pose pas une seconde question et ne déduis pas un RPE.",
                }
        else:
            row = con.execute(
                "SELECT revision,status FROM app.visible_planned_sessions WHERE id=?",
                [subject.id],
            ).fetchone()
            if (
                row is None
                or row[0] != subject.revision
                or row[1] not in {"pending", "modified"}
            ):
                raise ValueError(
                    "Le planning a changé ; relis la séance avant de poser cette question."
                )
            canonical = f"plan:{subject.id}:revision:{subject.revision}:{subject.kind}"
            if subject.kind == "availability":
                # Only a classified, explicit answer for one exact session can
                # be reused. Another day/revision or ambiguous multi-session
                # reply remains a separate question.
                answered = con.execute(
                    "SELECT e.id,e.answer FROM app.visible_automation_runs r "
                    "JOIN app.visible_coach_evening_messages e ON e.id=try_cast(json_extract_string(r.definition_json,'$.source.id') AS INTEGER) "
                    "WHERE json_extract_string(r.definition_json,'$.source.kind')='evening' "
                    "AND json_extract_string(r.definition_json,'$.decision.availability')='true' "
                    "AND json_array_length(r.definition_json,'$.source.sessions')=1 "
                    "AND try_cast(json_extract_string(r.definition_json,'$.source.sessions[0].id') AS INTEGER)=? "
                    "AND try_cast(json_extract_string(r.definition_json,'$.source.sessions[0].revision') AS INTEGER)=? "
                    "AND e.answer=json_extract_string(r.definition_json,'$.source.answer') "
                    "ORDER BY r.created_at DESC LIMIT 1",
                    [subject.id, subject.revision],
                ).fetchone()
                if answered:
                    return {
                        "state": "answered",
                        "answer": answered[1],
                        "subject_key": canonical,
                        "reference": f"evening:{answered[0]}",
                        "url": f"/follow-up?evening={answered[0]}",
                        "instruction": "Disponibilité déjà déclarée pour cette séance. Réutilise cette réponse sans reposer la question.",
                    }
        source_ref = f"automation_run:{run_id}"
        prior = con.execute(
            "SELECT source_ref,question_call_id,expires_at FROM app.visible_coach_attention_claims WHERE subject_key=?",
            [canonical],
        ).fetchone()
        if prior:
            if prior[0] == source_ref and prior[1] == call_id and prior[2] > now:
                return None
            kind, identifier = prior[0].split(":", 1)
            assert kind in {"automation_run", "proposal"}, (
                "Unexpected owner for a typed question"
            )
            state = "existing" if prior[2] > now else "closed"
            answer = None
            if kind == "automation_run":
                owner = con.execute(
                    "SELECT r.state,i.decision_json FROM app.visible_automation_runs r LEFT JOIN app.visible_automation_interrupts i ON i.run_id=r.id AND i.tool_call_id=? WHERE r.id=? LIMIT 1",
                    [prior[1], identifier],
                ).fetchone()
                if owner is None or owner[0] in {
                    "failed",
                    "cancelled",
                    "expired",
                    "completed",
                }:
                    state = "closed"
                if owner and owner[1]:
                    decision = json.loads(owner[1])
                    if decision.get("type") == "respond":
                        state, answer = "answered", decision["message"]
            return {
                "state": state,
                "answer": answer,
                "subject_key": canonical,
                "reference": prior[0],
                "url": f"/follow-up?{'run' if kind == 'automation_run' else 'proposal'}={identifier}",
                "instruction": "Ce sujet a déjà son suivi. Consulte-le sans poser une seconde question.",
            }
        con.execute(
            "INSERT INTO app.coach_attention_claims (subject_key,source_ref,source_revision,question_call_id,kind,state,expires_at,created_at) VALUES (?,?,?,?,'question','open',?,?)",
            [
                canonical,
                source_ref,
                str(run["revision"]),
                call_id,
                now + timedelta(hours=48),
                now,
            ],
        )
    return None


def coordinate_question(run_id: str, call_id: str, raw: dict) -> dict | None:
    try:
        return _coordinate_question(run_id, call_id, raw)
    except (duckdb.ConstraintException, duckdb.TransactionException) as exc:
        raise ValueError(
            "Un autre suivi vient de réserver ce sujet. Consulte les suivis existants sans répéter la question."
        ) from exc
