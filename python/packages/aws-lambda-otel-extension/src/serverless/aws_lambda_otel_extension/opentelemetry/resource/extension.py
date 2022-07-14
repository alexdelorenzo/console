import logging

from opentelemetry.sdk.resources import Resource, ResourceDetector

from serverless.aws_lambda_otel_extension.opentelemetry.semconv.resource import SlsExtensionResourceAttributes
from serverless.aws_lambda_otel_extension.shared.settings import SETTINGS_SLS_EXTENSION
from serverless.aws_lambda_otel_extension.shared.utilities import filter_dict_value_is_not_none

logger = logging.getLogger(__name__)

SLS_ORG_ID = SlsExtensionResourceAttributes.SLS_ORG_ID
SLS_SERVICE_NAME = SlsExtensionResourceAttributes.SLS_SERVICE_NAME
SLS_STAGE = SlsExtensionResourceAttributes.SLS_STAGE


class SlsExtensionResourceDetector(ResourceDetector):
    def detect(self) -> "Resource":

        attributes = filter_dict_value_is_not_none(
            {
                SLS_ORG_ID: SETTINGS_SLS_EXTENSION.get("orgId"),
                SLS_SERVICE_NAME: SETTINGS_SLS_EXTENSION.get("namespace"),
                SLS_STAGE: SETTINGS_SLS_EXTENSION.get("environment"),
            }
        )

        if SLS_ORG_ID not in attributes:
            if self.raise_on_error:
                raise ValueError(f"{SLS_ORG_ID} is required")
            logger.error(f"{SLS_ORG_ID} not defined")

        if SLS_SERVICE_NAME not in attributes:
            if self.raise_on_error:
                raise ValueError(f"{SLS_SERVICE_NAME} is required")
            logger.error(f"{SLS_SERVICE_NAME} not defined")

        if SLS_STAGE not in attributes:
            if self.raise_on_error:
                raise ValueError(f"{SLS_STAGE} is required")
            logger.error(f"{SLS_STAGE} not defined")

        return Resource(attributes)