"""Native typed pauses. No domain operation is executed by a human answer."""

from langgraph.types import interrupt

from arete.services.human_input import QuestionField, response_model


def ask(question: str, fields: list[QuestionField], call_id: str):
    answer_type = response_model(fields)
    answer = interrupt(
        {
            "type": "question",
            "name": "ask_athlete",
            "tool_call_id": call_id,
            "args": {"question": question},
            "description": question,
        },
        response_schema=answer_type,
    )
    # Native validation handles resume values before checkpointing. Validate
    # again here for a direct invocation supplied by a compatible older runner.
    return answer_type.model_validate(answer).model_dump_json()
