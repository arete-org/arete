"""The browser's complete editor writes atomically and rejects stale screens."""

import pytest

from arete.api.garmin import router
from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main
from arete.garmin.repository import GarminRepository
from arete.services.garmin_export import statuses


@pytest.fixture
def planning_client(tmp_path, monkeypatch, router_client):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "planning.duckdb"))
    main()
    return router_client(router)


BASE = {
    "date": "2027-01-12",
    "sport": "running",
    "session_type": "endurance",
    "description": "Endurance douce",
    "target_duration_min": 45,
    "source": "manual",
}
STEPS = {
    "version": 1,
    "steps": [{"kind": "effort", "duration_kind": "seconds", "value": 2700}],
}


def test_atomic_structured_create_and_versioned_edit_move_status_delete(
    planning_client,
):
    client = planning_client
    created = client.post("/garmin/planned", json={**BASE, "prescription": STEPS})
    assert created.status_code == 201, created.text
    session = created.json()
    identifier = session["id"]
    path = f"/garmin/planned/{identifier}"
    assert session["target_duration_min"] is None
    assert session["prescription"]["steps"][0]["value"] == 2700
    changes = {
        "revision": session["revision"],
        "date": "2027-01-14",
        "session_type": "endurance",
        "description": "Endurance déplacée",
        "prescription": {**STEPS, "steps": [{**STEPS["steps"][0], "value": 3600}]},
    }
    updated = client.put(path, json=changes)
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == session["revision"] + 1
    assert updated.json()["date"] == "2027-01-14"
    assert updated.json()["prescription"]["steps"][0]["value"] == 3600
    assert client.put(path, json=changes).status_code == 409
    assert (
        client.patch(path, json={"revision": 1, "status": "completed"}).status_code
        == 409
    )
    assert client.delete(f"{path}?revision=1").status_code == 409
    completed = client.patch(path, json={"revision": 2, "status": "completed"})
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    assert client.delete(f"{path}?revision=3").status_code == 200
    assert GarminRepository().get_planned_session(identifier) is None


def test_invalid_steps_leave_no_partial_session(planning_client):
    response = planning_client.post(
        "/garmin/planned", json={**BASE, "prescription": {"steps": []}}
    )
    assert response.status_code == 422
    assert planning_client.get("/garmin/planned").json() == []


def test_manual_strength_steps_do_not_require_model_grammar_evidence(planning_client):
    prescription = {
        "steps": [
            {
                "kind": "effort",
                "duration_kind": "reps",
                "value": 8,
                "exercise": "Squat",
                "weight_kg": 40,
            }
        ]
    }
    result = planning_client.post(
        "/garmin/planned",
        json={**BASE, "sport": "strength", "prescription": prescription},
    )
    assert result.status_code == 201, result.text
    result = planning_client.put(
        f"/garmin/planned/{result.json()['id']}",
        json={
            "revision": 1,
            "date": BASE["date"],
            "session_type": "strength",
            "description": "Force",
            "prescription": prescription,
        },
    )
    assert result.status_code == 200, result.text


def test_stale_delete_cannot_mark_garmin_for_removal(planning_client):
    session = planning_client.post("/garmin/planned", json=BASE).json()
    identifier = session["id"]
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.garmin_exports (session_id, operation_id, state, phase, intended_payload, intended_date) VALUES (?, 'test', 'scheduled', 'scheduled', ?, ?)",
            [identifier, '{"workoutName":"Endurance douce"}', BASE["date"]],
        )
    assert (
        planning_client.delete(f"/garmin/planned/{identifier}?revision=8").status_code
        == 409
    )
    assert statuses()[0]["state"] == "scheduled"
    assert (
        planning_client.delete(f"/garmin/planned/{identifier}?revision=1").status_code
        == 200
    )
    remaining = statuses()[0]
    assert remaining["state"] == "pending_removal"
    assert remaining["deleted"] is True
    assert remaining["description"] == BASE["description"]
    assert remaining["date"] == BASE["date"]
