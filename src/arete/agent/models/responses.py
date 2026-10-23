"""Reject completions that cannot advance a text-and-tool conversation."""

from langchain.agents.middleware.types import ModelResponse
from langchain_core.messages import AIMessage


class InvalidModelResponseError(RuntimeError):
    def __init__(self, response: ModelResponse, message: str):
        # Keep usage available to telemetry even when a provider spends its
        # entire output allowance on reasoning without answering.
        self.response = response
        super().__init__(message)


class EmptyModelResponseError(InvalidModelResponseError):
    def __init__(self, response: ModelResponse):
        super().__init__(response, "Le modèle n'a produit ni réponse ni appel d'outil.")


class TruncatedModelResponseError(InvalidModelResponseError):
    def __init__(self, response: ModelResponse):
        super().__init__(
            response,
            "Le modèle a atteint sa limite de sortie ; sa réponse est incomplète.",
        )


def validate_model_response(response: ModelResponse) -> None:
    if not any(
        isinstance(message, AIMessage) and (message.text.strip() or message.tool_calls)
        for message in response.result
    ):
        # Do not rely on finish_reason: providers can return empty `stop`
        # completions, and streaming can concatenate metadata (lengthlength).
        raise EmptyModelResponseError(response)
    for message in response.result:
        if not isinstance(message, AIMessage):
            continue
        finish = message.response_metadata.get("finish_reason", "")
        # Streaming can concatenate metadata (lengthlength). A little visible
        # text or even a parsed tool call does not make a truncated turn safe.
        if isinstance(finish, str) and finish and not finish.replace("length", ""):
            raise TruncatedModelResponseError(response)
