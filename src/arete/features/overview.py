"""Builders for the analytics overview: one card per question.

Each builder turns raw rows into a `Card`: a headline number with its delta
against the previous window, a French sentence, and the series to draw. No SQL,
no HTTP — the API layer fetches rows and hands them over.
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Sequence
from datetime import date
from typing import Any, Literal, TypedDict

from arete.features import insights
from arete.features.hr_drift import analyze_runs
from arete.features.insights import Insight
from arete.features.periods import Bucket, PeriodWindow, bucket_key, bucket_keys

Better = Literal["up", "down", "neutral"]


class Headline(TypedDict):
    value: float | None
    unit: str
    display: str
    previous: float | None
    delta: float | None
    delta_pct: float | None
    better: Better


class Card(TypedDict):
    headline: Headline
    secondary: list[Headline]
    insight: Insight
    series: list[dict[str, Any]]


# --------------------------------------------------------------------------- #
# Formatting and small helpers
# --------------------------------------------------------------------------- #
def format_pace(sec_per_km: float | None) -> str:
    if not sec_per_km or sec_per_km <= 0:
        return "—"
    minutes, seconds = divmod(int(round(sec_per_km)), 60)
    return f"{minutes}:{seconds:02d} /km"


def format_hms(seconds: float | None) -> str:
    """m:ss below an hour, h:mm:ss above (a half marathon is 1:32:15, not 92:15)."""
    if seconds is None:
        return "—"
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    hours, minutes = divmod(int(round(seconds / 60)), 60)
    return f"{hours}h{minutes:02d}" if hours else f"{minutes} min"


def headline(
    value: float | None,
    unit: str,
    display: str,
    previous: float | None = None,
    better: Better = "up",
) -> Headline:
    delta = None if value is None or previous is None else value - previous
    delta_pct = None if delta is None or not previous else delta / previous * 100
    return {
        "value": value,
        "unit": unit,
        "display": display,
        "previous": previous,
        "delta": None if delta is None else round(delta, 2),
        "delta_pct": None if delta_pct is None else round(delta_pct, 1),
        "better": better,
    }


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _split(rows: Sequence[Any], window: PeriodWindow, key=lambda r: r[0]):
    """Split rows fetched over both windows into (current, previous)."""
    cur = [r for r in rows if window.start <= key(r) <= window.end]
    if window.prev_start is None or window.prev_end is None:
        return cur, []
    prev = [r for r in rows if window.prev_start <= key(r) <= window.prev_end]
    return cur, prev


def _empty_series(window: PeriodWindow, fields: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"bucket": key, **fields}
        for key in bucket_keys(window.start, window.end, window.bucket)
    ]


# --------------------------------------------------------------------------- #
# Charge
# --------------------------------------------------------------------------- #
def build_volume_card(
    rows: Sequence[tuple[date, str, int, float | None]],
    window: PeriodWindow,
    running_sports: Sequence[str],
) -> Card:
    """rows: (date, sport, duration_sec, distance_m) over both windows."""
    cur, prev = _split(rows, window)

    def totals(
        subset: Sequence[tuple[date, str, int, float | None]],
    ) -> tuple[float, float, float]:
        km = sum((r[3] or 0) for r in subset) / 1000
        run_km = sum((r[3] or 0) for r in subset if r[1] in running_sports) / 1000
        hours = sum(r[2] or 0 for r in subset) / 3600
        return km, run_km, hours

    km, run_km, hours = totals(cur)
    prev_km, prev_run_km, prev_hours = totals(prev) if prev else (None, None, None)

    buckets: dict[str, dict[str, float]] = {
        key: {"km": 0.0, "run_km": 0.0, "hours": 0.0}
        for key in bucket_keys(window.start, window.end, window.bucket)
    }
    for day, sport, duration_sec, distance_m in cur:
        slot = buckets.get(bucket_key(day, window.bucket))
        if slot is None:
            continue
        slot["km"] += (distance_m or 0) / 1000
        slot["hours"] += (duration_sec or 0) / 3600
        if sport in running_sports:
            slot["run_km"] += (distance_m or 0) / 1000

    return {
        "headline": headline(
            round(run_km, 1), "km", f"{run_km:.0f} km", prev_run_km, "up"
        ),
        "secondary": [
            headline(
                round(hours, 1), "h", format_duration(hours * 3600), prev_hours, "up"
            ),
            headline(round(km, 1), "km", f"{km:.0f} km (tous sports)", prev_km, "up"),
        ],
        "insight": insights.volume_insight(run_km, prev_run_km, hours),
        "series": [
            {"bucket": key, **{k: round(v, 1) for k, v in vals.items()}}
            for key, vals in buckets.items()
        ],
    }


def build_pmc_card(
    series: Sequence[tuple[Any, float, float]],
    window: PeriodWindow,
    acwr: float | None,
    acwr_zone: str | None,
) -> Card:
    """series: (DailyTSS, ctl, atl) covering warm-up + both windows."""
    by_bucket: dict[str, tuple[float, float, float]] = {}
    tss_sum: dict[str, float] = defaultdict(float)
    prev_state: tuple[float, float] | None = None

    for day, ctl, atl in series:
        if window.prev_end is not None and day.date == window.prev_end:
            prev_state = (ctl, atl)
        if not (window.start <= day.date <= window.end):
            continue
        key = bucket_key(day.date, window.bucket)
        by_bucket[key] = (
            ctl,
            atl,
            ctl - atl,
        )  # state at the last day seen in the bucket
        tss_sum[key] += day.tss

    points = [
        {
            "bucket": key,
            "ctl": round(by_bucket[key][0], 1) if key in by_bucket else None,
            "atl": round(by_bucket[key][1], 1) if key in by_bucket else None,
            "tsb": round(by_bucket[key][2], 1) if key in by_bucket else None,
            "tss": round(tss_sum.get(key, 0.0), 1),
        }
        for key in bucket_keys(window.start, window.end, window.bucket)
    ]

    ctl, atl, tsb = by_bucket[max(by_bucket)] if by_bucket else (0.0, 0.0, 0.0)
    prev_ctl = prev_state[0] if prev_state else None
    prev_tsb = (prev_state[0] - prev_state[1]) if prev_state else None

    return {
        "headline": headline(round(ctl, 1), "pts", f"{ctl:.0f}", prev_ctl, "up"),
        "secondary": [
            headline(round(tsb, 1), "pts", f"{tsb:+.0f}", prev_tsb, "up"),
            # The ACWR is shown by the risk card (``answers.risk_card``); the
            # insight below still warns about it.
            headline(round(atl, 1), "pts", f"{atl:.0f}", None, "down"),
        ],
        "insight": insights.pmc_insight(ctl, tsb, acwr, acwr_zone),
        "series": points,
    }


# --------------------------------------------------------------------------- #
# Intensité
# --------------------------------------------------------------------------- #
ZONES = ("z1", "z2", "z3", "z4", "z5")


def _zone_key(raw: str) -> str | None:
    """'Z1', 'z1', 'zone1' -> 'z1'."""
    digits = "".join(c for c in str(raw) if c.isdigit())
    return f"z{digits}" if digits in {"1", "2", "3", "4", "5"} else None


def _zone_seconds(rows: Sequence[tuple[date, str]]) -> dict[str, float]:
    totals: dict[str, float] = dict.fromkeys(ZONES, 0.0)
    for _, raw in rows:
        try:
            zones = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (json.JSONDecodeError, TypeError):
            continue
        for name, seconds in (zones or {}).items():
            key = _zone_key(name)
            if key:
                totals[key] += float(seconds or 0)
    return totals


def build_zones_card(rows: Sequence[tuple[date, str]], window: PeriodWindow) -> Card:
    """rows: (date, hr_zones_json) over both windows."""
    cur, prev = _split(rows, window)

    def shares(
        subset: Sequence[tuple[date, str]],
    ) -> tuple[float | None, float | None, int]:
        totals = _zone_seconds(subset)
        total = sum(totals.values())
        if total <= 0:
            return None, None, 0
        easy = (totals["z1"] + totals["z2"]) / total * 100
        hard = (totals["z4"] + totals["z5"]) / total * 100
        return easy, hard, int(total / 60)

    easy, hard, total_min = shares(cur)
    prev_easy, _, _ = shares(prev) if prev else (None, None, 0)

    by_bucket: dict[str, list[tuple[date, str]]] = defaultdict(list)
    for row in cur:
        by_bucket[bucket_key(row[0], window.bucket)].append(row)

    points = []
    for key in bucket_keys(window.start, window.end, window.bucket):
        totals = _zone_seconds(by_bucket.get(key, []))
        total = sum(totals.values())
        point: dict[str, Any] = {"bucket": key, "total_min": int(total / 60)}
        for zone in ZONES:
            point[zone] = round(totals[zone] / 60)
            point[f"{zone}_pct"] = (
                round(totals[zone] / total * 100, 1) if total else 0.0
            )
        points.append(point)

    return {
        "headline": headline(
            round(easy, 1) if easy is not None else None,
            "%",
            f"{easy:.0f} %" if easy is not None else "—",
            round(prev_easy, 1) if prev_easy is not None else None,
            "up",
        ),
        "secondary": [
            headline(
                round(hard, 1) if hard is not None else None,
                "%",
                f"{hard:.0f} %" if hard is not None else "—",
                None,
                "neutral",
            ),
            headline(total_min, "min", format_duration(total_min * 60), None, "up"),
        ],
        "insight": insights.zones_insight(easy, hard, total_min),
        "series": points,
    }


# Garmin and Strava spell the same sport differently; the cards read in French.
SPORT_LABEL_FR: dict[str, str] = {
    "run": "course",
    "running": "course",
    "trail_run": "trail",
    "trail_running": "trail",
    "treadmill_running": "tapis",
    "virtual_run": "course virtuelle",
    "virtualrun": "course virtuelle",
    "ride": "vélo",
    "cycling": "vélo",
    "virtual_ride": "home-trainer",
    "indoor_cycling": "vélo intérieur",
    "mountain_biking": "VTT",
    "swim": "natation",
    "swimming": "natation",
    "lap_swimming": "natation",
    "strength": "musculation",
    "strength_training": "musculation",
    "weight_training": "musculation",
    "walk": "marche",
    "walking": "marche",
    "hike": "randonnée",
    "hiking": "randonnée",
    "rowing": "rameur",
    "indoor_rowing": "rameur",
    "yoga": "yoga",
    "mobility": "mobilité",
    "cardio": "cardio",
}


def sport_label(sport: str) -> str:
    return SPORT_LABEL_FR.get(sport.lower(), sport.replace("_", " "))


def build_sports_card(
    cur: Sequence[tuple[str, float, int]], prev: Sequence[tuple[str, float, int]]
) -> Card:
    """rows: (sport, hours, count) already aggregated per window."""
    total_hours = sum(r[1] for r in cur)
    rows = sorted(cur, key=lambda r: -r[1])
    series = [
        {
            "sport": sport,
            "hours": round(hours, 1),
            "count": count,
            "pct": round(hours / total_hours * 100, 1) if total_hours else 0.0,
        }
        for sport, hours, count in rows
    ]
    prev_hours = sum(r[1] for r in prev) if prev else None
    top_sport: str | None = sport_label(rows[0][0]) if rows else None
    top_pct: float | None = (
        round(rows[0][1] / total_hours * 100, 1) if rows and total_hours else None
    )

    return {
        "headline": headline(
            round(total_hours, 1),
            "h",
            format_duration(total_hours * 3600),
            prev_hours,
            "up",
        ),
        "secondary": [
            headline(
                top_pct,
                "%",
                f"{top_sport} {top_pct:.0f} %" if top_pct is not None else "—",
                None,
                "neutral",
            )
        ],
        "insight": insights.sports_insight(top_sport, top_pct, len(series)),
        "series": series,
    }


# --------------------------------------------------------------------------- #
# Économie cardiaque
# --------------------------------------------------------------------------- #
def build_decoupling_card(
    drift_rows: Sequence[tuple[Any, ...]],
    efficiency_rows: Sequence[tuple[date, float, float, int]],
    window: PeriodWindow,
) -> Card:
    """drift_rows: the hr-drift SELECT; efficiency_rows: (date, avg_hr, pace, duration)."""
    cur_drift, prev_drift = _split(drift_rows, window, key=lambda r: r[1])
    analysis = analyze_runs(list(cur_drift))
    runs = analysis["runs"]
    avg = _mean([r["decoupling_pct"] for r in runs])
    prev_avg = _mean(
        [r["decoupling_pct"] for r in analyze_runs(list(prev_drift))["runs"]]
    )

    cur_eff, prev_eff = _split(efficiency_rows, window)

    def efficiency(subset: Sequence[tuple[date, float, float, int]]) -> float | None:
        weight = sum(r[3] or 1 for r in subset)
        if not weight:
            return None
        hr = sum(r[1] * (r[3] or 1) for r in subset) / weight
        speed = sum((3600.0 / r[2]) * (r[3] or 1) for r in subset if r[2]) / weight
        return hr / speed if speed else None

    eff = efficiency(cur_eff)
    prev_eff_value = efficiency(prev_eff) if prev_eff else None

    by_bucket: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {"decoupling": [], "hr": [], "speed": [], "weight": []}
    )
    for run in runs:
        slot = by_bucket[bucket_key(date.fromisoformat(run["date"]), window.bucket)]
        slot["decoupling"].append(run["decoupling_pct"])
    for day, avg_hr, pace, duration in cur_eff:
        slot = by_bucket[bucket_key(day, window.bucket)]
        w = duration or 1
        slot["hr"].append(avg_hr * w)
        slot["speed"].append((3600.0 / pace) * w if pace else 0.0)
        slot["weight"].append(w)

    points = []
    for key in bucket_keys(window.start, window.end, window.bucket):
        bucket_slot = by_bucket.get(key)
        decoupling = _mean(bucket_slot["decoupling"]) if bucket_slot else None
        eff_bucket = None
        if bucket_slot and sum(bucket_slot["weight"]):
            weight = sum(bucket_slot["weight"])
            speed = sum(bucket_slot["speed"]) / weight
            eff_bucket = (sum(bucket_slot["hr"]) / weight) / speed if speed else None
        points.append(
            {
                "bucket": key,
                "decoupling_pct": round(decoupling, 1)
                if decoupling is not None
                else None,
                "efficiency": round(eff_bucket, 1) if eff_bucket is not None else None,
                "n_runs": len(bucket_slot["decoupling"]) if bucket_slot else 0,
            }
        )

    return {
        "headline": headline(
            round(avg, 1) if avg is not None else None,
            "%",
            f"{avg:.1f} %" if avg is not None else "—",
            round(prev_avg, 1) if prev_avg is not None else None,
            "down",
        ),
        "secondary": [
            headline(
                round(eff, 1) if eff is not None else None,
                "bpm/(km/h)",
                f"{eff:.1f}" if eff is not None else "—",
                round(prev_eff_value, 1) if prev_eff_value is not None else None,
                "down",
            )
        ],
        "insight": insights.decoupling_insight(avg, len(runs)),
        "series": points,
    }


MIN_PACE_SEC_KM = 150
MAX_PACE_SEC_KM = 900
MIN_PACE_DISTANCE_M = 3000


PaceRow = tuple[date, int, float | None, int, bool]


def build_pace_card(rows: Sequence[PaceRow], window: PeriodWindow) -> Card:
    """rows: (date, pace_sec_km, distance_m, duration_sec, graded) for runs, both windows.

    ``graded`` marks a pace that is the grade-adjusted one (a hilly run with
    kept streams): the trend then compares efforts, not the terrain.
    """
    import numpy as np  # here, not at module level: the API boot skips numpy

    def keep(subset: Sequence[PaceRow]):
        return [
            r
            for r in subset
            if r[1]
            and MIN_PACE_SEC_KM <= r[1] <= MAX_PACE_SEC_KM
            and (r[2] or 0) >= MIN_PACE_DISTANCE_M
        ]

    cur, prev = _split(rows, window)
    cur, prev = keep(cur), keep(prev)

    def median(subset) -> float | None:
        paces = sorted(r[1] for r in subset)
        return float(np.median(paces)) if paces else None

    med = median(cur)
    prev_med = median(prev)

    slope = None
    if len(cur) >= insights.PACE_TREND_MIN_RUNS:
        x = np.array([(r[0] - window.start).days for r in cur], dtype=float)
        y = np.array([r[1] for r in cur], dtype=float)
        if x.max() > x.min():
            slope = float(np.polyfit(x, y, 1)[0]) * 30  # s/km per month

    by_bucket: dict[str, list[int]] = defaultdict(list)
    graded: dict[str, int] = defaultdict(int)
    for day, pace, _distance, _duration, adjusted in cur:
        key = bucket_key(day, window.bucket)
        by_bucket[key].append(pace)
        graded[key] += adjusted
    points = [
        {
            "bucket": key,
            "pace_sec_km": round(float(np.median(by_bucket[key])))
            if key in by_bucket
            else None,
            "n_runs": len(by_bucket.get(key, [])),
            "n_graded": graded.get(key, 0),
        }
        for key in bucket_keys(window.start, window.end, window.bucket)
    ]

    return {
        "headline": headline(
            round(slope, 1) if slope is not None else None,
            "s/km/mois",
            f"{slope:+.0f} s/km · mois" if slope is not None else "—",
            None,
            "down",
        ),
        "secondary": [headline(med, "s/km", format_pace(med), prev_med, "down")],
        "insight": insights.pace_insight(slope, len(cur)),
        "series": points,
    }


# --------------------------------------------------------------------------- #
# Terrain & foulée
# --------------------------------------------------------------------------- #
#: Duration of the climbing-speed card's headline, in minutes.
VAM_HEADLINE_MINUTES = 30

VamRow = tuple[date, int, str | None, dict[int, int | None]]


def build_vam_card(
    rows: Sequence[VamRow], window: PeriodWindow, minutes: Sequence[int]
) -> Card:
    """rows: (date, session_id, name, {minutes: best m/h}) per session on foot, all time.

    A climbing curve like a power curve: per duration, the period's best and
    the all-time record (with the session holding it).
    """
    cur, prev = _split(rows, window)

    def best(subset: Sequence[VamRow], duration: int) -> VamRow | None:
        ranked = [r for r in subset if r[3].get(duration)]
        return max(ranked, key=lambda r: r[3][duration] or 0, default=None)

    def value(row: VamRow | None, duration: int) -> int | None:
        return None if row is None else row[3][duration]

    series: list[dict[str, Any]] = []
    for duration in minutes:
        period, record = best(cur, duration), best(rows, duration)
        series.append(
            {
                "bucket": str(duration),
                "minutes": duration,
                "period": value(period, duration),
                "period_date": None if period is None else period[0].isoformat(),
                "record": value(record, duration),
                "record_date": None if record is None else record[0].isoformat(),
                "record_session": None if record is None else record[1],
                "record_name": None if record is None else record[2],
            }
        )

    top = VAM_HEADLINE_MINUTES
    period_top = value(best(cur, top), top)
    prev_top = value(best(prev, top), top) if prev else None
    record_top = value(best(rows, top), top)
    shortest = minutes[0]
    period_short = value(best(cur, shortest), shortest)
    prev_short = value(best(prev, shortest), shortest) if prev else None

    def display(v: int | None) -> str:
        return f"{v} m/h" if v is not None else "—"

    return {
        "headline": headline(period_top, "m/h", display(period_top), prev_top, "up"),
        "secondary": [
            headline(record_top, "m/h", display(record_top), None, "neutral"),
            headline(period_short, "m/h", display(period_short), prev_short, "up"),
        ],
        "insight": insights.vam_insight(period_top, record_top, top, len(cur)),
        "series": series,
    }


#: A descent band needs this much running to show a pace.
MIN_BAND_SEC = 60
#: Bands at least this steep (percent, negative) count as "the descent".
DESCENT_FROM_PCT = -5
FLAT_BAND = (-2, 2)

DescentRow = tuple[date, Sequence[dict[str, float]]]


def _band_totals(rows: Sequence[DescentRow]) -> dict[tuple[int, int], list[float]]:
    """[seconds, metres] per (lower, upper) grade band."""
    out: dict[tuple[int, int], list[float]] = {}
    for _day, bands in rows:
        for band in bands:
            slot = out.setdefault((int(band["min"]), int(band["max"])), [0.0, 0.0])
            slot[0] += band["sec"]
            slot[1] += band["m"]
    return out


def _band_pace(slot: list[float] | None) -> float | None:
    if slot is None:
        return None
    sec, metres = slot
    return sec / metres * 1000 if sec >= MIN_BAND_SEC and metres > 0 else None


def _descent_gain(by_band: dict[tuple[int, int], list[float]]) -> float | None:
    """Descent speed over flat speed, minus one, in percent."""
    down = [v for (_lower, upper), v in by_band.items() if upper <= DESCENT_FROM_PCT]
    flat_pace = _band_pace(by_band.get(FLAT_BAND))
    down_pace = _band_pace([sum(v[0] for v in down), sum(v[1] for v in down)])
    if flat_pace is None or down_pace is None:
        return None
    return round((flat_pace / down_pace - 1) * 100, 1)


def build_descent_card(rows: Sequence[DescentRow], window: PeriodWindow) -> Card:
    """rows: (date, descent bands) per run with kept streams, both windows.

    Pace per grade band, summed over the period (time over distance), with
    the flat band as reference: the headline is how much faster than on the
    flat the athlete runs once the slope reaches 5 %.
    """
    cur, prev = _split(rows, window)
    by_band = _band_totals(cur)
    gain = _descent_gain(by_band)
    prev_gain = _descent_gain(_band_totals(prev)) if prev else None
    descent_min = (
        sum(v[0] for (_lo, hi), v in by_band.items() if hi <= DESCENT_FROM_PCT) / 60
    )
    flat_pace = _band_pace(by_band.get(FLAT_BAND))

    series: list[dict[str, Any]] = []
    for (lower, upper), slot in sorted(by_band.items(), key=lambda item: -item[0][1]):
        band_pace = _band_pace(slot)
        series.append(
            {
                "bucket": f"{lower}:{upper}",
                "min": lower,
                "max": upper,
                "pace_sec_km": None if band_pace is None else round(band_pace),
                "minutes": round(slot[0] / 60),
            }
        )

    return {
        "headline": headline(
            gain, "%", f"{gain:+.0f} %" if gain is not None else "—", prev_gain, "up"
        ),
        "secondary": [
            headline(
                None if flat_pace is None else round(flat_pace),
                "s/km",
                format_pace(flat_pace),
                None,
                "neutral",
            )
        ],
        "insight": insights.descent_insight(gain, descent_min),
        "series": series,
    }


def build_elevation_card(
    rows: Sequence[tuple[date, str, float | None, float | None]],
    window: PeriodWindow,
    running_sports: Sequence[str],
) -> Card:
    """rows: (date, sport, distance_m, ascent_m) for foot sports, both windows.

    Climbing is stacked running / walking; m per km reads the runs alone so a
    hike does not make the running terrain look hillier.
    """
    cur, prev = _split(rows, window)

    def total(subset) -> float:
        return sum(r[3] or 0 for r in subset)

    def per_km(subset) -> float | None:
        runs = [r for r in subset if r[1] in running_sports and r[2]]
        km = sum(r[2] for r in runs) / 1000
        return sum(r[3] or 0 for r in runs) / km if km else None

    def biggest(subset) -> float | None:
        return max((r[3] for r in subset if r[3]), default=None)

    climb, prev_climb = total(cur), total(prev) if prev else None
    m_per_km, prev_m_per_km = per_km(cur), per_km(prev)
    top, prev_top = biggest(cur), biggest(prev)

    buckets: dict[str, dict[str, float]] = {
        key: {"run_m": 0.0, "walk_m": 0.0, "run_km": 0.0}
        for key in bucket_keys(window.start, window.end, window.bucket)
    }
    for day, sport, distance_m, ascent_m in cur:
        slot = buckets.get(bucket_key(day, window.bucket))
        if slot is None:
            continue
        if sport in running_sports:
            slot["run_m"] += ascent_m or 0
            slot["run_km"] += (distance_m or 0) / 1000
        else:
            slot["walk_m"] += ascent_m or 0

    return {
        "headline": headline(
            round(climb), "m", f"{climb:.0f} m D+", prev_climb, "neutral"
        ),
        "secondary": [
            headline(
                round(m_per_km, 1) if m_per_km is not None else None,
                "m/km",
                f"{m_per_km:.0f} m/km" if m_per_km is not None else "—",
                round(prev_m_per_km, 1) if prev_m_per_km is not None else None,
                "neutral",
            ),
            headline(
                round(top) if top else None,
                "m",
                f"{top:.0f} m" if top else "—",
                round(prev_top) if prev_top else None,
                "neutral",
            ),
        ],
        "insight": insights.elevation_insight(climb, prev_climb, m_per_km),
        "series": [
            {
                "bucket": key,
                "run_m": round(vals["run_m"]),
                "walk_m": round(vals["walk_m"]),
                "m_per_km": round(vals["run_m"] / vals["run_km"], 1)
                if vals["run_km"]
                else None,
            }
            for key, vals in buckets.items()
        ],
    }


#: Steps/min outside this range are sensor noise or a per-leg value.
MIN_RUN_CADENCE = 120
MAX_RUN_CADENCE = 230


def build_cadence_card(
    rows: Sequence[tuple[date, int, int | None]], window: PeriodWindow
) -> Card:
    """rows: (date, avg_cadence steps/min, avg_pace_sec_km) for runs, both windows.

    Stride length (metres per step) is speed over cadence: with the cadence it
    tells whether a faster pace comes from quicker or longer steps.
    """
    import numpy as np  # here, not at module level: the API boot skips numpy

    def keep(subset):
        return [r for r in subset if MIN_RUN_CADENCE <= r[1] <= MAX_RUN_CADENCE]

    def stride_m(cadence: int, pace: int | None) -> float | None:
        if not pace or not MIN_PACE_SEC_KM <= pace <= MAX_PACE_SEC_KM:
            return None
        return 60_000 / (pace * cadence)

    def median(values: Sequence[float]) -> float | None:
        return float(np.median(values)) if values else None

    cur, prev = _split(rows, window)
    cur, prev = keep(cur), keep(prev)

    def strides(subset) -> list[float]:
        return [s for r in subset if (s := stride_m(r[1], r[2])) is not None]

    med, prev_med = median([r[1] for r in cur]), median([r[1] for r in prev])
    stride, prev_stride = median(strides(cur)), median(strides(prev))

    by_bucket: dict[str, list[tuple[date, int, int | None]]] = defaultdict(list)
    for row in cur:
        by_bucket[bucket_key(row[0], window.bucket)].append(row)
    points = []
    for key in bucket_keys(window.start, window.end, window.bucket):
        runs = by_bucket.get(key, [])
        cadence = median([r[1] for r in runs])
        step = median(strides(runs))
        points.append(
            {
                "bucket": key,
                "cadence": round(cadence) if cadence is not None else None,
                "stride_m": round(step, 2) if step is not None else None,
                "n_runs": len(runs),
            }
        )

    return {
        "headline": headline(
            round(med) if med is not None else None,
            "pas/min",
            f"{med:.0f} pas/min" if med is not None else "—",
            round(prev_med) if prev_med is not None else None,
            "neutral",
        ),
        "secondary": [
            headline(
                round(stride, 2) if stride is not None else None,
                "m",
                f"{stride:.2f} m" if stride is not None else "—",
                round(prev_stride, 2) if prev_stride is not None else None,
                "neutral",
            )
        ],
        "insight": insights.cadence_insight(med, prev_med, len(cur)),
        "series": points,
    }


# --------------------------------------------------------------------------- #
# Récupération
# --------------------------------------------------------------------------- #
def build_health_card(
    days: Sequence[dict[str, Any]],
    window: PeriodWindow,
    field: str,
    unit: str,
    better: Better,
    insight_fn,
    display=lambda v: f"{v:.0f}",
    extra_field: str | None = None,
) -> Card:
    """One recovery metric: mean over the window, latest value, bucketed series."""
    cur = [
        d for d in days if window.start <= date.fromisoformat(d["date"]) <= window.end
    ]
    prev = (
        [
            d
            for d in days
            if window.prev_start <= date.fromisoformat(d["date"]) <= window.prev_end
        ]
        if window.prev_start and window.prev_end
        else []
    )

    def values(subset, key: str) -> list[float]:
        return [float(d[key]) for d in subset if d.get(key) is not None]

    mean = _mean(values(cur, field))
    prev_mean = _mean(values(prev, field))
    latest = next((d[field] for d in reversed(cur) if d.get(field) is not None), None)
    extra_mean = _mean(values(cur, extra_field)) if extra_field else None

    by_bucket: dict[str, list[float]] = defaultdict(list)
    for d in cur:
        if d.get(field) is not None:
            by_bucket[bucket_key(date.fromisoformat(d["date"]), window.bucket)].append(
                float(d[field])
            )
    points = [
        {
            "bucket": key,
            "value": round(_mean(by_bucket[key]) or 0, 1) if key in by_bucket else None,
        }
        for key in bucket_keys(window.start, window.end, window.bucket)
    ]

    secondary = [
        headline(
            float(latest) if latest is not None else None,
            unit,
            display(float(latest)) if latest is not None else "—",
            None,
            better,
        )
    ]
    insight = (
        insight_fn(mean, extra_mean) if extra_field else insight_fn(mean, prev_mean)
    )
    return {
        "headline": headline(
            round(mean, 1) if mean is not None else None,
            unit,
            display(mean) if mean is not None else "—",
            round(prev_mean, 1) if prev_mean is not None else None,
            better,
        ),
        "secondary": secondary,
        "insight": insight,
        "series": points,
    }


def build_recovery_cards(
    days: Sequence[dict[str, Any]], window: PeriodWindow
) -> dict[str, Card]:
    return {
        "readiness": build_health_card(
            days, window, "readiness_score", "pts", "up", insights.readiness_insight
        ),
        "hrv": build_health_card(
            days, window, "hrv_last_night", "ms", "up", insights.hrv_insight
        ),
        "sleep": build_health_card(
            days,
            window,
            "sleep_duration_sec",
            "h",
            "up",
            insights.sleep_insight,
            display=lambda v: format_duration(v),
            extra_field="sleep_score",
        ),
        "resting_hr": build_health_card(
            days, window, "resting_hr", "bpm", "down", insights.resting_hr_insight
        ),
    }


def empty_card(insight_text: str, window: PeriodWindow, fields: dict[str, Any]) -> Card:
    return {
        "headline": headline(None, "", "—"),
        "secondary": [],
        "insight": {"text": insight_text, "tone": "neutral"},
        "series": _empty_series(window, fields),
    }


__all__ = [
    "Bucket",
    "Card",
    "Headline",
    "build_decoupling_card",
    "build_descent_card",
    "build_pace_card",
    "build_pmc_card",
    "build_recovery_cards",
    "build_sports_card",
    "build_vam_card",
    "build_volume_card",
    "build_zones_card",
    "sport_label",
    "empty_card",
    "format_hms",
    "format_pace",
]
