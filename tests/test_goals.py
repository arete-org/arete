"""Goal races: CRUD, the next goal, and what deleting one removes."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import goals
from arete.services.settings import athlete_today, today_in

FAR = today_in(None) + timedelta(days=900)  # from the default athlete's day


@pytest.fixture(autouse=True)
def _clean():
    yield
    con = connect()
    con.execute("DELETE FROM app.goals WHERE name LIKE 'test-%'")
    con.execute(
        "DELETE FROM app.planned_sessions WHERE date >= ?", [FAR - timedelta(days=60)]
    )
    con.close()


def test_the_next_goal_is_the_soonest_a_race():
    goals.create_goal(name="test-b", race_date=FAR, distance_km=10, priority="B")
    a = goals.create_goal(
        name="test-a", race_date=FAR + timedelta(days=30), distance_km=21.1
    )
    upcoming = [g for g in goals.list_goals() if g.name.startswith("test-")]
    assert [g.name for g in upcoming] == ["test-b", "test-a"]
    assert goals.next_goal(FAR - timedelta(days=1)) == a


def test_validation():
    with pytest.raises(ValueError):
        goals.create_goal(name="test-x", race_date=FAR, distance_km=10, priority="Z")
    with pytest.raises(ValueError):
        goals.create_goal(name="test-x", race_date=FAR, distance_km=0.5)
    g = goals.create_goal(name="test-x", race_date=FAR, distance_km=10)
    with pytest.raises(ValueError):
        goals.update_goal(g.id, user_id=2)


def test_deleting_a_goal_removes_its_future_plan_only():
    g = goals.create_goal(name="test-del", race_date=FAR, distance_km=42.195)
    repo = GarminRepository()
    generated = repo.create_planned_session(
        PlannedSession(
            date=FAR - timedelta(days=3), session_type=SessionType.TEMPO, goal_id=g.id
        )
    )
    manual = repo.create_planned_session(
        PlannedSession(date=FAR - timedelta(days=2), session_type=SessionType.ENDURANCE)
    )
    assert goals.delete_goal(g.id) is True
    assert repo.get_planned_session(generated) is None
    assert repo.get_planned_session(manual) is not None
    assert goals.delete_goal(g.id) is False


def test_the_routes(router_client, monkeypatch):
    from arete.api import goals as api
    from arete.api.goals import router

    # Collection and the HTTP request can fall on opposite sides of midnight.
    today = FAR - timedelta(days=900)
    monkeypatch.setattr(api, "athlete_today", lambda: today)
    monkeypatch.setattr(goals, "athlete_today", lambda: today)
    client = router_client(router)
    created = client.post(
        "/goals",
        json={"name": "test-api", "race_date": FAR.isoformat(), "distance_km": 10},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["days_left"] == 900 and body["priority"] == "A"
    past = (today - timedelta(days=1)).isoformat()
    assert (
        client.post(
            "/goals", json={"name": "test-p", "race_date": past, "distance_km": 10}
        ).status_code
        == 422
    )
    patched = client.patch(
        f"/goals/{body['id']}", json={"target_time_sec": 2400}
    ).json()
    assert patched["target_time_sec"] == 2400
    assert client.delete(f"/goals/{body['id']}").status_code == 204
    assert client.patch(f"/goals/{body['id']}", json={"name": "x"}).status_code == 404


class TestNextGoal:
    """One SQL row, the same choice as filtering every goal in Python."""

    def test_past_and_cancelled_races_are_skipped(self):
        goals.create_goal(name="test-past", race_date=FAR, distance_km=10)
        cancelled = goals.create_goal(
            name="test-cancelled", race_date=FAR + timedelta(days=1), distance_km=10
        )
        goals.update_goal(cancelled.id, status="cancelled")
        later = goals.create_goal(
            name="test-later", race_date=FAR + timedelta(days=2), distance_km=10
        )
        assert goals.next_goal(FAR + timedelta(days=1)) == later

    def test_a_race_today_is_still_next(self):
        today = goals.create_goal(name="test-today", race_date=FAR, distance_km=10)
        assert goals.next_goal(FAR) == today

    def test_without_an_a_race_the_soonest_other_wins(self):
        soon = goals.create_goal(
            name="test-c", race_date=FAR, distance_km=10, priority="C"
        )
        goals.create_goal(
            name="test-b",
            race_date=FAR + timedelta(days=3),
            distance_km=10,
            priority="B",
        )
        assert goals.next_goal(FAR - timedelta(days=1)) == soon

    def test_none_when_nothing_is_ahead(self):
        goals.create_goal(name="test-gone", race_date=FAR, distance_km=10)
        assert goals.next_goal(FAR + timedelta(days=1)) is None

    def test_one_statement(self, monkeypatch, statement_log):
        import duckdb

        goals.create_goal(name="test-one", race_date=FAR, distance_km=10)
        real = duckdb.connect
        monkeypatch.setattr(
            duckdb, "connect", lambda *a, **k: statement_log.wrap(real(*a, **k))
        )
        goals.next_goal(FAR - timedelta(days=1))
        assert [s for s in statement_log if "visible_goals" in s] == [statement_log[-1]]

    def test_a_hybrid_block_is_never_the_next_race(self):
        start = FAR - timedelta(weeks=9)
        goals.create_goal(
            name="test-block",
            race_date=goals.hybrid_end_window(8, start)[0],
            goal_type="hybrid",
            details={"weeks": 8},
            today=start,
        )
        hyrox = goals.create_goal(
            name="test-hyrox",
            race_date=FAR + timedelta(days=20),
            goal_type="hyrox",
            details={"category": "men"},
            priority="B",
        )
        assert goals.next_goal(FAR - timedelta(days=1)) == hyrox


class TestGoalTypes:
    def test_a_hyrox_goal_runs_8_km_and_keeps_its_details(self):
        g = goals.create_goal(
            name="test-hyrox",
            race_date=FAR,
            distance_km=21.1,  # ignored: a Hyrox is 8 km of running
            goal_type="hyrox",
            details={"format": "doubles", "category": "mixed", "equipment": ["sled"]},
        )
        assert (g.goal_type, g.distance_km) == ("hyrox", 8.0)
        assert g.details == {
            "division": "open",
            "format": "doubles",
            "category": "mixed",
            "equipment": ["sled"],
            "weeks": 12,
        }
        assert goals.get_goal(g.id) == g
        updated = goals.update_goal(
            g.id, details={**g.details, "division": "pro", "category": "women"}
        )
        assert updated is not None and updated.details["division"] == "pro"

    def test_a_road_race_is_unchanged(self):
        g = goals.create_goal(name="test-road", race_date=FAR, distance_km=10)
        assert (g.goal_type, g.details) == ("race", None)
        assert g.to_dict()["goal_type"] == "race"

    @pytest.mark.parametrize(
        ("goal_type", "details", "message"),
        [
            ("hyrox", {}, "catégorie Hyrox"),
            ("hyrox", {"category": "mixed"}, "Mixte se court en Duo"),
            (
                "hyrox",
                {"category": "mixed", "format": "doubles", "division": "pro"},
                "Mixte se court en Open, pas en Pro",
            ),
            ("hyrox", {"category": "men", "division": "elite"}, "Open ou Pro"),
            ("hyrox", {"category": "kids"}, "Hommes, Femmes ou Mixte"),
            ("hyrox", {"category": "men", "format": "trio"}, "Solo ou Duo"),
            # A hybrid block takes a category too, for its station loads.
            ("hybrid", {"category": "unknown"}, "Hommes, Femmes ou Mixte"),
            ("hyrox", {"category": "men", "equipment": ["none", "sled"]}, "matériel"),
            ("hybrid", {"weeks": 10}, "8 ou 12 semaines"),
            ("hybrid", {"color": "red"}, "Détail inconnu"),
            ("race", {"weeks": 8}, "ne s’appliquent qu’aux"),
            ("trail", None, "type d’objectif"),
        ],
    )
    def test_invalid_details_are_refused_in_french(self, goal_type, details, message):
        with pytest.raises(ValueError, match=message):
            goals.create_goal(
                name="test-bad",
                race_date=FAR,
                distance_km=10,
                goal_type=goal_type,
                details=details,
            )

    def test_a_hyrox_distance_cannot_be_edited(self):
        g = goals.create_goal(
            name="test-hyrox",
            race_date=FAR,
            goal_type="hyrox",
            details={"category": "women"},
        )
        with pytest.raises(ValueError, match="ne se modifie pas"):
            goals.update_goal(g.id, distance_km=10)

    def test_the_routes_validate_types_in_french(self, router_client, monkeypatch):
        from arete.api import goals as api
        from arete.api.goals import router

        today = FAR - timedelta(days=900)
        monkeypatch.setattr(api, "athlete_today", lambda: today)
        client = router_client(router)
        body = {"name": "test-api-hyrox", "race_date": FAR.isoformat()}
        created = client.post(
            "/goals",
            json={**body, "goal_type": "hyrox", "details": {"category": "women"}},
        )
        assert created.status_code == 201
        assert created.json()["goal_type"] == "hyrox"
        assert created.json()["distance_km"] == 8.0
        refused = client.post(
            "/goals", json={**body, "goal_type": "hyrox", "details": {}}
        )
        assert refused.status_code == 422 and "catégorie" in refused.json()["detail"]
        no_distance = client.post("/goals", json=body)
        assert no_distance.status_code == 422
        assert "distance" in no_distance.json()["detail"]
        patched = client.patch(
            f"/goals/{created.json()['id']}", json={"details": {"weeks": 9}}
        )
        assert patched.status_code == 422 and "semaines" in patched.json()["detail"]

    def test_patching_details_replaces_them_whole(self):
        g = goals.create_goal(
            name="test-hyrox",
            race_date=FAR,
            goal_type="hyrox",
            details={"division": "pro", "category": "women", "equipment": ["sled"]},
        )
        updated = goals.update_goal(g.id, details={"category": "men"})
        # Not merged: what the new details omit takes its default again.
        assert updated is not None and updated.details == {
            "division": "open",
            "format": "solo",
            "category": "men",
            "equipment": ["none"],
            "weeks": 12,
        }

    def test_a_hybrid_block_ends_a_whole_block_from_next_monday(self):
        today = FAR - timedelta(days=FAR.weekday() + 3)  # a Friday
        earliest, latest = goals.hybrid_end_window(8, today)
        assert earliest.weekday() == 6 and (earliest - today).days == 3 + 8 * 7 - 1
        assert latest == earliest + timedelta(weeks=2)
        for end in (earliest, latest):
            block = goals.create_goal(
                name="test-block",
                race_date=end,
                goal_type="hybrid",
                details={"weeks": 8},
                today=today,
            )
            assert (block.goal_type, block.distance_km) == ("hybrid", 0.0)
        with pytest.raises(ValueError, match="La fin du bloc doit tomber un dimanche"):
            goals.create_goal(
                name="test-block",
                race_date=earliest + timedelta(days=6),
                goal_type="hybrid",
                details={"weeks": 8},
                today=today,
            )
        for end in (earliest - timedelta(weeks=1), latest + timedelta(weeks=1)):
            with pytest.raises(ValueError, match="La fin du bloc doit tomber entre"):
                goals.create_goal(
                    name="test-block",
                    race_date=end,
                    goal_type="hybrid",
                    details={"weeks": 8},
                    today=today,
                )

    def test_the_routes_word_hybrid_and_plan_errors_in_french(
        self, router_client, monkeypatch
    ):
        from arete.api import goals as api
        from arete.api.goals import router

        today = FAR - timedelta(days=900)
        monkeypatch.setattr(api, "athlete_today", lambda: today)
        client = router_client(router)
        past = client.post(
            "/goals",
            json={
                "name": "test-block",
                "race_date": (today - timedelta(days=1)).isoformat(),
                "goal_type": "hybrid",
                "details": {"weeks": 8},
            },
        )
        assert (
            past.status_code == 422
            and past.json()["detail"] == "La fin du bloc est passée"
        )
        early = client.post(
            "/goals",
            json={
                "name": "test-block",
                "race_date": (today + timedelta(weeks=4)).isoformat(),
                "goal_type": "hybrid",
                "details": {"weeks": 8},
            },
        )
        assert early.status_code == 422 and "La fin du bloc" in early.json()["detail"]
        soon = goals.create_goal(
            name="test-hyrox-soon",
            race_date=athlete_today() + timedelta(weeks=3),
            goal_type="hyrox",
            details={"category": "women"},
        )
        with patch(
            "arete.services.coaching_rules.rule_facts",
            return_value=SimpleNamespace(acwr=None, tsb=None),
        ):
            resp = client.post(f"/goals/{soon.id}/plan/preview")
        assert (
            resp.status_code == 422 and "moins de 6 semaines" in resp.json()["detail"]
        )

    def test_patching_a_block_s_dates_checks_its_window(self, monkeypatch):
        today = athlete_today()
        end = goals.hybrid_end_window(8, today)[0]
        block = goals.create_goal(
            name="test-block",
            race_date=end,
            goal_type="hybrid",
            details={"weeks": 8},
            today=today,
        )
        # Not started yet: the creation window holds.
        with pytest.raises(ValueError, match="doit tomber entre"):
            goals.update_goal(block.id, race_date=end + timedelta(weeks=3))
        later = goals.update_goal(block.id, race_date=end + timedelta(weeks=1))
        assert later is not None
        end = later.race_date
        # Three weeks on, the block runs.
        running = today + timedelta(weeks=3)
        monkeypatch.setattr(goals, "athlete_today", lambda: running)
        renamed = goals.update_goal(
            block.id,
            name="test-block-renamed",
            details={"weeks": 8, "equipment": ["sled"]},
        )
        assert renamed is not None and renamed.race_date == end
        with pytest.raises(ValueError, match="déjà commencé ne se modifie pas"):
            goals.update_goal(block.id, details={"weeks": 12})
        with pytest.raises(ValueError, match="un dimanche"):
            goals.update_goal(block.id, race_date=end + timedelta(days=1))
        with pytest.raises(ValueError, match="bloc commencé doit tomber entre"):
            goals.update_goal(block.id, race_date=end + timedelta(weeks=3))
        past_sunday = running - timedelta(days=running.weekday() + 1)
        with pytest.raises(ValueError, match="bloc commencé doit tomber entre"):
            goals.update_goal(block.id, race_date=past_sunday)

    def test_a_running_block_may_be_postponed_two_weeks(self, monkeypatch):
        today = athlete_today()
        end = goals.hybrid_end_window(8, today)[0]
        block = goals.create_goal(
            name="test-block",
            race_date=end,
            goal_type="hybrid",
            details={"weeks": 8},
            today=today,
        )
        monkeypatch.setattr(goals, "athlete_today", lambda: today + timedelta(weeks=4))
        postponed = goals.update_goal(block.id, race_date=end + timedelta(weeks=2))
        assert postponed is not None
        assert postponed.race_date == end + timedelta(weeks=2)

    def test_a_goal_keeps_its_date(self, router_client):
        from arete.api.goals import router

        g = goals.create_goal(name="test-road", race_date=FAR, distance_km=10)
        with pytest.raises(ValueError, match="garde toujours la date"):
            goals.update_goal(g.id, race_date=None)
        resp = router_client(router).patch(f"/goals/{g.id}", json={"race_date": None})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Un objectif garde toujours la date."
