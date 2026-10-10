"""The daily briefing: produced once, stored, always with a floor under it.

The agent is never called for real here — these tests are about the contract
around it: the rule engine stays the floor, a failure stays visible without
reaching the dashboard, and the day's briefing is produced once.
"""

from __future__ import annotations

import threading
from contextlib import ExitStack
from datetime import date, timedelta
from functools import partial
from unittest.mock import AsyncMock, Mock, patch

import anyio
import pytest

from arete.coaching import generate_briefing, get_or_create_briefing
from arete.services import briefing as briefing_service
from arete.services.athlete_scope import athlete_scope
from arete.services.coaching_repository import BriefingRepository
from arete.services.coaching_rules import RuleFacts

#: An athlete with a training history: there is something to coach on.
TRAINED = RuleFacts(
    acwr=1.0, tsb=-3.0, readiness_score=71.0, fatigue_threshold=85, fitness_goal="build"
)


@pytest.fixture
def repo():
    return BriefingRepository()


@pytest.fixture
def fresh_athletes(tmp_path, monkeypatch):
    """Two accounts just created in their own database: no training data."""
    from arete.dataio.init_duckdb import main as init_schema
    from arete.services.users import upsert_user

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "fresh.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    return [
        upsert_user(name, f"{name}@example.com", name, verified=True).athlete_id
        for name in ("first", "second")
    ]


@pytest.fixture(autouse=True)
def clean_day(repo):
    """Each test owns its own day, so they cannot see each other's rows."""
    day = date(2031, 1, 1)
    repo.delete_for_day(day)
    yield day
    repo.delete_for_day(day)


@pytest.fixture
def enabled():
    with patch("arete.services.briefing.briefing_enabled", return_value=True):
        yield


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------


class TestRepository:
    def test_a_failed_run_is_stored_but_never_served(self, repo, clean_day):
        repo.create(
            text="floor",
            briefing_date=clean_day,
            status="failed",
            source="agent",
            error="model is away",
        )
        assert repo.get_for_day(clean_day) is None
        assert [b.status for b in repo.list_recent()][0] == "failed"

    def test_a_later_success_wins_over_an_earlier_one(self, repo, clean_day):
        repo.create(text="first", briefing_date=clean_day, source="rules")
        repo.create(text="second", briefing_date=clean_day, source="agent")
        assert repo.get_for_day(clean_day).text == "second"

    def test_days_do_not_bleed_into_each_other(self, repo, clean_day):
        repo.create(text="yesterday", briefing_date=clean_day - timedelta(days=1))
        assert repo.get_for_day(clean_day) is None
        repo.delete_for_day(clean_day - timedelta(days=1))


# ---------------------------------------------------------------------------
# Producer
# ---------------------------------------------------------------------------


class TestGenerate:
    def test_the_agent_text_is_stored_with_the_rules_priority(
        self, repo, clean_day, enabled
    ):
        # The card's colour must not depend on a model.
        with (
            patch("arete.coaching.run_briefing", return_value="Ta charge monte."),
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "alert", TRAINED),
            ),
        ):
            b = generate_briefing(target_date=clean_day)
        assert b.text == "Ta charge monte."
        assert b.source == "agent"
        assert b.priority == "alert"

    def test_a_failed_run_falls_back_to_the_floor_and_records_why(
        self, repo, clean_day, enabled
    ):
        with (
            patch(
                "arete.coaching.run_briefing",
                side_effect=RuntimeError("model is away"),
            ),
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
        ):
            b = generate_briefing(target_date=clean_day)

        assert b.text == "floor"
        assert b.source == "rules"
        rows = [r for r in repo.list_recent() if r.date == clean_day]
        failed = [r for r in rows if r.status == "failed"]
        assert failed and "model is away" in failed[0].error

    def test_disabled_stores_the_floor_without_calling_the_agent(self, clean_day):
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=False),
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
            patch("arete.coaching.run_briefing") as run,
        ):
            b = generate_briefing(target_date=clean_day)
        run.assert_not_called()
        assert b.source == "rules"

    def test_a_broken_rule_engine_still_yields_something(self, clean_day):
        # The floor has a floor: the dashboard is never empty.
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=False),
            patch(
                "arete.services.coaching_rules.daily_rule_tip",
                side_effect=RuntimeError("no data"),
            ),
        ):
            b = generate_briefing(target_date=clean_day)
        assert b.text and b.priority == "info"

    def test_an_athlete_without_data_gets_the_floor_without_a_model_request(
        self, fresh_athletes, clean_day, enabled
    ):
        # The model could only restate the rule sentence, at a request a day.
        with (
            athlete_scope(fresh_athletes[1]),
            patch("arete.coaching.run_briefing") as run,
        ):
            b = generate_briefing(target_date=clean_day)
        run.assert_not_called()
        assert (b.source, b.status) == ("rules", "ok")
        assert b.text.startswith("Enregistre tes séances")

    def test_a_plan_built_before_any_sync_still_gets_the_coach(
        self, fresh_athletes, clean_day, enabled
    ):
        # No history yet, but today's session is something to coach on.
        from arete.garmin.models import PlannedSession, SessionType
        from arete.garmin.repository import GarminRepository

        with athlete_scope(fresh_athletes[1]):
            GarminRepository().create_planned_session(
                PlannedSession(
                    date=clean_day,
                    sport="running",
                    session_type=SessionType.ENDURANCE,
                    description="Footing",
                )
            )
            with patch(
                "arete.coaching.run_briefing", return_value="Footing tranquille."
            ) as run:
                b = generate_briefing(target_date=clean_day)
        run.assert_called_once()
        assert b.source == "agent"

    @pytest.mark.parametrize(
        "broken",
        [
            ["arete.services.coaching_rules.rule_facts"],
            [
                "arete.services.coaching_rules.training_loads",
                "arete.services.metrics.load_form",
            ],
        ],
        ids=["facts", "reads"],
    )
    def test_unknown_facts_still_run_the_model(self, clean_day, enabled, broken):
        # A failed read is not an empty history: it never silences the coach.
        with ExitStack() as stack:
            for target in broken:
                stack.enter_context(patch(target, side_effect=RuntimeError("db down")))
            run = stack.enter_context(
                patch("arete.coaching.run_briefing", return_value="Écrit.")
            )
            b = generate_briefing(target_date=clean_day)
        run.assert_called_once()
        assert b.source == "agent"

    def test_an_overlong_briefing_is_refused(self, clean_day, enabled):
        from arete.services.briefing import MAX_BRIEFING_CHARS

        class _Msg:
            text = "x" * (MAX_BRIEFING_CHARS + 1)

        with (
            patch("arete.coaching.build_briefing_agent") as build,
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
        ):
            build.return_value.ainvoke = AsyncMock(return_value={"messages": [_Msg()]})
            b = anyio.run(
                partial(
                    anyio.to_thread.run_sync,
                    partial(generate_briefing, target_date=clean_day),
                )
            )
        # Refused, so the floor is served and the failure is on record.
        assert b.source == "rules"

    def test_an_empty_answer_is_refused(self, clean_day, enabled):
        class _Msg:
            text = "   "

        with (
            patch("arete.coaching.build_briefing_agent") as build,
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
        ):
            build.return_value.ainvoke = AsyncMock(return_value={"messages": [_Msg()]})
            b = generate_briefing(target_date=clean_day)
        assert b.source == "rules"


class TestGetOrCreate:
    def test_the_day_is_produced_once(self, clean_day, enabled):
        with (
            patch("arete.coaching.run_briefing", return_value="written") as run,
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
        ):
            first = get_or_create_briefing(target_date=clean_day)
            second = get_or_create_briefing(target_date=clean_day)

        assert run.call_count == 1
        assert first.id == second.id
        assert second.text == "written"

    def test_the_trigger_is_recorded(self, repo, clean_day, enabled):
        with (
            patch("arete.coaching.run_briefing", return_value="written"),
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
        ):
            b = get_or_create_briefing(target_date=clean_day, trigger="scheduler")
        assert b.trigger == "scheduler"

    def test_briefings_of_two_athletes_are_produced_concurrently(
        self, fresh_athletes, clean_day, enabled
    ):
        # One lock for everyone made each athlete wait out the others' runs.
        first, second = fresh_athletes
        first_producing, second_done = threading.Event(), threading.Event()

        def produce_first(_facts: str) -> str:
            first_producing.set()
            assert second_done.wait(timeout=5), "the second athlete was held up"
            return "Premier."

        def write(athlete_id, produce, done=None) -> None:
            with athlete_scope(athlete_id):
                briefing_service.get_or_create_briefing(
                    produce=produce, target_date=clean_day
                )
            if done is not None:
                done.set()

        with patch(
            "arete.services.briefing._rule_floor",
            return_value=("floor", "info", TRAINED),
        ):
            threads = [threading.Thread(target=write, args=(first, produce_first))]
            threads[0].start()
            assert first_producing.wait(timeout=5)
            threads.append(
                threading.Thread(
                    target=write,
                    args=(second, Mock(return_value="Second."), second_done),
                )
            )
            threads[1].start()
            for thread in threads:
                thread.join(timeout=10)
        assert not any(thread.is_alive() for thread in threads)
        for athlete_id, text in ((first, "Premier."), (second, "Second.")):
            with athlete_scope(athlete_id):
                stored = BriefingRepository().get_for_day(clean_day)
            assert stored is not None
            assert (stored.text, stored.source) == (text, "agent")


# ---------------------------------------------------------------------------
# The journal the briefing writes into every morning must stay bounded
# ---------------------------------------------------------------------------


class TestLedgerRotation:
    @pytest.fixture
    def ledger(self, tmp_path, monkeypatch):
        from arete.services import memory as fs

        root = tmp_path / "memory"
        root.mkdir()
        monkeypatch.setattr(fs, "memory_root", lambda: root)
        return root / fs.SESSIONS_LEDGER

    def _entries(self, count: int) -> str:
        return "".join(
            f"## 2026-09-{i:02d} — séance {i}\n" + "x" * 900 + "\n\n"
            for i in range(1, count + 1)
        )

    def test_a_small_ledger_is_left_alone(self, ledger):
        from arete.services.memory import rotate_sessions_ledger

        ledger.write_text(self._entries(3), encoding="utf-8")
        before = ledger.read_text(encoding="utf-8")
        assert rotate_sessions_ledger() is None
        assert ledger.read_text(encoding="utf-8") == before

    def test_an_overgrown_ledger_is_split_on_an_entry(self, ledger):
        from arete.services.memory import (
            MAX_SESSIONS_LEDGER_CHARS,
            rotate_sessions_ledger,
        )

        ledger.write_text(self._entries(60), encoding="utf-8")
        archive = rotate_sessions_ledger()

        assert archive is not None and archive.exists()
        kept = ledger.read_text(encoding="utf-8")
        assert len(kept) < MAX_SESSIONS_LEDGER_CHARS
        # Never mid-entry: half a session reads as a different session.
        assert kept.startswith("## ")
        # Nothing is lost, it just moved.
        assert "séance 1\n" in archive.read_text(encoding="utf-8")

    def test_rotation_is_idempotent(self, ledger):
        from arete.services.memory import rotate_sessions_ledger

        ledger.write_text(self._entries(60), encoding="utf-8")
        assert rotate_sessions_ledger() is not None
        assert rotate_sessions_ledger() is None

    def test_a_missing_ledger_is_not_an_error(self, ledger):
        from arete.services.memory import rotate_sessions_ledger

        assert rotate_sessions_ledger() is None


# ---------------------------------------------------------------------------
# Post-session feedback: same floor contract, plus a journal entry
# ---------------------------------------------------------------------------


class TestSessionFeedback:
    def test_the_agent_text_wins_when_the_run_succeeds(self):
        from arete.coaching import enrich_session_feedback

        with patch("arete.coaching.run_feedback", return_value="Belle séance."):
            text, source = enrich_session_feedback("Séance terminée.", ["10 km"])
        assert (text, source) == ("Belle séance.", "agent")

    def test_a_failed_run_returns_the_rule_text(self):
        from arete.coaching import enrich_session_feedback

        with patch(
            "arete.coaching.run_feedback",
            side_effect=RuntimeError("model is away"),
        ):
            text, source = enrich_session_feedback("Séance terminée.", ["10 km"])
        # An athlete who just uploaded a session gets an answer either way.
        assert (text, source) == ("Séance terminée.", "rules")

    def test_the_highlights_reach_the_agent_as_facts(self):
        from arete.coaching import enrich_session_feedback

        with patch("arete.coaching.run_feedback", return_value="ok") as run:
            enrich_session_feedback("Séance terminée.", ["10 km", "FC 150"])
        facts = run.call_args[0][0]
        assert "Séance terminée." in facts
        assert "- 10 km" in facts and "- FC 150" in facts

    def test_no_highlights_is_not_an_empty_bullet_list(self):
        from arete.coaching import enrich_session_feedback

        with patch("arete.coaching.run_feedback", return_value="ok") as run:
            enrich_session_feedback("Séance terminée.", [])
        assert run.call_args[0][0] == "Séance terminée."

    def test_an_overlong_answer_is_refused(self):
        from arete.coaching import run_feedback as _run_agent
        from arete.services.session_feedback import MAX_FEEDBACK_CHARS

        class _Msg:
            text = "x" * (MAX_FEEDBACK_CHARS + 1)

        with patch("arete.coaching.build_feedback_agent") as build:
            build.return_value.ainvoke = AsyncMock(return_value={"messages": [_Msg()]})
            with pytest.raises(RuntimeError, match="too long"):
                anyio.run(partial(anyio.to_thread.run_sync, _run_agent, "facts"))

    def test_the_briefing_and_the_feedback_do_not_share_a_graph(self):
        # Different prompts, so the cached factory must hand back two graphs.
        from arete.coaching import build_briefing_agent, build_feedback_agent

        with (
            patch(
                "arete.agent.factory.create_agent",
                side_effect=lambda *a, **k: Mock(
                    with_config=Mock(return_value=k["name"])
                ),
            ),
            patch("arete.coaching.build_chat_model", return_value=object()),
        ):
            build_briefing_agent.cache_clear()
            build_feedback_agent.cache_clear()
            first = build_briefing_agent()
            second = build_feedback_agent()
            build_briefing_agent.cache_clear()
            build_feedback_agent.cache_clear()
        assert first != second


# ---------------------------------------------------------------------------
# One request per mission: facts in, server-filed journal
# ---------------------------------------------------------------------------


@pytest.fixture
def memory(tmp_path, monkeypatch):
    from arete.services import memory as fs

    root = tmp_path / "memory"
    root.mkdir()
    monkeypatch.setattr(fs, "memory_root", lambda: root)
    return root


class TestAppendEntry:
    def test_the_server_writes_the_dated_heading(self, memory):
        from arete.services.memory import append_entry

        assert append_entry(
            "sessions.md", "trail — sortie longue", "20 km", date(2026, 10, 9)
        )
        assert (memory / "sessions.md").read_text() == (
            "## 2026-10-09 — trail — sortie longue\n20 km\n"
        )

    def test_the_same_entry_is_never_filed_twice(self, memory):
        from arete.services.memory import append_entry

        day = date(2026, 10, 9)
        append_entry("sessions.md", "footing", "8 km", day)
        assert not append_entry("sessions.md", "footing", "8 km encore", day)
        assert (memory / "sessions.md").read_text().count("## 2026-10-09") == 1

    def test_a_note_is_one_dated_line(self, memory):
        from arete.services.memory import append_entry

        append_entry(
            "notes.md", "genou", "gêne au genou gauche\nen descente", date(2026, 10, 9)
        )
        assert (memory / "notes.md").read_text() == (
            "- 2026-10-09 — genou : gêne au genou gauche en descente\n"
        )

    def test_an_unknown_ledger_is_refused(self, memory):
        from arete.services.memory import append_entry

        with pytest.raises(ValueError):
            append_entry("other.md", "x", "y")


class TestBriefingFacts:
    def test_the_facts_carry_the_date_the_rules_and_today_plan(self, clean_day):
        from arete.services.briefing import briefing_facts

        planned = type(
            "P",
            (),
            {
                "session_type": type("T", (), {"value": "tempo"})(),
                "target_duration_min": 45,
                "target_hr_zone": "Z3",
                "description": "3x10' tempo",
            },
        )()
        with patch(
            "arete.garmin.repository.GarminRepository.list_planned_sessions",
            return_value=[planned],
        ):
            facts = briefing_facts(clean_day, "Charge équilibrée.")
        assert "mercredi 2031-01-01" in facts
        assert "Conseil calculé par les règles : Charge équilibrée." in facts
        assert "tempo — 45 min — Z3 — 3x10' tempo" in facts

    def test_one_readiness_line_names_its_source(self, clean_day):
        from arete.services.briefing import briefing_facts
        from arete.services.coaching_rules import RuleFacts

        def facts_with(source, measured_on):
            return RuleFacts(
                acwr=1.0,
                tsb=-3.0,
                readiness_score=71.0,
                fatigue_threshold=85,
                fitness_goal="build",
                readiness_source=source,
                readiness_measured_on=measured_on,
            )

        with patch(
            "arete.services.coaching_rules.rule_facts",
            return_value=facts_with("garmin", clean_day),
        ):
            garmin = briefing_facts(clean_day, "x")
        with patch(
            "arete.services.coaching_rules.rule_facts",
            return_value=facts_with("model", None),
        ):
            model = briefing_facts(clean_day, "x")
        assert "Préparation Garmin (VFC, sommeil, cette nuit) : 71/100" in garmin
        assert "Préparation estimée par la charge" in model
        assert garmin.count("Préparation") == 1

    def test_the_facts_carry_the_decision_and_its_reason(self, clean_day):
        from arete.services.briefing import briefing_facts
        from arete.services.plan_repository import PlanDecision

        decision = PlanDecision(
            id=1,
            date=clean_day,
            planned_session_id=7,
            decision="ease",
            reason="Préparation Garmin 68/100 : la séance tempo 45 min Z4 est allégée.",
            readiness_score=68.0,
            readiness_source="garmin_training",
            acwr=1.0,
            original={
                "session_type": "tempo",
                "target_duration_min": 45,
                "target_hr_zone": "Z4",
            },
            adapted={"session_type": "endurance"},
            applied_at=None,
            reverted_at=None,
            created_at=None,
        )
        with patch(
            "arete.services.plan_repository.PlanDecisionRepository.list_for_day",
            return_value=[decision],
        ):
            facts = briefing_facts(clean_day, "x")
        assert "Décision du coach pour aujourd'hui :" in facts
        assert "tempo 45 min Z4 : allégée — raison : Préparation Garmin 68/100" in facts
        from coach_text_checks import RAW_FIELDS

        assert not any(field in facts for field in RAW_FIELDS)

    def test_no_decision_reads_aucune(self, clean_day):
        from arete.services.briefing import briefing_facts

        with patch(
            "arete.services.plan_repository.PlanDecisionRepository.list_for_day",
            return_value=[],
        ):
            facts = briefing_facts(clean_day, "x")
        assert "Décision du coach pour aujourd'hui :\n- aucune" in facts

    def test_race_times_read_like_a_clock(self):
        from arete.services.briefing import _clock

        assert (_clock(1188), _clock(2470), _clock(5465)) == (
            "19:48",
            "41:10",
            "1:31:05",
        )

    def test_a_failed_read_says_unavailable_instead_of_failing(self, clean_day):
        from arete.services.briefing import briefing_facts

        with patch(
            "arete.garmin.repository.GarminRepository.list_planned_sessions",
            side_effect=RuntimeError("db down"),
        ):
            facts = briefing_facts(clean_day, "x")
        assert "Séance(s) prévue(s) aujourd'hui :\n- indisponible" in facts

    def test_the_agent_receives_the_facts(self, clean_day, enabled):
        with (
            patch("arete.services.coaching_rules.rule_facts", return_value=TRAINED),
            patch("arete.coaching.run_briefing", return_value="ok") as run,
        ):
            generate_briefing(target_date=clean_day)
        assert "Nous sommes mercredi 2031-01-01." in run.call_args.args[0]

    def test_facts_are_computed_once_per_briefing(self, clean_day, enabled):
        with (
            patch(
                "arete.services.coaching_rules.rule_facts", return_value=TRAINED
            ) as facts,
            patch("arete.coaching.run_briefing", return_value="ok") as run,
        ):
            generate_briefing(target_date=clean_day)
        assert facts.call_count == 1
        # The model reads the floor's numbers rather than a second computation.
        assert "(ACWR, sur 28 jours) : 1.00" in run.call_args.args[0]

    def test_concurrent_first_requests_produce_once(self, clean_day, enabled):
        from concurrent.futures import ThreadPoolExecutor

        with (
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", TRAINED),
            ),
            patch("arete.coaching.run_briefing", return_value="ok") as run,
            ThreadPoolExecutor(max_workers=3) as pool,
        ):
            list(
                pool.map(
                    lambda _: get_or_create_briefing(target_date=clean_day), range(3)
                )
            )
        assert run.call_count == 1


class TestFeedbackFiling:
    @staticmethod
    def _evidence():
        from arete.services.session_feedback import SessionEvidence

        return SessionEvidence(
            date=date(2026, 10, 9), title="trail — sortie longue", rpe=7, notes="dur"
        )

    def test_the_server_files_the_session_with_the_coach_answer(self, memory):
        from arete.coaching import enrich_session_feedback

        with patch("arete.coaching.run_feedback", return_value="Belle séance.") as run:
            text, source = enrich_session_feedback(
                "20 km.", ["D+ 900"], self._evidence()
            )
        assert (text, source) == ("Belle séance.", "agent")
        assert "RPE ressenti : 7/10" in run.call_args.args[0]
        ledger = (memory / "sessions.md").read_text()
        assert ledger.startswith("## 2026-10-09 — trail — sortie longue\n")
        assert "Retour du coach : Belle séance." in ledger

    def test_a_repeated_request_files_nothing_more(self, memory):
        from arete.coaching import enrich_session_feedback

        with patch("arete.coaching.run_feedback", return_value="ok"):
            enrich_session_feedback("20 km.", [], self._evidence())
            enrich_session_feedback("20 km.", [], self._evidence())
        assert (memory / "sessions.md").read_text().count("## 2026-10-09") == 1

    def test_a_failed_model_still_files_the_facts(self, memory):
        from arete.coaching import enrich_session_feedback

        with patch("arete.coaching.run_feedback", side_effect=RuntimeError("down")):
            text, source = enrich_session_feedback("20 km.", [], self._evidence())
        assert (text, source) == ("20 km.", "rules")
        ledger = (memory / "sessions.md").read_text()
        assert "20 km." in ledger and "Retour du coach" not in ledger
