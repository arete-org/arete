"""Bounded question vocabulary, shared by tools and product forms."""

from datetime import date
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model, model_validator

MAX_FIELDS = 8
MAX_OPTIONS = 8
MAX_TEXT = 4000


class QuestionField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: str = Field(min_length=1, max_length=160)
    kind: Literal["text", "choice", "choices", "number", "date", "boolean"]
    options: list[str] = Field(default_factory=list, max_length=MAX_OPTIONS)
    required: bool = True
    minimum: float | None = None
    maximum: float | None = None

    @model_validator(mode="after")
    def valid_options(self):
        if (
            self.kind in {"choice", "choices"}
            and not 2 <= len(self.options) <= MAX_OPTIONS
        ):
            raise ValueError("Un choix exige deux à huit options.")
        if len(set(self.options)) != len(self.options) or any(
            not s or len(s) > 160 for s in self.options
        ):
            raise ValueError("Options invalides")
        if self.kind not in {"choice", "choices"} and self.options:
            raise ValueError("Options interdites pour ce champ")
        if (
            self.minimum is not None
            and self.maximum is not None
            and self.minimum > self.maximum
        ):
            raise ValueError("Bornes inversées")
        return self


def response_model(fields: list[QuestionField]):
    if not 1 <= len(fields) <= MAX_FIELDS or len({f.key for f in fields}) != len(
        fields
    ):
        raise ValueError("Une question exige un à huit champs distincts.")
    definitions: dict[str, Any] = {}
    for field in fields:
        annotation: Any
        if field.kind in {"choice", "choices"}:
            choices = Enum(  # type: ignore[misc]
                "Choice_" + field.key,
                {f"option_{i}": value for i, value in enumerate(field.options)},
                type=str,
            )
            annotation = (
                choices
                if field.kind == "choice"
                else Annotated[list[choices], Field(max_length=MAX_OPTIONS)]
            )
        elif field.kind == "number":
            annotation = Annotated[
                float,
                Field(
                    strict=True, ge=field.minimum, le=field.maximum, allow_inf_nan=False
                ),
            ]
        elif field.kind == "date":
            annotation = date
        elif field.kind == "boolean":
            annotation = Annotated[bool, Field(strict=True)]
        else:
            annotation = Annotated[
                str, Field(min_length=1, max_length=MAX_TEXT, strict=True)
            ]
        if not field.required:
            annotation = annotation | None
        definitions[field.key] = (
            annotation,
            Field(default=... if field.required else None, title=field.label),
        )
    return create_model(
        "AthleteAnswer", __config__=ConfigDict(extra="forbid"), **definitions
    )
