"""A session's terrain and weather: stored once, read by the page and the coach.

Open-Meteo is never called: the fetcher is injected, or httpx gets a mock
transport.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import httpx
import pytest

from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams
from arete.services import session_conditions as conditions
from arete.services.weather import (
    ARCHIVE_URL,
    FORECAST_URL,
    Weather,
    fetch_weather,
)

START = datetime(2031, 7, 4, 7, 40)
CHAMONIX = (45.9237, 6.8694)


def _climb(n: int = 2400) -> ActivityStreams:
    """40 min up at 1440 m/h from 1035 m, with a GPS trace."""
    return ActivityStreams(
        t=list(range(n)),
        altitude_m=[1035.0 + 0.4 * i for i in range(n)],
        distance_m=[1.0 * i for i in range(n)],
        lat=[CHAMONIX[0] + i * 1e-5 for i in range(n)],
        lon=[CHAMONIX[1]] * n,
    )


def _weather(**overrides) -> Weather:
    values = {
        "observed_at": datetime(2031, 7, 4, 8, 0),
        "temperature_c": 24.5,
        "humidity_pct": 61.0,
        "wind_kmh": 9.4,
        "elevation_m": 1042.0,
        "source": "open-meteo-archive",
        **overrides,
    }
    return Weather(**values)


@pytest.fixture
def make_session():
    repo = GarminRepository()
    created: list[int] = []

    def make(streams: ActivityStreams | None = None, **fields) -> int:
        values = {
            "date": START.date(),
            "sport": "running",
            "duration_sec": 2400,
            "distance_m": 2400,
            "avg_pace_sec_km": 1000,
            "ascent_m": 960,
            "source": ActivitySource.GARMIN_CONNECT,
            "start_time": START,
            **fields,
        }
        session_id = repo.create_actual_session(ActualSession(**values))
        created.append(session_id)
        if streams is not None:
            repo.save_activity_streams(session_id, streams)
        return session_id

    yield make
    for session_id in created:
        repo.delete_actual_session(session_id)


class Recorder:
    """A fetcher that records its calls."""

    def __init__(self, result: Weather | None = None, error: Exception | None = None):
        self.calls: list[tuple] = []
        self.result = result if result is not None else _weather()
        self.error = error

    def __call__(self, lat, lon, start, *, utc):
        self.calls.append((round(lat, 4), round(lon, 4), start, utc))
        if self.error:
            raise self.error
        return self.result


# ---------------------------------------------------------------------------
# Open-Meteo client
# ---------------------------------------------------------------------------


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _answer(times: list[str]) -> dict:
    return {
        "elevation": 1042.0,
        "hourly": {
            "time": times,
            "temperature_2m": [20.0 + i for i in range(len(times))],
            "relative_humidity_2m": [60] * len(times),
            "wind_speed_10m": [5.5] * len(times),
        },
    }


class TestWeatherClient:
    def test_an_old_session_reads_the_archive_at_the_nearest_hour(self):
        seen: list[httpx.URL] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url)
            return httpx.Response(
                200, json=_answer([f"2031-07-04T{h:02d}:00" for h in range(24)])
            )

        weather = fetch_weather(
            *CHAMONIX, START, utc=False, today=date(2031, 8, 1), client=_client(handler)
        )
        assert weather is not None
        assert weather.observed_at == datetime(2031, 7, 4, 8, 0)  # 7:40 -> 8:00
        assert weather.temperature_c == 28.0 and weather.humidity_pct == 60.0
        assert weather.elevation_m == 1042.0 and weather.source == "open-meteo-archive"
        (url,) = seen
        assert str(url).startswith(ARCHIVE_URL)
        assert url.params["timezone"] == "auto"
        assert url.params["start_date"] == url.params["end_date"] == "2031-07-04"

    def test_a_recent_fit_upload_reads_the_forecast_in_utc(self):
        seen: list[httpx.URL] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url)
            return httpx.Response(200, json=_answer(["2031-07-04T08:00"]))

        weather = fetch_weather(
            *CHAMONIX, START, utc=True, today=date(2031, 7, 5), client=_client(handler)
        )
        assert weather is not None and weather.source == "open-meteo-forecast"
        assert str(seen[0]).startswith(FORECAST_URL)
        assert seen[0].params["timezone"] == "GMT"

    @pytest.mark.parametrize(
        "handler",
        [
            lambda request: httpx.Response(503),
            lambda request: httpx.Response(200, text="not json"),
            lambda request: httpx.Response(200, json={"hourly": {"time": []}}),
            lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
        ],
        ids=["http-error", "garbage", "hour-missing", "timeout"],
    )
    def test_failures_are_none_never_an_exception(self, handler):
        assert (
            fetch_weather(*CHAMONIX, START, utc=False, client=_client(handler)) is None
        )


# ---------------------------------------------------------------------------
# Enrichment at sync, storage, reads
# ---------------------------------------------------------------------------


class TestEnrich:
    def test_terrain_and_weather_are_stored_once(self, make_session):
        session_id = make_session(_climb())
        fetch = Recorder()
        counts = conditions.enrich_sessions([session_id], fetch=fetch)
        assert counts == {"terrain": 1, "weather": 1}
        # Garmin's start is local; the start point is the first GPS fix.
        assert fetch.calls == [(*CHAMONIX, START, False)]

        terrain = conditions.get_terrain(session_id)
        assert terrain is not None
        assert terrain["vam"]["30"] == pytest.approx(1440, rel=0.02)
        assert terrain["gap_sec_km"] < 1000  # a 40 % climb is worth far more
        weather = conditions.get_weather(session_id)
        assert weather is not None and weather["temperature_c"] == 24.5
        # The watch's altitude, not the weather grid's 1042 m
        assert weather["start_altitude_m"] == pytest.approx(1035, abs=1)

        conditions.enrich_sessions([session_id], fetch=fetch)
        assert len(fetch.calls) == 1  # the weather is fetched once

    def test_a_file_import_is_read_on_the_local_clock(self, make_session):
        # The import stores its start on the athlete's clock, as Garmin does.
        session_id = make_session(
            _climb(), source=ActivitySource.GPX_FILE, start_lat=45.0, start_lon=6.0
        )
        fetch = Recorder()
        conditions.enrich_sessions([session_id], fetch=fetch)
        assert fetch.calls == [(45.0, 6.0, START, False)]

    def test_a_failing_fetch_never_fails_the_caller(self, make_session):
        session_id = make_session(_climb())
        counts = conditions.enrich_sessions(
            [session_id, 987654321], fetch=Recorder(error=RuntimeError("down"))
        )
        assert counts == {"terrain": 1, "weather": 0}
        assert conditions.get_weather(session_id) is None

    def test_a_spent_budget_skips_the_weather_not_the_terrain(self, make_session):
        session_id = make_session(_climb())
        fetch = Recorder()
        counts = conditions.enrich_sessions([session_id], fetch=fetch, budget_sec=0)
        assert counts == {"terrain": 1, "weather": 0} and fetch.calls == []

    def test_no_streams_no_place_nothing_to_do(self, make_session):
        session_id = make_session()
        fetch = Recorder()
        assert conditions.enrich_sessions([session_id], fetch=fetch) == {
            "terrain": 0,
            "weather": 0,
        }
        assert fetch.calls == []

    def test_a_ride_gets_weather_but_no_running_terrain(self, make_session):
        session_id = make_session(_climb(), sport="cycling")
        counts = conditions.enrich_sessions([session_id], fetch=Recorder())
        assert counts == {"terrain": 0, "weather": 1}

    def test_deleting_the_session_deletes_both_rows(self, make_session):
        session_id = make_session(_climb())
        conditions.enrich_sessions([session_id], fetch=Recorder())
        GarminRepository().delete_actual_session(session_id)
        assert conditions.get_terrain(session_id) is None
        assert conditions.get_weather(session_id) is None


class TestBackfill:
    def test_sessions_kept_before_get_their_terrain_in_bounded_batches(
        self, make_session
    ):
        ids = [
            make_session(_climb(), date=START.date() - timedelta(days=i))
            for i in range(3)
        ]
        first = conditions.backfill_terrain(2)
        assert first["processed"] == 2 and first["remaining"] >= 1
        conditions.backfill_terrain(conditions.BACKFILL_LIMIT)
        assert all(conditions.get_terrain(i) is not None for i in ids)
        assert conditions.backfill_terrain(conditions.BACKFILL_LIMIT)["remaining"] == 0

    def test_an_older_model_version_is_recomputed(self, make_session, monkeypatch):
        session_id = make_session(_climb())
        conditions.backfill_terrain(conditions.BACKFILL_LIMIT)
        monkeypatch.setattr(conditions.tr, "MODEL_VERSION", 99)
        assert conditions.backfill_terrain(conditions.BACKFILL_LIMIT)["remaining"] == 0
        assert conditions.get_terrain(session_id) is not None

    def test_the_endpoint_is_bounded(self, client):
        assert client.post("/analytics/terrain/backfill?limit=500").status_code == 422
        response = client.post("/analytics/terrain/backfill?limit=5")
        assert response.status_code == 200 and "remaining" in response.json()


class TestReads:
    def test_the_page_and_the_coach_get_gap_climbing_and_weather(self, make_session):
        from arete.services.activity_detail import (
            activity_detail_for_model,
            analysis_lines,
            get_activity_detail,
        )

        session_id = make_session(_climb())
        conditions.enrich_sessions([session_id], fetch=Recorder())

        detail = get_activity_detail(session_id)
        assert detail is not None
        assert detail["terrain"]["gap_sec_km"] < 1000
        assert detail["weather"]["humidity_pct"] == 61.0

        digest = activity_detail_for_model(session_id)
        assert digest["gap_sec_km"] == detail["terrain"]["gap_sec_km"]
        assert digest["vam_best_m_h"]["30min"] == detail["terrain"]["vam"]["30"]
        assert digest["weather"]["temperature_c"] == 24.5
        assert "observed_at" not in digest["weather"] and "streams" not in digest
        assert len(json.dumps(digest)) < 4000

        lines = analysis_lines(session_id)
        assert any(line.startswith("Allure ajustée à la pente") for line in lines)
        assert any(line.startswith("Météo au départ : 24 °C") for line in lines)

    def test_a_session_without_conditions_reads_none(self, make_session):
        from arete.services.activity_detail import get_activity_detail

        detail = get_activity_detail(make_session())
        assert detail is not None
        assert detail["terrain"] is None and detail["weather"] is None


def test_the_sync_endpoint_enriches_what_it_imported(router_client):
    from unittest.mock import MagicMock, patch

    from arete.api import garmin_sync

    sync_client = MagicMock()
    sync_client.is_authenticated.return_value = True
    sync_client.sync_activities.return_value = MagicMock(
        success=True,
        activities_synced=2,
        activities_merged=0,
        activities_matched=0,
        activities_skipped=0,
        errors=[],
        last_activity_date=None,
        session_ids=[7, 8],
    )
    from arete.garmin.sync import SyncResult

    sync_client.iter_sync_activities.return_value = (
        event for event in [SyncResult(success=True, session_ids=[7, 8])]
    )
    with (
        patch("arete.garmin.token_store.session_status", return_value=(True, None)),
        patch("arete.garmin.sync.GarminSyncClient", return_value=sync_client),
        patch(
            "arete.services.session_conditions.enrich_sessions",
            return_value={"terrain": 0, "weather": 0},
        ) as enrich,
    ):
        response = router_client(garmin_sync.router).post(
            "/garmin/sync/activities", json={"start_date": "2026-10-01"}
        )
    assert response.status_code == 200
    enrich.assert_called_once()
    assert enrich.call_args.args == ([7, 8],)
    assert enrich.call_args.kwargs["budget_sec"] <= 20
