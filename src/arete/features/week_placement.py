"""Placing a week's sessions on weekdays under interference rules.

A plan generator (``hybrid_plan``, ``tri_plan``) decides which sessions a
week holds; this module decides their days. Interference rules are data
(``Spacing``, ``Grouping``, ``Deload``, ``Taper``), read by ``violations``.
Sessions carry tags; a week is placed by a deterministic search over
weekdays that returns the first assignment without any violation. Every
rule is monotone (adding a session never removes a violation), so partial
assignments are pruned as soon as they break one.

What differs between plans is a ``Catalog``: each session kind's preferred
days, its rank, its French label, what a taper gives up first, which
sessions may share a day, and a last touch on the placed week. A ``Slot``
holds one session, or several done back to back on one day (a triathlon
brick). Pure: no I/O, no clock.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from itertools import combinations
from typing import Literal

from arete.features.plan_generator import DraftSession, WeekPlan

#: Tags every plan's rules read.
RACE = "race"
HARD = "hard"
#: A session the athlete edited, kept as it is when the plan is regenerated.
KEPT = "kept"

MAX_PER_DAY = 2
#: Slots one week's search places at most (the athlete's kept sessions apart).
MAX_SLOTS = 8


# --------------------------------------------------------------------------- #
# Rules as data
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Spacing:
    """A ``first_tag`` session at least ``min_days`` before a ``then_tag`` one.

    Days count from date to date: ``min_days=3`` forbids the two days before.
    On the same day, ``same_day="after"`` allows ``first_tag`` once the
    ``then_tag`` session is done (later in the day); ``"never"`` forbids it.
    """

    id: str
    first_tag: str
    then_tag: str
    min_days: int
    same_day: Literal["never", "after"]


@dataclass(frozen=True)
class Grouping:
    """Days holding a ``tag`` session: at most ``max_per_week`` of them and at
    most ``max_consecutive`` in a row, so the day after such a block is easy.
    Fewer such days than sessions means pairing them on the same day."""

    id: str
    tag: str
    max_per_week: int
    max_consecutive: int


@dataclass(frozen=True)
class Deload:
    """Start with a lighter week when the load is already too high; the
    thresholds are the daily readiness rules' (``services.adaptation``)."""

    id: str
    acwr_above: float
    tsb_below: float

    def triggered(self, acwr: float | None, tsb: float | None) -> bool:
        return (acwr is not None and acwr > self.acwr_above) or (
            tsb is not None and tsb < self.tsb_below
        )


@dataclass(frozen=True)
class Taper:
    """The ``days`` before the race: at most ``volume_share`` of the peak week
    (per seven days), no ``forbidden_tag`` session, and the last hard session
    at least ``last_hard_days`` before race day."""

    id: str
    days: int
    volume_share: float
    forbidden_tag: str
    last_hard_days: int


@dataclass(frozen=True)
class Rules:
    spacing: tuple[Spacing, ...]
    grouping: tuple[Grouping, ...]
    deload: Deload
    taper: Taper


@dataclass(frozen=True)
class Violation:
    rule: str
    day: date


def violations(
    week: WeekPlan,
    rules: Rules,
    *,
    previous: WeekPlan | None = None,
    race_date: date | None = None,
) -> list[Violation]:
    """What in ``week`` breaks a rule; ``previous`` carries spacing and
    consecutive days across the weekend, and ``race_date`` enables the taper.
    Sessions of one day are in the order they are done."""
    old = list(previous.sessions) if previous else []
    items = [(s, i, False) for i, s in enumerate(old)] + [
        (s, len(old) + i, True) for i, s in enumerate(week.sessions)
    ]
    out: list[Violation] = []
    for rule in rules.spacing:
        for first, i, first_new in items:
            if rule.first_tag not in first.tags:
                continue
            for then, j, then_new in items:
                if j == i or rule.then_tag not in then.tags:
                    continue
                if not (first_new or then_new):
                    continue
                gap = (then.date - first.date).days
                if gap == 0:
                    if rule.same_day == "never" or i < j:
                        out.append(Violation(rule.id, then.date))
                elif 0 < gap < rule.min_days:
                    out.append(Violation(rule.id, then.date))
    for group in rules.grouping:
        last = week.start + timedelta(days=6)
        current = sorted(
            {
                s.date
                for s in week.sessions
                if group.tag in s.tags and week.start <= s.date <= last
            }
        )
        # One violation per day past the cap: a further hard day is one more.
        for day in current[group.max_per_week :]:
            out.append(Violation(group.id, day))
        days = sorted({s.date for s, _, _ in items if group.tag in s.tags})
        run = 0
        for k, day in enumerate(days):
            run = run + 1 if k and (day - days[k - 1]).days == 1 else 1
            if run > group.max_consecutive and day >= week.start:
                out.append(Violation(group.id, day))
    if race_date is not None:
        taper = rules.taper
        for s in week.sessions:
            before = (race_date - s.date).days
            if 0 < before <= taper.days and taper.forbidden_tag in s.tags:
                out.append(Violation(taper.id, s.date))
            if 0 < before < taper.last_hard_days and HARD in s.tags:
                out.append(Violation(taper.id, s.date))
    return out


def plan_violations(
    weeks: Sequence[WeekPlan], rules: Rules, race_date: date | None
) -> list[Violation]:
    """Every week's violations, then the taper's volume (race plans only)."""
    out: list[Violation] = []
    previous = None
    for week in weeks:
        out += violations(week, rules, previous=previous, race_date=race_date)
        previous = week
    if race_date is not None and taper_over(weeks, rules.taper, race_date):
        out.append(Violation(f"{rules.taper.id}_volume", race_date))
    return out


def in_taper(day: date, taper: Taper, race_date: date) -> bool:
    return 0 < (race_date - day).days <= taper.days


def taper_over(weeks: Sequence[WeekPlan], taper: Taper, race_date: date) -> bool:
    """The taper's days, per seven, above ``volume_share`` of the peak week."""
    peak = max(
        (w.minutes for w in weeks if w.phase not in ("taper", "race")), default=0
    )
    window = sum(
        s.duration_min or 0
        for w in weeks
        for s in w.sessions
        if in_taper(s.date, taper, race_date)
    )
    return window * 7 / taper.days > taper.volume_share * peak


# --------------------------------------------------------------------------- #
# What a plan places
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Slot:
    """Sessions placed together on one day, in the order they are done."""

    drafts: tuple[DraftSession, ...]
    prefs: tuple[int, ...]  # weekdays in order of preference
    rank: int  # order within a day, and of placement
    kind: str  # the catalog kind the slot stands for (drops, labels)

    @property
    def tags(self) -> frozenset[str]:
        return frozenset().union(*(d.tags for d in self.drafts))


def _no_finish(week: WeekPlan) -> WeekPlan:
    return week


@dataclass(frozen=True)
class Catalog:
    """A plan's session kinds: how each is recognised, placed and named.

    ``kinds`` lists the tags that name a kind, the most specific first; a
    session with none of them is ``default_kind``. ``may_share`` says
    whether a slot may join the slots already on a day (at most
    ``MAX_PER_DAY`` sessions either way); ``finish`` touches the placed week.
    """

    kinds: tuple[str, ...]
    default_kind: str
    prefs: Mapping[str, tuple[int, ...]]
    rank: Mapping[str, int]
    labels: Mapping[str, str]
    #: What a taper gives up first, when its volume is over.
    taper_drops: tuple[str, ...]
    may_share: Callable[[Sequence[Slot], Slot], bool]
    finish: Callable[[WeekPlan], WeekPlan] = field(default=_no_finish)
    default_rank: int = 6

    def primary(self, tags: frozenset[str]) -> str:
        for tag in self.kinds:
            if tag in tags:
                return tag
        return self.default_kind

    def slot(self, *drafts: DraftSession, prefs: tuple[int, ...] | None = None) -> Slot:
        assert drafts, "a slot holds at least one session"
        kind = self.primary(drafts[0].tags)
        return Slot(
            tuple(drafts),
            prefs or self.prefs[kind],
            self.rank.get(kind, self.default_rank),
            kind,
        )

    def dropped(self, sessions: Sequence[DraftSession], reason: str) -> list[str]:
        """What the preview says of sessions a week gave up, in French."""
        return [
            f"Séance « {self.labels.get(self.primary(s.tags), s.description)} » "
            f"retirée : {reason}."
            for s in sessions
        ]

    def dropped_slots(self, slots: Sequence[Slot], reason: str) -> list[str]:
        """``dropped`` for slots: one line per slot, named by its kind."""
        return [
            f"Séance « {self.labels.get(s.kind, s.drafts[0].description)} » "
            f"retirée : {reason}."
            for s in slots
        ]


def _as_week(template: WeekPlan, placed: list[tuple[int, Slot]]) -> WeekPlan:
    ordered = sorted(placed, key=lambda p: (p[0], p[1].rank))
    sessions = [
        replace(draft, date=template.start + timedelta(days=d))
        for d, s in ordered
        for draft in s.drafts
    ]
    return replace(
        template,
        sessions=sessions,
        minutes=sum(s.duration_min or 0 for s in sessions),
    )


def place_week(
    template: WeekPlan,
    slots: Sequence[Slot],
    days: Sequence[int],
    max_days: int,
    rules: Rules,
    catalog: Catalog,
    *,
    fixed: Sequence[DraftSession] = (),
    ahead: Sequence[DraftSession] = (),
    previous: WeekPlan | None = None,
    race_date: date | None = None,
) -> WeekPlan | None:
    """The first assignment of ``slots`` to weekdays that adds no violation.

    ``fixed`` sessions (the athlete's edits) keep their day and count for the
    rules; what they already break themselves is not held against the plan.
    ``ahead`` are next week's kept sessions: the rules see them (no heavy
    legs on Sunday before a kept Monday key run), the week does not hold them.
    Slots are placed in rank order, each trying its unused preferred days
    first, then a day it can share (at most ``MAX_PER_DAY`` sessions, as the
    catalog's ``may_share`` allows, at most ``max_days`` days). None when no
    assignment exists.

    Bound: at most ``MAX_SLOTS`` slots, each trying at most 7 days, so at
    most 7**8 leaves per search, and ``fit_week`` runs at most 2**8 searches
    (one per subset of droppable slots). The rules are monotone, so a branch
    stops at its first violation, and one whose remaining sessions exceed the
    days' room stops at once: real weeks visit a few hundred nodes.
    """
    assert len(slots) <= MAX_SLOTS, f"{len(slots)} slots in one week"
    pinned = [
        (s.date.weekday(), catalog.slot(s, prefs=(s.date.weekday(),))) for s in fixed
    ]
    later = [
        ((s.date - template.start).days, catalog.slot(s, prefs=(s.date.weekday(),)))
        for s in ahead
    ]

    def broken(placed: list[tuple[int, Slot]]) -> Counter[Violation]:
        week = _as_week(template, [*placed, *later])
        return Counter(violations(week, rules, previous=previous, race_date=race_date))

    baseline = broken(pinned)
    order = sorted(slots, key=lambda s: s.rank)
    remaining = [sum(len(s.drafts) for s in order[i:]) for i in range(len(order))]

    def room(placed: list[tuple[int, Slot]]) -> int:
        """Sessions the week could still hold, at most: an upper bound."""
        count: Counter[int] = Counter()
        for day, s in placed:
            count[day] += len(s.drafts)
        unused = max(0, max_days - len(count))
        return sum(max(0, MAX_PER_DAY - n) for n in count.values()) + (
            unused * MAX_PER_DAY
        )

    def search(i: int, placed: list[tuple[int, Slot]]) -> list[tuple[int, Slot]] | None:
        if i == len(order):
            return placed
        if remaining[i] > room(placed):
            return None
        slot = order[i]
        used = {d for d, _ in placed}
        allowed = [d for d in slot.prefs if d in days or RACE in slot.tags]
        candidates = [d for d in allowed if d not in used] + [
            d for d in allowed if d in used
        ]
        for d in candidates:
            same = [s for day, s in placed if day == d]
            sessions = sum(len(s.drafts) for s in same) + len(slot.drafts)
            if sessions > MAX_PER_DAY or len(used | {d}) > max_days:
                continue
            if same and not catalog.may_share(same, slot):
                continue
            candidate = [*placed, (d, slot)]
            if broken(candidate) - baseline:
                continue
            result = search(i + 1, candidate)
            if result is not None:
                return result
        return None

    result = search(0, pinned)
    return None if result is None else catalog.finish(_as_week(template, result))


def fit_week(
    template: WeekPlan,
    slots: list[Slot],
    days: Sequence[int],
    max_days: int,
    rules: Rules,
    catalog: Catalog,
    *,
    drops: tuple[str, ...],
    keep_tag: str | None,
    fixed: Sequence[DraftSession],
    ahead: Sequence[DraftSession],
    previous: WeekPlan | None,
    race_date: date | None,
) -> tuple[WeekPlan, list[Slot]] | None:
    """The week with every slot when the rules allow it, else without the
    fewest, least important ones ``drops`` lists; None when even that fails.
    With ``keep_tag``, a week that had a slot so tagged keeps one."""
    droppable = sorted(
        (i for i, s in enumerate(slots) if s.kind in drops),
        key=lambda i: drops.index(slots[i].kind),
    )
    has_kept_tag = keep_tag is not None and any(keep_tag in s.tags for s in slots)
    for count in range(len(droppable) + 1):
        for gone in combinations(droppable, count):
            left = [s for i, s in enumerate(slots) if i not in gone]
            if has_kept_tag and not any(keep_tag in s.tags for s in left):
                continue
            week = place_week(
                template,
                left,
                days,
                max_days,
                rules,
                catalog,
                fixed=fixed,
                ahead=ahead,
                previous=previous,
                race_date=race_date,
            )
            if week is not None:
                return week, [slots[i] for i in gone]
    return None


def without_kept_kinds(
    slots: list[Slot], kept: Sequence[DraftSession], catalog: Catalog
) -> list[Slot]:
    """The slots less one of each kind a kept session already fills, of the
    same sport when there is one."""
    left = list(slots)
    for session in kept:
        kind = catalog.primary(session.tags)
        if kind not in session.tags:
            continue
        matches = [k for k, slot in enumerate(left) if slot.kind == kind]
        same_sport = [k for k in matches if left[k].drafts[0].sport == session.sport]
        if matches:
            del left[(same_sport or matches)[0]]
    return left


def cap_taper(
    weeks: list[WeekPlan], taper: Taper, race_date: date, catalog: Catalog
) -> None:
    """Drop sessions from the taper's days, the catalog's ``taper_drops``
    first, until their volume fits ``taper.volume_share``; never the race or
    a kept session."""
    reason = (
        f"l'affûtage reste sous {round(taper.volume_share * 100)} % "
        "de la semaine la plus chargée"
    )
    drops = catalog.taper_drops

    def rank(at: tuple[int, int]) -> tuple[int, int, int]:
        s = weeks[at[0]].sessions[at[1]]
        kind = catalog.primary(s.tags)
        order = drops.index(kind) if kind in drops else len(drops)
        return order, -(s.duration_min or 0), -s.date.toordinal()

    while taper_over(weeks, taper, race_date):
        candidates = [
            (w, k)
            for w, week in enumerate(weeks)
            for k, s in enumerate(week.sessions)
            if in_taper(s.date, taper, race_date)
            and RACE not in s.tags
            and KEPT not in s.tags
        ]
        if not candidates:
            return  # the athlete's own sessions: theirs to keep
        w, k = min(candidates, key=rank)
        week = weeks[w]
        gone = week.sessions[k]
        sessions = week.sessions[:k] + week.sessions[k + 1 :]
        weeks[w] = replace(
            week,
            sessions=sessions,
            minutes=sum(s.duration_min or 0 for s in sessions),
            dropped=[*week.dropped, *catalog.dropped([gone], reason)],
        )
