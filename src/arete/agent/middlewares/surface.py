"""Classify before delivery; the shared graph resolves invocation policy afterward."""

from arete.agent.runtime.surface import detect_surface


class SurfaceDetectionMiddleware:
    def __init__(self, model, *, context_tokens: int):
        self.model = model
        self.context_tokens = context_tokens

    async def prepare(self, messages, context):
        return await detect_surface(self.model, messages, context, self.context_tokens)
