from __future__ import annotations

import logging
import traceback
from functools import wraps
from time import time_ns
from typing import Any, List

from typing_extensions import Final

from ..base import Handler, Outcome, Tag
from ..trace_spans.aws_lambda import aws_lambda_span


__all__: Final[List[str]] = [
    "instrument",
]


def get_stacktrace(exception: Exception) -> str:
    trace = traceback.format_exception(
        type(exception), exception, exception.__traceback__
    )
    return "".join(trace)


def instrument(user_handler: Handler, *args, **kwargs) -> Handler:
    @wraps(user_handler)
    def wrapper(event, context):
        aws_lambda_span.tags[Tag.request_id] = context.aws_request_id

        try:
            result = user_handler(event, context)
            close_trace(Outcome.success, result)
            return result

        except Exception as e:
            logging.error(f"Error executing handler: {e}")
            close_trace(Outcome.error_handled, e)

    return wrapper


def close_trace(outcome: str, outcome_result: Any):
    aws_lambda_span.tags[Tag.outcome] = outcome

    if outcome == Outcome.error_handled:
        aws_lambda_span.tags[Tag.error_message] = str(outcome_result)
        aws_lambda_span.tags[Tag.error_stacktrace] = get_stacktrace(outcome_result)

    end_time = time_ns()
    aws_lambda_span.close(end_time=end_time)
