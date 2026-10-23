"""Real ledger and context boundaries; no external model or Garmin calls."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from arete.dataio.db import db_connection
from arete.services import memory, onboarding
from arete.services.athlete_scope import athlete_scope


@pytest.fixture(autouse=True)
def clean_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path))
    with db_connection() as con:
        con.execute("DELETE FROM app.coach_memory_files")
        con.execute("DELETE FROM app.coach_memory_imports")
    yield
    with db_connection() as con:
        con.execute("DELETE FROM app.coach_memory_files")
        con.execute("DELETE FROM app.coach_memory_imports")


def command(**answers):
    return onboarding.ConfirmOnboarding(
        command_id=uuid4(), expected_revision=0, answers=onboarding.Answers(**answers)
    )


def test_http_confirmation_is_the_same_md_seen_by_composite_backend_and_context(
    router_client,
):
    from arete.agent.backends.journal import LedgerBackend
    from arete.agent.context.builder import build_context
    from arete.api.onboarding import router

    client = router_client(router)
    body = command(
        display_name="Camille",
        goal="race",
        race_name="Trail des crêtes",
        race_date="2027-05-16",
        sports=["running", "strength"],
        weekly_training_goal=3,
        rest_day_preference=["wednesday", "sunday"],
        constraints="Pas disponible mercredi",
        timezone="Europe/Paris",
    )
    assert client.get("/onboarding").json() == {"revision": 0, "status": "not_started"}
    response = client.post("/onboarding", json=body.model_dump(mode="json"))
    assert response.status_code == 200
    assert response.json() == {"revision": 1, "status": "completed"}
    content = client.get("/onboarding/context").json()["content"]
    assert '- Course envisagée : "Trail des crêtes" · 2027-05-16' in content
    assert "- Sports pratiqués : course à pied, renforcement" in content
    assert "- Jours de repos préférés : mercredi, dimanche" in content
    assert "Non précisé" not in content and "Précisions" not in content
    file = memory.read_file("profile.md")
    assert file.content == content
    assert "/profile.md" in LedgerBackend().files()
    request = MagicMock()
    request.runtime.context = None
    request.state, request.tools, request.system_message = {}, [], None
    build_context(request)
    prompt = request.override.call_args.kwargs["system_message"].text
    assert "Trail des crêtes" in prompt and "Pas disponible mercredi" in prompt
    assert '"Camille"' in prompt and "3" in prompt


def test_retries_do_not_duplicate_and_forgotten_profile_cannot_be_resurrected():
    body = command(goal="restart")
    first = onboarding.confirm(body)
    assert onboarding.confirm(body) == first
    assert memory.read_file("profile.md").content.count("Mon point de départ") == 1
    memory.delete_file("profile.md")
    with pytest.raises(memory.MemoryConflict, match="avec le coach"):
        onboarding.confirm(body)
    assert onboarding.confirmed_context()["content"] == ""
    assert onboarding.get_progress()["status"] == "completed"


def test_edit_is_visible_on_next_context_and_does_not_keep_a_hidden_copy():
    from arete.services.coach_today import reference
    from arete.services.journal import journal_block

    onboarding.confirm(command(constraints="Mercredi indisponible"))
    memory.edit_file("profile.md", "Mercredi indisponible", "Vendredi indisponible")
    assert "Vendredi indisponible" in journal_block()
    assert "Mercredi indisponible" not in reference("onboarding:1")["record"]["content"]


def test_the_recap_states_a_race_intention_only_for_a_race_goal():
    text = onboarding.render_answers(onboarding.Answers(goal="progress"))
    assert "Objectif : Progresser" in text
    assert "intention" not in text and "Course envisagée" not in text
    assert (
        "Ce qui n’y figure pas reste inconnu : rien n’est supposé à sa place." in text
    )


def test_blank_answers_render_the_intro_alone():
    assert onboarding.render_answers(onboarding.Answers()) == (
        "Réponses confirmées par l’athlète. Ce qui n’y figure pas reste inconnu : rien n’est supposé à sa place."
    )


def test_scope_isolation_and_blank_answers_do_not_create_defaults_or_plan():
    from arete.services.settings import get_settings

    with db_connection() as con:
        con.execute(
            "INSERT INTO app.athletes(id) VALUES (909001) ON CONFLICT DO NOTHING"
        )
    before = get_settings().model_dump()
    onboarding.confirm(command(goal="race"))
    assert get_settings().model_dump() == before
    text = memory.read_file("profile.md").content
    # Unanswered questions are left out of the recap the athlete reads.
    assert "Non précisé" not in text and "Course envisagée" not in text
    assert "Séances souhaitées" not in text and "Contraintes" not in text
    assert "Objectif : Préparer une course" in text
    assert (
        "Ce qui n’y figure pas reste inconnu : rien n’est supposé à sa place." in text
    )
    assert "peak" not in text
    with athlete_scope(909001):
        assert onboarding.get_progress()["status"] == "not_started"
        assert onboarding.confirmed_context()["content"] == ""
        onboarding.confirm(command(display_name="Autre athlète"))
    assert "Autre athlète" not in memory.read_file("profile.md").content


def test_failure_leaves_no_partial_confirmation(monkeypatch):
    original = memory._write

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise OSError("interrupted")

    monkeypatch.setattr(memory, "_write", fail_after_write)
    with pytest.raises(OSError):
        onboarding.confirm(command(goal="progress"))
    assert onboarding.get_progress() == {"revision": 0, "status": "not_started"}


def test_two_confirmations_cannot_overwrite_each_other():
    memory.ensure_imported()

    def save(name):
        try:
            return onboarding.confirm(command(display_name=name))
        except memory.MemoryConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ["Premier", "Second"]))
    assert results.count("conflict") == 1
    assert memory.read_file("profile.md").revision == 1


def test_validation_and_profile_growth_fail_explicitly(router_client):
    from arete.api.onboarding import router

    client = router_client(router)
    base = command().model_dump(mode="json")
    for answers in (
        {"weekly_training_goal": 0},
        {"weekly_training_goal": 15},
        {"timezone": "Wrong/Zone"},
        {"constraints": "x" * 281},
        {"goal": "peak"},
        {"race_name": "Trail"},
        {"athlete_id": 2},
    ):
        assert (
            client.post("/onboarding", json={**base, "answers": answers}).status_code
            == 422
        )
    onboarding.confirm(command())
    file = memory.read_file("profile.md")
    with pytest.raises(ValueError, match="Profil trop long"):
        memory.replace_file(
            "profile.md", "x" * (memory.MAX_PROFILE_CHARS + 1), file.revision
        )
    assert memory.read_file("profile.md").content == file.content
