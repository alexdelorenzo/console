import json
import logging

from serverless.aws_lambda_otel_extension.shared.constants import INSTRUMENTATION_MAP, TRUTHY
from serverless.aws_lambda_otel_extension.shared.defaults import DEF_SLS_EXTENSION_EXPORT_URL
from serverless.aws_lambda_otel_extension.shared.environment import (
    ENV_SLS_EXTENSION,
    ENV_SLS_EXTENSION_INTERNAL_DISABLED_INSTRUMENTATIONS,
    ENV_SLS_EXTENSION_INTERNAL_ENABLED_INSTRUMENTATIONS,
    ENV_SLS_TEST_EXTENSION_INTERNAL_DEBUG,
    ENV_SLS_TEST_EXTENSION_INTERNAL_EXPORT_FLUSH_TIMEOUT,
    ENV_SLS_TEST_EXTENSION_INTERNAL_EXPORT_URL,
    ENV_SLS_TEST_EXTENSION_INTERNAL_LOG,
    ENV_SLS_TEST_EXTENSION_INTERNAL_LOG_PRETTY,
)
from serverless.aws_lambda_otel_extension.shared.utilities import split_or_none

logger = logging.getLogger(__name__)

SETTINGS_SLS_EXTENSION_EXPORT_URL = ENV_SLS_TEST_EXTENSION_INTERNAL_EXPORT_URL or DEF_SLS_EXTENSION_EXPORT_URL


# Process enabled/disabled instrumentation list
SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS = split_or_none(ENV_SLS_EXTENSION_INTERNAL_ENABLED_INSTRUMENTATIONS)
SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS = split_or_none(ENV_SLS_EXTENSION_INTERNAL_DISABLED_INSTRUMENTATIONS)

# Iterate through a copy of the list and expand the tidle strings.
if SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS is not None:
    for _instrumentation in SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS[:]:
        _expanded_instrumentation = INSTRUMENTATION_MAP.get(_instrumentation)
        if _expanded_instrumentation:
            SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS.remove(_instrumentation)
            SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS.extend(_expanded_instrumentation)
    SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS = sorted(set(SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS))

if SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS is not None:
    for _instrumentation in SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS[:]:
        _expanded_instrumentation = INSTRUMENTATION_MAP.get(_instrumentation)
        if _expanded_instrumentation:
            SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS.remove(_instrumentation)
            SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS.extend(_expanded_instrumentation)
    SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS = sorted(set(SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS))


SETTINGS_SLS_EXTENSION_DEBUG = ENV_SLS_TEST_EXTENSION_INTERNAL_DEBUG in TRUTHY
SETTINGS_SLS_EXTENSION_INTERNAL_LOG = ENV_SLS_TEST_EXTENSION_INTERNAL_LOG in TRUTHY
SETTINGS_SLS_EXTENSION_INTERNAL_LOG_PRETTY = ENV_SLS_TEST_EXTENSION_INTERNAL_LOG_PRETTY in TRUTHY
SETTINGS_SLS_EXTENSION_LOG_LEVEL = logging.DEBUG if SETTINGS_SLS_EXTENSION_DEBUG else logging.CRITICAL


SETTINGS_SLS_EXTENSION_FLUSH_TIMEOUT = (
    int(ENV_SLS_TEST_EXTENSION_INTERNAL_EXPORT_FLUSH_TIMEOUT)
    if ENV_SLS_TEST_EXTENSION_INTERNAL_EXPORT_FLUSH_TIMEOUT
    else 30000
)

SETTINGS_SLS_EXTENSION: dict = {}

SETTINGS_SLS_EXTENSION_OVERRIDE: dict = {}

if ENV_SLS_EXTENSION:  # Do not allow an empty string or None.
    try:
        SETTINGS_SLS_EXTENSION = {
            **SETTINGS_SLS_EXTENSION,
            **json.loads(ENV_SLS_EXTENSION),
        }
    except Exception:
        logger.exception("Unable to parse extension configuration")
