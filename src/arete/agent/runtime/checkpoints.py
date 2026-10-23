"""Public LangGraph saver contract over athlete-scoped storage."""

from functools import partial

from anyio import to_thread
from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    BaseCheckpointSaver,
    CheckpointTuple,
)

from arete.dataio import automation_checkpoints as repository


def _config(thread, namespace, identifier):
    return {
        "configurable": {
            "thread_id": thread,
            "checkpoint_ns": namespace,
            "checkpoint_id": identifier,
        }
    }


class RunCheckpointSaver(BaseCheckpointSaver):
    def __init__(self, *, family="automation"):
        super().__init__()
        assert family in {"automation", "chat"}
        self.family = family

    def list(self, config, *, filter=None, before=None, limit=None):
        if config is None:
            raise ValueError("An owned execution thread is required")
        values = config["configurable"]
        thread, namespace = values["thread_id"], values.get("checkpoint_ns", "")
        bound = repository.MAX_CHECKPOINTS if limit is None else limit
        if not 0 < bound <= repository.MAX_CHECKPOINTS:
            raise ValueError("Invalid checkpoint page size")
        prior = before["configurable"].get("checkpoint_id") if before else None
        for row, writes in repository.read(
            thread,
            namespace,
            values.get("checkpoint_id"),
            before=prior,
            limit=bound,
            family=self.family,
        ):
            identifier, parent, kind, blob, meta_kind, meta_blob = row
            metadata = self.serde.loads_typed((meta_kind, meta_blob))
            if filter and any(metadata.get(k) != v for k, v in filter.items()):
                continue
            yield CheckpointTuple(
                config=_config(thread, namespace, identifier),
                checkpoint=self.serde.loads_typed((kind, blob)),
                metadata=metadata,
                parent_config=_config(thread, namespace, parent) if parent else None,
                pending_writes=[
                    (task, channel, self.serde.loads_typed((typ, val)))
                    for task, channel, typ, val in writes
                ],
            )

    def get_tuple(self, config):
        return next(self.list(config, limit=1), None)

    def put(self, config, checkpoint, metadata, new_versions):
        values = config["configurable"]
        thread, namespace = values["thread_id"], values.get("checkpoint_ns", "")
        repository.put(
            thread,
            namespace,
            checkpoint["id"],
            values.get("checkpoint_id"),
            self.serde.dumps_typed(checkpoint),
            self.serde.dumps_typed(metadata),
            family=self.family,
        )
        return _config(thread, namespace, checkpoint["id"])

    def put_writes(self, config, writes, task_id, task_path=""):
        values = config["configurable"]
        repository.put_writes(
            values["thread_id"],
            values.get("checkpoint_ns", ""),
            values["checkpoint_id"],
            task_id,
            [
                (
                    WRITES_IDX_MAP.get(channel, index),
                    channel,
                    *self.serde.dumps_typed(value),
                )
                for index, (channel, value) in enumerate(writes)
            ],
            task_path,
            family=self.family,
        )

    def delete_thread(self, thread_id):
        repository.delete(thread_id, family=self.family)

    async def aget_tuple(self, config):
        return await to_thread.run_sync(self.get_tuple, config)

    async def alist(self, config, *, filter=None, before=None, limit=None):
        records = await to_thread.run_sync(
            lambda: list(self.list(config, filter=filter, before=before, limit=limit))
        )
        for record in records:
            yield record

    async def aput(self, config, checkpoint, metadata, new_versions):
        return await to_thread.run_sync(
            self.put, config, checkpoint, metadata, new_versions
        )

    async def aput_writes(self, config, writes, task_id, task_path=""):
        await to_thread.run_sync(
            partial(self.put_writes, config, writes, task_id, task_path)
        )

    async def adelete_thread(self, thread_id):
        await to_thread.run_sync(self.delete_thread, thread_id)


# Existing automation callers retain their default storage family and formats.
AutomationSaver = RunCheckpointSaver
