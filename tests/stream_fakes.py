"""Small v3 stream stand-in for HTTP tests; real graphs cover native projection."""


class FakeEventStream:
    def __init__(self, source):
        self.source = source

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.source.aclose()

    def __aiter__(self):
        return self.source

    async def interrupts(self):
        return ()


class StreamGraph:
    async def astream_events(self, state, **kwargs):
        assert kwargs.pop("version") == "v3"
        kwargs.pop("transformers")
        return FakeEventStream(self.astream(state, **kwargs))
