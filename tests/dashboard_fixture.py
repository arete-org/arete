"""A realistic training history around one fixture day, for dashboard tests.

Two years of mixed sessions (RPE, Strava suffer score, HR-only, none), logged
strength sessions with their sets, Garmin nights, and today's plan, decision,
follow-up, goal and briefing. Deterministic: the same day gives the same rows.
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta


def seed_history(con, today: date, *, days: int = 730, label: str = "") -> None:
    """Insert the history ending ``today`` for the connection's athlete."""
    rng = random.Random(f"{today}{label}")
    con.execute(
        "INSERT OR REPLACE INTO app.user_settings (user_id, display_name, timezone,"
        " weekly_training_goal, lthr) VALUES (getvariable('arete_athlete_id'), ?,"
        " 'Europe/Paris', 5, 168)",
        [f"Fixture{label}"],
    )
    rows = []
    for offset in range(days, 0, -1):
        day = today - timedelta(days=offset)
        if rng.random() < 0.3:
            continue
        signal = rng.random()
        rows.append(
            [
                day,
                rng.choice(["running", "run", "cycling", "trail_running"]),
                rng.randint(1800, 7200),
                rng.randint(4, 9) if signal < 0.35 else None,
                rng.randint(20, 160) if 0.35 <= signal < 0.5 else None,
                rng.randint(120, 170) if signal < 0.9 else None,
                rng.uniform(5000, 30000),
                rng.uniform(2.2, 4.0),
                f"{label}Sortie {offset}",
                "strava" if 0.35 <= signal < 0.5 else "garmin_connect",
            ]
        )
    con.executemany(
        "INSERT INTO app.actual_sessions (date, sport, duration_sec, rpe, suffer_score,"
        " avg_hr, distance_m, avg_speed_mps, name, source)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    exercise = con.execute(
        "INSERT INTO app.exercises (name, category, primary_muscle)"
        " VALUES (?, 'compound', 'quadriceps') RETURNING id",
        [f"{label}Squat"],
    ).fetchone()[0]
    for offset in [*range(days, 0, -6), 0]:
        day = today - timedelta(days=offset)
        session = con.execute(
            "INSERT INTO app.strength_sessions (date, name, duration_min, overall_rpe)"
            " VALUES (?, ?, ?, ?) RETURNING id",
            [day, f"{label}Force {offset}", rng.randint(30, 70), rng.randint(5, 9)],
        ).fetchone()[0]
        link = con.execute(
            "INSERT INTO app.session_exercises (session_id, exercise_id)"
            " VALUES (?, ?) RETURNING id",
            [session, exercise],
        ).fetchone()[0]
        con.executemany(
            "INSERT INTO app.exercise_sets (session_exercise_id, set_number, reps,"
            " weight_kg) VALUES (?, ?, ?, ?)",
            [[link, n, 5, 100.0 + n] for n in range(1, 4)],
        )
    con.executemany(
        "INSERT INTO app.daily_metrics (date, hrv_last_night, hrv_weekly_avg,"
        " hrv_status, sleep_duration_sec, sleep_score, body_battery_high,"
        " stress_avg, resting_hr, steps, readiness_score)"
        " VALUES (?, ?, ?, 'BALANCED', ?, ?, ?, ?, ?, ?, ?)",
        [
            [
                today - timedelta(days=offset),
                rng.randint(40, 70),
                55,
                rng.randint(21000, 30000),
                rng.randint(50, 95),
                rng.randint(50, 100),
                rng.randint(15, 45),
                rng.randint(45, 55),
                rng.randint(4000, 15000),
                rng.randint(40, 95),
            ]
            for offset in range(60, -1, -1)
        ],
    )
    planned = con.execute(
        "INSERT INTO app.planned_sessions (date, sport, session_type,"
        " target_duration_min, description, source) VALUES (?, 'running', 'tempo',"
        " 50, ?, 'coach') RETURNING id",
        [today, f"{label}Tempo du jour"],
    ).fetchone()[0]
    con.execute(
        "INSERT INTO app.planned_sessions (date, sport, session_type, description)"
        " VALUES (?, 'running', 'endurance', ?)",
        [today + timedelta(days=1), f"{label}Footing demain"],
    )
    actual = con.execute(
        "INSERT INTO app.actual_sessions (date, sport, duration_sec, avg_hr,"
        " name, source, start_time) VALUES (?, 'running', 2400, 150, ?, 'manual', ?)"
        " RETURNING id",
        [
            today,
            f"{label}Réveil musculaire",
            datetime.combine(today, datetime.min.time()),
        ],
    ).fetchone()[0]
    decision = con.execute(
        "INSERT INTO app.plan_decisions (date, planned_session_id, decision, reason,"
        " readiness_score, state, session_revision, original_json, adapted_json)"
        " VALUES (?, ?, 'easier', 'Récupération basse', 52, 'pending', 1,"
        ' \'{"session_type": "tempo"}\', \'{"session_type": "endurance"}\')'
        " RETURNING id",
        [today, planned],
    ).fetchone()[0]
    con.execute(
        "INSERT INTO app.coach_followups (session_id, decision_id, requested_on,"
        " question, expires_at) VALUES (?, ?, ?, 'Comment était la séance ?', ?)",
        [
            actual,
            decision,
            today,
            datetime.combine(today + timedelta(days=2), datetime.min.time()),
        ],
    )
    con.execute(
        "INSERT INTO app.goals (name, race_date, distance_km, target_time_sec)"
        " VALUES (?, ?, 21.1, 5400)",
        [f"{label}Semi", today + timedelta(days=40)],
    )
    con.execute(
        "INSERT INTO app.coach_briefings (date, text, source, trigger)"
        " VALUES (?, ?, 'rules', 'scheduler')",
        [today, f"{label}Garde l’allure facile ce matin."],
    )
    con.execute(
        "INSERT OR REPLACE INTO app.banister_coefficients (user_id, k1, k2, baseline, r2)"
        " VALUES (getvariable('arete_athlete_id'), 0.8, 1.6, 70, 0.4)"
    )
