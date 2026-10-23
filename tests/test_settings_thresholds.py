"""Cycling FTP and swimming CSS round-trip through the settings boundaries."""

from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from arete.api.settings import router
from arete.dataio.init_duckdb import main as init_db
from arete.dataio.settings import get_user_settings


@pytest.fixture(autouse=True)
def settings_database(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "thresholds.duckdb"))
    init_db()


def test_ftp_and_css_round_trip_and_clear(router_client):
    client = router_client(router)
    original = client.get("/settings").json()
    assert original["ftp_w"] is None and original["css_sec_100m"] is None

    saved = client.put("/settings", json={**original, "ftp_w": 245, "css_sec_100m": 98})
    assert saved.status_code == 200, saved.text
    assert (saved.json()["ftp_w"], saved.json()["css_sec_100m"]) == (245, 98)
    again = client.get("/settings").json()
    assert (again["ftp_w"], again["css_sec_100m"]) == (245, 98)

    # An explicit null clears one; the other stays as sent.
    cleared = client.put("/settings", json={**again, "ftp_w": None})
    assert cleared.status_code == 200, cleared.text
    assert (cleared.json()["ftp_w"], cleared.json()["css_sec_100m"]) == (None, 98)


def test_a_tab_without_the_fields_keeps_the_stored_values(router_client):
    client = router_client(router)
    original = client.get("/settings").json()
    client.put("/settings", json={**original, "ftp_w": 200, "css_sec_100m": 110})
    older = {k: v for k, v in original.items() if k not in ("ftp_w", "css_sec_100m")}
    response = client.put("/settings", json={**older, "display_name": "Ana"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["display_name"], body["ftp_w"], body["css_sec_100m"]) == (
        "Ana",
        200,
        110,
    )


@pytest.mark.parametrize(
    "field",
    [{"ftp_w": 49}, {"ftp_w": 601}, {"css_sec_100m": 59}, {"css_sec_100m": 301}],
)
def test_out_of_bounds_values_are_refused(router_client, field):
    client = router_client(router)
    original = client.get("/settings").json()
    response = client.put("/settings", json={**original, **field})
    assert response.status_code == 422
    assert client.get("/settings").json() == original


def test_a_garmin_threshold_update_keeps_ftp_and_css(router_client):
    from arete.garmin.threshold import ThresholdReading, refresh_threshold

    client = router_client(router)
    original = client.get("/settings").json()
    client.put("/settings", json={**original, "ftp_w": 260, "css_sec_100m": 92})
    reading = ThresholdReading(
        heart_rate=171, pace_sec_km=255, measured_on=date(2026, 10, 1)
    )
    with patch("arete.garmin.threshold.parse_threshold", return_value=reading):
        assert refresh_threshold(MagicMock())["updated"]
    stored = get_user_settings() or {}
    assert stored["lthr"] == 171
    assert (stored["ftp_w"], stored["css_sec_100m"]) == (260, 92)
