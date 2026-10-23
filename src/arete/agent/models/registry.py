"""Provider defaults and the configured model envelope; no network discovery."""

from dataclasses import dataclass
from typing import Literal

from pydantic import SecretStr

#: Named bounds, per TigerStyle: no silent SDK defaults on the agent loop.
AGENT_TEMPERATURE = 0.3
AGENT_MAX_TOKENS = 4096
#: A free model that hangs is not coming back: give up on the attempt after a
#: minute, or 30 s without a streamed chunk, and let the native middleware try
#: the next candidate instead of burning the whole run deadline.
AGENT_TIMEOUT_SEC = 60
#: Retained for a pinned model without alternatives. Composition disables SDK
#: retries for fallback chains to avoid multiplying attempts.
AGENT_MAX_RETRIES = 2
AGENT_STREAM_CHUNK_TIMEOUT_SEC = 30

#: Free, tool-calling chat models, measured on 2026-10-09. Nemotron 3 Super
#: answers a tool call in 1.3 s and a real briefing in 6-8 s, in French, with
#: its reasoning kept out of the answer. Rejected the same day: Nemotron 3.5
#: Lightning (writes its reasoning into the answer), `openrouter/free` (routed
#: a tool-less request to a content-safety classifier that replied "User
#: Safety: safe"), Ling 3.1 Flash (priced 0 but not free under a price cap).
#: On 2026-10-23 both Nemotron models were free only on NVIDIA's trial
#: endpoint, which trains on prompts: under `data_collection: "deny"` Gemma 4
#: 31B (Google AI Studio: no training, 55-day retention) is the only measured
#: free model left. Free availability changes weekly: LLM_MODEL and
#: LLM_MODEL_FALLBACKS override both.
DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free"
DEFAULT_OPENROUTER_FALLBACKS: tuple[str, ...] = ()
#: Default OpenRouter policy: a model that stops being free is skipped
#: instead of billed. Only the explicit admin GLM rollout permits paid chat
#: requests; Jev surface and memory decisions have separately bounded paid routes.
#: Every policy denies data collection: each request carries athlete data, so
#: OpenRouter must skip providers that train on prompts. It does not filter
#: on retention (that would be `zdr`).
OPENROUTER_FREE_ONLY = {
    "sort": "latency",
    "data_collection": "deny",
    "max_price": {"prompt": 0, "completion": 0},
}
#: Opt-in admin experiment. Provider fallback stays on this model and cannot
#: exceed these USD/million-token prices if a provider changes its tariff.
GLM_FLASH_MODEL = "z-ai/glm-5.3-flash"
OPENROUTER_GLM_FLASH = {
    "sort": "latency",
    "allow_fallbacks": True,
    "require_parameters": True,
    "data_collection": "deny",
    "max_price": {"prompt": 0.15, "completion": 0.5},
}
#: OpenRouter rejects a longer `models` list with HTTP 400.
MAX_OPENROUTER_MODELS = 3

#: Default GitHub Models model: free tier, tool-calling capable.
DEFAULT_GITHUB_MODEL = "Meta-Llama-3.1-8B-Instruct"


@dataclass(frozen=True)
class ModelRoute:
    model: str
    base_url: str
    api_key: SecretStr
    context_tokens: int
    #: Tried in order by OpenRouter when the model above errors, is rate
    #: limited or down. Empty everywhere else.
    fallbacks: tuple[str, ...] = ()
    openrouter_policy: Literal["free", "glm_flash"] = "free"
