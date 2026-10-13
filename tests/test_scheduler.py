"""The daily sync must fire once a day, even across a suspended machine."""

from __future__ import annotations

import json
from datetime import date, datetime
from unittest.mock import patch

import pytest

from arete import scheduler


class TestIsDue:
    def test_not_before_the_scheduled_hour(self):
        now = datetime(2026, 9, 20, 8, 59)
        assert scheduler.is_due(9, now, None) is False

    def test_due_at_the_hour_when_never_run(self):
        assert scheduler.is_due(9, datetime(2026, 9, 20, 9, 0), None) is True

    def test_done_today_is_not_due_again(self):
        now = datetime(2026, 9, 20, 18, 0)
        assert scheduler.is_due(9, now, date(2026, 9, 20)) is False

    def test_a_missed_day_runs_late_rather_than_never(self):
        # machine asleep at 9:00, back at 18:07 with yesterday as the last run
        now = datetime(2026, 9, 20, 18, 7)
        assert scheduler.is_due(9, now, date(2026, 9, 19)) is True

    def test_midnight_hour_is_supported(self):
        assert scheduler.is_due(0, datetime(2026, 9, 20, 0, 1), None) is True


class TestState:
    @pytest.fixture(autouse=True)
    def state_file(self, tmp_path, monkeypatch):
        path = tmp_path / "last_daily_sync.json"
        monkeypatch.setattr(scheduler, "state_path", lambda: path)
        return path

    def test_never_run_before(self, state_file):
        assert scheduler.last_run_date() is None

    def test_round_trip(self, state_file):
        scheduler.record_run(datetime(2026, 9, 20, 9, 0, 12))
        assert scheduler.last_run_date() == date(2026, 9, 20)
        assert json.loads(state_file.read_text())["ran_at"].startswith("2026-09-20")

    def test_corrupt_state_is_treated_as_never_run(self, state_file):
        state_file.write_text("{oops")
        assert scheduler.last_run_date() is None


class TestRunForever:
    @pytest.fixture
    def anyio_backend(self):
        return "asyncio"

    @pytest.mark.anyio
    async def test_dispatches_then_waits(self):
        with (
            patch.object(scheduler, "run_scheduled_batch", return_value={}) as dispatch,
            patch("asyncio.sleep", side_effect=StopAsyncIteration) as sleep,
            pytest.raises(StopAsyncIteration),
        ):
            await scheduler.run_forever(0, tick_seconds=1)
        dispatch.assert_called_once()
        sleep.assert_awaited_once_with(1)

    @pytest.mark.anyio
    async def test_a_dispatch_failure_does_not_stop_the_clock(self):
        with (
            patch.object(
                scheduler, "run_scheduled_batch", side_effect=RuntimeError("db down")
            ),
            patch("asyncio.sleep", side_effect=StopAsyncIteration) as sleep,
            pytest.raises(StopAsyncIteration),
        ):
            await scheduler.run_forever(0, tick_seconds=1)
        sleep.assert_awaited_once_with(1)


class TestWriteDailyBriefing:
    def test_disabled_is_reported_not_run(self):
        with patch("arete.services.briefing.briefing_enabled", return_value=False):
            assert scheduler.write_daily_briefing() == "disabled"

    def test_failure_is_reported_not_raised(self):
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=None,
            ),
            patch(
                "arete.coaching.get_or_create_briefing",
                side_effect=RuntimeError("boom"),
            ),
        ):
            assert scheduler.write_daily_briefing().startswith("failed:")

    def _existing(self, trigger):
        from arete.services.coaching_repository import Briefing

        return Briefing(
            id=1,
            date=date.today(),
            text="Déjà écrit.",
            priority="info",
            source="agent",
            status="ok",
            error=None,
            trigger=trigger,
            created_at=None,
        )

    def test_a_second_scheduler_run_keeps_its_briefing(self):
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=self._existing("scheduler"),
            ),
            patch("arete.coaching.get_or_create_briefing") as generate,
        ):
            assert scheduler.write_daily_briefing() == "agent"
        generate.assert_not_called()

    def test_the_written_briefing_is_pushed_by_its_first_sentence(self):
        fresh = self._existing("scheduler")
        fresh = type(fresh)(**{**fresh.__dict__, "text": "Footing 45'. Puis repos."})
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=None,
            ),
            patch("arete.coaching.get_or_create_briefing", return_value=fresh),
            patch("arete.services.notifications.notify") as notify,
        ):
            scheduler.write_daily_briefing()
        notify.assert_called_once_with(
            "Briefing du coach", "Footing 45'.", "/", kind="briefing"
        )

    def test_a_briefing_written_from_other_facts_is_rewritten(self):
        fresh, stale = self._existing("scheduler"), self._existing("api")
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=stale,
            ),
            patch("arete.services.briefing.facts_changed", return_value=True),
            patch(
                "arete.coaching.get_or_create_briefing", return_value=fresh
            ) as generate,
        ):
            scheduler.write_daily_briefing()
        generate.assert_called_once_with(trigger="scheduler", replacing=stale)

    def test_a_briefing_written_from_the_same_data_is_kept(self):
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=self._existing("api"),
            ),
            patch("arete.services.briefing.facts_changed", return_value=False),
            patch("arete.coaching.get_or_create_briefing") as generate,
        ):
            assert scheduler.write_daily_briefing() == "agent"
        generate.assert_not_called()

    def test_a_run_in_progress_is_awaited_then_compared(self):
        # The dashboard's request was writing it: once stored, its facts decide.
        dashboard = self._existing("api")
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                side_effect=[None, dashboard],
            ),
            patch("arete.services.briefing.facts_changed", return_value=False),
            patch("arete.coaching.get_or_create_briefing", return_value=None),
            patch.object(scheduler, "sleep") as sleep,
            patch("arete.services.notifications.notify") as notify,
        ):
            assert scheduler.write_daily_briefing() == "agent"
        sleep.assert_called_once_with(scheduler.BRIEFING_POLL_SECONDS)
        notify.assert_not_called()

    def test_a_run_still_in_progress_after_the_wait_is_left_to_finish(self):
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=None,
            ),
            patch("arete.coaching.get_or_create_briefing", return_value=None),
            patch.object(scheduler, "BRIEFING_WAIT_SECONDS", 0),
            patch.object(scheduler, "sleep") as sleep,
            patch("arete.services.notifications.notify") as notify,
        ):
            assert scheduler.write_daily_briefing() == "in progress"
        sleep.assert_not_called()
        notify.assert_not_called()

    def test_the_wait_stops_at_the_dispatch_s_model_deadline(self):
        # A rewrite started past SCHEDULE_MODEL_SECONDS would outlive the function.
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=None,
            ),
            patch("arete.coaching.get_or_create_briefing", return_value=None),
            patch.object(scheduler, "sleep") as sleep,
        ):
            spent = scheduler.monotonic() - 1
            assert scheduler.write_daily_briefing(model_deadline=spent) == "in progress"
        sleep.assert_not_called()

    def test_a_failed_rewrite_keeps_the_briefing_without_a_notification(self):
        stale = self._existing("api")
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch(
                "arete.services.coaching_repository.BriefingRepository.get_for_day",
                return_value=stale,
            ),
            patch("arete.services.briefing.facts_changed", return_value=True),
            patch("arete.coaching.get_or_create_briefing", return_value=stale),
            patch("arete.services.notifications.notify") as notify,
        ):
            assert scheduler.write_daily_briefing() == "rewrite failed; kept"
        notify.assert_not_called()


class TestStart:
    def test_disabled_without_env(self, monkeypatch):
        monkeypatch.delenv("ARETE_AUTO_SYNC_HOUR", raising=False)
        assert scheduler.start() is None


class TestDailySync:
    def test_reports_missing_connectors(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARETE_GARMIN_TOKENS_DIR", str(tmp_path / "none"))
        with (
            patch("arete.api.strava._get_strava_tokens", return_value=None),
            patch("arete.services.plan_adaptation.adapt_today", return_value=[]),
        ):
            status = scheduler.daily_sync()
        assert status == {
            "garmin": "no tokens",
            "plan": "0 decisions (none)",
            "strava": "not connected",
            "google_calendar": "disabled",
        }

    def test_adaptation_runs_before_strava_and_failures_are_reported(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ARETE_GARMIN_TOKENS_DIR", str(tmp_path / "none"))
        calls: list[str] = []

        def adapt(**_kwargs):
            calls.append("adapt")
            raise RuntimeError("db down")

        def tokens():
            calls.append("strava")
            return None

        with (
            patch("arete.services.plan_adaptation.adapt_today", side_effect=adapt),
            patch("arete.api.strava._get_strava_tokens", side_effect=tokens),
        ):
            status = scheduler.daily_sync()
        assert calls == ["adapt", "strava"]
        assert status["plan"] == "failed: db down"

    def test_status_is_kept_not_discarded(self, tmp_path, monkeypatch):
        # run_forever ignores the return value; the coach needs to know what
        # the last sync actually did before briefing on the day's data.
        monkeypatch.setenv("ARETE_GARMIN_TOKENS_DIR", str(tmp_path / "none"))
        with patch("arete.api.strava._get_strava_tokens", return_value=None):
            status = scheduler.daily_sync()
        assert scheduler.last_status() == status

    def test_with_garmin_the_push_follows_the_decisions(self):
        from unittest.mock import MagicMock

        garmin = MagicMock()
        garmin.has_tokens.return_value = True
        calls: list[str] = []
        sync_client = MagicMock()
        sync_client.sync_activities.return_value = MagicMock(
            activities_synced=0, errors=[]
        )
        with (
            patch("arete.garmin.client.GarminClient", return_value=garmin),
            patch("arete.garmin.sync.GarminSyncClient", return_value=sync_client),
            patch("arete.garmin.health_sync.sync_range", return_value=[]),
            patch("arete.garmin.readiness.update_readiness_range"),
            patch(
                "arete.services.plan_adaptation.adapt_today",
                side_effect=lambda **_: calls.append("adapt") or [],
            ),
            patch(
                "arete.services.plan_adaptation.push_today",
                side_effect=lambda client: calls.append("push") or "1 sent",
            ),
            patch("arete.api.strava._get_strava_tokens", return_value=None),
        ):
            status = scheduler.daily_sync()
        assert calls == ["adapt", "push"]
        assert status["garmin_push"] == "1 sent"

    def test_new_sessions_are_announced_once(self):
        with (
            patch("arete.services.plan_adaptation.adapt_today", return_value=[]),
            patch("arete.api.strava._get_strava_tokens", return_value={"x": 1}),
            patch("arete.api.strava.sync", return_value={"imported": 2}),
            patch("arete.services.notifications.notify") as notify,
        ):
            scheduler.daily_sync()
        notify.assert_called_once_with(
            "Arete", "2 séance(s) importée(s)", "/log?tab=cardio", kind="imports"
        )

    def test_last_status_is_a_copy(self):
        # Callers must not be able to edit the scheduler's record.
        snapshot = scheduler.last_status()
        snapshot["garmin"] = "tampered"
        assert scheduler.last_status().get("garmin") != "tampered"


class TestSyncStatusEndpoint:
    def test_reports_schedule_and_last_run(self, client, monkeypatch):
        monkeypatch.setenv("ARETE_AUTO_SYNC_HOUR", "9")
        with patch.object(scheduler, "last_run_date", return_value=date(2026, 9, 20)):
            body = client.get("/sync/status").json()
        assert body["scheduled_hour"] == 9
        assert body["last_run"] == "2026-09-20"
        assert isinstance(body["sources"], dict)

    def test_never_run_reports_null(self, client, monkeypatch):
        monkeypatch.delenv("ARETE_AUTO_SYNC_HOUR", raising=False)
        with patch.object(scheduler, "last_run_date", return_value=None):
            body = client.get("/sync/status").json()
        assert body["scheduled_hour"] is None
        assert body["last_run"] is None
