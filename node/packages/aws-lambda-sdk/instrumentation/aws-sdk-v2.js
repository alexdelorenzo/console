'use strict';

const ensureObject = require('type/object/ensure');
const ensureConstructor = require('type/constructor/ensure');
const doNotInstrumentFollowingHttpRequest =
  require('@serverless/sdk/lib/instrumentation/http').ignoreFollowingRequest;
const serviceMapper = require('../lib/instrumentation/aws-sdk/service-mapper');
const safeStringify = require('../lib/instrumentation/aws-sdk/safe-stringify');

const instrumentedSdks = new WeakMap();

module.exports.install = (Sdk) => {
  if (instrumentedSdks.has(Sdk)) return instrumentedSdks.get(Sdk);
  ensureObject(Sdk, { errorMessage: '%v is not an instance of AWS SDK' });
  ensureConstructor(Sdk.Request, { errorMessage: 'Passed argument is not an instance of AWS SDK' });
  if (typeof Sdk.VERSION !== 'string') {
    throw new TypeError('Passed argument is not an instance of AWS SDK');
  }
  if (!Sdk.VERSION.startsWith('2.')) {
    throw new TypeError(`Unsupported AWS SDK version: ${Sdk.VERSION}`);
  }
  const shouldMonitorRequestResponse =
    serverlessSdk._isDevMode && !serverlessSdk._settings.disableRequestResponseMonitoring;
  const originalRunTo = Sdk.Request.prototype.runTo;
  const originalPresign = Sdk.Request.prototype.presign;
  Sdk.Request.prototype.presign = function presign(expires, callback) {
    // Presign only pre-configures request url but does not issue real AWS SDK request.
    // Ensure to not instrument such requests
    this.runTo = originalRunTo;
    return originalPresign.call(this, expires, callback);
  };
  Sdk.Request.prototype.runTo = function runTo(state, done) {
    // identifier
    const serviceName =
      this.service.constructor.serviceIdentifier ||
      this.service.constructor.__super__.serviceIdentifier;
    const tagMapper = serviceMapper.get(serviceName);
    const operationName = this.operation.toLowerCase();
    const params = this.params;
    const traceSpan = serverlessSdk._createTraceSpan(`aws.sdk.${serviceName}.${operationName}`, {
      tags: {
        'aws.sdk.region': this.service.config.region,
        'aws.sdk.signature_version': this.service.config.signatureVersion,
        'aws.sdk.service': serviceName,
        'aws.sdk.operation': operationName,
      },
      input: shouldMonitorRequestResponse ? safeStringify(params) : null,
    });
    if (tagMapper && tagMapper.params) tagMapper.params(traceSpan, params);
    let wasCompleted = false;
    this.on('complete', (response) => {
      if (wasCompleted) {
        console.warn({
          source: 'serverlessSdk',
          message:
            'Detected doubled handling for same AWS SDK request. ' +
            'It may happen if for the same request both callback and promise resolution ' +
            'is requested. Internally it creates two AWS SDK calls so such design should be avoided.\n',
          code: 'AWS_SDK_DOUBLE_RESOLUTION',
        });
        return;
      }
      wasCompleted = true;
      if (response.requestId) traceSpan.tags.set('aws.sdk.request_id', response.requestId);
      if (response.error) {
        traceSpan.tags.set('aws.sdk.error', response.error.message);
      } else {
        if (shouldMonitorRequestResponse) traceSpan.output = safeStringify(response.data);
        if (tagMapper && tagMapper.responseData) tagMapper.responseData(traceSpan, response.data);
      }
      if (!traceSpan.endTime) traceSpan.close();
    });
    doNotInstrumentFollowingHttpRequest();
    try {
      return originalRunTo.call(this, state, done);
    } finally {
      traceSpan.closeContext();
    }
  };

  const uninstall = () => {
    if (!instrumentedSdks.has(Sdk)) return;
    Sdk.Request.prototype.runTo = originalRunTo;
    instrumentedSdks.delete(Sdk);
  };
  instrumentedSdks.set(Sdk, uninstall);
  return uninstall;
};

module.exports.uninstall = (client) => {
  const uninstall = instrumentedSdks.get(client);
  if (uninstall) uninstall();
};

const serverlessSdk = global.serverlessSdk || require('../');
