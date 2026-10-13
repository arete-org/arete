"""Deterministic RPG projection and commands; one durable server-owned economy."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal, TypedDict
from uuid import uuid4
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from arete.config import config
from arete.dataio.db import db_connection, transaction

MAX_EVENTS = 100
MAX_WEEK_ACTIVITIES = 1000
RANKS = (
    (1, "Novice"),
    (3, "Initié"),
    (6, "Adepte"),
    (10, "Expert"),
    (15, "Maître"),
    (20, "Légende"),
)
CLASSES = {
    "scout": "Éclaireur",
    "sentinel": "Sentinelle",
    "colossus": "Colosse",
    "pioneer": "Pionnier",
}


class CatalogItem(TypedDict):
    id: str
    name: str
    price: int
    level: int


CATALOG: tuple[CatalogItem, ...] = (
    {"id": "base", "name": "Tenue d’origine", "price": 0, "level": 1},
    {"id": "cape", "name": "Cape d’adepte", "price": 0, "level": 6},
    {"id": "eclipse", "name": "Éclipse", "price": 300, "level": 1},
    {"id": "sovereign", "name": "Souverain", "price": 600, "level": 1},
)


class GameError(ValueError):
    """A visible operating failure, never silently substituted with a zero."""


class Preference(BaseModel):
    enabled: bool
    version: int = Field(ge=0)


class Appearance(BaseModel):
    athlete_class: Literal["scout", "sentinel", "colossus", "pioneer"]
    silhouette: Literal["slender", "balanced", "broad"]
    version: int = Field(ge=0)


class Purchase(BaseModel):
    key: str = Field(min_length=8, max_length=80)
    skin: Literal["base", "cape", "eclipse", "sovereign"]
    expected_price: int = Field(ge=0, le=600)


class Equip(BaseModel):
    skin: Literal["base", "cape", "eclipse", "sovereign"]
    version: int = Field(ge=0)


def level_for(xp: int) -> int:
    return max(n for n in range(1, 21) if 50 * n * (n - 1) <= max(0, xp))


def _profile(con):
    row = con.execute(
        "SELECT enabled,version,CAST(activated_at AS VARCHAR),athlete_class,silhouette,equipped FROM app.visible_game_profile WHERE id=1"
    ).fetchone()
    assert row is not None
    return row


def preference() -> dict:
    with db_connection() as con:
        p = _profile(con)
    return {
        "enabled": bool(p[0] and config.gamification_available),
        "opted_in": p[0],
        "available": config.gamification_available,
        "version": p[1],
    }


def _require(con):
    p = _profile(con)
    if not config.gamification_available or not p[0]:
        raise GameError("La gamification est désactivée.")
    return p


def _lock(con) -> None:
    # DuckDB rejects overlapping writers on this row. Never retry a failed write.
    con.execute(
        "UPDATE app.game_profile SET version=version WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id=1) "
    )


def _today(con) -> tuple[date, str, int]:
    row = con.execute(
        "SELECT timezone,weekly_training_goal FROM app.visible_user_settings WHERE user_id = getvariable('arete_athlete_id')"
    ).fetchone()
    zone, goal = row or ("Europe/Paris", 6)
    return datetime.now(ZoneInfo(zone)).date(), zone, goal


def set_preference(command: Preference) -> dict:
    with transaction() as con:
        _lock(con)
        p = _profile(con)
        if command.version != p[1]:
            raise GameError("Les réglages ont changé. Actualise avant de réessayer.")
        if command.enabled and not config.gamification_available:
            raise GameError("Cette fonctionnalité est indisponible sur ce déploiement.")
        if p[0] != command.enabled:
            now = datetime.now(UTC)
            con.execute(
                "UPDATE app.game_profile SET enabled=?,version=version+1,activated_at=coalesce(activated_at,?) WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id=1) ",
                [command.enabled, now],
            )
            if command.enabled:
                con.execute(
                    "INSERT INTO app.game_periods (started_at) VALUES (?)", [now]
                )
                day, zone, goal = _today(con)
                con.execute(
                    "INSERT INTO app.game_weeks (week_start,goal,timezone) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                    [day - timedelta(days=day.weekday()), goal, zone],
                )
            else:
                con.execute(
                    "UPDATE app.game_periods SET ended_at=? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (ended_at IS NULL) ",
                    [now],
                )
    return preference()


def _balance(con) -> tuple[int, int]:
    row = con.execute(
        "SELECT coalesce(sum(xp),0),coalesce(sum(shards),0) FROM app.visible_game_ledger"
    ).fetchone()
    assert row is not None
    return int(row[0]), int(row[1])


#: A strength session linked to an actual one whose evidence still has its own
#: canonical identity: the projection must resolve it before counting.
_UNRESOLVED_LINK = """SELECT 1 FROM app.visible_game_events e, app.visible_strength_sessions s,
    app.visible_game_events a WHERE e.source_key='strength:'||s.id
    AND a.source_key='actual:'||s.actual_session_id AND e.canonical_key<>a.canonical_key
    LIMIT 1"""


def _receipts(con, week: date, targets: list[tuple[str, int, int, str]]) -> list[list]:
    """Ledger rows that bring each cause's total to its target, in order.

    One query for the week's causes; a cause appears at most once per week.
    """
    sums = {
        cause: (xp, shards)
        for cause, xp, shards in con.execute(
            "SELECT cause,coalesce(sum(xp),0),coalesce(sum(shards),0) FROM app.visible_game_ledger WHERE cause IN (SELECT unnest(?)) GROUP BY cause",
            [[cause for cause, *_ in targets]],
        ).fetchall()
    }
    rows = []
    for cause, xp, shards, label in targets:
        old_xp, old_shards = sums.get(cause, (0, 0))
        dx, ds = xp - old_xp, shards - old_shards
        if dx or ds:
            rows.append(
                [
                    str(uuid4()),
                    cause,
                    week,
                    dx,
                    ds,
                    label
                    if dx >= 0 and ds >= 0
                    else "Correction de doublon · " + label,
                ]
            )
    return rows


def _week(con, week: date, today: date) -> tuple[dict, list[list]]:
    """The week's summary and the receipts it is missing. Reads only."""
    goal, zone = con.execute(
        "SELECT goal,timezone FROM app.visible_game_weeks WHERE week_start=?", [week]
    ).fetchone()
    rows = con.execute(
        "SELECT canonical_key,bool_or(eligible),min(name),epoch(min(created_at)) FROM app.visible_game_events GROUP BY canonical_key HAVING min(week_start)=? ORDER BY min(created_at),canonical_key LIMIT ?",
        [week, MAX_WEEK_ACTIVITIES + 1],
    ).fetchall()
    if len(rows) > MAX_WEEK_ACTIVITIES:
        raise GameError("Trop d’activités dans cette semaine : projection suspendue.")
    # Canonical aliases are durable. A late link reverses the duplicate, even after purchase.
    count = 0
    targets = []
    for key, eligible, name, _ in rows:
        rewarded = eligible and count < 6
        targets.append(
            ("activity:" + key, 50 if rewarded else 0, 10 if rewarded else 0, name)
        )
        count += int(eligible)
    live = {cause for cause, *_ in targets}
    old = con.execute(
        "SELECT DISTINCT cause FROM app.visible_game_ledger WHERE week_start=? AND starts_with(cause,'activity:') LIMIT ?",
        [week, MAX_WEEK_ACTIVITIES + 1],
    ).fetchall()
    targets += [
        (cause, 0, 0, "Séance rapprochée") for (cause,) in old if cause not in live
    ]
    # A prescribed rest counts once per planned session and only after its day.
    rest = con.execute(
        """SELECT count(DISTINCT d.planned_session_id) FROM app.visible_plan_decisions d
        WHERE d.date>=? AND d.date<? AND d.date<=? AND d.decision='rest'
        AND d.applied_at IS NOT NULL AND d.reverted_at IS NULL
        AND EXISTS (SELECT 1 FROM app.visible_game_periods p WHERE d.applied_at>=p.started_at AND (p.ended_at IS NULL OR d.applied_at<p.ended_at))
        AND NOT EXISTS (SELECT 1 FROM app.visible_actual_sessions a WHERE a.planned_session_id=d.planned_session_id)
        """,
        [week, week + timedelta(days=7), today],
    ).fetchone()[0]
    complete = count + rest >= goal
    targets.append(
        (
            "week:" + week.isoformat(),
            200 if complete else 0,
            40 if complete else 0,
            "Objectif hebdomadaire respecté",
        )
    )
    receipts = _receipts(con, week, targets)
    # The receipts this week will hold once written: the live ones it adds too.
    held = {cause for (cause,) in old} | {
        r[1] for r in receipts if r[1].startswith("activity:")
    }
    if len(held) > MAX_WEEK_ACTIVITIES:
        raise GameError("Trop de reçus dans cette semaine.")
    summary = {
        "start": str(week),
        "goal": goal,
        "sessions": count,
        "credited": min(count, 6),
        "rest": rest,
        "completed": min(count + rest, goal),
        "complete": complete,
        "timezone": zone,
    }
    return summary, receipts


def _current_week(con, day: date) -> date | None:
    """This week, when an opted-in athlete has its row (frozen goal)."""
    current = day - timedelta(days=day.weekday())
    if (
        _profile(con)[0]
        and con.execute(
            "SELECT 1 FROM app.visible_game_weeks WHERE week_start=?", [current]
        ).fetchone()
    ):
        return current
    return None


def _owns_cape(con) -> bool:
    return bool(
        con.execute("SELECT 1 FROM app.visible_game_owned WHERE skin='cape'").fetchone()
    )


def _due(con) -> bool:
    """Whether a projection would write anything. Reads only, takes no lock.

    Pending evidence, an unresolved strength link, a current week whose
    receipts differ from its rules (a rest decision applied since) or a cape
    earned but not owned.
    """
    if con.execute(
        "SELECT 1 FROM app.visible_game_events WHERE NOT processed LIMIT 1"
    ).fetchone():
        return True
    if con.execute(_UNRESOLVED_LINK).fetchone():
        return True
    day, _, _ = _today(con)
    current = _current_week(con, day)
    if current is not None and _week(con, current, day)[1]:
        return True
    return level_for(_balance(con)[0]) >= 6 and not _owns_cape(con)


def sync() -> dict:
    """Explicit bounded projection. Reads never quietly credit a receipt.

    With nothing to settle it writes nothing and takes no lock: a page that
    asks twice, or two tabs at once, read the same snapshot.
    """
    if not config.gamification_available:
        raise GameError("Gamification indisponible sur ce déploiement.")
    with db_connection() as con:
        if not _due(con):
            return _snapshot(con)
    with transaction() as con:
        _lock(con)
        # An opted-out athlete may settle evidence captured before opting out.
        day, _, _ = _today(con)
        balance_before = _balance(con)
        pending = con.execute(
            "SELECT source_key,week_start FROM app.visible_game_events WHERE NOT processed ORDER BY created_at,source_key LIMIT ?",
            [MAX_EVENTS],
        ).fetchall()
        weeks = {w for _, w in pending}
        current = _current_week(con, day)
        if current is not None:
            weeks.add(current)
        # Resolve existing strength ↔ actual links before counting or debiting.
        if con.execute(_UNRESOLVED_LINK).fetchone():
            con.execute(
                """UPDATE app.game_events e SET canonical_key=a.canonical_key
                FROM app.visible_strength_sessions s, app.visible_game_events a
                WHERE e.athlete_id = getvariable('arete_athlete_id') AND e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=e.athlete_id AND scope_owner.deleted_at IS NULL) AND (e.source_key='strength:'||s.id AND a.source_key='actual:'||s.actual_session_id
                AND e.canonical_key<>a.canonical_key) """
            )
        # A duplicate imported with another date must settle its original week too.
        if pending:
            keys = [key for key, _ in pending]
            original_weeks = con.execute(
                "SELECT min(week_start) FROM app.visible_game_events WHERE canonical_key IN (SELECT canonical_key FROM app.visible_game_events WHERE source_key IN (SELECT unnest(?))) GROUP BY canonical_key",
                [keys],
            ).fetchall()
            weeks.update(w for (w,) in original_weeks)
        for week in sorted(weeks):
            if con.execute(
                "SELECT 1 FROM app.visible_game_weeks WHERE week_start=?", [week]
            ).fetchone():
                for receipt in _week(con, week, day)[1]:
                    con.execute(
                        "INSERT INTO app.game_ledger (id,cause,week_start,xp,shards,label) VALUES (?,?,?,?,?,?)",
                        receipt,
                    )
        if pending:
            con.execute(
                "UPDATE app.game_events SET processed=true WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key IN (SELECT unnest(?))) ",
                [[key for key, _ in pending]],
            )
        xp, _ = _balance(con)
        if level_for(xp) >= 6 and not _owns_cape(con):
            con.execute(
                "INSERT INTO app.game_owned (skin) VALUES ('cape') ON CONFLICT DO NOTHING"
            )
        if pending or _balance(con) != balance_before:
            con.execute(
                "UPDATE app.game_profile SET version=version+1 WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id=1) "
            )
    return snapshot()


def snapshot(offset: int = 0) -> dict:
    with db_connection() as con:
        return _snapshot(con, offset)


def _snapshot(con, offset: int = 0) -> dict:
    p = _profile(con)
    xp, shards = _balance(con)
    day, zone, goal = _today(con)
    week = day - timedelta(days=day.weekday())
    frozen = con.execute(
        "SELECT goal FROM app.visible_game_weeks WHERE week_start=?", [week]
    ).fetchone()
    counts = con.execute(
        "SELECT count(*),count(*) FILTER(WHERE week_start=?) FROM (SELECT canonical_key,min(week_start) AS week_start FROM app.visible_game_events GROUP BY canonical_key HAVING bool_or(eligible))",
        [week],
    ).fetchone()
    owned = {
        r[0] for r in con.execute("SELECT skin FROM app.visible_game_owned").fetchall()
    }
    rows = con.execute(
        "SELECT id,cause,week_start,xp,shards,label,CAST(created_at AS VARCHAR) FROM app.visible_game_ledger ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?",
        [offset],
    ).fetchall()
    pending_row = con.execute(
        "SELECT count(*) FROM app.visible_game_events WHERE NOT processed"
    ).fetchone()
    assert pending_row is not None
    pending = pending_row[0]
    bonus_row = con.execute(
        "SELECT coalesce(sum(xp),0) FROM app.visible_game_ledger WHERE cause=?",
        ["week:" + str(week)],
    ).fetchone()
    assert bonus_row is not None and counts is not None
    bonus = bonus_row[0]
    level = level_for(xp)
    rank = next(name for n, name in reversed(RANKS) if level >= n)
    return {
        "enabled": bool(p[0] and config.gamification_available),
        "available": config.gamification_available,
        "version": p[1],
        "athlete_class": p[3],
        "silhouette": p[4],
        "equipped": p[5],
        "xp": max(0, xp),
        "shards": shards,
        "level": level,
        "rank": rank,
        "in_level": max(0, xp) - 50 * level * (level - 1),
        "level_span": 100 * level if level < 20 else None,
        "sessions": counts[0],
        "week": {
            "sessions": counts[1],
            "goal": frozen[0] if frozen else goal,
            "complete": bonus > 0,
            "timezone": zone,
        },
        "pending": pending,
        "catalog": [{**item, "owned": item["id"] in owned} for item in CATALOG],
        "badges": [
            {"sessions": n, "unlocked": counts[0] >= n} for n in (5, 20, 50, 100)
        ],
        "history": [
            dict(
                zip(
                    ("id", "cause", "week", "xp", "shards", "label", "created_at"),
                    r,
                    strict=True,
                )
            )
            for r in rows[:50]
        ],
        "has_more": len(rows) > 50,
    }


def purchase(command: Purchase) -> dict:
    fingerprint = json.dumps(command.model_dump(exclude={"key"}), sort_keys=True)
    with transaction() as con:
        _lock(con)
        _require(con)
        if con.execute(
            "SELECT 1 FROM app.visible_game_events WHERE NOT processed LIMIT 1"
        ).fetchone():
            raise GameError("Actualise la progression avant cet achat.")
        old = con.execute(
            "SELECT fingerprint,result FROM app.visible_game_commands WHERE key=?",
            [command.key],
        ).fetchone()
        if old:
            if old[0] != fingerprint:
                raise GameError("Cette clé d’achat appartient à une autre commande.")
            result: dict[str, Any] = json.loads(old[1])
            return result
        item = next(i for i in CATALOG if i["id"] == command.skin)
        if item["price"] != command.expected_price:
            raise GameError("Le prix a changé. Actualise la collection.")
        if con.execute(
            "SELECT 1 FROM app.visible_game_owned WHERE skin=?", [command.skin]
        ).fetchone():
            result = {"skin": command.skin, "charged": 0}
        else:
            xp, shards = _balance(con)
            if level_for(xp) < item["level"]:
                raise GameError("Le rang nécessaire n’est pas encore atteint.")
            if shards < item["price"]:
                raise GameError("Solde d’Éclats insuffisant.")
            con.execute("INSERT INTO app.game_owned (skin) VALUES (?)", [command.skin])
            con.execute(
                "INSERT INTO app.game_ledger (id,cause,xp,shards,label) VALUES (?,?,0,?,?)",
                [
                    str(uuid4()),
                    "purchase:" + command.key,
                    -item["price"],
                    "Achat · " + str(item["name"]),
                ],
            )
            result = {"skin": command.skin, "charged": item["price"]}
        con.execute(
            "INSERT INTO app.game_commands (key,fingerprint,result) VALUES (?,?,?)",
            [command.key, fingerprint, json.dumps(result)],
        )
        con.execute(
            "UPDATE app.game_profile SET version=version+1 WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id=1) "
        )
    return result


def equip(command: Equip) -> dict:
    with transaction() as con:
        _lock(con)
        p = _require(con)
        if p[1] != command.version:
            raise GameError("Le profil a changé. Actualise-le.")
        if not con.execute(
            "SELECT 1 FROM app.visible_game_owned WHERE skin=?", [command.skin]
        ).fetchone():
            raise GameError("Cette tenue n’est pas possédée.")
        con.execute(
            "UPDATE app.game_profile SET equipped=?,version=version+1 WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id=1) ",
            [command.skin],
        )
    return snapshot()


def appearance(command: Appearance) -> dict:
    with transaction() as con:
        _lock(con)
        p = _require(con)
        if p[1] != command.version:
            raise GameError("Le profil a changé. Actualise-le.")
        con.execute(
            "UPDATE app.game_profile SET athlete_class=?,silhouette=?,version=version+1 WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id=1) ",
            [command.athlete_class, command.silhouette],
        )
    return snapshot()
