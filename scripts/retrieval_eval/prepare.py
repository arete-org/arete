"""Frozen synthetic corpus builder. Run deliberately; never regenerate during tuning."""

import hashlib
import json
import random
from datetime import date, timedelta
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[2]
QUESTIONS = [
    (
        "volume",
        "De combien de mètres mon volume de course a-t-il changé entre le 1–15 septembre et le 16–30 septembre 2026 ? Réponds deuxième période moins première.",
        "sessions",
        "distance_m",
        "sum",
        {"sport": "running"},
    ),
    (
        "pace",
        "De combien de secondes/km mon allure moyenne par séance de course a-t-elle changé entre le 1–15 septembre et le 16–30 septembre 2026 ? Réponds deuxième période moins première.",
        "sessions",
        "pace_sec_km",
        "avg",
        {"sport": "running"},
    ),
    (
        "sleep",
        "Quelle est mon allure moyenne par séance de course après moins de 6 heures de sommeil en septembre 2026 ?",
        "sessions",
        "pace_sec_km",
        "avg",
        {"sport": "running", "sleep_duration_sec__lt": 21600},
    ),
    (
        "hrv",
        "Quelle est la moyenne quotidienne de VFC mesurée en septembre 2026, sans compter plusieurs fois les jours à deux séances ?",
        "days",
        "hrv",
        "avg",
        {},
    ),
    (
        "adherence",
        "Quelle proportion de mes séances prévues en septembre 2026 est réalisée ? Donne une fraction entre 0 et 1.",
        "plans",
        "completed",
        "avg",
        {},
    ),
    (
        "terrain",
        "Quelle est mon allure ajustée à la pente moyenne par séance de course avec plus de 200 m de dénivelé positif en septembre 2026 ?",
        "sessions",
        "gap_sec_km",
        "avg",
        {"sport": "running", "ascent_m__gt": 200},
    ),
    (
        "heat",
        "Quelle est ma fréquence cardiaque moyenne par séance de course à plus de 25 degrés en septembre 2026 ?",
        "sessions",
        "avg_hr",
        "avg",
        {"sport": "running", "temperature_c__gt": 25},
    ),
    (
        "strength",
        "Quel volume total de musculation ai-je soulevé en septembre 2026, en kg répétitions ?",
        "strength",
        "volume_kg",
        "sum",
        {},
    ),
    (
        "feedback",
        "Combien de séances réalisées en septembre 2026 ont un retour du coach ?",
        "sessions",
        "has_feedback",
        "sum",
        {},
    ),
    (
        "lookup",
        "Quelle distance en mètres faisait ma séance nommée Sortie des crêtes en septembre 2026 ?",
        "sessions",
        "distance_m",
        "sum",
        {"name": "Sortie des crêtes"},
    ),
]


def matches(row, filters):
    for key, expected in filters.items():
        field, _, op = key.partition("__")
        value = row.get(field)
        if (
            value is None
            or (
                value < expected
                if op == "lt"
                else value > expected
                if op == "gt"
                else value == expected
            )
            is False
        ):
            return False
    return True


def build():
    cases = []
    for seed in range(6):
        rng = random.Random(31000 + seed)
        days, sessions, plans, strength = [], [], [], []
        for d in range(30):
            day = (date(2026, 9, 1) + timedelta(days=d)).isoformat()
            sleep = None if d % 7 == 0 else rng.randint(18000, 32000)
            hrv = None if d % 9 == 0 else rng.randint(35, 85)
            days.append(
                dict(id=f"day:{day}", date=day, sleep_duration_sec=sleep, hrv=hrv)
            )
            for n in range(2 if d % 3 == 0 else 1):
                sid = seed * 1000 + len(sessions) + 1
                running = n == 0
                pace = rng.randint(280, 410) if running else None
                sessions.append(
                    dict(
                        id=f"actual:{sid}",
                        session_id=sid,
                        date=day,
                        sport="running" if running else "cycling",
                        name="Sortie des crêtes"
                        if d == 10
                        else "Footing"
                        if running
                        else "Vélo",
                        distance_m=rng.randint(4, 18) * 1000,
                        duration_sec=rng.randint(1800, 7200),
                        pace_sec_km=pace,
                        avg_hr=rng.randint(125, 168),
                        ascent_m=rng.randint(0, 500),
                        gap_sec_km=pace - 20 if pace else None,
                        temperature_c=rng.randint(12, 32),
                        sleep_duration_sec=sleep,
                        hrv=hrv,
                        has_feedback=int(d % 4 == 0),
                        feedback="Effort régulier (interprétation du coach)."
                        if d % 4 == 0
                        else None,
                        planned_id=f"planned:{sid}",
                        day_id=f"day:{day}",
                        source="garmin_connect",
                    )
                )
                plans.append(
                    dict(
                        id=f"planned:{sid}",
                        date=day,
                        completed=int(d % 5 != 0),
                        actual_id=f"actual:{sid}" if d % 5 != 0 else None,
                    )
                )
            if d % 4 == 0:
                strength.append(
                    dict(
                        id=f"strength:{seed * 100 + d}",
                        date=day,
                        volume_kg=rng.randint(1000, 4000),
                    )
                )
        tables = dict(sessions=sessions, days=days, plans=plans, strength=strength)
        for name, question, entity, metric, agg, filters in QUESTIONS:
            rows = [
                r
                for r in tables[entity]
                if matches(r, filters) and r[metric] is not None
            ]
            values = [r[metric] for r in rows]
            value = sum(values) if agg == "sum" else mean(values)
            if name in {"volume", "pace"}:
                first = [r[metric] for r in rows if r["date"] <= "2026-09-15"]
                second = [r[metric] for r in rows if r["date"] > "2026-09-15"]
                value = (
                    (sum(second) - sum(first))
                    if agg == "sum"
                    else (mean(second) - mean(first))
                )
            cases.append(
                dict(
                    id=f"{seed}-{name}",
                    split="development" if seed < 4 else "validation",
                    question=question,
                    tables=tables,
                    expected=dict(value=value, sources=[r["id"] for r in rows]),
                    oracle=dict(
                        entity=entity,
                        metric=metric,
                        aggregate=agg,
                        filters=filters,
                        difference=name in {"volume", "pace"},
                    ),
                )
            )
    return cases


if __name__ == "__main__":
    path = ROOT / "tests/data/session_retrieval_cases.jsonl"
    payload = "".join(
        json.dumps(c, ensure_ascii=False, sort_keys=True) + "\n" for c in build()
    )
    path.write_text(payload)
    (path.with_suffix(".sha256")).write_text(
        hashlib.sha256(payload.encode()).hexdigest() + "\n"
    )
    print(f"Frozen {len(build())} cases: {path}")
