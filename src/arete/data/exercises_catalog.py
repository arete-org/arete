"""
Exercise catalog with muscle mappings.

This catalog contains exercises extracted from user training logs,
with primary and secondary muscle groups for each exercise.
"""

from typing import TypedDict


class ExerciseDefinition(TypedDict):
    id: str
    name: str
    name_fr: str
    category: str  # push, pull, legs, core, cardio, compound
    equipment: list[str]  # barbell, dumbbell, cable, bodyweight, machine, kettlebell
    primary_muscles: list[str]
    secondary_muscles: list[str]
    movement_pattern: str  # horizontal_push, horizontal_pull, vertical_push, vertical_pull, hip_hinge, squat, isolation


# Muscle IDs matching AnatomicalHeatmap component
MUSCLES = {
    # Front upper body
    "chest": "Pectorals",
    "front_delts": "Anterior Deltoids",
    "side_delts": "Lateral Deltoids",
    "biceps": "Biceps",
    "forearms": "Forearms",
    "abs": "Rectus Abdominis",
    "obliques": "Obliques",
    # Back upper body
    "traps": "Trapezius",
    "rear_delts": "Posterior Deltoids",
    "lats": "Latissimus Dorsi",
    "rhomboids": "Rhomboids",
    "lower_back": "Erector Spinae",
    "triceps": "Triceps",
    # Lower body
    "quads": "Quadriceps",
    "hip_flexors": "Hip Flexors",
    "adductors": "Adductors",
    "tibialis": "Tibialis Anterior",
    "glutes": "Gluteus Maximus",
    "hamstrings": "Hamstrings",
    "calves": "Calves",
}


EXERCISES_CATALOG: list[ExerciseDefinition] = [
    # =========================================
    # PUSH - Horizontal
    # =========================================
    {
        "id": "bench_press",
        "name": "Bench Press",
        "name_fr": "Développé couché",
        "category": "push",
        "equipment": ["barbell"],
        "primary_muscles": ["chest", "triceps"],
        "secondary_muscles": ["front_delts"],
        "movement_pattern": "horizontal_push",
    },
    {
        "id": "pause_bench_press",
        "name": "Pause Bench Press",
        "name_fr": "Développé couché pause",
        "category": "push",
        "equipment": ["barbell"],
        "primary_muscles": ["chest", "triceps"],
        "secondary_muscles": ["front_delts"],
        "movement_pattern": "horizontal_push",
    },
    {
        "id": "incline_bench_press",
        "name": "Incline Bench Press",
        "name_fr": "Développé incliné",
        "category": "push",
        "equipment": ["barbell"],
        "primary_muscles": ["chest", "front_delts"],
        "secondary_muscles": ["triceps"],
        "movement_pattern": "horizontal_push",
    },
    {
        "id": "dips",
        "name": "Dips",
        "name_fr": "Dips",
        "category": "push",
        "equipment": ["bodyweight"],
        "primary_muscles": ["chest", "triceps"],
        "secondary_muscles": ["front_delts"],
        "movement_pattern": "vertical_push",
    },
    {
        "id": "weighted_dips",
        "name": "Weighted Dips",
        "name_fr": "Dips lestés",
        "category": "push",
        "equipment": ["bodyweight"],
        "primary_muscles": ["chest", "triceps"],
        "secondary_muscles": ["front_delts"],
        "movement_pattern": "vertical_push",
    },
    {
        "id": "push_ups",
        "name": "Push Ups",
        "name_fr": "Pompes",
        "category": "push",
        "equipment": ["bodyweight"],
        "primary_muscles": ["chest", "triceps"],
        "secondary_muscles": ["front_delts", "abs"],
        "movement_pattern": "horizontal_push",
    },
    {
        "id": "pec_fly",
        "name": "Pec Fly",
        "name_fr": "Écarté pectoraux",
        "category": "push",
        "equipment": ["dumbbell", "cable", "machine"],
        "primary_muscles": ["chest"],
        "secondary_muscles": ["front_delts"],
        "movement_pattern": "isolation",
    },
    # =========================================
    # PUSH - Vertical (Shoulders)
    # =========================================
    {
        "id": "shoulder_press",
        "name": "Shoulder Press / OHP",
        "name_fr": "Développé militaire",
        "category": "push",
        "equipment": ["barbell", "dumbbell"],
        "primary_muscles": ["front_delts", "side_delts"],
        "secondary_muscles": ["triceps", "traps"],
        "movement_pattern": "vertical_push",
    },
    {
        "id": "machine_shoulder_press",
        "name": "Machine Shoulder Press",
        "name_fr": "Développé épaules machine",
        "category": "push",
        "equipment": ["machine"],
        "primary_muscles": ["front_delts", "side_delts"],
        "secondary_muscles": ["triceps"],
        "movement_pattern": "vertical_push",
    },
    {
        "id": "db_lateral_raises",
        "name": "Dumbbell Lateral Raises",
        "name_fr": "Élévations latérales",
        "category": "push",
        "equipment": ["dumbbell"],
        "primary_muscles": ["side_delts"],
        "secondary_muscles": ["traps"],
        "movement_pattern": "isolation",
    },
    {
        "id": "cable_lateral_raises",
        "name": "Cable Lateral Raises",
        "name_fr": "Élévations latérales poulie",
        "category": "push",
        "equipment": ["cable"],
        "primary_muscles": ["side_delts"],
        "secondary_muscles": ["traps"],
        "movement_pattern": "isolation",
    },
    {
        "id": "front_raises",
        "name": "Front Raises",
        "name_fr": "Élévations frontales",
        "category": "push",
        "equipment": ["dumbbell"],
        "primary_muscles": ["front_delts"],
        "secondary_muscles": ["side_delts"],
        "movement_pattern": "isolation",
    },
    {
        "id": "kettlebell_swing",
        "name": "Kettlebell Swing",
        "name_fr": "Swing kettlebell",
        "category": "compound",
        "equipment": ["kettlebell"],
        "primary_muscles": ["glutes", "hamstrings"],
        "secondary_muscles": ["lower_back", "abs", "front_delts", "quads"],
        "movement_pattern": "hip_hinge",
    },
    {
        "id": "barbell_strict_swing",
        "name": "Barbell Strict Swing",
        "name_fr": "Swing barre stricte",
        "category": "push",
        "equipment": ["barbell"],
        "primary_muscles": ["front_delts"],
        "secondary_muscles": ["side_delts", "traps", "abs"],
        "movement_pattern": "vertical_push",
    },
    {
        "id": "upright_rows",
        "name": "Upright Rows",
        "name_fr": "Rowing menton",
        "category": "push",
        "equipment": ["barbell", "kettlebell"],
        "primary_muscles": ["side_delts", "traps"],
        "secondary_muscles": ["biceps", "forearms"],
        "movement_pattern": "vertical_pull",
    },
    # =========================================
    # PULL - Horizontal
    # =========================================
    {
        "id": "barbell_row",
        "name": "Barbell Row",
        "name_fr": "Rowing barre",
        "category": "pull",
        "equipment": ["barbell"],
        "primary_muscles": ["lats", "rhomboids"],
        "secondary_muscles": ["rear_delts", "biceps", "traps", "lower_back"],
        "movement_pattern": "horizontal_pull",
    },
    {
        "id": "t_row",
        "name": "T-Bar Row",
        "name_fr": "T-Bar rowing",
        "category": "pull",
        "equipment": ["barbell"],
        "primary_muscles": ["lats", "rhomboids"],
        "secondary_muscles": ["rear_delts", "biceps", "traps"],
        "movement_pattern": "horizontal_pull",
    },
    {
        "id": "dumbbell_row",
        "name": "Dumbbell Row",
        "name_fr": "Rowing haltère",
        "category": "pull",
        "equipment": ["dumbbell"],
        "primary_muscles": ["lats", "rhomboids"],
        "secondary_muscles": ["rear_delts", "biceps"],
        "movement_pattern": "horizontal_pull",
    },
    {
        "id": "machine_row",
        "name": "Machine Row",
        "name_fr": "Rowing machine",
        "category": "pull",
        "equipment": ["machine"],
        "primary_muscles": ["lats", "rhomboids"],
        "secondary_muscles": ["rear_delts", "biceps"],
        "movement_pattern": "horizontal_pull",
    },
    {
        "id": "low_row",
        "name": "Low Row / Seated Cable Row",
        "name_fr": "Tirage horizontal bas",
        "category": "pull",
        "equipment": ["cable", "machine"],
        "primary_muscles": ["lats", "rhomboids"],
        "secondary_muscles": ["rear_delts", "biceps", "lower_back"],
        "movement_pattern": "horizontal_pull",
    },
    {
        "id": "horizontal_pull",
        "name": "Horizontal Pull (Neutral Grip)",
        "name_fr": "Tirage horizontal prise neutre",
        "category": "pull",
        "equipment": ["machine", "cable"],
        "primary_muscles": ["lats", "rhomboids"],
        "secondary_muscles": ["rear_delts", "biceps"],
        "movement_pattern": "horizontal_pull",
    },
    {
        "id": "face_pull",
        "name": "Face Pull",
        "name_fr": "Face pull",
        "category": "pull",
        "equipment": ["cable"],
        "primary_muscles": ["rear_delts"],
        "secondary_muscles": ["rhomboids", "traps", "side_delts"],
        "movement_pattern": "horizontal_pull",
    },
    # =========================================
    # PULL - Vertical
    # =========================================
    {
        "id": "pull_ups",
        "name": "Pull Ups",
        "name_fr": "Tractions pronation",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats"],
        "secondary_muscles": ["biceps", "rear_delts", "rhomboids", "forearms"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "weighted_pull_ups",
        "name": "Weighted Pull Ups",
        "name_fr": "Tractions lestées pronation",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats"],
        "secondary_muscles": ["biceps", "rear_delts", "rhomboids", "forearms"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "chin_ups",
        "name": "Chin Ups",
        "name_fr": "Tractions supination",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats", "biceps"],
        "secondary_muscles": ["rear_delts", "rhomboids", "forearms"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "weighted_chin_ups",
        "name": "Weighted Chin Ups",
        "name_fr": "Tractions lestées supination",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats", "biceps"],
        "secondary_muscles": ["rear_delts", "rhomboids", "forearms"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "neutral_pull_ups",
        "name": "Neutral Grip Pull Ups",
        "name_fr": "Tractions prise neutre",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats"],
        "secondary_muscles": ["biceps", "rear_delts", "rhomboids", "forearms"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "wide_pull_ups",
        "name": "Wide Grip Pull Ups",
        "name_fr": "Tractions prise large",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats"],
        "secondary_muscles": ["rear_delts", "rhomboids", "biceps"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "lat_pulldown",
        "name": "Lat Pulldown",
        "name_fr": "Tirage vertical",
        "category": "pull",
        "equipment": ["cable", "machine"],
        "primary_muscles": ["lats"],
        "secondary_muscles": ["biceps", "rear_delts", "rhomboids"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "wide_lat_pulldown",
        "name": "Wide Grip Lat Pulldown",
        "name_fr": "Tirage vertical prise large",
        "category": "pull",
        "equipment": ["cable", "machine"],
        "primary_muscles": ["lats"],
        "secondary_muscles": ["rear_delts", "rhomboids", "biceps"],
        "movement_pattern": "vertical_pull",
    },
    {
        "id": "muscle_ups",
        "name": "Muscle Ups",
        "name_fr": "Muscle ups",
        "category": "pull",
        "equipment": ["bodyweight"],
        "primary_muscles": ["lats", "chest", "triceps"],
        "secondary_muscles": ["biceps", "front_delts", "abs"],
        "movement_pattern": "compound",
    },
    # =========================================
    # ARMS - Isolation
    # =========================================
    {
        "id": "triceps_pushdown",
        "name": "Triceps Pushdown",
        "name_fr": "Extensions triceps poulie",
        "category": "push",
        "equipment": ["cable"],
        "primary_muscles": ["triceps"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "triceps_kickback",
        "name": "Triceps Kickback",
        "name_fr": "Kickback triceps",
        "category": "push",
        "equipment": ["dumbbell"],
        "primary_muscles": ["triceps"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "triceps_extension",
        "name": "Triceps Extension (Cable)",
        "name_fr": "Extension triceps",
        "category": "push",
        "equipment": ["cable"],
        "primary_muscles": ["triceps"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "ez_bar_curl",
        "name": "EZ Bar Curl",
        "name_fr": "Curl barre EZ",
        "category": "pull",
        "equipment": ["barbell"],
        "primary_muscles": ["biceps"],
        "secondary_muscles": ["forearms"],
        "movement_pattern": "isolation",
    },
    {
        "id": "hammer_curl",
        "name": "Hammer Curl",
        "name_fr": "Curl marteau",
        "category": "pull",
        "equipment": ["dumbbell"],
        "primary_muscles": ["biceps", "forearms"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    # =========================================
    # LEGS - Squat Pattern
    # =========================================
    {
        "id": "back_squat",
        "name": "Back Squat",
        "name_fr": "Squat arrière",
        "category": "legs",
        "equipment": ["barbell"],
        "primary_muscles": ["quads", "glutes"],
        "secondary_muscles": ["hamstrings", "lower_back", "abs"],
        "movement_pattern": "squat",
    },
    {
        "id": "sandbag_squat",
        "name": "Sandbag Squat",
        "name_fr": "Squat sandbag",
        "category": "legs",
        "equipment": ["sandbag"],
        "primary_muscles": ["quads", "glutes"],
        "secondary_muscles": ["hamstrings", "abs"],
        "movement_pattern": "squat",
    },
    {
        "id": "bulgarian_split_squat",
        "name": "Bulgarian Split Squat",
        "name_fr": "Squat bulgare",
        "category": "legs",
        "equipment": ["dumbbell", "bodyweight"],
        "primary_muscles": ["quads", "glutes"],
        "secondary_muscles": ["hamstrings", "adductors", "hip_flexors"],
        "movement_pattern": "squat",
    },
    # =========================================
    # LEGS - Hip Hinge Pattern
    # =========================================
    {
        "id": "rdl",
        "name": "Romanian Deadlift",
        "name_fr": "Soulevé de terre roumain",
        "category": "legs",
        "equipment": ["barbell", "dumbbell"],
        "primary_muscles": ["hamstrings", "glutes"],
        "secondary_muscles": ["lower_back", "forearms"],
        "movement_pattern": "hip_hinge",
    },
    {
        "id": "deadlift",
        "name": "Deadlift",
        "name_fr": "Soulevé de terre",
        "category": "legs",
        "equipment": ["barbell"],
        "primary_muscles": ["glutes", "hamstrings", "lower_back"],
        "secondary_muscles": ["quads", "lats", "traps", "forearms", "abs"],
        "movement_pattern": "hip_hinge",
    },
    {
        "id": "sumo_deadlift",
        "name": "Sumo Deadlift",
        "name_fr": "Soulevé de terre sumo",
        "category": "legs",
        "equipment": ["barbell"],
        "primary_muscles": ["glutes", "quads", "adductors"],
        "secondary_muscles": ["hamstrings", "lower_back", "traps", "forearms"],
        "movement_pattern": "hip_hinge",
    },
    # =========================================
    # LEGS - Calves
    # =========================================
    {
        "id": "calf_raises",
        "name": "Calf Raises",
        "name_fr": "Mollets debout",
        "category": "legs",
        "equipment": ["bodyweight", "machine"],
        "primary_muscles": ["calves"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    # =========================================
    # LEGS - Machines, lunges and hip thrust
    # =========================================
    {
        "id": "lunges",
        "name": "Lunges",
        "name_fr": "Fentes",
        "category": "legs",
        "equipment": ["dumbbell", "barbell", "bodyweight"],
        "primary_muscles": ["quads", "glutes"],
        "secondary_muscles": ["hamstrings", "adductors", "calves"],
        "movement_pattern": "squat",
    },
    {
        "id": "leg_press",
        "name": "Leg Press",
        "name_fr": "Presse à cuisses",
        "category": "legs",
        "equipment": ["machine"],
        "primary_muscles": ["quads", "glutes"],
        "secondary_muscles": ["hamstrings", "adductors"],
        "movement_pattern": "squat",
    },
    {
        "id": "leg_extension",
        "name": "Leg Extension",
        "name_fr": "Extension des quadriceps",
        "category": "legs",
        "equipment": ["machine"],
        "primary_muscles": ["quads"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "leg_curl",
        "name": "Leg Curl",
        "name_fr": "Leg curl ischio-jambiers",
        "category": "legs",
        "equipment": ["machine"],
        "primary_muscles": ["hamstrings"],
        "secondary_muscles": ["calves"],
        "movement_pattern": "isolation",
    },
    {
        "id": "hip_thrust",
        "name": "Hip Thrust",
        "name_fr": "Hip thrust",
        "category": "legs",
        "equipment": ["barbell", "machine"],
        "primary_muscles": ["glutes"],
        "secondary_muscles": ["hamstrings", "quads", "adductors"],
        "movement_pattern": "hip_hinge",
    },
    {
        "id": "cable_triceps_extension",
        "name": "Cable Triceps Extension",
        "name_fr": "Extension triceps poulie",
        "category": "push",
        "equipment": ["cable"],
        "primary_muscles": ["triceps"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "treadmill",
        "name": "Treadmill",
        "name_fr": "Tapis de course",
        "category": "cardio",
        "equipment": ["machine"],
        "primary_muscles": ["quads", "hamstrings", "calves", "glutes"],
        "secondary_muscles": ["hip_flexors", "abs", "tibialis"],
        "movement_pattern": "compound",
    },
    # =========================================
    # CORE
    # =========================================
    {
        "id": "crunches",
        "name": "Crunches",
        "name_fr": "Crunchs",
        "category": "core",
        "equipment": ["bodyweight"],
        "primary_muscles": ["abs"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "leg_raises",
        "name": "Leg Raises",
        "name_fr": "Relevés de jambes",
        "category": "core",
        "equipment": ["bodyweight"],
        "primary_muscles": ["abs", "hip_flexors"],
        "secondary_muscles": [],
        "movement_pattern": "isolation",
    },
    {
        "id": "plank",
        "name": "Plank",
        "name_fr": "Gainage",
        "category": "core",
        "equipment": ["bodyweight"],
        "primary_muscles": ["abs"],
        "secondary_muscles": ["obliques", "lower_back", "front_delts"],
        "movement_pattern": "core",
    },
    {
        "id": "side_plank",
        "name": "Side Plank",
        "name_fr": "Gainage latéral",
        "category": "core",
        "equipment": ["bodyweight"],
        "primary_muscles": ["obliques"],
        "secondary_muscles": ["abs", "glutes"],
        "movement_pattern": "core",
    },
    # =========================================
    # CARRY
    # =========================================
    {
        "id": "farmer_carry",
        "name": "Farmer Carry",
        "name_fr": "Marche du fermier",
        "category": "compound",
        "equipment": ["dumbbell", "kettlebell"],
        "primary_muscles": ["forearms", "traps"],
        "secondary_muscles": ["abs", "obliques", "glutes", "quads"],
        "movement_pattern": "carry",
    },
    # =========================================
    # HYROX STATIONS
    # =========================================
    {
        "id": "sled_push",
        "name": "Sled Push",
        "name_fr": "Poussée de traîneau",
        "category": "compound",
        "equipment": ["sled"],
        "primary_muscles": ["quads", "glutes", "calves"],
        "secondary_muscles": ["hamstrings", "chest", "triceps", "front_delts", "abs"],
        "movement_pattern": "compound",
    },
    {
        "id": "sled_pull",
        "name": "Sled Pull",
        "name_fr": "Tirage de traîneau",
        "category": "compound",
        "equipment": ["sled"],
        "primary_muscles": ["lats", "biceps", "forearms"],
        "secondary_muscles": [
            "rhomboids",
            "rear_delts",
            "glutes",
            "hamstrings",
            "lower_back",
        ],
        "movement_pattern": "compound",
    },
    {
        "id": "burpee_broad_jump",
        "name": "Burpee Broad Jump",
        "name_fr": "Burpee saut en longueur",
        "category": "compound",
        "equipment": ["bodyweight"],
        "primary_muscles": ["quads", "glutes", "chest"],
        "secondary_muscles": ["hamstrings", "calves", "triceps", "front_delts", "abs"],
        "movement_pattern": "compound",
    },
    {
        "id": "wall_ball",
        "name": "Wall Ball",
        "name_fr": "Wall ball",
        "category": "compound",
        "equipment": ["medicine_ball"],
        "primary_muscles": ["quads", "glutes", "front_delts"],
        "secondary_muscles": ["hamstrings", "triceps", "side_delts", "abs"],
        "movement_pattern": "squat",
    },
    # =========================================
    # OLYMPIC LIFTS
    # =========================================
    {
        "id": "power_clean",
        "name": "Power Clean",
        "name_fr": "Épaulé en puissance",
        "category": "compound",
        "equipment": ["barbell"],
        "primary_muscles": ["glutes", "hamstrings", "quads", "traps"],
        "secondary_muscles": ["lower_back", "calves", "front_delts", "forearms"],
        "movement_pattern": "compound",
    },
    {
        "id": "clean_and_jerk",
        "name": "Clean and Jerk",
        "name_fr": "Épaulé-jeté",
        "category": "compound",
        "equipment": ["barbell"],
        "primary_muscles": ["glutes", "quads", "hamstrings", "front_delts"],
        "secondary_muscles": ["traps", "triceps", "lower_back", "calves", "abs"],
        "movement_pattern": "compound",
    },
    {
        "id": "snatch",
        "name": "Snatch",
        "name_fr": "Arraché",
        "category": "compound",
        "equipment": ["barbell"],
        "primary_muscles": ["glutes", "hamstrings", "quads", "traps"],
        "secondary_muscles": [
            "lower_back",
            "front_delts",
            "side_delts",
            "triceps",
            "calves",
            "abs",
        ],
        "movement_pattern": "compound",
    },
    # =========================================
    # CARDIO / ERG
    # =========================================
    {
        "id": "row_erg",
        "name": "Rowing Ergometer",
        "name_fr": "Rameur",
        "category": "cardio",
        "equipment": ["machine"],
        "primary_muscles": ["lats", "quads", "glutes"],
        "secondary_muscles": [
            "hamstrings",
            "biceps",
            "forearms",
            "lower_back",
            "abs",
            "calves",
        ],
        "movement_pattern": "compound",
    },
    {
        "id": "ski_erg",
        "name": "SkiErg",
        "name_fr": "SkiErg",
        "category": "cardio",
        "equipment": ["machine"],
        "primary_muscles": ["lats", "triceps", "abs"],
        "secondary_muscles": [
            "front_delts",
            "rear_delts",
            "glutes",
            "quads",
            "obliques",
        ],
        "movement_pattern": "compound",
    },
    {
        "id": "stairmaster",
        "name": "Stairmaster",
        "name_fr": "Stepper",
        "category": "cardio",
        "equipment": ["machine"],
        "primary_muscles": ["quads", "glutes", "calves"],
        "secondary_muscles": ["hamstrings"],
        "movement_pattern": "compound",
    },
    {
        "id": "running",
        "name": "Running",
        "name_fr": "Course à pied",
        "category": "cardio",
        "equipment": [],
        "primary_muscles": ["quads", "hamstrings", "calves", "glutes"],
        "secondary_muscles": ["hip_flexors", "abs", "tibialis"],
        "movement_pattern": "compound",
    },
    {
        "id": "swimming",
        "name": "Swimming",
        "name_fr": "Natation",
        "category": "cardio",
        "equipment": [],
        "primary_muscles": ["lats", "front_delts", "triceps"],
        "secondary_muscles": ["chest", "abs", "quads"],
        "movement_pattern": "compound",
    },
]


# Create lookup dictionaries
EXERCISES_BY_ID = {ex["id"]: ex for ex in EXERCISES_CATALOG}
EXERCISES_BY_NAME = {ex["name"].lower(): ex for ex in EXERCISES_CATALOG}


def get_exercise(name_or_id: str) -> ExerciseDefinition | None:
    """Get exercise by ID or name (case-insensitive)."""
    # Try ID first
    if name_or_id in EXERCISES_BY_ID:
        return EXERCISES_BY_ID[name_or_id]
    # Try name
    return EXERCISES_BY_NAME.get(name_or_id.lower())


def get_muscles_for_exercise(exercise_id: str) -> tuple[list[str], list[str]]:
    """Get primary and secondary muscles for an exercise."""
    ex = EXERCISES_BY_ID.get(exercise_id)
    if not ex:
        return [], []
    return ex["primary_muscles"], ex["secondary_muscles"]


def calculate_muscle_volume(
    sets: list[dict],  # [{"exercise_id": str, "reps": int, "weight": float}, ...]
    primary_weight: float = 1.0,
    secondary_weight: float = 0.5,
) -> dict[str, float]:
    """
    Calculate volume per muscle from a list of sets.

    Volume = sets * reps * weight
    Primary muscles get full volume, secondary get half.
    """
    muscle_volume: dict[str, float] = {}

    for s in sets:
        ex_id = s.get("exercise_id")
        reps = s.get("reps", 0)
        weight = s.get("weight", 0)

        if not ex_id or reps <= 0:
            continue

        ex = EXERCISES_BY_ID.get(ex_id)
        if not ex:
            continue

        volume = reps * weight

        # Primary muscles get full volume
        for muscle in ex["primary_muscles"]:
            muscle_volume[muscle] = (
                muscle_volume.get(muscle, 0) + volume * primary_weight
            )

        # Secondary muscles get partial volume
        for muscle in ex["secondary_muscles"]:
            muscle_volume[muscle] = (
                muscle_volume.get(muscle, 0) + volume * secondary_weight
            )

    return muscle_volume


# Exercise name aliases for parsing training logs
EXERCISE_ALIASES = {
    # Spoken French: what a dictated session actually sounds like. The matcher
    # strips accents, so only shapes the catalog labels do not already cover
    # belong here.
    "écartés": "pec_fly",
    "écarté": "pec_fly",
    "ecartes": "pec_fly",
    "curl biceps": "ez_bar_curl",
    "curl haltères": "hammer_curl",
    "rowing menton": "upright_rows",
    "tirage menton": "upright_rows",
    "tractions lestées": "weighted_pull_ups",
    "traction": "pull_ups",
    "traction lestée": "weighted_pull_ups",
    "dips lesté": "weighted_dips",
    "dip": "dips",
    "pompe": "push_ups",
    "fente": "lunges",
    "fentes marchées": "lunges",
    "fentes avant": "lunges",
    "fentes arrière": "lunges",
    "fentes sandbag": "lunges",
    "fentes avec sac de sable": "lunges",
    "walking lunges": "lunges",
    "lunge": "lunges",
    "presse cuisses": "leg_press",
    "leg extensions": "leg_extension",
    "extension quadriceps": "leg_extension",
    "extensions quadriceps": "leg_extension",
    "leg curls": "leg_curl",
    "curl ischio": "leg_curl",
    "curl ischios": "leg_curl",
    "curl jambes": "leg_curl",
    "hip thrusts": "hip_thrust",
    "relevé de bassin": "hip_thrust",
    "planche": "plank",
    "gainage ventral": "plank",
    "gainage frontal": "plank",
    "gainage côté": "side_plank",
    "face pulls": "face_pull",
    "farmer walk": "farmer_carry",
    "farmer walks": "farmer_carry",
    "farmers walk": "farmer_carry",
    "farmer": "farmer_carry",
    "farmers": "farmer_carry",
    "marche du fermier": "farmer_carry",
    "clean": "power_clean",
    "power cleans": "power_clean",
    "épaulé puissance": "power_clean",
    "épaulé jeté": "clean_and_jerk",
    "clean & jerk": "clean_and_jerk",
    "arraché": "snatch",
    "power snatch": "snatch",
    "soulevé de terre jambes tendues": "rdl",
    "extensions triceps": "triceps_extension",
    "élévations frontales": "front_raises",
    "montées de mollets": "calf_raises",
    "vélo elliptique": "stairmaster",
    # Bench variants
    "bp": "bench_press",
    "bench": "bench_press",
    "bench press": "bench_press",
    "pause bp": "pause_bench_press",
    "pause bench": "pause_bench_press",
    "pause bench press": "pause_bench_press",
    "incline bp": "incline_bench_press",
    "incline bench": "incline_bench_press",
    "incline bench press": "incline_bench_press",
    # Shoulder press variants
    "ohp": "shoulder_press",
    "bb ohp": "shoulder_press",
    "shoulder press": "shoulder_press",
    "db shoulder press": "shoulder_press",
    "machine shoulder press": "machine_shoulder_press",
    # Lateral raises
    "lat raises": "db_lateral_raises",
    "db lat raises": "db_lateral_raises",
    "db lateral raises": "db_lateral_raises",
    "dumbbell lateral raises": "db_lateral_raises",
    "cable lat raises": "cable_lateral_raises",
    "cable lateral raises": "cable_lateral_raises",
    "front raises": "front_raises",
    # Rows
    "row": "barbell_row",
    "bb row": "barbell_row",
    "barbell row": "barbell_row",
    "rowing barre": "barbell_row",
    "t-row": "t_row",
    "t row": "t_row",
    "db row": "dumbbell_row",
    "uni row": "dumbbell_row",
    "uni db row": "dumbbell_row",
    "low row": "low_row",
    "uni low row": "low_row",
    "machine row": "machine_row",
    "horizontal pull": "horizontal_pull",
    "neutral horizontal row": "horizontal_pull",
    "neutral grip horizontal pull": "horizontal_pull",
    "smith bb row": "barbell_row",
    # Pull ups
    "pu": "pull_ups",
    "pull ups": "pull_ups",
    "pullups": "pull_ups",
    "wide pu": "wide_pull_ups",
    "wide pull ups": "wide_pull_ups",
    "weighted pu": "weighted_pull_ups",
    "weighted pull ups": "weighted_pull_ups",
    "neutral pu": "neutral_pull_ups",
    "neutral pull ups": "neutral_pull_ups",
    # Chin ups
    "cu": "chin_ups",
    "chin ups": "chin_ups",
    "chinups": "chin_ups",
    "weighted chin ups": "weighted_chin_ups",
    "weighted cu": "weighted_chin_ups",
    # Lat pulldown
    "pulldowns": "lat_pulldown",
    "lat pulldowns": "lat_pulldown",
    "vertical wide pulldowns": "wide_lat_pulldown",
    "wide grip pulldowns": "wide_lat_pulldown",
    # Dips
    "dips": "dips",
    "weighted dips": "weighted_dips",
    # Push ups
    "push ups": "push_ups",
    "pushups": "push_ups",
    # Triceps
    "triceps pushdown": "triceps_pushdown",
    "triceps pushdowns": "triceps_pushdown",
    "tri pushdowns": "triceps_pushdown",
    "triceps kickback": "triceps_kickback",
    "triceps extension": "triceps_extension",
    "triceps extensions": "triceps_extension",
    # Biceps
    "ez bar curl": "ez_bar_curl",
    "ez-bar curl": "ez_bar_curl",
    "hammer curl": "hammer_curl",
    "db hammer curl": "hammer_curl",
    # Upright rows
    "upright rows": "upright_rows",
    "ez bar upright rows": "upright_rows",
    "ez-bar upright rows": "upright_rows",
    "kettlebell upright rows": "upright_rows",
    # Flyes
    "pec fly": "pec_fly",
    "pec flyes": "pec_fly",
    "db pec fly": "pec_fly",
    # Squats
    "squats": "back_squat",
    "back squats": "back_squat",
    "sandbag squats": "sandbag_squat",
    "bss": "bulgarian_split_squat",
    "bulgarian split squats": "bulgarian_split_squat",
    # Deadlifts
    "rdl": "rdl",
    "deadlift": "deadlift",
    "dl": "deadlift",
    "sumo deadlift": "sumo_deadlift",
    "sumo dl": "sumo_deadlift",
    # Calves
    "calves raises": "calf_raises",
    "calf raises": "calf_raises",
    # Core
    "crunch": "crunches",
    "crunches": "crunches",
    "leg raises": "leg_raises",
    "abs": "crunches",  # Generic abs work
    # Cardio
    "row erg": "row_erg",
    "rowing": "row_erg",
    "rameur": "row_erg",
    "stairmaster": "stairmaster",
    "run": "running",
    "running": "running",
    "ef": "running",  # Easy/endurance running
    "swim": "swimming",
    "swimming": "swimming",
    # Muscle ups
    "mu": "muscle_ups",
    "muscle ups": "muscle_ups",
    # Kettlebell
    "kb swing": "kettlebell_swing",
    "kettlebell swing": "kettlebell_swing",
    # Barbell strict swing (overhead front raise)
    "bb swing": "barbell_strict_swing",
    "strict bb swing": "barbell_strict_swing",
    "barbell swing": "barbell_strict_swing",
    "barbell strict swing": "barbell_strict_swing",
    # RDL variants
    "kb rdl": "rdl",
    "kettlebell rdl": "rdl",
    # Triceps cable
    "cable triceps extension": "cable_triceps_extension",
    "cable triceps extensions": "cable_triceps_extension",
    "triceps cable": "cable_triceps_extension",
    # Treadmill
    "treadmill": "treadmill",
    "treamill": "treadmill",  # Common typo
    # Wide pull ups
    "wide pullups": "wide_pull_ups",
    # Pulls ups typo
    "pulls ups": "pull_ups",
}


def resolve_exercise_name(raw_name: str) -> str | None:
    """Resolve a raw exercise name from training log to exercise ID."""
    normalized = raw_name.lower().strip()
    return EXERCISE_ALIASES.get(normalized)
