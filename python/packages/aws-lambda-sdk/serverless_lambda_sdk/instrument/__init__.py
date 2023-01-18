from __future__ import annotations

from functools import wraps
from typing import List

from typing_extensions import Final

from ..base import Handler
from ..trace_spans.aws_lambda import aws_lambda_span


__all__: Final[List[str]] = [
    "instrument",
]


def instrument(user_handler: Handler, *args, **kwargs) -> Handler:
    @wraps(user_handler)
    def wrapper(event, context):
        aws_lambda_span.tags['aws.lambda.request_id'] = context.aws_request_id
        return user_handler(event, context)

    return wrapper
