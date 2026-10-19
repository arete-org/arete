"""Feedback on every synced session: one model request per sync run."""

from __future__ import annotations

from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.services.coaching_repository import SessionFeedbackRepository
from arete.services.memory import read_file as read_memory_file
from arete.services.session_feedback import (
    MAX_BATCH_SESSIONS,
    SessionEvidence,
    SessionFacts,
    batch_session_feedback,
    split_sections,
)


@pytest.fixture
def memory(tmp_path, monkeypatch):
    from arete.services import memory as fs

    root = tmp_path / "memory"
    root.mkdir()
    monkeypatch.setattr(fs, "memory_root", lambda: root)
    return root


def _facts(n: int) -> SessionFacts:
    return SessionFacts(
        rule_feedback=f"Séance {n} terminée.",
        highlights=[f"{n} km"],
        evidence=SessionEvidence(
            date=date(2026, 10, n), title=f"running — sortie {n} (08:00)"
        ),
    )


class TestSplitSections:
    def test_numbered_sections_in_order(self):
        assert split_sections("### 1\nBien.\n\n### 2\nTrop vite.", 2) == [
            "Bien.",
            "Trop vite.",
        ]

    @pytest.mark.parametrize(
        "text",
        [
            "Une seule réponse sans section.",
            "### 1\nBien.",  # one missing
            "### 1\nBien.\n### 1\nEncore.",  # repeated
            "### 1\nBien.\n### 2\n",  # empty
            "### 1\nBien.\n### 3\nAilleurs.",  # misnumbered
        ],
    )
    def test_an_unusable_answer_is_rejected(self, text):
        assert split_sections(text, 2) is None


class TestBatch:
    def test_one_request_answers_every_session(self, memory):
        produce = MagicMock(return_value="### 1\nBelle sortie.\n### 2\nBien géré.")
        out = batch_session_feedback([_facts(1), _facts(2)], produce=produce)
        assert out == [("Belle sortie.", "agent"), ("Bien géré.", "agent")]
        produce.assert_called_once()
        message, count = produce.call_args.args
        assert count == 2 and message.startswith("### 1\nSéance du 2026-10-01")
        ledger = read_memory_file("sessions.md").content
        assert ledger.count("## 2026-10-0") == 2
        assert (
            "Interprétation du coach (non confirmée, jamais une preuve) : Bien géré."
            in ledger
        )

    def test_a_single_session_needs_no_section(self, memory):
        produce = MagicMock(return_value="Belle sortie.")
        assert batch_session_feedback([_facts(1)], produce=produce) == [
            ("Belle sortie.", "agent")
        ]
        assert not produce.call_args.args[0].startswith("###")

    def test_an_unsplittable_answer_keeps_every_rule_text(self, memory):
        produce = MagicMock(return_value="Tout était bien.")
        out = batch_session_feedback([_facts(1), _facts(2)], produce=produce)
        assert [source for _, source in out] == ["rules", "rules"]
        assert out[0][0] == "Séance 1 terminée."
        assert "Retour du coach" not in read_memory_file("sessions.md").content

    def test_a_failed_request_keeps_every_rule_text(self, memory):
        produce = MagicMock(side_effect=RuntimeError("quota"))
        out = batch_session_feedback([_facts(1), _facts(2)], produce=produce)
        assert [source for _, source in out] == ["rules", "rules"]

    def test_beyond_the_batch_sessions_keep_their_rule_text(self, memory):
        n = MAX_BATCH_SESSIONS + 2
        answer = "\n".join(
            f"### {i}\nOk {i}." for i in range(1, MAX_BATCH_SESSIONS + 1)
        )
        produce = MagicMock(return_value=answer)
        out = batch_session_feedback(
            [_facts(i) for i in range(1, n + 1)], produce=produce
        )
        produce.assert_called_once()
        assert [source for _, source in out].count("agent") == MAX_BATCH_SESSIONS
        assert out[-1] == (f"Séance {n} terminée.", "rules")
        assert read_memory_file("sessions.md").content.count("## 2026-10-") == n

    def test_nothing_to_say_costs_nothing(self):
        produce = MagicMock()
        assert batch_session_feedback([], produce=produce) == []
        produce.assert_not_called()


@pytest.fixture
def synced():
    repo = GarminRepository()
    created: list[int] = []

    def make(source=ActivitySource.GARMIN_CONNECT, name="Footing", rpe=None) -> int:
        session_id = repo.create_actual_session(
            ActualSession(
                date=date(2031, 5, 6),
                rpe=rpe,
                sport="running",
                name=name,
                duration_sec=2700,
                distance_m=8000,
                avg_hr=145,
                max_hr=160,
                source=source,
                start_time=datetime(2031, 5, 6, 7, len(created)),
            )
        )
        created.append(session_id)
        return session_id

    yield make
    for session_id in created:
        repo.delete_actual_session(session_id)


class TestSyncFeedback:
    def test_one_request_for_the_garmin_sessions_only(self, memory, synced):
        from arete.services.coaching_rules import sync_feedback

        first, strava, second = synced(), synced(ActivitySource.STRAVA), synced()
        produce = MagicMock(return_value="### 1\nPremière.\n### 2\nSeconde.")
        outcome = sync_feedback([first, strava, second], produce=produce)
        assert (outcome["sessions"], outcome["agent"]) == (2, 2)
        assert [w["session_id"] for w in outcome["written"]] == [first, second]
        assert outcome["written"][1]["text"] == "Seconde."
        produce.assert_called_once()
        assert "Strava" not in produce.call_args.args[0]
        repo = SessionFeedbackRepository()
        stored = repo.get(second)
        assert stored is not None
        assert (stored.text, stored.source, stored.trigger) == (
            "Seconde.",
            "agent",
            "sync",
        )
        assert repo.get(strava) is None

    def test_a_session_with_feedback_is_not_paid_for_twice(self, memory, synced):
        from arete.services.coaching_rules import sync_feedback

        session_id = synced()
        SessionFeedbackRepository().save(
            session_id, text="Déjà dit.", source="agent", trigger="api"
        )
        produce = MagicMock()
        assert sync_feedback([session_id], produce=produce) == {
            "sessions": 0,
            "agent": 0,
            "written": [],
        }
        produce.assert_not_called()

    def test_deleting_the_session_deletes_its_feedback(self, synced):
        session_id = synced()
        repo = SessionFeedbackRepository()
        repo.save(session_id, text="Bien.", source="rules", trigger="api")
        GarminRepository().delete_actual_session(session_id)
        assert repo.get(session_id) is None

    def test_the_composition_root_sizes_the_answer_to_the_batch(self):
        from arete import coaching

        with patch("arete.coaching._run_mission", return_value="ok") as run:
            coaching.run_feedback_batch("### 1\n…", 3)
        assert run.call_args.args[3] == coaching.session_feedback.MAX_FEEDBACK_CHARS * 3


class TestDailySync:
    def _garmin(self, session_ids):
        from arete.garmin.client import GarminClient

        sync_client = MagicMock()
        sync_client.sync_activities.return_value = MagicMock(
            activities_synced=len(session_ids), errors=[], session_ids=session_ids
        )
        return (
            # Only the method: replacing the class would leave its mock bound in
            # any module first imported under this patch (arete.garmin.health_sync).
            patch.object(GarminClient, "has_tokens", return_value=True),
            patch(
                "arete.services.garmin_sync.ensure_fresh",
                return_value={
                    "imported": len(session_ids),
                    "session_ids": session_ids,
                    "errors": [],
                    "state": "complete",
                    "health_checked_at": "2026-10-13",
                },
            ),
            patch("arete.garmin.health_sync.sync_range", return_value=[]),
            patch("arete.garmin.readiness.update_readiness_range"),
            patch("arete.services.plan_adaptation.adapt_today", return_value=[]),
            patch("arete.services.plan_adaptation.push_today", return_value="0"),
            patch("arete.api.strava._get_strava_tokens", return_value=None),
            patch(
                "arete.services.coaching_repository.SessionFeedbackRepository.pending_garmin",
                return_value=([], 0),
            ),
            patch("arete.services.notifications.notify"),
        )

    def test_the_imported_sessions_get_one_feedback_run(self):
        from contextlib import ExitStack

        from arete import scheduler

        with ExitStack() as stack:
            for p in self._garmin([4, 5]):
                stack.enter_context(p)
            write = stack.enter_context(
                patch(
                    "arete.coaching.write_sync_feedback",
                    return_value={"sessions": 2, "agent": 2},
                )
            )
            status = scheduler.daily_sync()
        write.assert_called_once_with([4, 5])
        assert status["feedback"] == "2 sessions (2 by the coach)"

    def test_no_import_no_feedback(self):
        from contextlib import ExitStack

        from arete import scheduler

        with ExitStack() as stack:
            for p in self._garmin([]):
                stack.enter_context(p)
            write = stack.enter_context(patch("arete.coaching.write_sync_feedback"))
            status = scheduler.daily_sync()
        write.assert_not_called()
        assert "feedback" not in status

    def test_on_use_import_gets_feedback_in_the_next_daily_run(self):
        from contextlib import ExitStack

        from arete import scheduler

        with ExitStack() as stack:
            for p in self._garmin([]):
                stack.enter_context(p)
            stack.enter_context(
                patch(
                    "arete.services.coaching_repository.SessionFeedbackRepository.pending_garmin",
                    return_value=([17], 1),
                )
            )
            write = stack.enter_context(
                patch(
                    "arete.coaching.write_sync_feedback",
                    return_value={"sessions": 1, "agent": 1, "written": []},
                )
            )
            status = scheduler.daily_sync()
        write.assert_called_once_with([17])
        assert status["feedback_pending"] == "1"

    def test_a_failing_feedback_is_reported_not_raised(self):
        from contextlib import ExitStack

        from arete import scheduler

        with ExitStack() as stack:
            for p in self._garmin([4]):
                stack.enter_context(p)
            stack.enter_context(
                patch(
                    "arete.coaching.write_sync_feedback",
                    side_effect=RuntimeError("db down"),
                )
            )
            status = scheduler.daily_sync()
        assert status["feedback"] == "failed: db down"

    def test_imported_sessions_get_terrain_and_weather_before_feedback(self):
        from contextlib import ExitStack

        from arete import scheduler

        calls: list[str] = []

        def refresh(**kwargs):
            calls.append("conditions")
            return {
                "imported": 2,
                "session_ids": [4, 5],
                "errors": [],
                "state": "complete",
                "conditions": {"terrain": 2, "weather": 1},
            }

        def feedback(ids):
            calls.append("feedback")
            return {"sessions": 2, "agent": 2}

        with ExitStack() as stack:
            for p in self._garmin([4, 5]):
                stack.enter_context(p)
            refreshed = stack.enter_context(
                patch("arete.services.garmin_sync.ensure_fresh", side_effect=refresh)
            )
            stack.enter_context(
                patch("arete.coaching.write_sync_feedback", side_effect=feedback)
            )
            status = scheduler.daily_sync()
        refreshed.assert_called_once_with(force=True, daily=True)
        assert calls == ["conditions", "feedback"]
        assert status["conditions"] == "2 terrain, 1 weather"


class TestPostSessionPush:
    """The sync's one notification carries the coach's sentence, once per session."""

    def _run(self, session_ids, written, *, imported=None):
        from contextlib import ExitStack

        from arete import scheduler

        daily = TestDailySync()
        with ExitStack() as stack:
            for p in daily._garmin(session_ids)[:-1]:
                stack.enter_context(p)
            notify = stack.enter_context(patch("arete.services.notifications.notify"))
            notify.return_value = MagicMock(skipped_reason=None, sent=1)
            stack.enter_context(
                patch(
                    "arete.coaching.write_sync_feedback",
                    return_value={"sessions": 1, "agent": 1, "written": written},
                )
            )
            status = scheduler.daily_sync()
        return notify, status

    def test_one_session_pushes_its_feedback_sentence_and_page(self):
        written = [
            {
                "session_id": 4,
                "date": date(2031, 5, 6),
                "text": "Belle sortie maîtrisée. Le cardio est resté bas.",
            }
        ]
        notify, status = self._run([4], written)
        notify.assert_called_once_with(
            "Séance analysée",
            "Belle sortie maîtrisée.",
            "/log/sessions/4?rpe=1",
            kind="post_session",
        )
        assert status["notification"] == "1 sent"

    def test_several_sessions_make_one_push_linking_the_latest(self):
        written = [
            {"session_id": 4, "date": date(2031, 5, 5), "text": "Hier, bien."},
            {"session_id": 5, "date": date(2031, 5, 6), "text": "Ce matin, solide."},
        ]
        notify, _ = self._run([4, 5], written)
        notify.assert_called_once_with(
            "Séances analysées",
            "2 séances analysées. Ce matin, solide.",
            "/log/sessions/5?rpe=1",
            kind="post_session",
        )

    def test_a_rerun_does_not_push_the_same_session_again(self, memory, synced):
        from contextlib import ExitStack

        from arete import scheduler

        session_id = synced()
        notify_calls = []
        for _ in range(2):  # the second run re-reports the same activity
            with ExitStack() as stack:
                for p in TestDailySync()._garmin([session_id])[:-1]:
                    stack.enter_context(p)
                notify = stack.enter_context(
                    patch("arete.services.notifications.notify")
                )
                notify.return_value = MagicMock(skipped_reason=None, sent=1)
                run = stack.enter_context(
                    patch(
                        "arete.coaching.run_feedback_batch",
                        return_value="Footing bien dosé. Rien à signaler.",
                    )
                )
                scheduler.daily_sync()
                notify_calls.append(notify.call_args_list)
        assert len(notify_calls[0]) == 1
        assert notify_calls[0][0].args[2] == f"/log/sessions/{session_id}?rpe=1"
        assert notify_calls[1] == []
        run.assert_not_called()  # nor is the feedback paid for twice

    def test_the_athlete_rpe_reaches_the_coach_facts(self, memory, synced):
        from arete.services.coaching_rules import sync_feedback

        session_id = synced(rpe=6)
        produce = MagicMock(return_value="Bien.")
        sync_feedback([session_id], produce=produce)
        assert "RPE ressenti : 6/10" in produce.call_args.args[0]
