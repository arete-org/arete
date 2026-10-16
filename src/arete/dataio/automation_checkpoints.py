"""Bounded checkpoint storage; only owned automation threads may be persisted."""

from arete.dataio.db import transaction

MAX_CHECKPOINTS = 512
MAX_WRITES = 4096
MAX_BLOB_BYTES = 4_000_000


def _owner(con, thread):
    if not con.execute(
        "SELECT 1 FROM app.visible_automation_runs WHERE id=?", [thread]
    ).fetchone():
        raise LookupError("Automation thread not found")


def read(thread, namespace, identifier=None, *, before=None, limit=MAX_CHECKPOINTS):
    assert 0 < limit <= MAX_CHECKPOINTS
    with transaction() as con:
        _owner(con, thread)
        checkpoints = con.execute(
            "SELECT id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata FROM app.visible_automation_checkpoints WHERE thread_id=? AND namespace=? AND (? IS NULL OR id=?) AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?",
            [thread, namespace, identifier, identifier, before, before, limit],
        ).fetchall()
        result = []
        for row in checkpoints:
            writes = con.execute(
                "SELECT task_id,channel,value_type,value FROM app.visible_automation_checkpoint_writes WHERE thread_id=? AND namespace=? AND checkpoint_id=? ORDER BY task_id,position LIMIT ?",
                [thread, namespace, row[0], MAX_WRITES + 1],
            ).fetchall()
            if len(writes) > MAX_WRITES:
                raise ValueError("Checkpoint write limit exceeded")
            result.append((row, writes))
        return result


def put(thread, namespace, identifier, parent, checkpoint, metadata):
    if len(checkpoint[1]) + len(metadata[1]) > MAX_BLOB_BYTES:
        raise ValueError("Checkpoint size limit exceeded")
    with transaction() as con:
        _owner(con, thread)
        count = con.execute(
            "SELECT count(*) FROM app.visible_automation_checkpoints WHERE thread_id=?",
            [thread],
        ).fetchone()[0]
        if count >= MAX_CHECKPOINTS:
            raise ValueError("Checkpoint count limit exceeded")
        con.execute(
            "INSERT INTO app.automation_checkpoints (thread_id,namespace,id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            [thread, namespace, identifier, parent, *checkpoint, *metadata],
        )


def put_writes(thread, namespace, identifier, task, writes, path):
    if len(writes) > MAX_WRITES or sum(len(w[3]) for w in writes) > MAX_BLOB_BYTES:
        raise ValueError("Checkpoint write size limit exceeded")
    with transaction() as con:
        _owner(con, thread)
        count = con.execute(
            "SELECT count(*) FROM app.visible_automation_checkpoint_writes WHERE thread_id=?",
            [thread],
        ).fetchone()[0]
        if count + len(writes) > MAX_WRITES:
            raise ValueError("Checkpoint write count limit exceeded")
        for position, channel, kind, value in writes:
            conflict = (
                "DO UPDATE SET channel=excluded.channel,value_type=excluded.value_type,value=excluded.value"
                if position < 0
                else "DO NOTHING"
            )
            con.execute(
                f"INSERT INTO app.automation_checkpoint_writes (thread_id,namespace,checkpoint_id,task_id,position,channel,value_type,value,task_path) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT {conflict}",
                [
                    thread,
                    namespace,
                    identifier,
                    task,
                    position,
                    channel,
                    kind,
                    value,
                    path,
                ],
            )


def delete(thread):
    with transaction() as con:
        _owner(con, thread)
        for table in ("automation_checkpoint_writes", "automation_checkpoints"):
            con.execute(
                f"DELETE FROM app.{table} WHERE athlete_id=getvariable('arete_athlete_id') AND thread_id=?",
                [thread],
            )
