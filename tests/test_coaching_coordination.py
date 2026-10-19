"""Atomic planning and cross-producer attention, using a disposable athlete."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import uuid4

import pytest

from arete.dataio.db import db_connection
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import coaching_attention as attention
from arete.services import planning
from arete.services.athlete_scope import athlete_scope
from arete.services.feature_flags import (
    FeatureFlags,
    get_feature_flags,
    set_feature_flags,
)

NOW = datetime(2026, 10, 18, 12, tzinfo=UTC)
PREFS = {
    "timezone": "Europe/Paris",
    "notification_preferences": {
        "coordinated_coaching": True,
        "daily_limit": 2,
        "quiet_hours": None,
    },
}


@pytest.fixture
def athlete(monkeypatch):
    original = get_feature_flags()
    set_feature_flags(FeatureFlags(coaching_attention=True))
    with db_connection() as con:
        identifier = con.execute("SELECT nextval('app.athletes_seq')").fetchone()[0]
        con.execute("INSERT INTO app.athletes(id) VALUES (?)", [identifier])
    monkeypatch.setattr(attention, "utc_now", lambda: NOW)
    monkeypatch.setattr(attention, "get_user_settings", lambda: PREFS)
    monkeypatch.setattr(planning, "utc_now", lambda: NOW)
    monkeypatch.setattr(planning, "athlete_today", lambda: NOW.date())
    with athlete_scope(identifier):
        yield identifier
    set_feature_flags(FeatureFlags(**original.model_dump()))


def sessions(count=2):
    repo = GarminRepository()
    return [
        repo.create_planned_session(
            PlannedSession(
                date=NOW.date() + timedelta(days=i + 1),
                session_type=SessionType.ENDURANCE,
                target_duration_min=40,
            )
        )
        for i in range(count)
    ]


def proposal(ids):
    return planning.PlanChangeSet(
        items=[
            planning.PlanChangeItem(
                session_id=identifier,
                revision=1,
                changes=planning.SessionChanges(
                    date_str=NOW.date() + timedelta(days=3 + i)
                ),
            )
            for i, identifier in enumerate(ids)
        ]
    )


def actual():
    with db_connection() as con:
        return con.execute(
            "INSERT INTO app.actual_sessions (date,sport,source,duration_sec) VALUES (?,'running','garmin_connect',6000) RETURNING id",
            [NOW.date()],
        ).fetchone()[0]


def followup(session_id):
    with db_connection() as con:
        return con.execute(
            "INSERT INTO app.coach_followups (session_id,requested_on,question,expires_at) VALUES (?,?,'Quel ressenti ?',?) RETURNING id",
            [session_id, NOW.date(), (NOW + timedelta(hours=24)).replace(tzinfo=None)],
        ).fetchone()[0]


def test_preview_apply_is_atomic_and_acknowledgement_replay_returns_receipt(athlete):
    ids = sessions()
    preview = planning.preview_plan_changes(proposal(ids))
    repo = GarminRepository()
    assert [repo.get_planned_session(i).revision for i in ids] == [1, 1]
    assert preview["before"][0]["date"] != preview["after"][0]["date"]
    operation = str(uuid4())
    first = planning.apply_plan_changes(preview["id"], 1, operation)
    assert planning.apply_plan_changes(preview["id"], 1, operation) == first
    assert [repo.get_planned_session(i).revision for i in ids] == [2, 2]
    assert planning.get_plan_changes(preview["id"])["state"] == "applied"
    with pytest.raises(ValueError, match="autre opération"):
        planning.apply_plan_changes(preview["id"], 1, str(uuid4()))
    with athlete_scope(1), pytest.raises(LookupError):
        planning.get_plan_changes(preview["id"])


def test_stale_second_session_never_changes_first(athlete):
    ids = sessions()
    preview = planning.preview_plan_changes(proposal(ids))
    repo = GarminRepository()
    repo.update_planned_session_fields(ids[1], description="Changed elsewhere")
    with pytest.raises(ValueError, match="changé"):
        planning.apply_plan_changes(preview["id"], 1, preview["id"])
    assert repo.get_planned_session(ids[0]).revision == 1
    assert planning.get_plan_changes(preview["id"])["state"] == "pending"
    assert not attention.projection()["items"]  # Stale proposals don't compete.


def test_rollback_on_late_repository_failure_and_no_remote_retry(athlete, monkeypatch):
    ids = sessions()
    preview = planning.preview_plan_changes(proposal(ids))
    original = GarminRepository.update_planned_session_fields

    def fail_second(self, session_id, **kwargs):
        if session_id == ids[1]:
            raise ValueError("Garmin reservation changed")
        return original(self, session_id, **kwargs)

    monkeypatch.setattr(GarminRepository, "update_planned_session_fields", fail_second)
    with pytest.raises(ValueError, match="Garmin"):
        planning.apply_plan_changes(preview["id"], 1, preview["id"])
    assert GarminRepository().get_planned_session(ids[0]).revision == 1
    assert planning.get_plan_changes(preview["id"])["receipt"] is None


def test_preview_bounds_expiry_foreign_duplicate_and_finished(athlete, monkeypatch):
    ids = sessions()
    item = proposal(ids[:1]).items[0]
    with pytest.raises(ValueError):
        planning.PlanChangeSet(items=[item, item])
    with pytest.raises(ValueError):
        planning.PlanChangeSet(items=[item] * 8)
    preview = planning.preview_plan_changes(proposal(ids))
    monkeypatch.setattr(planning, "utc_now", lambda: NOW + timedelta(hours=49))
    with pytest.raises(ValueError, match="disponible"):
        planning.apply_plan_changes(preview["id"], 1, preview["id"])
    with athlete_scope(1), pytest.raises(ValueError):
        planning.preview_plan_changes(proposal(ids))


def test_competing_apply_commits_once(athlete):
    ids = sessions()
    preview = planning.preview_plan_changes(proposal(ids))
    barrier = Barrier(2, timeout=5)

    def apply():
        with athlete_scope(athlete):
            barrier.wait()
            try:
                return planning.apply_plan_changes(preview["id"], 1, preview["id"])
            except ValueError:
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: apply(), range(2)))
    assert any(outcomes)
    assert [GarminRepository().get_planned_session(i).revision for i in ids] == [2, 2]


def test_shared_subject_delivery_claim_not_notification_read_state(athlete):
    session = actual()
    ref = followup(session)
    url = f"/log/sessions/{session}?rpe=1"
    assert attention.reserve("post_session", "first", url, None, PREFS) is None
    assert "déjà" in attention.reserve(
        "automation",
        "second",
        f"/follow-up?followup={ref}",
        {"kind": "followup", "id": ref},
        PREFS,
    )
    item = attention.projection()["items"][0]
    assert item["subject_key"] == f"session:{session}:perceived_effort"
    with db_connection() as con:
        con.execute("UPDATE app.actual_sessions SET rpe=6 WHERE id=?", [session])
    assert attention.projection()["items"] == []
    assert "clos" in attention.reserve(
        "post_session",
        "third",
        f"/follow-up?followup={ref}",
        {"kind": "followup", "id": ref},
        PREFS,
    )


def test_daily_cap_is_atomic_under_overlapping_workers_and_local_date(
    athlete, monkeypatch
):
    barrier = Barrier(2, timeout=5)
    one = {
        **PREFS,
        "notification_preferences": {
            **PREFS["notification_preferences"],
            "daily_limit": 1,
        },
    }

    def reserve(index):
        with athlete_scope(athlete):
            barrier.wait()
            return attention.reserve(
                "automation", f"event-{index}", "/follow-up", None, one
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(reserve, range(2)))
    assert outcomes.count(None) == 1
    with db_connection() as con:
        assert (
            con.execute(
                "SELECT attempts FROM app.visible_coach_attention_days"
            ).fetchone()[0]
            == 1
        )
    # Paris's following day starts before UTC midnight, including the DST change.
    monkeypatch.setattr(
        attention, "utc_now", lambda: datetime(2026, 10, 18, 22, 30, tzinfo=UTC)
    )
    assert attention.reserve("automation", "next-day", "/follow-up", None, one) is None


def test_approval_priority_bounds_and_observation_are_explicit(athlete):
    preview = planning.preview_plan_changes(proposal(sessions()))
    ref = followup(actual())
    selected = attention.projection()
    assert selected["primary_ref"] == f"plan_change_set:{preview['id']}"
    assert "décision" in attention.reserve(
        "post_session", "effort", f"/follow-up?followup={ref}", None, PREFS
    )
    set_feature_flags(FeatureFlags(coaching_attention=False))
    assert attention.projection()["mode"] == "observation"
    assert (
        attention.reserve(
            "post_session", "effort", f"/follow-up?followup={ref}", None, PREFS
        )
        is None
    )
    with db_connection() as con:
        assert (
            con.execute(
                "SELECT count(*) FROM app.visible_coach_attention_claims"
            ).fetchone()[0]
            == 0
        )
        for _ in range(100):
            con.execute(
                "INSERT INTO app.plan_change_sets (id,items_json,before_json,after_json,digest,expires_at,created_at) VALUES (?,'{\"items\":[]}','[]','[]','x',?,?)",
                [str(uuid4()), NOW + timedelta(hours=1), NOW],
            )
    with pytest.raises(ValueError, match="100"):
        attention.projection()


def test_notification_preflight_and_unknown_delivery_keep_inbox_and_spend_once(
    athlete, monkeypatch
):
    import pywebpush

    from arete.services import inbox, notifications

    monkeypatch.setattr(notifications, "get_user_settings", lambda: PREFS)
    monkeypatch.setattr(notifications, "configured", lambda: True)
    monkeypatch.setattr(
        notifications,
        "_subscriptions",
        lambda: [("https://push.test/one", "key", "auth")],
    )

    def failed(**kwargs):
        raise TimeoutError("Acknowledgement lost")

    monkeypatch.setattr(pywebpush, "webpush", failed)
    first = inbox.publish("one", "automation", "Un suivi", "Un retour", "/follow-up")
    second = notifications.notify(
        "Autre suivi", "Autre retour", "/follow-up", kind="automation"
    )
    third = notifications.notify(
        "Troisième", "Pas envoyé", "/follow-up", kind="automation"
    )
    assert first and second.sent == 0 and "plafond" in third.skipped_reason
    with db_connection() as con:
        assert (
            con.execute(
                "SELECT attempts FROM app.visible_coach_attention_days"
            ).fetchone()[0]
            == 2
        )
        assert (
            con.execute("SELECT count(*) FROM app.visible_notifications").fetchone()[0]
            == 3
        )
    inbox.mark(first, read=True, archived=True)
    assert attention.reserve("automation", "one", "/follow-up", None, PREFS) is not None


def test_flag_patch_does_not_reset_an_unrelated_flag(athlete, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    set_feature_flags(FeatureFlags(glm_flash=True))
    set_feature_flags(FeatureFlags(coaching_attention=False))
    assert get_feature_flags().glm_flash is True


def running():
    identifier = str(uuid4())
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.automation_runs (id,automation_id,occurrence_key,definition_json,due_at,created_at,state) VALUES (?,?,'one','{}',?,?,'running')",
            [identifier, str(uuid4()), NOW, NOW],
        )
    return identifier


@pytest.mark.parametrize("outcome", ["applied", "stale", "expired", "dismissed"])
def test_grouped_native_approval_owns_one_priority_until_preview_is_closed(
    athlete, monkeypatch, outcome
):
    import json

    ids = sessions()
    preview = planning.preview_plan_changes(proposal(ids))
    assert attention.projection()["primary_ref"] == f"plan_change_set:{preview['id']}"
    run = running()
    with db_connection() as con:
        con.execute("UPDATE app.automation_runs SET state='waiting' WHERE id=?", [run])
        con.execute(
            "INSERT INTO app.automation_interrupts (run_id,id,tool_call_id,payload_json,schema_json,created_at,expires_at) VALUES (?,'one','apply-group',?,'{}',?,?)",
            [
                run,
                json.dumps(
                    {
                        "name": "apply_plan_changes",
                        "args": {"preview_id": preview["id"]},
                    }
                ),
                NOW,
                NOW + timedelta(hours=72),
            ],
        )
    items = attention.projection()["items"]
    assert len(items) == 1
    assert items[0]["source_ref"] == f"automation_run:{run}"
    assert items[0]["subject_key"] == f"plan_change_set:{preview['id']}"
    assert items[0]["expires_at"] == preview["expires_at"]
    if outcome == "applied":
        planning.apply_plan_changes(preview["id"], 1, preview["id"])
    elif outcome == "stale":
        GarminRepository().update_planned_session_fields(ids[0], description="Changed")
    elif outcome == "expired":
        monkeypatch.setattr(attention, "utc_now", lambda: NOW + timedelta(days=3))
    else:
        planning.dismiss_plan_changes(preview["id"], 1)
    assert attention.projection()["items"] == []
    # Native HITL can hold malformed model arguments before tool validation.
    with db_connection() as con:
        con.execute(
            "UPDATE app.automation_interrupts SET payload_json=? WHERE run_id=?",
            [
                json.dumps(
                    {
                        "name": "apply_plan_changes",
                        "args": {"preview_id": "invalid" * 100},
                    }
                ),
                run,
            ],
        )
    assert attention.projection()["items"] == []


def test_typed_rpe_question_reuses_one_answer_owner_and_returns_recorded_effort(
    athlete, monkeypatch
):
    from arete.services import coach_followup

    monkeypatch.setattr(coach_followup, "athlete_today", lambda: NOW.date())
    monkeypatch.setattr(
        coach_followup, "naive_utc_now", lambda: NOW.replace(tzinfo=None)
    )
    session = actual()
    raw = {"kind": "perceived_effort", "source": "session", "id": session}
    first = attention.coordinate_question(running(), "q1", raw)
    second = attention.coordinate_question(running(), "q2", raw)
    assert first["reference"] == second["reference"]
    identifier = int(first["reference"].split(":")[1])
    coach_followup.respond(identifier, 1, "answer", rpe=7)
    recorded = attention.coordinate_question(running(), "q3", raw)
    assert recorded == {
        "state": "answered",
        "rpe": 7,
        "subject_key": f"session:{session}:perceived_effort",
    }
    with db_connection() as con:
        assert (
            con.execute("SELECT count(*) FROM app.visible_coach_followups").fetchone()[
                0
            ]
            == 1
        )


def test_typed_availability_reserves_exact_subject_before_native_question(athlete):
    session = sessions(1)[0]
    raw = {"kind": "availability", "source": "plan", "id": session, "revision": 1}
    first, second = running(), running()
    assert attention.coordinate_question(first, "q1", raw) is None
    assert attention.coordinate_question(first, "q1", raw) is None  # native resume
    other = attention.coordinate_question(second, "q2", raw)
    assert other["reference"] == f"automation_run:{first}"
    assert other["state"] == "existing"
    GarminRepository().update_planned_session_fields(session, description="Updated")
    with pytest.raises(ValueError, match="changé"):
        attention.coordinate_question(first, "q1", raw)
    with athlete_scope(1), pytest.raises(LookupError):
        attention.coordinate_question(first, "q1", raw)


def test_attention_http_and_plan_change_http_preserve_preview_after_acknowledgement(
    athlete, router_client
):
    from arete.api.coach import router

    client = router_client(router)
    ids = sessions()
    preview = client.post(
        "/coach/plan-changes",
        json=proposal(ids).model_dump(mode="json", exclude_unset=True),
    )
    assert preview.status_code == 200
    saved = preview.json()
    assert (
        client.get("/coach/attention").json()["primary_ref"]
        == f"plan_change_set:{saved['id']}"
    )
    payload = {"revision": 1, "operation_id": saved["id"]}
    applied = client.post(f"/coach/plan-changes/{saved['id']}/apply", json=payload)
    assert applied.status_code == 200
    assert (
        client.post(f"/coach/plan-changes/{saved['id']}/apply", json=payload).json()
        == applied.json()
    )
    assert client.get("/coach/attention").json()["items"] == []


def test_announcing_a_typed_question_never_answers_it_and_reuses_its_answer(athlete):
    import json

    session = sessions(1)[0]
    subject = {"kind": "availability", "source": "plan", "id": session, "revision": 1}
    run = running()
    assert attention.coordinate_question(run, "question", subject) is None
    with db_connection() as con:
        con.execute("UPDATE app.automation_runs SET state='waiting' WHERE id=?", [run])
        con.execute(
            "INSERT INTO app.automation_interrupts (run_id,id,tool_call_id,payload_json,schema_json,created_at,expires_at) VALUES (?,'one','question',?,'{}',?,?)",
            [
                run,
                json.dumps(
                    {
                        "name": "ask_athlete",
                        "args": {"question": "Disponible demain ?", "subject": subject},
                    }
                ),
                NOW,
                NOW + timedelta(hours=24),
            ],
        )
    reference = {"kind": "automation_run", "id": run}
    assert (
        attention.reserve(
            "automation", "question", f"/follow-up?run={run}", reference, PREFS
        )
        is None
    )
    assert attention.projection()["primary_ref"] == f"automation_run:{run}"
    with db_connection() as con:
        con.execute(
            "UPDATE app.automation_interrupts SET decision_json=? WHERE run_id=?",
            [
                json.dumps(
                    {"type": "respond", "message": "Disponible seulement le matin."}
                ),
                run,
            ],
        )
        con.execute("UPDATE app.automation_runs SET state='ready' WHERE id=?", [run])
    assert attention.projection()["items"] == []
    reused = attention.coordinate_question(running(), "other", subject)
    assert (
        reused["state"] == "answered"
        and reused["answer"] == "Disponible seulement le matin."
    )


def test_late_activity_hides_a_missed_session_proposal(athlete):
    from arete.services.plan_repository import MISSED_REPLAN

    session = sessions(1)[0]
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.plan_decisions (date,planned_session_id,decision,reason,readiness_source,session_revision,state) VALUES (?,?,'move','Séance manquée',?,1,'pending')",
            [NOW.date(), session, MISSED_REPLAN],
        )
    assert attention.projection()["items"][0]["kind"] == "approval"
    actual()
    assert attention.projection()["items"] == []


def test_migration_53_upgrades_existing_schema_and_keeps_scoped_views(
    tmp_path, monkeypatch
):
    from arete.dataio import init_duckdb
    from arete.dataio.coaching_coordination_schema import TABLES

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "upgrade.duckdb"))
    init_duckdb.main()
    with db_connection() as con:
        for name in TABLES:
            con.execute(f"DROP VIEW app.visible_{name}")
            con.execute(f"DROP TABLE app.{name}")
        con.execute("DELETE FROM app.schema_version WHERE version=53")
        assert init_duckdb.pending_migrations(con) == [53]
    init_duckdb.main()
    with db_connection() as con:
        assert init_duckdb.pending_migrations(con) == []
        for name in TABLES:
            assert con.execute(
                f"SELECT count(*) FROM app.visible_{name}"
            ).fetchone() == (0,)
