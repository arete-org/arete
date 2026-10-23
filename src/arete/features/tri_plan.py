"""Triathlon plans: swimming, cycling and running towards one race.

Four distances: sprint (S), olympic (M), half (70.3) and full (the Ironman
distance). Pure: no I/O, no clock.
"""

from __future__ import annotations

from typing import Literal

TriDistance = Literal["sprint", "olympic", "half", "full"]
TRI_DISTANCES: tuple[TriDistance, ...] = ("sprint", "olympic", "half", "full")

#: (swim, bike, run) kilometres of each distance.
LEGS_KM: dict[TriDistance, tuple[float, float, float]] = {
    "sprint": (0.75, 20.0, 5.0),
    "olympic": (1.5, 40.0, 10.0),
    "half": (1.9, 90.0, 21.1),
    "full": (3.8, 180.0, 42.2),
}
#: A goal's stored distance: the three legs added up, rounded as announced.
TRI_DISTANCE_KM: dict[TriDistance, float] = {
    "sprint": 25.75,
    "olympic": 51.5,
    "half": 113.0,
    "full": 226.0,
}
#: Hours a week a plan needs at least, by distance.
MIN_HOURS: dict[TriDistance, int] = {"sprint": 3, "olympic": 4, "half": 6, "full": 8}
MAX_HOURS = 25
#: How the plan names each distance, in French; never a trademark claim.
TRI_LABEL: dict[TriDistance, str] = {
    "sprint": "S",
    "olympic": "M",
    "half": "70.3",
    "full": "distance Ironman",
}
#: The same, after « pour » in a French sentence.
_FOR_LABEL: dict[TriDistance, str] = {
    "sprint": "un triathlon S",
    "olympic": "un triathlon M",
    "half": "un 70.3",
    "full": "une distance Ironman",
}


def too_few_hours(distance: TriDistance, hours: float) -> str | None:
    """Why ``hours`` a week cannot prepare ``distance``, in French; None when
    they can."""
    least = MIN_HOURS[distance]
    if hours < least:
        return f"Prévois au moins {least} h par semaine pour {_FOR_LABEL[distance]}."
    return None
