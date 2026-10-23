"""One sentence per analytics card, in French.

Rule-based on purpose: the numbers are already on screen, what is missing is what
they mean. Every function takes what the card computed and returns a short line
plus a tone the UI colours.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from arete.features.workload import format_acwr

Tone = Literal["good", "neutral", "warn", "bad"]


class Insight(TypedDict):
    text: str
    tone: Tone


def _insight(text: str, tone: Tone = "neutral") -> Insight:
    return {"text": text, "tone": tone}


def _pct(value: float) -> str:
    return f"{value:+.0f} %"


# --- Charge ---------------------------------------------------------------
VOLUME_SPIKE_PCT = 25.0
VOLUME_STABLE_PCT = 5.0


def volume_insight(km: float, prev_km: float | None, hours: float) -> Insight:
    if km <= 0:
        return _insight("Aucune séance sur la période.")
    base = f"{km:.0f} km, {hours:.1f} h"
    if not prev_km:
        return _insight(f"{base} sur la période.")
    change = (km - prev_km) / prev_km * 100
    if change > VOLUME_SPIKE_PCT:
        return _insight(
            f"{base}. Volume en forte hausse ({_pct(change)}) : surveille la fatigue.",
            "warn",
        )
    if change < -VOLUME_SPIKE_PCT:
        return _insight(
            f"{base}. Volume en nette baisse ({_pct(change)}) : coupure ou récupération ?",
            "warn",
        )
    if abs(change) <= VOLUME_STABLE_PCT:
        return _insight(f"{base}. Volume stable ({_pct(change)}).", "good")
    return _insight(f"{base}. Progression maîtrisée ({_pct(change)}).", "good")


def pmc_insight(
    ctl: float, tsb: float, acwr: float | None, acwr_zone: str | None
) -> Insight:
    head = f"Forme de fond {ctl:.0f}, fraîcheur {tsb:+.0f}"
    if acwr is not None and acwr > 1.5:
        return _insight(
            f"{head}. Charge aiguë très supérieure à la chronique (ACWR {format_acwr(acwr)}) : risque de blessure.",
            "bad",
        )
    if tsb < -25:
        return _insight(f"{head}. Fatigue lourde : prévois une décharge.", "bad")
    if acwr is not None and acwr > 1.3:
        return _insight(
            f"{head}. Montée de charge rapide (ACWR {format_acwr(acwr)}) : ne rajoute rien cette semaine.",
            "warn",
        )
    if tsb < -10:
        return _insight(f"{head}. La fatigue s'accumule, normal en bloc de charge.")
    if tsb > 25:
        return _insight(
            f"{head}. Très frais : c'est le moment de performer, ou de recharger.",
            "warn",
        )
    zone = f" ({acwr_zone})" if acwr_zone else ""
    return _insight(f"{head}. Charge équilibrée{zone}.", "good")


# --- Intensité ------------------------------------------------------------
POLARIZED_EASY_PCT = 75.0
POLARIZED_HARD_PCT = 20.0
MIN_ZONE_MINUTES = 60


def zones_insight(
    easy_pct: float | None, hard_pct: float | None, total_min: int
) -> Insight:
    if easy_pct is None or total_min < MIN_ZONE_MINUTES:
        return _insight(
            "Pas assez de temps avec une mesure de FC pour juger la répartition."
        )
    hard = hard_pct or 0.0
    if easy_pct >= POLARIZED_EASY_PCT and hard <= POLARIZED_HARD_PCT:
        return _insight(
            f"Répartition polarisée : {easy_pct:.0f} % en Z1-Z2, {hard:.0f} % en Z4-Z5.",
            "good",
        )
    if easy_pct < 60:
        return _insight(
            f"Trop d'intensité moyenne : seulement {easy_pct:.0f} % en Z1-Z2.", "warn"
        )
    return _insight(f"{easy_pct:.0f} % en Z1-Z2, {hard:.0f} % en Z4-Z5 : vise 80/20.")


def sports_insight(
    top_sport: str | None, top_pct: float | None, n_sports: int
) -> Insight:
    if not top_sport or top_pct is None:
        return _insight("Aucune séance sur la période.")
    if n_sports == 1:
        return _insight(f"Uniquement du {top_sport} sur la période.")
    return _insight(
        f"{top_sport} domine avec {top_pct:.0f} % du temps, sur {n_sports} sports."
    )


# --- Économie cardiaque ---------------------------------------------------
DECOUPLING_GOOD_PCT = 5.0
DECOUPLING_OK_PCT = 10.0


def decoupling_insight(avg_pct: float | None, n_runs: int) -> Insight:
    if avg_pct is None or n_runs == 0:
        return _insight(
            "Pas de sortie assez longue (≥ 40 min avec des tours) pour mesurer le découplage."
        )
    tail = f"sur {n_runs} sortie{'s' if n_runs > 1 else ''}"
    if avg_pct < DECOUPLING_GOOD_PCT:
        return _insight(
            f"Découplage moyen {avg_pct:.1f} % {tail} : base aérobie solide.", "good"
        )
    if avg_pct < DECOUPLING_OK_PCT:
        return _insight(
            f"Découplage moyen {avg_pct:.1f} % {tail} : correct, encore de la marge."
        )
    return _insight(
        f"Découplage moyen {avg_pct:.1f} % {tail} : base aérobie à travailler.", "warn"
    )


PACE_TREND_MIN_RUNS = 5
PACE_TREND_SIGNIFICANT = 3.0  # s/km per month


def pace_insight(slope_sec_km_per_month: float | None, n_runs: int) -> Insight:
    if slope_sec_km_per_month is None or n_runs < PACE_TREND_MIN_RUNS:
        return _insight(
            f"Trop peu de sorties ({n_runs}) pour dégager une tendance d'allure."
        )
    if slope_sec_km_per_month <= -PACE_TREND_SIGNIFICANT:
        return _insight(
            f"Allure en progression : {abs(slope_sec_km_per_month):.0f} s/km gagnées par mois.",
            "good",
        )
    if slope_sec_km_per_month >= PACE_TREND_SIGNIFICANT:
        return _insight(
            f"Allure qui se dégrade : {slope_sec_km_per_month:.0f} s/km perdues par mois.",
            "warn",
        )
    return _insight("Allure stable sur la période.")


# --- Terrain & foulée -----------------------------------------------------
FLAT_M_PER_KM = 10.0
HILLY_M_PER_KM = 25.0
ELEVATION_SPIKE_PCT = 50.0


def elevation_insight(
    climb_m: float, prev_climb_m: float | None, m_per_km: float | None
) -> Insight:
    if climb_m <= 0:
        return _insight("Aucun dénivelé enregistré sur la période.")
    base = f"{climb_m:.0f} m D+"
    if m_per_km is not None:
        terrain = (
            "plat"
            if m_per_km < FLAT_M_PER_KM
            else "vallonné"
            if m_per_km < HILLY_M_PER_KM
            else "montagneux"
        )
        base += f", terrain {terrain} en course ({m_per_km:.0f} m/km)"
    if prev_climb_m:
        change = (climb_m - prev_climb_m) / prev_climb_m * 100
        if change > ELEVATION_SPIKE_PCT:
            return _insight(
                f"{base}. Dénivelé en forte hausse ({_pct(change)}) : "
                "ménage mollets et quadriceps.",
                "warn",
            )
    return _insight(f"{base}.")


def vam_insight(
    best: int | None, record: int | None, minutes: int, n_sessions: int
) -> Insight:
    """``best`` is the period's best climbing speed over ``minutes``."""
    if not n_sessions:
        return _insight(
            "Aucune sortie à pied avec les flux de la montre sur la période."
        )
    if best is None:
        return _insight(f"Aucune montée continue de {minutes} min sur la période.")
    if record is not None and best >= record:
        return _insight(
            f"Record de vitesse ascensionnelle sur {minutes} min : {best} m/h.",
            "good",
        )
    if record:
        return _insight(
            f"Meilleure montée de {minutes} min à {best} m/h, "
            f"{best / record * 100:.0f} % du record ({record} m/h)."
        )
    return _insight(f"Meilleure montée de {minutes} min à {best} m/h.")


def descent_insight(gain_pct: float | None, descent_min: float) -> Insight:
    """``gain_pct``: descent speed over flat speed, minus one, in percent."""
    if gain_pct is None:
        return _insight(
            "Pas assez de descente courue avec les flux de la montre "
            "pour la comparer au plat."
        )
    if gain_pct < 0:
        return _insight(
            f"En descente (pente de 5 % et plus, {descent_min:.0f} min), "
            f"tu vas {abs(gain_pct):.0f} % moins vite que sur le plat : "
            "la descente se travaille, technique et quadriceps.",
            "warn",
        )
    return _insight(
        f"En descente (pente de 5 % et plus, {descent_min:.0f} min), "
        f"tu vas {gain_pct:.0f} % plus vite que sur le plat."
    )


LOW_CADENCE = 160
CADENCE_SHIFT = 3


def cadence_insight(median: float | None, prev: float | None, n_runs: int) -> Insight:
    if median is None:
        return _insight("Aucune cadence de course enregistrée sur la période.")
    plural = "s" if n_runs > 1 else ""
    base = f"Cadence médiane {median:.0f} pas/min sur {n_runs} sortie{plural}"
    if median < LOW_CADENCE:
        return _insight(
            f"{base} : plutôt basse, une foulée plus courte allège les impacts.",
            "warn",
        )
    if prev is not None and abs(median - prev) >= CADENCE_SHIFT:
        trend = "en hausse" if median > prev else "en baisse"
        return _insight(f"{base}, {trend} ({median - prev:+.0f}).")
    return _insight(f"{base}.")


# --- Récupération ---------------------------------------------------------
def readiness_insight(mean: float | None, prev_mean: float | None) -> Insight:
    if mean is None:
        return _insight("Aucune donnée Garmin sur la période.")
    if prev_mean is None:
        return _insight(f"Préparation moyenne {mean:.0f}/100.")
    delta = mean - prev_mean
    if delta > 5:
        return _insight(
            f"Préparation moyenne {mean:.0f}/100, en hausse ({delta:+.0f}).", "good"
        )
    if delta < -5:
        return _insight(
            f"Préparation moyenne {mean:.0f}/100, en baisse ({delta:+.0f}).", "warn"
        )
    return _insight(f"Préparation moyenne {mean:.0f}/100, stable.")


def hrv_insight(mean: float | None, prev_mean: float | None) -> Insight:
    if mean is None:
        return _insight("Aucune mesure de VFC sur la période.")
    if prev_mean is None or prev_mean == 0:
        return _insight(f"VFC moyenne {mean:.0f} ms.")
    change = (mean - prev_mean) / prev_mean * 100
    if change > 5:
        return _insight(
            f"VFC moyenne {mean:.0f} ms ({_pct(change)}) : bonne adaptation.", "good"
        )
    if change < -10:
        return _insight(
            f"VFC moyenne {mean:.0f} ms ({_pct(change)}) : fatigue ou stress.", "warn"
        )
    return _insight(f"VFC moyenne {mean:.0f} ms, stable.")


SLEEP_SHORT_SEC = 6.5 * 3600
SLEEP_GOOD_SEC = 7.5 * 3600


def sleep_insight(mean_sec: float | None, mean_score: float | None) -> Insight:
    if mean_sec is None:
        return _insight("Aucune donnée de sommeil sur la période.")
    hours = int(mean_sec // 3600)
    minutes = int(round((mean_sec - hours * 3600) / 60))
    duration = f"{hours}h{minutes:02d}"
    score = f", score {mean_score:.0f}/100" if mean_score is not None else ""
    if mean_sec < SLEEP_SHORT_SEC:
        return _insight(f"Sommeil court : {duration} en moyenne{score}.", "warn")
    if mean_sec >= SLEEP_GOOD_SEC:
        return _insight(f"Sommeil suffisant : {duration} en moyenne{score}.", "good")
    return _insight(f"Sommeil moyen : {duration}{score}.")


def resting_hr_insight(mean: float | None, prev_mean: float | None) -> Insight:
    if mean is None:
        return _insight("Aucune mesure de FC de repos sur la période.")
    if prev_mean is None:
        return _insight(f"FC de repos moyenne {mean:.0f} bpm.")
    delta = mean - prev_mean
    if delta > 3:
        return _insight(
            f"FC de repos {mean:.0f} bpm ({delta:+.0f}) : fatigue ou début de maladie ?",
            "warn",
        )
    if delta < -2:
        return _insight(
            f"FC de repos {mean:.0f} bpm ({delta:+.0f}) : bon signe.", "good"
        )
    return _insight(f"FC de repos {mean:.0f} bpm, stable.")
