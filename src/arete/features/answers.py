"""The four answers that open the Analyses page, one French sentence each.

« Suis-je prêt ? », « Est-ce que je progresse ? », « Où est le risque ? » and
« Qu’est-ce qui marche ? »: rules over numbers the overview already computes
(no model call). Every sentence names the period it reads and where its
numbers come from, so a reader never has to guess what « 44 » covers.
Pure: the service hands the values over.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Literal, TypedDict

from arete.features.fitness import (
    FormZone,
    ReadinessLevel,
    get_form_zone,
    get_readiness_level,
)
from arete.features.insights import PACE_TREND_SIGNIFICANT, Tone
from arete.features.periods import PeriodWindow

AnswerId = Literal["ready", "progress", "risk", "works"]


class Answer(TypedDict):
    id: AnswerId
    question: str
    text: str
    tone: Tone
    #: What the sentence reads, as the sentence says it ("sur les 30 derniers jours").
    period: str
    #: Where its numbers come from, as the sentence says it ("tes séances").
    source: str


QUESTIONS: dict[AnswerId, str] = {
    "ready": "Suis-je prêt ?",
    "progress": "Est-ce que je progresse ?",
    "risk": "Où est le risque ?",
    "works": "Qu’est-ce qui marche ?",
}

#: A forme de fond (CTL) change smaller than this is "stable".
CTL_STABLE_PTS = 2.0
#: Forme de fond gained in 7 days above which the ramp is too steep (points of
#: daily load per week; 5 to 8 is the usual ceiling of a build block).
RAMP_HIGH_PTS = 8.0
#: ACWR bands of ``workload.get_acwr_zone`` and ``coaching_rules.generate_daily_tip``.
ACWR_CAUTION = 1.3
ACWR_DANGER = 1.5
#: Foster's monotony threshold (``workload.get_monotony_zone``).
MONOTONY_HIGH = 2.0
#: The week pattern reads at least this span, and needs this many weeks per group.
PATTERN_MIN_WEEKS = 12
PATTERN_MIN_GROUP = 2
#: Weekly forme de fond gain by which more training days must win to "pay".
PATTERN_MIN_GAP_PTS = 1.0

SESSIONS = "tes séances"

FORM_WORD: dict[FormZone, str] = {
    FormZone.FRESHEST: "très frais",
    FormZone.FRESH: "frais",
    FormZone.NEUTRAL: "neutre",
    FormZone.TIRED: "fatigué",
    FormZone.EXHAUSTED: "très fatigué",
}


def fr(value: float, digits: int = 0, sign: bool = False) -> str:
    """French decimal comma: 1,42 ; ``sign`` keeps the + of a gain."""
    text = f"{value:+.{digits}f}" if sign else f"{value:.{digits}f}"
    return text.replace(".", ",")


def period_phrase(window: PeriodWindow) -> str:
    """The window as a sentence names it."""
    if window.period == "all":
        return "depuis ta première séance"
    if window.period == "6m":
        return "sur les 6 derniers mois"
    if window.period == "1y":
        return "sur les 12 derniers mois"
    return f"sur les {window.days} derniers jours"


def _sentence(period: str, body: str, source: str) -> str:
    return f"{period[0].upper()}{period[1:]}, {body}, d’après {source}."


def _answer(key: AnswerId, period: str, body: str, source: str, tone: Tone) -> Answer:
    return {
        "id": key,
        "question": QUESTIONS[key],
        "text": _sentence(period, body, source),
        "tone": tone,
        "period": period,
        "source": source,
    }


# --------------------------------------------------------------------------- #
# Suis-je prêt ?
# --------------------------------------------------------------------------- #
READINESS_SOURCE: dict[str, str] = {
    "garmin_training": "ta montre Garmin et tes séances",
    "garmin": "tes nuits Garmin et tes séances",
}


def ready_answer(
    today: date,
    readiness: float | None,
    readiness_source: str | None,
    measured_on: date | None,
    tsb: float | None,
) -> Answer:
    """Today's readiness (the one every surface shows) and the fraîcheur zone.

    The modelled readiness is itself read from the fraîcheur, so only a
    Garmin one is quoted next to it.
    """
    period = "aujourd’hui"
    garmin = readiness is not None and readiness_source in READINESS_SOURCE
    source = (
        READINESS_SOURCE.get(readiness_source or "", SESSIONS) if garmin else SESSIONS
    )
    if not garmin and tsb is None:
        return _answer(
            "ready",
            period,
            "ni séance ni nuit mesurée pour juger ta forme",
            "tes séances et ta montre Garmin",
            "neutral",
        )

    parts = []
    level: ReadinessLevel | None = None
    if garmin:
        assert readiness is not None
        level = get_readiness_level(readiness)
        night = (
            " (nuit d’hier)" if measured_on is not None and measured_on < today else ""
        )
        parts.append(f"préparation à {readiness:.0f}/100{night}")
    zone = get_form_zone(tsb) if tsb is not None else None
    if tsb is not None and zone is not None:
        parts.append(f"fraîcheur à {fr(tsb, sign=True)} ({FORM_WORD[zone]})")

    tone: Tone
    if level in (ReadinessLevel.LOW, ReadinessLevel.CRITICAL) or (
        zone == FormZone.EXHAUSTED
    ):
        tone, verdict = "bad", "récupère d’abord, repos ou séance très facile"
    elif level == ReadinessLevel.MODERATE or zone == FormZone.TIRED:
        tone, verdict = "warn", "garde une séance facile ou modérée"
    elif level in (ReadinessLevel.OPTIMAL, ReadinessLevel.GOOD) or zone in (
        FormZone.FRESH,
        FormZone.FRESHEST,
    ):
        tone, verdict = "good", "feu vert pour une séance dure ou un test"
    else:
        tone, verdict = "neutral", "entraînement normal possible"
    return _answer("ready", period, f"{' et '.join(parts)} : {verdict}", source, tone)


# --------------------------------------------------------------------------- #
# Est-ce que je progresse ?
# --------------------------------------------------------------------------- #
LiftTrend = tuple[str, float, float]  # (exercise, previous best e1RM, best e1RM)


def progress_answer(
    window: PeriodWindow,
    ctl_start: float | None,
    ctl_end: float | None,
    pace_slope: float | None,
    lift: LiftTrend | None = None,
) -> Answer:
    """Forme de fond over the window, with the pace trend (or a lift's e1RM).

    ``pace_slope`` is the Allure card's trend, in s/km per month (negative is
    faster), None below its minimum number of runs. ``lift`` reads only when
    there is no pace trend: a strength athlete's progress is a heavier lift.
    """
    period = period_phrase(window)
    if not ctl_end and not ctl_start and pace_slope is None and lift is None:
        return _answer(
            "progress",
            period,
            "aucune séance pour mesurer une progression",
            SESSIONS,
            "neutral",
        )

    start, end = ctl_start or 0.0, ctl_end or 0.0
    delta = end - start
    parts = [
        f"ta forme de fond passe de {fr(start)} à {fr(end)} ({fr(delta, sign=True)})"
    ]
    source = SESSIONS
    improving = worsening = False
    if pace_slope is not None:
        source = "tes séances et tes courses"
        if pace_slope <= -PACE_TREND_SIGNIFICANT:
            improving = True
            parts.append(f"ton allure gagne {fr(abs(pace_slope))} s/km par mois")
        elif pace_slope >= PACE_TREND_SIGNIFICANT:
            worsening = True
            parts.append(f"ton allure perd {fr(pace_slope)} s/km par mois")
        else:
            parts.append("ton allure reste stable")
    elif lift is not None:
        exercise, previous, best = lift
        source = "tes séances et ton journal de force"
        improving, worsening = best > previous, best < previous
        parts.append(
            f"ton meilleur e1RM ({exercise}) passe de {fr(previous)} à {fr(best)} kg"
        )

    tone: Tone
    if (delta >= CTL_STABLE_PTS and not worsening) or (
        improving and delta > -CTL_STABLE_PTS
    ):
        tone, verdict = "good", "tu progresses"
    elif worsening or delta <= -CTL_STABLE_PTS:
        tone, verdict = "warn", "tu régresses pour l’instant"
    else:
        tone, verdict = "neutral", "tu te maintiens"
    return _answer(
        "progress", period, f"{' et '.join(parts)} : {verdict}", source, tone
    )


# --------------------------------------------------------------------------- #
# Où est le risque ?
# --------------------------------------------------------------------------- #
def risk_answer(
    acwr: float | None, monotony: float | None, ramp: float | None
) -> Answer:
    """The first risk of the last 7 days, with the three numbers it is read from.

    ``ramp`` is the forme de fond gained over the last 7 days. First match:
    ACWR above 1.5, a steep ramp, ACWR above 1.3, a monotonous week.
    """
    period = "sur les 7 derniers jours"
    if acwr is None and monotony is None and not ramp:
        return _answer(
            "risk",
            period,
            "aucune charge enregistrée, rien à surveiller",
            SESSIONS,
            "neutral",
        )

    values = []
    if acwr is not None:
        values.append(f"ACWR {fr(acwr, 2)}")
    if monotony is not None:
        values.append(f"monotonie {fr(monotony, 1)}")
    if ramp is not None:
        values.append(f"forme de fond {fr(ramp, 1, sign=True)} en 7 jours")
    tail = f" ({', '.join(values)})" if values else ""

    tone: Tone
    if acwr is not None and acwr > ACWR_DANGER:
        tone, main = (
            "bad",
            "risque de blessure, ta charge aiguë dépasse largement la chronique",
        )
    elif ramp is not None and ramp > RAMP_HIGH_PTS:
        tone, main = "warn", "ta forme de fond monte trop vite, stabilise la charge"
    elif acwr is not None and acwr > ACWR_CAUTION:
        tone, main = "warn", "ta charge monte vite, n’ajoute rien cette semaine"
    elif monotony is not None and monotony > MONOTONY_HIGH:
        tone, main = "warn", "semaine trop monotone, alterne jours durs et faciles"
    else:
        tone, main = "good", "aucun signal d’alerte"
    return _answer("risk", period, f"{main}{tail}", SESSIONS, tone)


# --------------------------------------------------------------------------- #
# Qu'est-ce qui marche ?
# --------------------------------------------------------------------------- #
class Week(TypedDict):
    end: date
    active_days: int
    ctl_gain: float


def weeks_of(
    window: PeriodWindow,
    active_dates: set[date],
    ctl_by_date: dict[date, float],
) -> tuple[str, list[Week]]:
    """Consecutive 7-day weeks ending on the window's last day, oldest first.

    The window when it spans at least ``PATTERN_MIN_WEEKS`` weeks, else that
    many weeks: a short period has too few weeks to compare.
    """
    if window.days >= PATTERN_MIN_WEEKS * 7:
        period, count = period_phrase(window), window.days // 7
    else:
        period, count = (
            f"sur les {PATTERN_MIN_WEEKS} dernières semaines",
            PATTERN_MIN_WEEKS,
        )
    weeks: list[Week] = []
    for back in range(count - 1, -1, -1):
        end = window.end - timedelta(days=7 * back)
        start = end - timedelta(days=6)
        days = sum(1 for i in range(7) if start + timedelta(days=i) in active_dates)
        gain = ctl_by_date.get(end, 0.0) - ctl_by_date.get(
            start - timedelta(days=1), 0.0
        )
        weeks.append({"end": end, "active_days": days, "ctl_gain": gain})
    return period, weeks


def _split_weeks(weeks: Sequence[Week]) -> tuple[int, list[Week], list[Week]] | None:
    """The training-days threshold that splits the weeks most evenly."""
    best: tuple[int, list[Week], list[Week]] | None = None
    for k in sorted({w["active_days"] for w in weeks})[1:]:
        high = [w for w in weeks if w["active_days"] >= k]
        low = [w for w in weeks if w["active_days"] < k]
        if best is None or min(len(high), len(low)) >= min(len(best[1]), len(best[2])):
            best = (k, high, low)
    if best is None or min(len(best[1]), len(best[2])) < PATTERN_MIN_GROUP:
        return None
    return best


def works_answer(period: str, weeks: Sequence[Week]) -> Answer:
    """Which week pattern builds the forme de fond: more training days, or not.

    Weeks are split on the number of training days that divides them most
    evenly; the answer compares the mean forme de fond gained by each group.
    """
    split = _split_weeks([w for w in weeks if w["active_days"] or w["ctl_gain"]])
    if split is None:
        return _answer(
            "works",
            period,
            "pas encore assez de semaines comparables pour dire ce qui marche",
            SESSIONS,
            "neutral",
        )
    k, high, low = split
    hi = sum(w["ctl_gain"] for w in high) / len(high)
    lo = sum(w["ctl_gain"] for w in low) / len(low)
    days = f"tes semaines à {k} jours d’entraînement ou plus"
    if hi - lo >= PATTERN_MIN_GAP_PTS:
        body = (
            f"{days} font monter ta forme de fond de {fr(hi, 1, sign=True)} en moyenne, "
            f"contre {fr(lo, 1, sign=True)} pour les autres : la régularité paie"
        )
        return _answer("works", period, body, SESSIONS, "good")
    body = (
        f"{days} ne font pas plus monter ta forme de fond ({fr(hi, 1, sign=True)} contre "
        f"{fr(lo, 1, sign=True)}) : le nombre de jours ne fait pas la différence"
    )
    return _answer("works", period, body, SESSIONS, "neutral")


__all__ = [
    "Answer",
    "QUESTIONS",
    "Week",
    "period_phrase",
    "progress_answer",
    "ready_answer",
    "risk_answer",
    "weeks_of",
    "works_answer",
]
