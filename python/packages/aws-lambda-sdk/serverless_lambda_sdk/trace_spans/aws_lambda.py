import logging
from os import environ
from typing import Dict, Optional
import platform

from typing_extensions import Final

from serverless_sdk.span.trace import TraceSpan
from serverless_sdk.span.tags import Tags

from ..internal_extension.base import START
from ..base import Env, NAME, __version__


TAGS: Final[Tags] = Tags()
_TAGS: Final[Dict[str, str]] = {
    'org_id': environ.get("SLS_ORG_ID"),
    'service': environ.get(Env.AWS_LAMBDA_FUNCTION_NAME),
    'sdk.name': NAME,
    'sdk.version': __version__,
}

TAGS.update(_TAGS)


def get_arch() -> Optional[str]:
    arch = platform.machine()

    if arch == "AMD64" or arch == "x86_64":
        return "x86_64"

    elif 'arm' in arch.casefold():
        return "arm64"

    logging.error(f"Serverless SDK Warning: Unrecognized architecture: {arch}")
    return None


ARCH: Final[str] = get_arch()

if ARCH:
    TAGS.update({'aws.lambda.arch': ARCH})


INIT = environ.get(Env.AWS_LAMBDA_INITIALIZATION_TYPE)

if INIT == 'on-demand':
    TAGS.update({'aws.lambda.is_coldstart': True})

else:
    TAGS.update({'aws.lambda.is_coldstart': False})

TAGS['aws.lambda.name'] = environ.get(Env.AWS_LAMBDA_FUNCTION_NAME)
TAGS['aws.lambda.version'] = environ.get(Env.AWS_LAMBDA_FUNCTION_VERSION)
TAGS['aws.lambda.request_id'] = ''
TAGS['aws.lambda.outcome'] = 'success'

aws_lambda_span: Final[TraceSpan] = TraceSpan(
    name="aws.lambda",
    start_time=START,
    tags=TAGS
)

aws_lambda_initialization: Final[TraceSpan] = TraceSpan(
    name="aws.lambda.initialization",
    start_time=START,
)

aws_lambda_invocation: Final[TraceSpan] = TraceSpan(
    name="aws.lambda.invocation",
    start_time=START,
)