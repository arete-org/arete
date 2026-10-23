"""Speech to text: the only call that leaves the machine for a dictation."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from arete.llm.transcription import (
    TranscriptionError,
    audio_format,
    is_configured,
    looks_empty,
    transcribe,
)

AUDIO = b"fake-audio-bytes"


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setenv("STT_PROVIDER", "openrouter")
    monkeypatch.setenv("STT_API_KEY", "sk-test")
    monkeypatch.setenv("STT_MODEL", "openai/whisper-large-v3-turbo")


def response(payload: dict, status: int = 200):
    reply = MagicMock()
    reply.json.return_value = payload
    reply.status_code = status
    if status >= 400:
        reply.raise_for_status.side_effect = httpx.HTTPStatusError(
            "boom", request=MagicMock(), response=reply
        )
    return reply


def client_returning(reply):
    client = MagicMock()
    client.__enter__.return_value.post.return_value = reply
    return client


class TestAudioFormat:
    def test_maps_the_browser_formats(self):
        assert audio_format("dictation.webm") == "webm"  # Chrome
        assert audio_format("dictation.m4a") == "m4a"  # Safari

    def test_extension_case_does_not_matter(self):
        assert audio_format("DICTATION.WEBM") == "webm"

    def test_unknown_extension_is_refused(self):
        with pytest.raises(TranscriptionError) as err:
            audio_format("dictation.aiff")
        assert err.value.reason == "unsupported_format"

    def test_no_extension_at_all(self):
        with pytest.raises(TranscriptionError):
            audio_format("dictation")


class TestLooksEmpty:
    def test_blank_audio(self):
        assert looks_empty("") is True
        assert looks_empty("   ") is True

    def test_a_single_word_is_not_a_session(self):
        assert looks_empty("euh") is True

    def test_known_hallucination_on_silence(self):
        assert looks_empty("Sous-titres réalisés par la communauté d'Amara.org") is True

    def test_a_real_dictation_passes(self):
        assert looks_empty("squat 3 séries de 5 à 100 kilos") is False


class TestConfiguration:
    def test_configured_by_default(self):
        assert is_configured() is True

    def test_provider_none_disables_dictation(self, monkeypatch):
        monkeypatch.setenv("STT_PROVIDER", "none")
        assert is_configured() is False
        with pytest.raises(TranscriptionError) as err:
            transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "unconfigured"

    def test_missing_key_disables_dictation(self, monkeypatch):
        monkeypatch.setenv("STT_API_KEY", "")
        monkeypatch.setenv("OPENROUTER_API_KEY", "")
        assert is_configured() is False
        with pytest.raises(TranscriptionError) as err:
            transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "unconfigured"

    def test_falls_back_to_the_openrouter_key(self, monkeypatch):
        monkeypatch.delenv("STT_API_KEY", raising=False)
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
        assert is_configured() is True


class TestTranscribe:
    def test_returns_the_text(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(
                response({"text": "squat 3 séries de 5"})
            )
            result = transcribe(AUDIO, filename="d.webm")
        assert result.text == "squat 3 séries de 5"
        assert result.audio_bytes == len(AUDIO)

    def test_reports_the_cost(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(
                response({"text": "squat 3 séries de 5", "usage": {"cost": 0.00012}})
            )
            assert transcribe(AUDIO, filename="d.webm").cost_usd == 0.00012

    def test_cost_is_optional(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(response({"text": "squat 3x5"}))
            assert transcribe(AUDIO, filename="d.webm").cost_usd is None

    def test_audio_is_sent_base64_with_its_format(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            mock = client_returning(response({"text": "squat 3 séries de 5"}))
            client.return_value = mock
            transcribe(AUDIO, filename="d.m4a")
        payload = mock.__enter__.return_value.post.call_args.kwargs["json"]
        assert payload["input_audio"]["format"] == "m4a"
        assert payload["language"] == "fr"
        assert payload["input_audio"]["data"]

    @pytest.mark.parametrize(
        ("base_url", "provider"),
        [
            ("https://openrouter.ai/api/v1", {"data_collection": "deny"}),
            ("http://localhost:8000/v1", None),
        ],
    )
    def test_only_openrouter_is_told_to_deny_data_collection(
        self, monkeypatch, base_url, provider
    ):
        # A dictation is athlete data; a local server knows no routing object.
        monkeypatch.setenv("STT_BASE_URL", base_url)
        with patch("arete.llm.transcription.httpx.Client") as client:
            mock = client_returning(response({"text": "squat 3 séries de 5"}))
            client.return_value = mock
            transcribe(AUDIO, filename="d.webm")
        payload = mock.__enter__.return_value.post.call_args.kwargs["json"]
        assert payload.get("provider") == provider

    def test_read_timeout_comes_from_the_configuration(self, monkeypatch):
        monkeypatch.setenv("STT_TIMEOUT_S", "17")
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(response({"text": "squat 3 séries"}))
            transcribe(AUDIO, filename="d.webm")
        assert client.call_args.kwargs["timeout"].read == 17.0

    def test_empty_audio_is_refused_before_any_call(self):
        with (
            patch("arete.llm.transcription.httpx.Client") as client,
            pytest.raises(TranscriptionError) as err,
        ):
            transcribe(b"", filename="d.webm")
        assert err.value.reason == "empty"
        client.assert_not_called()

    def test_silence_is_reported_as_empty(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(response({"text": "   "}))
            with pytest.raises(TranscriptionError) as err:
                transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "empty"

    def test_hallucination_is_reported_as_empty(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(
                response({"text": "Sous-titres réalisés par la communauté d'Amara.org"})
            )
            with pytest.raises(TranscriptionError) as err:
                transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "empty"

    def test_upstream_error(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(response({}, status=500))
            with pytest.raises(TranscriptionError) as err:
                transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "upstream"

    def test_timeout(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            mock = MagicMock()
            mock.__enter__.return_value.post.side_effect = httpx.ReadTimeout("slow")
            client.return_value = mock
            with pytest.raises(TranscriptionError) as err:
                transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "timeout"

    def test_service_unreachable(self):
        with patch("arete.llm.transcription.httpx.Client") as client:
            mock = MagicMock()
            mock.__enter__.return_value.post.side_effect = httpx.ConnectError("down")
            client.return_value = mock
            with pytest.raises(TranscriptionError) as err:
                transcribe(AUDIO, filename="d.webm")
        assert err.value.reason == "upstream"

    def test_transcript_never_reaches_the_logs(self, caplog):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(
                response({"text": "squat 3 séries de 5 à 100 kilos"})
            )
            with caplog.at_level("DEBUG"):
                transcribe(AUDIO, filename="d.webm")
        assert "squat" not in caplog.text


class TestUpstreamStatuses:
    """Each refusal has its own fix, so each one gets its own message."""

    def _fails_with(self, status: int):
        with patch("arete.llm.transcription.httpx.Client") as client:
            client.return_value = client_returning(response({}, status=status))
            with pytest.raises(TranscriptionError) as err:
                transcribe(AUDIO, filename="d.webm")
        return err.value

    def test_no_credit_says_so(self):
        error = self._fails_with(402)
        assert error.reason == "no_credit"
        assert "solde" in str(error)

    def test_rejected_key(self):
        assert self._fails_with(401).reason == "rejected_key"
        assert self._fails_with(403).reason == "rejected_key"

    def test_rate_limited(self):
        assert self._fails_with(429).reason == "rate_limited"

    def test_anything_else_stays_generic(self):
        assert self._fails_with(500).reason == "upstream"
