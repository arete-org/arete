"""Post-session feedback, written by the coach and filed in its journal.

Replaces the one-shot "reformulate this sentence" call that used to sit
behind ``POST /tips/post-session``. Two things change for the athlete:

- the feedback is written by the agent that can read the rest of their
  training, instead of a model that only saw a pre-rendered sentence;
- the session lands in ``sessions.md``, so tomorrow's briefing — and the next
  conversation in the side panel — already know it happened.

Same contract as the briefing: the rule-based text is the floor, computed by
the caller and handed in. A failure here returns that floor, never an error.

The daily sync imports several sessions at once: ``batch_session_feedback``
answers them all with one model request, one numbered section per session.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Literal

from arete.services.memory import SESSIONS_LEDGER, append_entry

logger = logging.getLogger(__name__)

#: A card under an upload, not an essay.
MAX_FEEDBACK_CHARS = 900
#: Sessions answered by one sync's model request; the rest keep the rule text.
MAX_BATCH_SESSIONS = 5

Source = Literal["agent", "rules"]


@dataclass(frozen=True)
class SessionEvidence:
    """Who the session is: what the ledger entry is filed under."""

    date: date
    title: str
    rpe: float | None = None
    notes: str | None = None
    session_ref: str | None = None
    sport: str | None = None


@dataclass(frozen=True)
class SessionFacts:
    """One session's rule feedback and evidence, ready for the coach."""

    rule_feedback: str
    highlights: list[str]
    evidence: SessionEvidence


def _facts(
    rule_feedback: str, highlights: list[str], evidence: SessionEvidence | None
) -> str:
    lines = []
    if evidence is not None:
        lines.append(f"Séance du {evidence.date.isoformat()} : {evidence.title}")
        if evidence.sport:
            lines.append(f"Sport : {evidence.sport}")
        if evidence.rpe:
            lines.append(f"Déclaration de l’athlète — RPE ressenti : {evidence.rpe}/10")
        if evidence.notes:
            lines.append(f"Notes de l'athlète : {evidence.notes}")
    lines.append("Observation calculée (pas une déclaration) : " + rule_feedback)
    facts = "\n".join(lines)
    if highlights:
        facts += "\n\nPoints clés:\n" + "\n".join(f"- {h}" for h in highlights)
    return facts


def _file(evidence: SessionEvidence, facts: str, text: str, source: Source) -> None:
    """The ledger entry, written by the server once, whatever the model did."""
    reference = (
        f"Source séance : {evidence.session_ref}\n" if evidence.session_ref else ""
    )
    body = (
        reference
        + facts
        + (
            f"\n\nInterprétation du coach (non confirmée, jamais une preuve) : {text}"
            if source == "agent"
            else ""
        )
    )
    try:
        append_entry(SESSIONS_LEDGER, evidence.title, body, when=evidence.date)
    except OSError:
        logger.warning("Could not file the session in the journal", exc_info=True)
        raise


def enrich_session_feedback(
    rule_feedback: str,
    highlights: list[str],
    *,
    produce: Callable[[str], str],
    evidence: SessionEvidence | None = None,
) -> tuple[str, Source]:
    """The coach's word on a finished session, with the rule text as floor.

    Returns ``(text, source)`` where source is ``"agent"`` or ``"rules"``.
    Never raises: an athlete who just uploaded a session gets an answer either
    way. With ``evidence``, the server files the session in ``sessions.md``
    itself — once, whatever the model does — so tomorrow's briefing knows it
    happened; the model only writes the answer.
    """
    facts = _facts(rule_feedback, highlights, evidence)
    text: str
    source: Source
    try:
        text, source = produce(facts), "agent"
    except Exception:
        logger.warning("Session feedback agent run failed", exc_info=True)
        text, source = rule_feedback, "rules"
    if evidence is not None:
        _file(evidence, facts, text, source)
    return text, source


#: ``### 2`` opens the answer about the second session of a batch.
_SECTION = re.compile(r"^#{1,4}\s*(\d+)\s*$", re.MULTILINE)


def split_sections(text: str, count: int) -> list[str] | None:
    """The answer's ``count`` numbered sections, in order, or None.

    None when any section is missing, repeated or empty: a misnumbered answer
    would hand one session's feedback to another, so it is not used at all.
    """
    parts = _SECTION.split(text)
    sections: dict[int, str] = {}
    for number, body in zip(parts[1::2], parts[2::2], strict=True):
        n, body = int(number), body.strip()
        if n in sections or not body:
            return None
        sections[n] = body
    if sorted(sections) != list(range(1, count + 1)):
        return None
    return [sections[n] for n in range(1, count + 1)]


def batch_session_feedback(
    sessions: Sequence[SessionFacts],
    *,
    produce: Callable[[str, int], str],
) -> list[tuple[str, Source]]:
    """Feedback on several sessions with at most ONE model request.

    ``produce(message, count)`` runs the feedback mission on ``count``
    numbered sessions. The first ``MAX_BATCH_SESSIONS`` are sent; the others,
    and every session when the request fails or its answer cannot be split
    per session, keep their rule text. Each session is filed in the journal
    once. Never raises; returns ``(text, source)`` per session, in order.
    """
    if not sessions:
        return []
    facts = [_facts(s.rule_feedback, s.highlights, s.evidence) for s in sessions]
    sent = facts[:MAX_BATCH_SESSIONS]
    answers: list[str] | None = None
    try:
        if len(sent) == 1:
            answers = [produce(sent[0], 1)]
        else:
            message = "\n\n".join(
                f"### {i}\n{block}" for i, block in enumerate(sent, start=1)
            )
            answers = split_sections(produce(message, len(sent)), len(sent))
            if answers is None:
                logger.warning("Batch feedback answer had no usable sections")
    except Exception:
        logger.warning("Batch session feedback agent run failed", exc_info=True)
    results: list[tuple[str, Source]] = []
    for i, (session, block) in enumerate(zip(sessions, facts, strict=True)):
        text: str
        source: Source
        if answers is not None and i < len(answers):
            text, source = answers[i], "agent"
        else:
            text, source = session.rule_feedback, "rules"
        _file(session.evidence, block, text, source)
        results.append((text, source))
    return results
