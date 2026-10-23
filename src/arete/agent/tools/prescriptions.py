"""Finite provider schema over the domain's validated recursive prescription."""

from copy import deepcopy
from typing import Annotated, Any

from pydantic import WithJsonSchema

from arete.services.prescriptions import MAX_REPEAT_DEPTH, Prescription


def _schema() -> dict:
    schema = Prescription.model_json_schema()
    definitions = schema.pop("$defs")
    schema["description"] = (
        "Workout steps. A repeat group requires kind='repeat', repeat (count) "
        "and steps (children); put duration_kind and value on each child. "
        "For lap steps omit value; otherwise value uses duration_kind units."
    )

    # LangChain's provider conversion erases recursive refs. Inline the domain's
    # allowed depth so nested intervals stay typed; validation still uses Prescription.
    def step(depth: int) -> dict:
        item: dict = deepcopy(definitions["Step"])
        fields = item["properties"]
        for name in ("target", "secondary_target"):
            fields[name]["anyOf"][0] = deepcopy(definitions["Target"])
        if depth == MAX_REPEAT_DEPTH:
            fields["kind"]["enum"].remove("repeat")
            fields["steps"] = {
                "type": "array",
                "items": {"type": "null"},
                "maxItems": 0,
            }
            fields["repeat"] = {"type": "null"}
            fields["skip_last_recovery"] = {"type": "null"}
        else:
            fields["steps"]["items"] = step(depth + 1)
        return item

    schema["properties"]["steps"]["items"] = step(0)
    compacted = _compact(schema)
    assert isinstance(compacted, dict)
    assert "anyOf" not in compacted["properties"]["steps"]
    return compacted


def _compact(node: object) -> Any:
    """Drop what Pydantic repeats in every inlined step without telling the model
    anything: titles, empty defaults and nullable wrappers (omission means unset)."""
    if isinstance(node, list):
        return [_compact(item) for item in node]
    if not isinstance(node, dict):
        return node
    # A property named "title" is a dict; only the string annotation goes.
    result = {
        key: _compact(value)
        for key, value in node.items()
        if not (key == "title" and isinstance(value, str))
        and not (key == "default" and value in (None, ""))
    }
    options = result.get("anyOf")
    if options and len(options) == 2 and options[1] == {"type": "null"}:
        result = {**options[0], **{k: v for k, v in result.items() if k != "anyOf"}}
    return result


PrescriptionInput = Annotated[Prescription, WithJsonSchema(_schema())]
