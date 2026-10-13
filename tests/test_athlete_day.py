"""The server decides "today" on the athlete's clock, not on its own (UTC)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from unittest.mock import patch

import pytest

from arete.services import settings

#: Sunday 23:30 in UTC is already Monday 01:30 in Paris (summer time).
INSTANT = datetime(2026, 10, 11, 23, 30, tzinfo=UTC)
PARIS_DAY = date(2026, 10, 12)


@pytest.fixture
def frozen(monkeypatch):
    zone = {"timezone": "Europe/Paris"}
    monkeypatch.setattr(settings, "utc_now", lambda: INSTANT)
    monkeypatch.setattr(settings.repo, "get_user_settings", lambda *a, **k: zone)
    return zone


def test_the_athlete_day_follows_their_timezone(frozen):
    assert settings.athlete_today() == PARIS_DAY
    assert settings.athlete_now().hour == 1
    frozen["timezone"] = "America/New_York"
    assert settings.athlete_today() == date(2026, 10, 11)
    frozen["timezone"] = "Mars/Olympus"  # a hand-edited row: the default zone
    assert settings.athlete_today() == PARIS_DAY
    assert settings.today_in(None) == PARIS_DAY


def test_plan_today_answers_for_the_paris_day(frozen, router_client):
    from arete.api.plan import router
    from arete.services.plan_repository import PlanDecisionRepository

    asked: list[date] = []

    def list_for_day(self, day, **kwargs):
        asked.append(day)
        return []

    with patch.object(PlanDecisionRepository, "list_for_day", list_for_day):
        body = router_client(router).get("/plan/today").json()
    assert body == {"date": "2026-10-12", "decisions": []}
    assert asked == [PARIS_DAY]


def test_adaptation_and_the_garmin_push_pick_the_paris_day(frozen):
    from arete.garmin.repository import GarminRepository
    from arete.services import plan_adaptation

    asked: list[date] = []

    def planned(self, start_date, end_date, **kwargs):
        asked.append(start_date)
        return []

    with (
        patch.object(GarminRepository, "list_planned_sessions", planned),
        patch.object(
            plan_adaptation,
            "get_user_settings",
            return_value={"push_to_garmin_enabled": True},
        ),
    ):
        plan_adaptation.adapt_today(respect_setting=False)
        plan_adaptation.push_today(client=None)  # type: ignore[arg-type]
    assert asked == [PARIS_DAY, PARIS_DAY]


def test_the_weekly_review_runs_on_the_paris_monday(frozen, router_client):
    from arete import scheduler
    from arete.api.plan import router
    from arete.services import weekly_review

    with (
        patch("arete.coaching.generate_weekly_review") as generate,
        patch("arete.services.notifications.notify"),
    ):
        generate.return_value = weekly_review.Review(
            1, PARIS_DAY, "Semaine tenue.", "agent", [], [], None, None
        )
        # Sunday on the server's clock; Monday on the athlete's.
        assert scheduler.write_weekly_review() == "agent, 0 proposals"
    with patch.object(weekly_review, "get_review", return_value=None) as get:
        router_client(router).get("/plan/review")
    get.assert_called_once_with(date(2026, 10, 5))


def test_the_briefing_and_the_agent_share_the_paris_day(frozen):
    from arete import scheduler
    from arete.agent.runtime.context import AgentContext

    assert AgentContext().current_date == PARIS_DAY
    with (
        patch("arete.services.briefing.briefing_enabled", return_value=True),
        patch(
            "arete.services.coaching_repository.BriefingRepository.get_for_day",
            return_value=None,
        ) as existing,
        patch("arete.coaching.generate_briefing", side_effect=RuntimeError("stop")),
    ):
        scheduler.write_daily_briefing()
    existing.assert_called_once_with(PARIS_DAY)


class TestOwedToday:
    """The daily batch's marker is read as a calendar day on the athlete's clock."""

    NOW = INSTANT.timestamp()
    #: 21:00 UTC on Sunday: 23:00 Sunday in Paris, so Paris owes Monday's run.
    SUNDAY_EVENING = datetime(2026, 10, 11, 21, 0, tzinfo=UTC).timestamp()
    #: 22:15 UTC on Sunday: 00:15 Monday in Paris, already today's run there.
    PARIS_MONDAY = datetime(2026, 10, 11, 22, 15, tzinfo=UTC).timestamp()

    def test_never_run_is_owed(self):
        from arete.scheduler import owed_today

        assert owed_today(None, None, self.NOW, "Europe/Paris") is True

    def test_the_athlete_midnight_opens_a_new_day(self):
        from arete.scheduler import owed_today

        assert owed_today(self.SUNDAY_EVENING, None, self.NOW, "Europe/Paris")
        # On UTC's clock the same run happened today: nothing owed yet.
        assert not owed_today(self.SUNDAY_EVENING, None, self.NOW, "UTC")
        assert not owed_today(self.PARIS_MONDAY, None, self.NOW, "Europe/Paris")

    def test_a_lease_taken_today_holds_the_athlete(self):
        from arete.scheduler import owed_today

        assert not owed_today(None, self.PARIS_MONDAY, self.NOW, "Europe/Paris")
        assert owed_today(None, self.SUNDAY_EVENING, self.NOW, "Europe/Paris")

    def test_a_lease_is_dated_by_its_claim(self):
        """A run claimed at 23:58 holds a lease past midnight; not the next day."""
        from arete.scheduler import SCHEDULE_LEASE_SECONDS, owed_today

        claimed = datetime(2026, 10, 11, 21, 58, tzinfo=UTC).timestamp()  # 23:58
        lease = claimed + SCHEDULE_LEASE_SECONDS  # 00:13 on Monday in Paris
        assert owed_today(None, lease, self.NOW, "Europe/Paris")

    def test_nothing_is_owed_before_the_hour_or_in_quiet_hours(self):
        from arete.scheduler import owed_today
        from arete.services.settings import QuietHours

        def at(hour: int) -> float:
            return datetime(2026, 10, 12, hour, 0, tzinfo=UTC).timestamp()

        # 05:00 and 07:00 in Paris against a sync hour of 7.
        assert not owed_today(None, None, at(3), "Europe/Paris", sync_hour=7)
        assert owed_today(None, None, at(5), "Europe/Paris", sync_hour=7)
        quiet = QuietHours()  # 21:30-07:00, the default
        assert not owed_today(None, None, at(4), "Europe/Paris", quiet_hours=quiet)
        assert owed_today(None, None, at(5), "Europe/Paris", quiet_hours=quiet)
        assert not owed_today(None, None, at(20), "Europe/Paris", quiet_hours=quiet)
