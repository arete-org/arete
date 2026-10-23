"""Audio in, French text out.

The only call that leaves the machine for a dictated session. The boundary is
deliberately thin: one function, one error type, a base URL and a model read
from the environment. Pointing ``STT_BASE_URL`` at a local OpenAI-compatible
server is all it takes to stop sending voice anywhere.

httpx rather than the shared ``openai`` client on purpose: that client is a
singleton bound to ``LLM_PROVIDER``, which defaults to Ollama — reusing it
would post the audio to Ollama.
"""

from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

from arete.config import config

logger = logging.getLogger(__name__)

Reason = Literal[
    "unconfigured",
    "unsupported_format",
    "timeout",
    "upstream",
    "empty",
    "no_credit",
    "rejected_key",
    "rate_limited",
]

# Extension -> the format name the API expects.
SUPPORTED_FORMATS: dict[str, str] = {
    ".webm": "webm",  # Chrome, Firefox
    ".m4a": "m4a",  # Safari
    ".mp4": "mp4",  # Safari, some Android builds
    ".ogg": "ogg",
    ".oga": "ogg",
    ".mp3": "mp3",
    ".wav": "wav",
    ".flac": "flac",
}

# Whisper fills silence with the captions it was trained on. These are not
# transcriptions, they are the model talking to itself.
_HALLUCINATIONS = (
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titres réalisés para la communauté d'amara.org",
    "merci d'avoir regardé cette vidéo",
    "abonnez-vous",
    "sous-titrage société radio-canada",
    "thanks for watching",
    "thank you for watching",
)
MIN_WORDS = 2


class TranscriptionError(RuntimeError):
    """Speech-to-text failed, with a reason the API layer maps to a status."""

    def __init__(self, reason: Reason, message: str = "") -> None:
        super().__init__(message or reason)
        self.reason: Reason = reason


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    model: str
    cost_usd: float | None
    audio_bytes: int


def is_configured() -> bool:
    """True when a dictation can actually be transcribed."""
    return config.stt_provider != "none" and bool(config.stt_api_key)


def audio_format(filename: str) -> str:
    """ "session.webm" -> "webm". Raises on anything we would not send."""
    suffix = PurePath(filename or "").suffix.lower()
    fmt = SUPPORTED_FORMATS.get(suffix)
    if fmt is None:
        supported = ", ".join(sorted(f.lstrip(".") for f in SUPPORTED_FORMATS))
        raise TranscriptionError(
            "unsupported_format", f"Format audio non supporté ({supported})"
        )
    return fmt


def looks_empty(text: str) -> bool:
    """Silence, or the model filling silence with captions."""
    cleaned = text.strip().lower()
    if not cleaned:
        return True
    if any(marker in cleaned for marker in _HALLUCINATIONS):
        return True
    return len(re.findall(r"[\wÀ-ÿ']+", cleaned)) < MIN_WORDS


def transcribe(
    audio: bytes, *, filename: str, language: str = "fr"
) -> TranscriptionResult:
    """Transcribe recorded audio. Raises ``TranscriptionError``, never returns None."""
    if config.stt_provider == "none":
        raise TranscriptionError(
            "unconfigured", "Dictée désactivée (STT_PROVIDER=none)"
        )
    if not config.stt_api_key:
        raise TranscriptionError(
            "unconfigured", "Transcription non configurée (STT_API_KEY manquante)"
        )
    fmt = audio_format(filename)
    if not audio:
        raise TranscriptionError("empty", "Fichier audio vide")

    payload = {
        "model": config.stt_model,
        "input_audio": {
            "data": base64.b64encode(audio).decode("ascii"),
            "format": fmt,
        },
        "language": language,
    }
    if urlsplit(config.stt_base_url).hostname == "openrouter.ai":
        # A dictation is athlete data: no provider that trains on it. Other
        # OpenAI-compatible servers do not know OpenRouter's routing object.
        payload["provider"] = {"data_collection": "deny"}
    data = _post(payload)

    text = str(data.get("text") or "").strip()
    if looks_empty(text):
        raise TranscriptionError(
            "empty", "Aucune parole détectée dans l'enregistrement"
        )

    usage = data.get("usage") or {}
    cost = usage.get("cost")
    logger.info(
        "Transcribed %d bytes of %s with %s (cost %s)",
        len(audio),
        fmt,
        config.stt_model,
        cost,
    )  # never log the transcript itself
    return TranscriptionResult(
        text=text,
        model=config.stt_model,
        cost_usd=float(cost) if isinstance(cost, int | float) else None,
        audio_bytes=len(audio),
    )


# Upstream statuses worth telling apart: each one has its own fix.
_UPSTREAM_STATUS: dict[int, tuple[Reason, str]] = {
    401: ("rejected_key", "Clé de transcription refusée"),
    403: ("rejected_key", "Clé de transcription refusée"),
    402: (
        "no_credit",
        "Crédit insuffisant chez le fournisseur : l'audio demande au moins "
        "0,50 $ de solde sur openrouter.ai/settings/credits",
    ),
    429: ("rate_limited", "Trop de requêtes, réessaie dans un instant"),
}


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    """One request, one client, explicit timeouts per phase."""
    timeout = httpx.Timeout(
        connect=5.0, read=float(config.stt_timeout_s), write=30.0, pool=5.0
    )
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{config.stt_base_url}/audio/transcriptions",
                headers={"Authorization": f"Bearer {config.stt_api_key}"},
                json=payload,
            )
            response.raise_for_status()
            return dict(response.json())
    except httpx.TimeoutException as exc:
        raise TranscriptionError(
            "timeout", "Le service de transcription n'a pas répondu à temps"
        ) from exc
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        # The body may quote the audio back: log the status, never the body.
        logger.warning("Transcription upstream returned %s", status)
        reason, message = _UPSTREAM_STATUS.get(
            status, ("upstream", "Le service de transcription a échoué")
        )
        raise TranscriptionError(reason, message) from exc
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Transcription request failed: %s", type(exc).__name__)
        raise TranscriptionError(
            "upstream", "Le service de transcription est injoignable"
        ) from exc


__all__ = [
    "SUPPORTED_FORMATS",
    "TranscriptionError",
    "TranscriptionResult",
    "audio_format",
    "is_configured",
    "looks_empty",
    "transcribe",
]
