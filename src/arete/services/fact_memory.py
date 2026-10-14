"""Reconcile a new fact against bounded, complete candidates before persistence."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from functools import partial
from typing import Annotated, Literal

from anyio import to_thread
from pydantic import BaseModel, ConfigDict, Field, model_validator

from arete.services import athlete_facts as facts
from arete.services.personal_context import tokenize

MAX_CANDIDATES = 7
DUPLICATE_PROBABILITY = 0.9
CONTRADICTION_PROBABILITY = 0.7
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class MemoryDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["choice"]
    choice: str
    probabilities: dict[str, Probability]
    confidence: Probability

    @model_validator(mode="after")
    def coherent(self):
        if self.choice not in self.probabilities:
            raise ValueError("Choix mémoire absent des probabilités.")
        if abs(sum(self.probabilities.values()) - 1) > 0.001:
            raise ValueError("Distribution mémoire invalide.")
        if self.probabilities[self.choice] < max(self.probabilities.values()):
            raise ValueError("Choix mémoire incohérent.")
        return self


@dataclass(frozen=True)
class FactDraft:
    kind: str
    text: str
    evidence: str
    source_ref: str
    since: date
    valid_until: date | None

    def fields(self) -> dict:
        return dict(
            kind=self.kind,
            text=self.text,
            evidence=self.evidence,
            source_ref=self.source_ref,
            since=self.since,
            valid_until=self.valid_until,
        )


ClassifyMemory = Callable[[dict, dict[str, str]], Awaitable[MemoryDecision]]


def candidates(draft: FactDraft, existing: list[facts.Fact]) -> list[facts.Fact]:
    from rank_bm25 import BM25Plus

    # Date comparisons belong to Python. A bounded exception is independent
    # of a standing preference; only compare overlapping, equally scoped facts.
    eligible = [
        f
        for f in existing
        if f.status == "active"
        and f.evidence == draft.evidence
        and (f.valid_until is None) == (draft.valid_until is None)
        and (f.valid_until is None or f.valid_until >= draft.since)
        and (draft.valid_until is None or draft.valid_until >= f.since)
    ]
    if not eligible:
        return []
    scores = BM25Plus(
        [tokenize(f.text) or ["_empty_"] for f in eligible], k1=1.5, b=0.75, delta=0
    ).get_scores(tokenize(draft.text))
    # Same-kind zero-overlap candidates give paraphrases a chance. Relevant
    # cross-kind facts can still reveal a misclassified constraint/preference.
    ranked = sorted(
        zip(eligible, scores, strict=True),
        key=lambda pair: (-float(pair[1]), pair[0].kind != draft.kind, -pair[0].id),
    )
    return [fact for fact, _ in ranked[:MAX_CANDIDATES]]


def decision_request(
    draft: FactDraft, selected: list[facts.Fact]
) -> tuple[dict, dict[str, str]]:
    state = {
        "new_fact": draft.text,
        "candidates": {str(f.id): f.text for f in selected},
    }
    choices = {
        "create": "The new fact adds distinct information; no candidate is equivalent or contradictory."
    }
    for fact in selected:
        if facts.same_fact_scope(
            fact, draft.kind, draft.evidence, draft.since, draft.valid_until
        ):
            choices[f"duplicate_{fact.id}"] = (
                f"The new fact has exactly the same meaning as candidates.{fact.id}, including negation, quantities and conditions; nothing new."
            )
        choices[f"contradiction_{fact.id}"] = (
            f"The new fact and candidates.{fact.id} cannot both hold under the same conditions. Similar topics alone are not a contradiction."
        )
    return state, choices


async def remember(draft: FactDraft, *, classify: ClassifyMemory | None) -> dict:
    # Validate before any remote call, including dates which Jev must never infer.
    facts.validate_fact_fields(
        draft.kind, draft.text, "active", draft.evidence, draft.source_ref
    )
    if draft.valid_until is not None and draft.valid_until < draft.since:
        raise ValueError("La fin de validité précède le début.")
    existing = await to_thread.run_sync(facts.list_facts)
    exact = any(
        f.kind == draft.kind
        and facts.fact_identity(f.text) == facts.fact_identity(draft.text)
        and f.evidence == draft.evidence
        and f.valid_until == draft.valid_until
        and (draft.valid_until is None or f.since == draft.since)
        for f in existing
    )
    selected = candidates(draft, existing) if classify and not exact else []
    duplicate_id = None
    review = None
    if selected:
        state, choices = decision_request(draft, selected)
        assert classify is not None
        decision = await classify(state, choices)
        if set(decision.probabilities) != set(choices):
            raise ValueError("Le classement mémoire ne couvre pas les choix proposés.")
        probability = decision.probabilities[decision.choice]
        if (
            decision.choice.startswith("contradiction_")
            and probability >= CONTRADICTION_PROBABILITY
        ):
            ident = int(decision.choice.removeprefix("contradiction_"))
            # A contradiction is evidence for clarification, never permission to
            # erase or rewrite a fact. Return the actual candidate and revision.
            current = await to_thread.run_sync(facts.get_fact, ident)
            candidate = next(f for f in selected if f.id == ident)
            if current is None or current.revision != candidate.revision:
                raise facts.FactConflict("Le souvenir a changé. Relis la mémoire.")
            return {
                "saved": False,
                "action": "needs_clarification",
                "fact": current.to_dict(),
                "reason": "Contradiction possible : clarifie avant de corriger ce fait avec son id et sa révision.",
            }
        if (
            decision.choice.startswith("duplicate_")
            and probability >= DUPLICATE_PROBABILITY
        ):
            duplicate_id = int(decision.choice.removeprefix("duplicate_"))
        review = {
            "choice": decision.choice,
            "probability": probability,
            "candidates": len(selected),
            "selection_limited": len(existing) > len(selected),
        }
    result = await to_thread.run_sync(
        partial(
            facts.create_fact,
            **draft.fields(),
            expected_facts=facts.fact_snapshot(existing),
            duplicate_id=duplicate_id,
        )
    )
    return {
        "saved": result.action == "created",
        "action": result.action,
        "fact": result.fact.to_dict(),
        "review": review,
    }
