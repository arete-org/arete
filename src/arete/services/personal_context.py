"""Bounded lexical memory retrieval and traversal of authoritative source links.

No LLM, framework, global index or credentials: each snapshot is disposable and
re-read before a model call, so corrections/deletions never leave a stale cache.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from time import perf_counter

from arete.dataio.db import transaction
from arete.services.athlete_facts import MemoryLimitExceeded
from arete.services.memory import list_files

MAX_PASSAGES = 10_000
MAX_CORPUS_BYTES = 20 * 1024 * 1024
MAX_JOURNAL_FILES = 1_000
PASSAGE_CHARS = 800
MAX_QUERY_CHARS = 16_000
MAX_QUERY_TERMS = 256


@dataclass(frozen=True)
class SearchLimits:
    seeds: int = 8
    hops: int = 2
    visited: int = 24
    graph: bool = False

    def __post_init__(self):
        assert 1 <= self.seeds <= 8
        assert 0 <= self.hops <= 2
        assert self.seeds <= self.visited <= 24


@dataclass(frozen=True)
class Passage:
    id: str
    source: str
    date: str
    text: str
    links: tuple[str, ...] = ()


@dataclass(frozen=True)
class Hit:
    passage: Passage
    score: float
    path: tuple[str, ...]

    def to_dict(self) -> dict:
        return {
            "id": self.passage.id,
            "source": self.passage.source,
            "date": self.passage.date,
            "text": self.passage.text,
            "path": list(self.path),
        }


@dataclass(frozen=True)
class SearchResult:
    hits: tuple[Hit, ...]
    total_passages: int
    matched: int
    limited: bool
    elapsed_ms: float


@dataclass
class Corpus:
    passages: list[Passage] = field(default_factory=list)
    bytes_read: int = 0
    indexed_bytes: int = 0
    ids: set[str] = field(default_factory=set)

    def reserve(self, size: int) -> None:
        self.bytes_read += size
        if self.bytes_read > MAX_CORPUS_BYTES:
            raise MemoryLimitExceeded(
                "Corpus mémoire supérieur à 20 Mio ; recherche indisponible."
            )

    def add(
        self, source: str, day: str, text: str, *, links: tuple[str, ...] = ()
    ) -> None:
        self.indexed_bytes += len((source + day + text).encode("utf-8"))
        if self.indexed_bytes > MAX_CORPUS_BYTES:
            raise MemoryLimitExceeded("Texte indexé supérieur à 20 Mio.")
        # Sources are chunked completely; selection later reports omitted passages.
        for offset in range(0, len(text), PASSAGE_CHARS):
            if len(self.passages) >= MAX_PASSAGES:
                raise MemoryLimitExceeded("Corpus mémoire supérieur à 10 000 passages.")
            chunk = text[offset : offset + PASSAGE_CHARS]
            digest = hashlib.sha256(chunk.encode()).hexdigest()[:16]
            passage_id = f"{source}:{offset // PASSAGE_CHARS}:{digest}"
            if passage_id in self.ids:
                continue
            self.ids.add(passage_id)
            self.passages.append(Passage(passage_id, source, day, chunk, links))


def tokenize(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKD", text.casefold())
    normalized = "".join(c for c in normalized if not unicodedata.combining(c))
    # Keep negations, numbers and units; there is deliberately no stop-word list.
    return re.findall(r"[\w]+(?:[.,][0-9]+)?", normalized)


def _rows(con, corpus: Corpus, sql: str, params: list | None = None):
    params = params or []
    count, size = con.execute(
        f"SELECT count(*), coalesce(sum(octet_length(encode(body))), 0) FROM ({sql})",
        params,
    ).fetchone()
    if count > MAX_PASSAGES:
        raise MemoryLimitExceeded("Trop de sources mémoire ; recherche indisponible.")
    corpus.reserve(size)
    return con.execute(sql + " LIMIT ?", [*params, MAX_PASSAGES]).fetchall()


def _database_corpus(corpus: Corpus, thread_id: str | None) -> None:
    from arete.dataio.queries import sql_in
    from arete.services.analytics import MODEL_EXCLUDED_SOURCES

    # One transaction gives source rows and their revision links a consistent view.
    with transaction() as con:
        sql = """SELECT id, revision, CAST(since AS VARCHAR), to_json(struct_pack(
            kind := kind, text := text, status := status, evidence := evidence,
            since := since, valid_until := valid_until, source_ref := source_ref)) AS body
            FROM app.visible_athlete_facts WHERE user_id = getvariable('arete_athlete_id') ORDER BY id"""
        for fid, revision, day, body in _rows(con, corpus, sql):
            links: tuple[str, ...] = (
                (f"fact:{fid}:r{revision - 1}",) if revision > 1 else ()
            )
            corpus.add(f"fact:{fid}:r{revision}", day, body, links=links)
        sql = """SELECT r.fact_id, r.revision, CAST(r.recorded_at AS VARCHAR),
            CAST(r.snapshot AS VARCHAR) AS body FROM app.visible_athlete_fact_revisions r
            JOIN app.visible_athlete_facts f ON f.id = r.fact_id WHERE f.user_id = getvariable('arete_athlete_id')
            ORDER BY r.fact_id, r.revision"""
        for fid, revision, day, body in _rows(con, corpus, sql):
            links = (f"fact:{fid}:r{revision - 1}",) if revision > 1 else ()
            corpus.add(
                f"fact:{fid}:r{revision}",
                day,
                "Version historique, pas une règle actuelle : " + body,
                links=links,
            )
        sql = f"""SELECT id, CAST(date AS VARCHAR), planned_session_id,
            concat_ws(' ', sport, name, notes) AS body FROM app.visible_actual_sessions
            WHERE user_id = getvariable('arete_athlete_id') AND source NOT IN ({sql_in(MODEL_EXCLUDED_SOURCES)}) ORDER BY id"""
        for sid, day, planned, body in _rows(con, corpus, sql):
            corpus.add(
                f"actual:{sid}",
                day,
                f"Séance réalisée {day} {body}",
                links=(f"planned:{planned}",) if planned else (),
            )
        sql = """SELECT id, CAST(date AS VARCHAR), actual_session_id,
            concat_ws(' ', name, program, notes) AS body FROM app.visible_strength_sessions
            WHERE user_id = getvariable('arete_athlete_id') ORDER BY id"""
        for sid, day, actual, body in _rows(con, corpus, sql):
            corpus.add(
                f"strength:{sid}",
                day,
                f"Musculation {day} {body}",
                links=(f"actual:{actual}",) if actual else (),
            )
        sql = """SELECT id, CAST(date AS VARCHAR),
            to_json(struct_pack(sport := sport, description := description,
                session_type := session_type, provenance := provenance)) AS body
            FROM app.visible_planned_sessions WHERE user_id = getvariable('arete_athlete_id') ORDER BY id"""
        planned_rows = _rows(con, corpus, sql)
        allowed: set[str] = set()
        if thread_id:
            sql = """SELECT id, name, CAST(created_at AS VARCHAR),
                CAST(extraction AS VARCHAR) AS body FROM app.visible_coach_documents
                WHERE thread_id = ? AND status = 'ready' ORDER BY id"""
            for did, name, day, body in _rows(con, corpus, sql, [thread_id]):
                extraction = json.loads(body)
                for block in extraction["blocks"]:
                    source = f"document:{did}:{block['locator']}"
                    allowed.add(source)
                    corpus.add(
                        source, day, f"{name} [{block['locator']}] {block['text']}"
                    )
        for sid, day, body in planned_rows:
            payload = json.loads(body)
            provenance = payload.pop("provenance") or []
            if isinstance(provenance, str):
                provenance = json.loads(provenance)
            # Never include provenance quotes from documents outside this thread.
            links = tuple(
                f"document:{p['document_id']}:{p['locator']}"
                for p in provenance
                if f"document:{p['document_id']}:{p['locator']}" in allowed
            )
            corpus.add(
                f"planned:{sid}",
                day,
                f"Séance prévue {day} {json.dumps(payload, ensure_ascii=False)}",
                links=links,
            )


def _journal_corpus(corpus: Corpus) -> None:
    for file in list_files():
        text = file.content
        corpus.reserve(len(text.encode()))
        entries = (
            text.splitlines()
            if file.name == "notes.md"
            else re.split(r"(?m)(?=^## )", text)
        )
        for entry in entries:
            if not entry.strip():
                continue
            digest = hashlib.sha256(entry.encode()).hexdigest()[:16]
            day = re.search(r"\d{4}-\d{2}-\d{2}", entry.splitlines()[0])
            # Only an explicit typed reference establishes a relation, never a date/name.
            links = tuple(re.findall(r"\b(?:actual|strength|planned):\d+\b", entry))
            corpus.add(
                f"journal:{file.name}:{digest}",
                day[0] if day else "",
                entry,
                links=links,
            )


def retrieve(
    corpus: list[Passage], query: str, *, limits: SearchLimits
) -> SearchResult:
    """Pure ranking, also used by the offline comparison harness."""
    from rank_bm25 import BM25Plus

    started = perf_counter()
    if len(query) > MAX_QUERY_CHARS:
        raise MemoryLimitExceeded("Requête mémoire trop longue.")
    terms = list(dict.fromkeys(tokenize(query)))
    if len(terms) > MAX_QUERY_TERMS:
        raise MemoryLimitExceeded("Requête mémoire supérieure à 256 termes.")
    if len(corpus) > MAX_PASSAGES:
        raise MemoryLimitExceeded("Trop de passages mémoire.")
    if not corpus or not terms:
        return SearchResult(
            (), len(corpus), 0, False, (perf_counter() - started) * 1000
        )
    tokens = [tokenize(p.text + " " + p.date) or ["_empty_"] for p in corpus]
    # delta=0 makes unmatched documents score zero; common terms retain positive IDF.
    scores = BM25Plus(tokens, k1=1.5, b=0.75, delta=0).get_scores(terms)
    ranked = sorted(
        (i for i, score in enumerate(scores) if score > 0),
        key=lambda i: (-scores[i], corpus[i].id),
    )
    hits = [
        Hit(corpus[i], float(scores[i]), (corpus[i].id,))
        for i in ranked[: limits.seeds]
    ]
    seen = {hit.passage.id for hit in hits}
    by_source: dict[str, list[Passage]] = defaultdict(list)
    for passage in corpus:
        by_source[passage.source].append(passage)
    frontier = list(hits)
    limited = len(ranked) > limits.seeds
    for _ in range(limits.hops if limits.graph else 0):
        following = []
        for hit in frontier:
            for link in hit.passage.links:
                for passage in by_source.get(link, []):
                    if passage.id in seen:
                        continue
                    if len(seen) >= limits.visited:
                        limited = True
                        break
                    seen.add(passage.id)
                    child = Hit(passage, hit.score, (*hit.path, passage.id))
                    following.append(child)
                    hits.append(child)
        frontier = following
    return SearchResult(
        tuple(hits),
        len(corpus),
        len(ranked),
        limited,
        (perf_counter() - started) * 1000,
    )


def search_personal_context(
    query: str,
    thread_id: str | None,
    current_date: date,
    limits: SearchLimits = SearchLimits(),
) -> SearchResult:
    started = perf_counter()
    corpus = Corpus()
    _database_corpus(corpus, thread_id)
    _journal_corpus(corpus)
    result = retrieve(corpus.passages, query, limits=limits)
    # Date is provided by the server. Historical dates remain visible, not rewritten.
    assert isinstance(current_date, date)
    return SearchResult(
        result.hits,
        result.total_passages,
        result.matched,
        result.limited,
        (perf_counter() - started) * 1000,
    )
