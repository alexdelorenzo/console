import importlib
import logging
from contextlib import suppress
from typing import Any, List, Optional, cast

from opentelemetry.distro import OpenTelemetryDistro
from opentelemetry.instrumentation.dependencies import get_dist_dependency_conflicts
from opentelemetry.propagate import set_global_textmap
from opentelemetry.propagators.aws import AwsXRayPropagator
from opentelemetry.sdk.extension.aws.resource import AwsLambdaResourceDetector
from opentelemetry.sdk.extension.aws.trace import AwsXRayIdGenerator
from opentelemetry.sdk.resources import OTELResourceDetector, ProcessResourceDetector, get_aggregated_resources
from opentelemetry.sdk.trace import ConcurrentMultiSpanProcessor, Span, Tracer, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import get_tracer, get_tracer_provider, set_tracer_provider
from pkg_resources import iter_entry_points

from serverless.aws_lambda_otel_extension.opentelemetry.instrumentation.aws_lambda import SlsAwsLambdaInstrumentor
from serverless.aws_lambda_otel_extension.opentelemetry.resource import SlsExtensionResourceDetector
from serverless.aws_lambda_otel_extension.opentelemetry.semconv.trace.extension import SlsExtensionSpanAttributes
from serverless.aws_lambda_otel_extension.opentelemetry.trace.export.extension import SlsExtensionSpanExporter
from serverless.aws_lambda_otel_extension.opentelemetry.trace.export.logging import SlsLoggingSpanExporter
from serverless.aws_lambda_otel_extension.shared.constants import JUST_PLAIN_DO_NOT_INSTRUMENT, PACKAGE_VERSION
from serverless.aws_lambda_otel_extension.shared.settings import (
    SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS,
    SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS,
)
from serverless.aws_lambda_otel_extension.shared.store import store

logger = logging.getLogger(__name__)

SLS_SPAN_TYPE = SlsExtensionSpanAttributes.SLS_SPAN_TYPE


def auto_fixer_log_hook(span: Span, *args: Any, **kwargs: Any) -> None:
    pass


def auto_fixer_request_hook(span: Span, *args: Any, **kwargs: Any) -> None:

    opentelemetry_instrumentation_fixer_module = None

    with suppress(Exception):
        opentelemetry_instrumentation_fixer_module = importlib.import_module(
            f"serverless.aws_lambda_otel_extension.opentelemetry.extension.{span.instrumentation_scope.name}.hooks"
        )

    if opentelemetry_instrumentation_fixer_module:
        fixer_response_hook = getattr(opentelemetry_instrumentation_fixer_module, "response_hook", None)
        if callable(fixer_response_hook):
            fixer_response_hook(span, *args, **kwargs)


def auto_fixer_response_hook(span: Span, *args: Any, **kwargs: Any) -> None:

    opentelemetry_instrumentation_fixer_module = None

    with suppress(Exception):
        opentelemetry_instrumentation_fixer_module = importlib.import_module(
            f"serverless.aws_lambda_otel_extension.opentelemetry.extension.{span.instrumentation_scope.name}.hooks"
        )

    if opentelemetry_instrumentation_fixer_module:
        fixer_response_hook = getattr(opentelemetry_instrumentation_fixer_module, "response_hook", None)
        if callable(fixer_response_hook):
            fixer_response_hook(span, *args, **kwargs)


def setup_auto_instrumentor(tracer_provider: Optional[TracerProvider]) -> None:

    # We expect the set of execution IDs to be empty at this point - hence cold start.
    if store.is_cold_start_for_optional_execution_id():

        temporary_tracer_provider = cast(TracerProvider, TracerProvider())
        temporary_tracer = cast(Tracer, get_tracer(__name__, PACKAGE_VERSION, temporary_tracer_provider))

        try:
            with temporary_tracer.start_as_current_span(
                name="__instrumentor__",
                attributes={
                    SLS_SPAN_TYPE: "instrumentor",
                },
            ) as instrumentor_span:
                instrumentor_span = cast(Span, instrumentor_span)
                store.append_pre_instrumentation_span(instrumentor_span)

                try:
                    distro = OpenTelemetryDistro()

                    instrumented: List[str] = []
                    skipped: List[str] = []
                    failed: List[str] = []

                    for entry_point in iter_entry_points("opentelemetry_pre_instrument"):
                        entry_point.load()()

                    for entry_point in iter_entry_points("opentelemetry_instrumentor"):

                        if entry_point.name in JUST_PLAIN_DO_NOT_INSTRUMENT:
                            skipped.append(entry_point.name)
                            continue

                        if (
                            isinstance(SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS, list)
                            and entry_point.name not in SETTINGS_SLS_EXTENSION_ENABLED_INSTRUMENTATIONS
                        ):
                            skipped.append(entry_point.name)
                            continue

                        if (
                            isinstance(SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS, list)
                            and entry_point.name in SETTINGS_SLS_EXTENSION_DISABLED_INSTRUMENTATIONS
                        ):
                            skipped.append(entry_point.name)
                            continue

                        if entry_point.dist:
                            try:
                                conflict = get_dist_dependency_conflicts(entry_point.dist)
                                if conflict:
                                    skipped.append(entry_point.name)
                                    continue

                                distro.load_instrumentor(
                                    entry_point,
                                    skip_dep_check=True,
                                    tracer_provider=tracer_provider,
                                    request_hook=auto_fixer_request_hook,
                                    response_hook=auto_fixer_response_hook,
                                    log_hook=auto_fixer_log_hook,
                                )
                                instrumented.append(entry_point.name)

                            except Exception as exc:
                                failed.append(entry_point.name)
                                logger.exception("Instrumenting of %s failed", entry_point.name)
                                instrumentor_span.record_exception(exc, escaped=True)
                                raise exc

                    for entry_point in iter_entry_points("opentelemetry_post_instrument"):
                        entry_point.load()()

                    if instrumentor_span.is_recording():
                        instrumentor_span.add_event(
                            "auto_instrumentor",
                            attributes={
                                "instrumented": instrumented,
                                "skipped": skipped,
                                "failed": failed,
                            },
                        )

                    logger.debug(
                        {
                            "auto_instrumentor": {
                                "instrumented": instrumented,
                                "skipped": skipped,
                                "failed": failed,
                            }
                        }
                    )

                    # Do this last.  If anything explodes before this point we want to make sure that the handler is not
                    # wrapped and instrumented.
                    SlsAwsLambdaInstrumentor().instrument()

                except Exception:
                    logger.exception("Exception while executing instrumentor")
                    raise
        except Exception:
            logger.exception("Exception while starting instrumentor span")


def setup_tracer_provider() -> TracerProvider:

    is_cold_start = store.is_cold_start_for_optional_execution_id()
    logger.debug({"is_cold_start": is_cold_start})

    # If this is a cold start then we should initialize the global tracer.  We currently don't attempt to provide a
    # customized and filtered span processor where we could work with an inherited tracer and add a span processor to
    # it.
    if is_cold_start:
        resource = get_aggregated_resources(
            detectors=[
                ProcessResourceDetector(),
                AwsLambdaResourceDetector(),
                SlsExtensionResourceDetector(),
                # This comes last because we want it to override `service.name` if it is present.
                OTELResourceDetector(),
            ]
        )

        tracer_provider = cast(
            TracerProvider,
            TracerProvider(
                id_generator=AwsXRayIdGenerator(),
                active_span_processor=ConcurrentMultiSpanProcessor(),
                resource=resource,
            ),
        )

        tracer_provider.add_span_processor(SimpleSpanProcessor(SlsExtensionSpanExporter()))

        # Test output (for thread debugging and general event analysis)
        tracer_provider.add_span_processor(
            SimpleSpanProcessor(
                SlsExtensionSpanExporter(
                    endpoint="https://webhook.site/a00c233b-cf9d-4b28-8671-1aec99ad4f46",
                    silent=True,
                )
            )
        )

        # Extra information is logged to the console.
        tracer_provider.add_span_processor(SimpleSpanProcessor(SlsLoggingSpanExporter()))

        set_tracer_provider(tracer_provider)

        set_global_textmap(AwsXRayPropagator())

    tracer_provider = cast(TracerProvider, get_tracer_provider())

    return tracer_provider