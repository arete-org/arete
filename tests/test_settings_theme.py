"""Theme preferences round-trip through the HTTP and persistence boundaries."""

import pytest

from arete.api.settings import router
from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_db
from arete.services.athlete_scope import resolve_athlete_id


@pytest.fixture(autouse=True)
def settings_database(tmp_path, monkeypatch):
    # Other suites intentionally leave legacy settings in the shared database.
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "settings.duckdb"))
    init_db()


@pytest.mark.parametrize("theme", ["system", "pierre", "prune", "odyssey", "encre"])
def test_theme_round_trip(router_client, theme):
    client = router_client(router)
    original = client.get("/settings").json()
    try:
        response = client.put("/settings", json={**original, "theme": theme})
        assert response.status_code == 200, response.text
        assert response.json()["theme"] == theme
        assert client.get("/settings").json()["theme"] == theme
    finally:
        assert client.put("/settings", json=original).status_code == 200


def test_a_fresh_database_follows_the_device(router_client):
    assert router_client(router).get("/settings").json()["theme"] == "system"


@pytest.mark.parametrize(
    ("stored", "read"),
    [
        ("light", "pierre"),
        ("performance", "pierre"),
        ("dark", "encre"),
        ("darker", "encre"),
        ("abyss", "encre"),
        ("odyssey", "odyssey"),
        ("unknown", "system"),
        (None, "system"),
    ],
)
def test_a_stored_retired_theme_reads_as_its_replacement(router_client, stored, read):
    # No migration rewrites the rows: the read maps them, the next save stores it.
    client = router_client(router)
    original = client.get("/settings").json()
    with connect() as con:
        con.execute(
            "UPDATE app.user_settings SET theme = ? WHERE user_id = ?",
            [stored, resolve_athlete_id()],
        )
    assert client.get("/settings").json()["theme"] == read
    saved = client.put("/settings", json={**original, "theme": read})
    assert saved.status_code == 200, saved.text
    with connect() as con:
        row = con.execute(
            "SELECT theme FROM app.user_settings WHERE user_id = ?",
            [resolve_athlete_id()],
        ).fetchone()
    assert row == (read,)


def test_an_older_tab_saving_a_retired_theme_stores_its_replacement(router_client):
    client = router_client(router)
    original = client.get("/settings").json()
    response = client.put("/settings", json={**original, "theme": "darker"})
    assert response.status_code == 200, response.text
    assert response.json()["theme"] == "encre"


def test_unknown_theme_is_rejected(router_client):
    client = router_client(router)
    original = client.get("/settings").json()
    response = client.put("/settings", json={**original, "theme": "unknown"})
    assert response.status_code == 422
    assert client.get("/settings").json() == original
