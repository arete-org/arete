"""Strict argument schemas for validation and native provider binding."""

import inspect
import json
from collections.abc import Callable
from copy import deepcopy
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, ConfigDict, create_model


def _strict(schema: type[BaseModel]) -> type[BaseModel]:
    return create_model(
        schema.__name__, __base__=schema, __config__=ConfigDict(extra="forbid")
    )


class TypedTool(StructuredTool):
    @property
    def tool_call_schema(self) -> dict[str, Any]:
        # LangChain's injected-argument subset drops the parent model config.
        # Preserve the same unknown-field contract in the provider's schema.
        schema = super().tool_call_schema
        assert isinstance(schema, type) and issubclass(schema, BaseModel)
        result = deepcopy(schema.model_json_schema())
        result["additionalProperties"] = False
        return result


def typed_tool(function: Callable[..., Any]) -> BaseTool:
    result = (
        TypedTool.from_function(coroutine=function)
        if inspect.iscoroutinefunction(function)
        else TypedTool.from_function(function)
    )
    schema = result.args_schema
    assert isinstance(schema, type) and issubclass(schema, BaseModel)
    result.args_schema = _strict(schema)
    result.handle_validation_error = lambda exc: json.dumps(
        {"error": str(exc)}, ensure_ascii=False
    )
    return result
