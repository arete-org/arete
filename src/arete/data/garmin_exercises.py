"""Garmin's exercise names (FIT ``exercise_category`` and its sub-names) to catalog ids.

A static, reviewed table instead of fuzzy matching: an English Garmin key
fuzzy-matched against the catalog lands on a near but wrong exercise
(``DUMBBELL_BENCH_PRESS`` on the barbell bench press, ``TRAP_BAR_DEADLIFT`` on
the deadlift), and a wrong exercise means false records and a wrong muscle map.
A Garmin name missing here stays free text the athlete writes themselves.

Keys are Garmin's spelling, upper case. Only a name whose catalog entry is the
same movement with the same equipment is listed.
"""

from __future__ import annotations

#: Garmin's finer name (``subCategory``) -> catalog id.
GARMIN_EXERCISES: dict[str, str] = {
    # Bench press: barbell only; dumbbell, close-grip and Smith presses stay free text.
    "BARBELL_BENCH_PRESS": "bench_press",
    "INCLINE_BARBELL_BENCH_PRESS": "incline_bench_press",
    # Squat
    "BARBELL_BACK_SQUAT": "back_squat",
    "BACK_SQUATS": "back_squat",
    "BULGARIAN_SPLIT_SQUAT": "bulgarian_split_squat",
    "DUMBBELL_BULGARIAN_SPLIT_SQUAT": "bulgarian_split_squat",
    "LEG_PRESS": "leg_press",
    "LEG_EXTENSIONS": "leg_extension",
    "LEG_EXTENSION": "leg_extension",
    # Deadlift
    "BARBELL_DEADLIFT": "deadlift",
    "SUMO_DEADLIFT": "sumo_deadlift",
    "ROMANIAN_DEADLIFT": "rdl",
    "DUMBBELL_ROMANIAN_DEADLIFT": "rdl",
    # Rows
    "BARBELL_ROW": "barbell_row",
    "BENT_OVER_ROW_WITH_BARBELL": "barbell_row",
    "DUMBBELL_ROW": "dumbbell_row",
    "ONE_ARM_BENT_OVER_ROW": "dumbbell_row",
    "SINGLE_ARM_DUMBBELL_ROW": "dumbbell_row",
    "T_BAR_ROW": "t_row",
    "SEATED_CABLE_ROW": "low_row",
    "FACE_PULL": "face_pull",
    "BARBELL_UPRIGHT_ROW": "upright_rows",
    # Pulls
    "PULL_UP": "pull_ups",
    "WEIGHTED_PULL_UP": "weighted_pull_ups",
    "WIDE_GRIP_PULL_UP": "wide_pull_ups",
    "CHIN_UP": "chin_ups",
    "WEIGHTED_CHIN_UP": "weighted_chin_ups",
    "LAT_PULLDOWN": "lat_pulldown",
    "WIDE_GRIP_LAT_PULLDOWN": "wide_lat_pulldown",
    "MUSCLE_UP": "muscle_ups",
    # Pushes
    "PUSH_UP": "push_ups",
    "DIP": "dips",
    "BODY_WEIGHT_DIP": "dips",
    "WEIGHTED_DIP": "weighted_dips",
    "DUMBBELL_FLYE": "pec_fly",
    "CABLE_CROSSOVER": "pec_fly",
    # Shoulders: the catalog's press takes a barbell or dumbbells.
    "OVERHEAD_BARBELL_PRESS": "shoulder_press",
    "BARBELL_SHOULDER_PRESS": "shoulder_press",
    "DUMBBELL_SHOULDER_PRESS": "shoulder_press",
    "DUMBBELL_LATERAL_RAISE": "db_lateral_raises",
    "CABLE_LATERAL_RAISE": "cable_lateral_raises",
    "DUMBBELL_FRONT_RAISE": "front_raises",
    # Arms: only the EZ bar curl and the hammer curl exist in the catalog.
    "EZ_BAR_CURL": "ez_bar_curl",
    "HAMMER_CURL": "hammer_curl",
    "DUMBBELL_HAMMER_CURL": "hammer_curl",
    "TRICEPS_PRESSDOWN": "triceps_pushdown",
    "ROPE_PRESSDOWN": "triceps_pushdown",
    "DUMBBELL_KICKBACK": "triceps_kickback",
    "CABLE_OVERHEAD_TRICEPS_EXTENSION": "cable_triceps_extension",
    # Legs and hips
    "LEG_CURL": "leg_curl",
    "STANDING_CALF_RAISE": "calf_raises",
    "DUMBBELL_LUNGE": "lunges",
    "BARBELL_LUNGE": "lunges",
    "WALKING_LUNGE": "lunges",
    "BARBELL_HIP_THRUST_ON_FLOOR": "hip_thrust",
    "BARBELL_HIP_THRUST_WITH_BENCH": "hip_thrust",
    # Core and carries
    "CRUNCH": "crunches",
    "HANGING_LEG_RAISE": "leg_raises",
    "PLANK": "plank",
    "SIDE_PLANK": "side_plank",
    "FARMERS_WALK": "farmer_carry",
    # Olympic lifts
    "POWER_CLEAN": "power_clean",
    "CLEAN_AND_JERK": "clean_and_jerk",
}

#: A category alone, when Garmin gave no finer name: only where the catalog's
#: exercise is what that category means without qualifier.
#: Not ``PULL_UP`` (lat pulldowns, chin-ups), ``CALF_RAISE`` or ``LEG_CURL``
#: (seated, Nordic): their variants would set false records.
GARMIN_CATEGORIES: dict[str, str] = {
    "PLANK": "plank",
    "CRUNCH": "crunches",
    "LUNGE": "lunges",
    "PUSH_UP": "push_ups",
}


def garmin_catalog_id(category: str | None, sub_category: str | None) -> str | None:
    """The catalog id of a Garmin exercise, or None when it is not listed.

    The finer name decides when Garmin gave one; the category alone only when
    it gave none (missing or ``UNKNOWN``) and the category is listed.
    """
    sub = (sub_category or "").strip().upper()
    if sub and sub != "UNKNOWN":
        return GARMIN_EXERCISES.get(sub)
    return GARMIN_CATEGORIES.get((category or "").strip().upper())
