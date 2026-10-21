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
from arete.features.overview import Card, headline
from arete.features.periods import PeriodWindow
from arete.strength.progression import E1RM_EPSILON

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
#: A shorter window is too short to judge progress: the answer reads the
#: last 30 days instead (and says so), never one week's swing.
PROGRESS_MIN_DAYS = 28
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
#: Weekly forme de fond gain by which the weeks with more training days must
#: differ for the sentence to say they went with a bigger gain.
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
    """French decimal comma: 1,42 ; ``sign`` keeps the + of a gain.

    A value that rounds to zero is written 0, never -0 or +0.
    """
    rounded = round(value, digits) + 0.0  # -0.0 + 0.0 is 0.0
    if rounded == 0:
        return f"{0:.{digits}f}".replace(".", ",")
    text = f"{rounded:+.{digits}f}" if sign else f"{rounded:.{digits}f}"
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

    ``window`` spans at least ``PROGRESS_MIN_DAYS`` (the service passes the
    last 30 days for a shorter period). ``pace_slope`` is the Allure card's
    trend over that window, in s/km per month (negative is faster), None
    below its minimum number of runs. ``lift`` reads only when there is no
    pace trend: a strength athlete's progress is a heavier lift.
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
        if fr(delta) != "0"
        else f"ta forme de fond reste à {fr(end)}"
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
        improving = best > previous + E1RM_EPSILON
        worsening = best < previous - E1RM_EPSILON
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
            "risque de blessure : ta charge aiguë dépasse largement la chronique",
        )
    elif ramp is not None and ramp > RAMP_HIGH_PTS:
        tone, main = "warn", "ta forme de fond monte trop vite : stabilise la charge"
    elif acwr is not None and acwr > ACWR_CAUTION:
        tone, main = "warn", "ta charge monte vite : n’en rajoute pas cette semaine"
    elif monotony is not None and monotony > MONOTONY_HIGH:
        tone, main = "warn", "semaine trop monotone : alterne jours durs et faciles"
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

    The window's whole weeks when it spans at least ``PATTERN_MIN_WEEKS``
    weeks, else that many weeks: a short period has too few weeks to compare.
    The phrase names the weeks read (« les 12 dernières semaines » on 90
    days, which hold 12 whole weeks).
    """
    count = max(window.days // 7, PATTERN_MIN_WEEKS)
    period = (
        period_phrase(window)
        if count * 7 == window.days
        else f"sur les {count} dernières semaines"
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


def trained_weeks(weeks: Sequence[Week]) -> list[Week]:
    """The weeks with at least one session: an illness or a holiday is no pattern."""
    return [w for w in weeks if w["active_days"] > 0]


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


def _weeks(n: int) -> str:
    return "ta semaine" if n == 1 else f"tes {n} semaines"


def works_answer(period: str, weeks: Sequence[Week]) -> Answer:
    """Which weeks went with a rising forme de fond: a description, not a cause.

    The weeks with a session are split on the number of training days that
    divides them most evenly, and the mean forme de fond gained by each group
    is reported. The forme de fond follows the load, so more training days
    raise it by construction: the sentence says what coincided, never that
    a pattern « pays ».
    """
    split = _split_weeks(trained_weeks(weeks))
    if split is None:
        return _answer(
            "works",
            period,
            "pas encore assez de semaines d’entraînement différentes à comparer",
            SESSIONS,
            "neutral",
        )
    k, high, low = split
    hi = sum(w["ctl_gain"] for w in high) / len(high)
    lo = sum(w["ctl_gain"] for w in low) / len(low)
    more = f"{_weeks(len(high))} à {k} jours d’entraînement ou plus"
    fewer = f"{_weeks(len(low))} à moins de {k} jours"
    if hi - lo >= PATTERN_MIN_GAP_PTS:
        body = (
            f"{more} ont vu ta forme de fond monter de {fr(hi, 1, sign=True)} "
            f"en moyenne, contre {fr(lo, 1, sign=True)} pour {fewer} "
            "(semaines sans séance exclues)"
        )
    else:
        body = (
            f"{more} et {fewer} ont vu ta forme de fond évoluer de la même façon "
            f"({fr(hi, 1, sign=True)} contre {fr(lo, 1, sign=True)} en moyenne, "
            "semaines sans séance exclues)"
        )
    return _answer("works", period, body, SESSIONS, "neutral")


# --------------------------------------------------------------------------- #
# The cards that carry the risk and week-pattern numbers
# --------------------------------------------------------------------------- #
def risk_card(acwr: float | None, monotony: float | None, ramp: float | None) -> Card:
    """The three numbers « Où est le risque ? » reads, and the thresholds it applies."""
    return {
        "headline": headline(
            round(acwr, 2) if acwr is not None else None,
            "",
            fr(acwr, 2) if acwr is not None else "—",
            None,
            "neutral",
        ),
        "secondary": [
            headline(
                round(monotony, 2) if monotony is not None else None,
                "",
                fr(monotony, 1) if monotony is not None else "—",
                None,
                "down",
            ),
            headline(
                round(ramp, 1) if ramp is not None else None,
                "pts",
                f"{fr(ramp, 1, sign=True)} pts" if ramp is not None else "—",
                None,
                "neutral",
            ),
        ],
        "insight": {
            "text": (
                f"Seuils : ACWR au-delà de {fr(ACWR_CAUTION, 1)} (prudence) et "
                f"{fr(ACWR_DANGER, 1)} (danger), monotonie au-delà de "
                f"{fr(MONOTONY_HIGH, 1)}, forme de fond au-delà de "
                f"+{fr(RAMP_HIGH_PTS)} en 7 jours."
            ),
            "tone": "neutral",
        },
        "series": [],
    }


def weeks_card(period: str, weeks: Sequence[Week]) -> Card:
    """« Qu’est-ce qui marche ? »: the weeks grouped by training days.

    One row per number of training days: how many weeks, and the forme de
    fond they gained on average. Weeks without a session are left out.
    """
    trained = trained_weeks(weeks)
    by_days: dict[int, list[float]] = {}
    for week in trained:
        by_days.setdefault(week["active_days"], []).append(week["ctl_gain"])
    count = len(trained)
    return {
        "headline": headline(
            count,
            "semaines",
            f"{count} semaine{'s' if count > 1 else ''}",
            None,
            "neutral",
        ),
        "secondary": [],
        "insight": {
            "text": (
                f"{period[0].upper()}{period[1:]}, semaines sans séance exclues. "
                "La forme de fond suit la charge : ce tableau décrit tes semaines, "
                "il ne prouve pas ce qui marche."
            ),
            "tone": "neutral",
        },
        "series": [
            {
                "bucket": str(days),
                "days": days,
                "weeks": len(gains),
                "ctl_gain": round(sum(gains) / len(gains), 1),
            }
            for days, gains in sorted(by_days.items())
        ],
    }


__all__ = [
    "Answer",
    "QUESTIONS",
    "Week",
    "period_phrase",
    "progress_answer",
    "ready_answer",
    "risk_answer",
    "risk_card",
    "trained_weeks",
    "weeks_card",
    "weeks_of",
    "works_answer",
]
