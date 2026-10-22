"""Analytics API: the overview bundle, session CRUD."""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.api.analytics import router
from arete.dataio.db import connect
from arete.dataio.queries import (
    OverviewRow,
    daily_loads,
    daily_tss,
    overview_rows,
)
from arete.services import analytics, settings

# TODAY is read at collection, the services read the clock when a test runs: a
# run crossing the athlete's midnight saw two days (ARE-169). Every test runs at
# the instant TODAY comes from (``_one_instant``).
NOW = settings.utc_now()
# The test athlete stores no timezone, so the services read the default one
# (Europe/Paris): zone_of(None) is that zone.
TODAY = NOW.astimezone(settings.zone_of(None)).date()

CARD_KEYS = {
    "volume",
    "pmc",
    "zones",
    "sports",
    "decoupling",
    "pace",
    "elevation",
    "cadence",
    "vam",
    "descent",
    "risk",
    "weeks",
    "readiness",
    "hrv",
    "sleep",
    "resting_hr",
}


@pytest.fixture(autouse=True)
def _one_instant(monkeypatch):
    monkeypatch.setattr(settings, "utc_now", lambda: NOW)


@pytest.fixture
def client(router_client):
    return router_client(router)


@pytest.fixture
def stub_queries():
    """Patch every SELECT the overview makes; each test sets what it needs."""
    targets = {
        "overview_rows": [],
        "drift_rows": [],
        "daily_metrics_range": [],
        "earliest_session_date": None,
        "terrain_rows": [],
        "fetch_window": [],
        "record_rows": [],
        "lift_effort_rows": [],
    }
    patches = {
        name: patch(f"arete.services.analytics.{name}", return_value=value)
        for name, value in targets.items()
    }
    mocks = {name: p.start() for name, p in patches.items()}
    with patch("arete.services.analytics.db_connection"):
        yield mocks
    for p in patches.values():
        p.stop()


def _row(day: date, sport: str = "running", duration_sec: int = 3600, **kw):
    fields = {
        "distance_m": None,
        "hr_zones_json": None,
        "avg_pace_sec_km": None,
        "avg_hr": None,
        "rpe": None,
        "ascent_m": None,
        "avg_cadence": None,
        "tss": 0.0,
    }
    return OverviewRow(day, sport, duration_sec, **(fields | kw))


class TestOverview:
    def test_returns_every_card(self, client, stub_queries):
        resp = client.get("/analytics/overview?period=30d")
        assert resp.status_code == 200
        data = resp.json()
        assert data["period"] == "30d"
        assert data["bucket"] == "day"
        assert set(data["cards"]) == CARD_KEYS

    def test_unknown_period_falls_back_to_30d(self, client, stub_queries):
        data = client.get("/analytics/overview?period=xyz").json()
        assert data["period"] == "30d"

    def test_long_period_switches_bucket(self, client, stub_queries):
        assert client.get("/analytics/overview?period=90d").json()["bucket"] == "week"
        assert client.get("/analytics/overview?period=1y").json()["bucket"] == "month"

    def test_all_period_has_no_previous_window(self, client, stub_queries):
        stub_queries["earliest_session_date"].return_value = TODAY - timedelta(days=200)
        data = client.get("/analytics/overview?period=all").json()
        assert data["start"] == (TODAY - timedelta(days=200)).isoformat()
        assert data["prev_start"] is None

    def test_volume_card_uses_sessions(self, client, stub_queries):
        stub_queries["overview_rows"].return_value = [
            _row(TODAY - timedelta(days=40), distance_m=8000.0),
            _row(TODAY - timedelta(days=1), distance_m=12000.0),
        ]
        card = client.get("/analytics/overview?period=30d").json()["cards"]["volume"]
        assert card["headline"]["value"] == 12.0
        assert card["headline"]["previous"] == 8.0
        assert len(card["series"]) == 30

    def test_pmc_card_reads_sessions_from_the_first_one_on(self, client, stub_queries):
        # The chart walks the whole history, like the dashboard and the tip.
        stub_queries["earliest_session_date"].return_value = TODAY - timedelta(days=200)
        stub_queries["overview_rows"].return_value = [
            _row(TODAY - timedelta(days=i), tss=60.0) for i in range(200, -1, -1)
        ]
        data = client.get("/analytics/overview?period=30d").json()
        _con, start, end = stub_queries["overview_rows"].call_args.args
        assert (start, end) == (TODAY - timedelta(days=200), TODAY)
        assert data["cards"]["pmc"]["headline"]["value"] > 0

    def test_sports_card_compares_windows(self, client, stub_queries):
        stub_queries["overview_rows"].return_value = [
            _row(TODAY - timedelta(days=40), duration_sec=4 * 3600),
            _row(TODAY - timedelta(days=3), duration_sec=6 * 3600),
            _row(TODAY - timedelta(days=2), "strength", duration_sec=2 * 3600),
        ]
        card = client.get("/analytics/overview?period=30d").json()["cards"]["sports"]
        assert card["headline"]["value"] == 8.0
        assert card["headline"]["previous"] == 4.0

    def test_terrain_cards_read_foot_sports_and_runs(self, client, stub_queries):
        stub_queries["overview_rows"].return_value = [
            _row(
                TODAY - timedelta(days=1),
                distance_m=10000.0,
                ascent_m=120.0,
                avg_cadence=174,
                avg_pace_sec_km=300,
            ),
            _row(TODAY - timedelta(days=2), "hiking", ascent_m=500.0, avg_cadence=110),
            _row(TODAY - timedelta(days=3), "cycling", ascent_m=900.0, avg_cadence=88),
        ]
        cards = client.get("/analytics/overview?period=30d").json()["cards"]
        assert cards["elevation"]["headline"]["value"] == 620
        assert cards["cadence"]["headline"]["value"] == 174

    def test_the_pace_trend_reads_gap_on_hilly_runs_only(self, client, stub_queries):
        run = {"distance_m": 10000.0, "avg_pace_sec_km": 400, "gap_sec_km": 330}
        stub_queries["overview_rows"].return_value = [
            _row(TODAY - timedelta(days=1), ascent_m=600.0, **run),  # 60 m/km
            _row(TODAY - timedelta(days=2), ascent_m=40.0, **run),  # 4 m/km: flat
            _row(
                TODAY - timedelta(days=3),
                ascent_m=600.0,
                distance_m=10000.0,
                avg_pace_sec_km=400,
            ),  # no streams: no GAP
        ]
        card = client.get("/analytics/overview?period=30d").json()["cards"]["pace"]
        assert card["secondary"][0]["value"] == 400.0  # median of 330, 400, 400
        assert sum(p["n_graded"] for p in card["series"]) == 1

    def test_climbing_records_are_all_time_descents_are_runs(
        self, client, stub_queries
    ):
        from arete.dataio.queries import TerrainRow

        bands = json.dumps(
            [
                {"min": -2, "max": 2, "sec": 600, "m": 2000},
                {"min": -15, "max": -10, "sec": 300, "m": 1200},
            ]
        )
        stub_queries["terrain_rows"].return_value = [
            TerrainRow(
                1, TODAY - timedelta(days=300), "Brévent", "running", {30: 1300}, None
            ),
            TerrainRow(
                2, TODAY - timedelta(days=2), "Lac Blanc", "hiking", {30: 1100}, bands
            ),
            TerrainRow(
                3, TODAY - timedelta(days=1), "Petit Balcon", "running", {}, bands
            ),
        ]
        cards = client.get("/analytics/overview?period=30d").json()["cards"]
        assert cards["vam"]["headline"]["value"] == 1100
        assert cards["vam"]["secondary"][0]["value"] == 1300
        # The hike's descent is not running: only one run's bands count.
        steep = next(p for p in cards["descent"]["series"] if p["min"] == -15)
        assert steep["minutes"] == 5

    def test_no_data_still_renders_cards(self, client, stub_queries):
        cards = client.get("/analytics/overview?period=7d").json()["cards"]
        assert cards["volume"]["headline"]["value"] == 0.0
        assert cards["hrv"]["headline"]["value"] is None
        assert all(
            len(c["series"]) in (0, 7)
            for key, c in cards.items()
            if key != "vam"  # one point per climbing duration
        )

    def test_overview_costs_eight_statements_on_one_cursor(
        self, client, monkeypatch, statement_log
    ):
        real = analytics.db_connection

        @contextmanager
        def counting_connection(*args, **kwargs):
            with real(*args, **kwargs) as con:
                yield statement_log.wrap(con)

        monkeypatch.setattr(analytics, "db_connection", counting_connection)
        assert client.get("/analytics/overview?period=30d").status_code == 200
        # The cards' five, the readiness window, the best efforts and the lifts.
        assert len(statement_log) == 8


class TestOverviewSeries:
    """The Python slices of the wide read equal the SQL series they replace."""

    @pytest.fixture
    def seeded(self):
        con = connect()
        con.execute("DELETE FROM app.actual_sessions WHERE source = 'test'")
        for day, duration, rpe, hr in (
            (date(2029, 3, 1), 3600, 6, None),
            (date(2029, 3, 1), 1830, None, 150),
            (date(2029, 3, 4), 2400, None, None),
        ):
            con.execute(
                "INSERT INTO app.actual_sessions "
                "(user_id, date, sport, duration_sec, rpe, avg_hr, source) "
                "VALUES (1, ?, 'run', ?, ?, ?, 'test')",
                [day, duration, rpe, hr],
            )
        yield con, date(2029, 2, 27), date(2029, 3, 5)
        con.execute("DELETE FROM app.actual_sessions WHERE source = 'test'")
        con.close()

    def test_daily_tss_matches_the_sql_series(self, seeded):
        con, start, end = seeded
        rows = overview_rows(con, start, end)
        expected = daily_tss(con, start, end)
        got = analytics._daily_tss(rows, start, end)
        assert [t.date for t in got] == [t.date for t in expected]
        assert [t.tss for t in got] == pytest.approx([t.tss for t in expected])

    def test_overview_rows_carry_the_stored_gap(self, seeded):
        con, start, end = seeded
        (session_id,) = con.execute(
            "SELECT id FROM app.actual_sessions WHERE source = 'test' "
            "ORDER BY date LIMIT 1"
        ).fetchone()
        con.execute(
            "INSERT INTO app.activity_terrain "
            "(actual_session_id, model_version, gap_sec_km) VALUES (?, 1, 287)",
            [session_id],
        )
        try:
            rows = overview_rows(con, start, end)
        finally:
            con.execute(
                "DELETE FROM app.activity_terrain WHERE actual_session_id = ?",
                [session_id],
            )
        assert sorted(r.gap_sec_km or 0 for r in rows) == [0, 0, 287]

    def test_daily_loads_match_the_sql_series(self, seeded):
        con, start, end = seeded
        rows = overview_rows(con, start, end)
        assert analytics._daily_loads(rows, start, end) == daily_loads(con, start, end)


class TestRecordsEndpoint:
    def test_the_records_endpoint_is_gone(self, client):
        # Its best efforts all came from Strava (ARE-126); the records now come
        # from Garmin streams, inside the overview (ARE-139).
        assert client.get("/analytics/records").status_code == 404


class TestSessionUpdate:
    @patch("arete.services.analytics.connect")
    def test_update_rpe_and_notes(self, mock_connect, client):
        mock_conn = mock_connect.return_value
        resp = client.patch(
            "/analytics/sessions/42", json={"rpe": 7, "notes": "Felt good"}
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True
        mock_conn.execute.assert_called_once()

    @patch("arete.services.analytics.connect")
    def test_null_rpe_clears_it(self, mock_connect, client):
        mock_conn = mock_connect.return_value
        resp = client.patch("/analytics/sessions/42", json={"rpe": None})
        assert resp.status_code == 200
        sql, params = mock_conn.execute.call_args.args
        assert "rpe = ?" in sql and "notes" not in sql
        assert params == [None, 42]

    def test_out_of_range_rpe_and_unknown_session_are_refused(self, client):
        from arete.garmin.models import ActualSession
        from arete.garmin.repository import GarminRepository

        repo = GarminRepository()
        own = repo.create_actual_session(
            ActualSession(date=date(2031, 5, 6), sport="running", duration_sec=60)
        )
        try:
            path = f"/analytics/sessions/{own}"
            for rpe in (0, 11):
                assert client.patch(path, json={"rpe": rpe}).status_code == 422
            # Not this athlete's session (or none): nothing written, not a success.
            missing = client.patch(
                f"/analytics/sessions/{own + 10_000}", json={"rpe": 6}
            )
            assert missing.status_code == 404
            assert client.patch(path, json={"rpe": 10}).json() == {"success": True}
        finally:
            repo.delete_actual_session(own)

    @patch("arete.services.analytics.connect")
    def test_update_empty_body(self, mock_connect, client):
        mock_conn = mock_connect.return_value
        resp = client.patch("/analytics/sessions/42", json={})
        assert resp.status_code == 200
        mock_conn.execute.assert_not_called()


class TestListSessions:
    @patch("arete.services.analytics.db_connection")
    def test_returns_sessions(self, mock_db, client):
        con = mock_db.return_value.__enter__.return_value
        con.execute.return_value.fetchall.return_value = [
            (
                1,
                date(2026, 5, 10),
                "run",
                "Morning Run",
                3600,
                10000,
                145,
                320,
                7,
                "Great",
                "strava",
                450,
            ),
        ]
        sessions = client.get("/analytics/sessions").json()["sessions"]
        assert sessions[0]["name"] == "Morning Run"
        assert sessions[0]["pace_display"] == "5:20 /km"


class TestRemovedEndpoints:
    @pytest.mark.parametrize(
        "path",
        [
            "/analytics/volume",
            "/analytics/training-load",
            "/analytics/pace",
            "/analytics/hr-zones",
            "/analytics/sport-distribution",
            "/analytics/best-efforts",
            "/analytics/cardiac-efficiency",
            "/analytics/hr-pace-scatter",
            "/analytics/hr-drift",
        ],
    )
    def test_per_card_endpoints_are_gone(self, client, path):
        assert client.get(path).status_code == 404
