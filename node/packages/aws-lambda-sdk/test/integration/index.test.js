'use strict';

const { expect } = require('chai');

const path = require('path');
const log = require('log').get('test');
const wait = require('timers-ext/promise/sleep');
const { APIGateway } = require('@aws-sdk/client-api-gateway');
const { ApiGatewayV2 } = require('@aws-sdk/client-apigatewayv2');
const { Lambda } = require('@aws-sdk/client-lambda');
const { SQS } = require('@aws-sdk/client-sqs');
const { SNS } = require('@aws-sdk/client-sns');
const { default: fetch } = require('node-fetch');
const cleanup = require('../lib/cleanup');
const createCoreResources = require('../lib/create-core-resources');
const processFunction = require('../lib/process-function');
const resolveTestVariantsConfig = require('../lib/resolve-test-variants-config');
const resolveFileZipBuffer = require('../utils/resolve-file-zip-buffer');
const awsRequest = require('../utils/aws-request');
const pkgJson = require('../../package');

const fixturesDirname = path.resolve(__dirname, '../fixtures/lambdas');

for (const name of ['TEST_INTERNAL_LAYER_FILENAME']) {
  // In tests, current working directory is mocked,
  // so if relative path is provided in env var it won't be resolved properly
  // with this patch we resolve it before cwd mocking
  if (process.env[name]) process.env[name] = path.resolve(process.env[name]);
}

describe('integration', function () {
  this.timeout(120000);
  const coreConfig = {};

  const getCreateHttpApi = (payloadFormatVersion) => async (testConfig) => {
    const apiId = (testConfig.apiId = (
      await awsRequest(ApiGatewayV2, 'createApi', {
        Name: testConfig.configuration.FunctionName,
        ProtocolType: 'HTTP',
      })
    ).ApiId);
    const deferredAddPermission = awsRequest(Lambda, 'addPermission', {
      FunctionName: testConfig.configuration.FunctionName,
      Principal: '*',
      Action: 'lambda:InvokeFunction',
      SourceArn: `arn:aws:execute-api:${process.env.AWS_REGION}:${coreConfig.accountId}:${apiId}/*`,
      StatementId: testConfig.name,
    });
    const integrationId = (
      await awsRequest(ApiGatewayV2, 'createIntegration', {
        ApiId: apiId,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: `arn:aws:lambda:${process.env.AWS_REGION}:${coreConfig.accountId}:function:${testConfig.configuration.FunctionName}`,
        PayloadFormatVersion: payloadFormatVersion,
      })
    ).IntegrationId;

    await awsRequest(ApiGatewayV2, 'createRoute', {
      ApiId: apiId,
      RouteKey: 'POST /test',
      Target: `integrations/${integrationId}`,
    });

    await awsRequest(ApiGatewayV2, 'createStage', {
      ApiId: apiId,
      StageName: '$default',
      AutoDeploy: true,
    });

    await deferredAddPermission;
  };

  const createEventSourceMapping = async (functionName, eventSourceArn) => {
    try {
      return (
        await awsRequest(Lambda, 'createEventSourceMapping', {
          FunctionName: functionName,
          EventSourceArn: eventSourceArn,
        })
      ).UUID;
    } catch (error) {
      if (error.message.includes('Please update or delete the existing mapping with UUID')) {
        const previousUuid = error.message
          .slice(error.message.indexOf('with UUID ') + 'with UUID '.length)
          .trim();
        log.notice(
          'Found existing event source mapping (%s) for %s, reusing',
          previousUuid,
          functionName
        );
        return previousUuid;
      }
      throw error;
    }
  };

  const testAwsSdk = ({ testConfig, invocationsData }) => {
    for (const [
      index,
      {
        trace: { spans },
      },
    ] of invocationsData.entries()) {
      spans.shift();
      if (!index) spans.shift();
      const [
        invocationSpan,
        sqsCreateSpan,
        sqsSendSpan,
        sqsDeleteSpan,
        snsCreateSpan,
        snsPublishSpan,
        snsDeleteSpan,
        dynamodbCreateSpan,
        dynamodbDescribeSpan,
        ...dynamodbSpans
      ] = spans;

      // SNS
      const queueName = `${testConfig.configuration.FunctionName}-${index + 1}.fifo`;
      // Create
      expect(sqsCreateSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(sqsCreateSpan.name).to.equal('aws.sdk.sqs.createqueue');
      let sdkTags = sqsCreateSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('sqs');
      expect(sdkTags.operation).to.equal('createqueue');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.sqs.queueName).to.equal(queueName);
      // Send
      expect(sqsSendSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(sqsSendSpan.name).to.equal('aws.sdk.sqs.sendmessage');
      sdkTags = sqsSendSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('sqs');
      expect(sdkTags.operation).to.equal('sendmessage');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.sqs.queueName).to.equal(queueName);
      expect(sdkTags.sqs.messageIds.length).to.equal(1);
      // Delete
      expect(sqsDeleteSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(sqsDeleteSpan.name).to.equal('aws.sdk.sqs.deletequeue');
      sdkTags = sqsDeleteSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('sqs');
      expect(sdkTags.operation).to.equal('deletequeue');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.sqs.queueName).to.equal(queueName);

      // SQS
      const topicName = `${testConfig.configuration.FunctionName}-${index + 1}`;
      // Create
      expect(snsCreateSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(snsCreateSpan.name).to.equal('aws.sdk.sns.createtopic');
      sdkTags = snsCreateSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('sns');
      expect(sdkTags.operation).to.equal('createtopic');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.sns.topicName).to.equal(topicName);
      // Send
      expect(snsPublishSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(snsPublishSpan.name).to.equal('aws.sdk.sns.publish');
      sdkTags = snsPublishSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('sns');
      expect(sdkTags.operation).to.equal('publish');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.sns.topicName).to.equal(topicName);
      expect(sdkTags.sns.messageIds.length).to.equal(1);
      // Delete
      expect(snsDeleteSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(snsDeleteSpan.name).to.equal('aws.sdk.sns.deletetopic');
      sdkTags = snsDeleteSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('sns');
      expect(sdkTags.operation).to.equal('deletetopic');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.sns.topicName).to.equal(topicName);

      // Dynamodb
      const tableName = `${testConfig.configuration.FunctionName}-${index + 1}`;
      // Create
      expect(dynamodbCreateSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(dynamodbCreateSpan.name).to.equal('aws.sdk.dynamodb.createtable');
      sdkTags = dynamodbCreateSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('dynamodb');
      expect(sdkTags.operation).to.equal('createtable');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.dynamodb.tableName).to.equal(tableName);
      // Describe
      expect(dynamodbDescribeSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(dynamodbDescribeSpan.name).to.equal('aws.sdk.dynamodb.describetable');
      sdkTags = dynamodbDescribeSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('dynamodb');
      expect(sdkTags.operation).to.equal('describetable');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.dynamodb.tableName).to.equal(tableName);
      while (dynamodbSpans[0].name === 'aws.sdk.dynamodb.describetable') {
        dynamodbSpans.shift();
      }
      const [dynamodbPutItemSpan, dynamodbQuerySpan, dynamodbDeleteSpan] = dynamodbSpans;
      // Put item
      expect(dynamodbPutItemSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(dynamodbPutItemSpan.name).to.equal('aws.sdk.dynamodb.putitem');
      sdkTags = dynamodbPutItemSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('dynamodb');
      expect(sdkTags.operation).to.equal('putitem');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.dynamodb.tableName).to.equal(tableName);
      // Query
      expect(dynamodbQuerySpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(dynamodbQuerySpan.name).to.equal('aws.sdk.dynamodb.query');
      sdkTags = dynamodbQuerySpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('dynamodb');
      expect(sdkTags.operation).to.equal('query');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.dynamodb.tableName).to.equal(tableName);
      expect(sdkTags.dynamodb.keyCondition).to.equal('#id = :id');
      // Delete
      expect(dynamodbDeleteSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());
      expect(dynamodbDeleteSpan.name).to.equal('aws.sdk.dynamodb.deletetable');
      sdkTags = dynamodbDeleteSpan.tags.aws.sdk;
      expect(sdkTags.region).to.equal(process.env.AWS_REGION);
      expect(sdkTags.signatureVersion).to.equal('v4');
      expect(sdkTags.service).to.equal('dynamodb');
      expect(sdkTags.operation).to.equal('deletetable');
      expect(sdkTags).to.have.property('requestId');
      expect(sdkTags).to.not.have.property('error');
      expect(sdkTags.dynamodb.tableName).to.equal(tableName);
    }
  };

  const useCasesConfig = new Map([
    [
      'esm-callback/index',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
      },
    ],
    [
      'esm-thenable/index',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
      },
    ],
    [
      'esm-nested/nested/within/index',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
      },
    ],
    [
      'callback',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          [
            'v16',
            {
              configuration: { Runtime: 'nodejs16.x' },
              invokePayload: { test: 'foo' },
              test: ({ invocationsData }) => {
                for (const { request } of invocationsData) {
                  expect(request.data.requestData).to.equal(JSON.stringify({ test: 'foo' }));
                }
              },
            },
          ],
          [
            'sqs',
            {
              isAsyncInvocation: true,
              hooks: {
                afterCreate: async function self(testConfig) {
                  const queueName =
                    (testConfig.queueName = `${testConfig.configuration.FunctionName}.fifo`);
                  try {
                    testConfig.queueUrl = (
                      await awsRequest(SQS, 'createQueue', {
                        QueueName: queueName,
                        Attributes: { FifoQueue: true },
                      })
                    ).QueueUrl;
                  } catch (error) {
                    if (error.code === 'AWS.SimpleQueueService.QueueDeletedRecently') {
                      log.notice(
                        'Queue of same name was deleted recently, we must wait up to 60s to continue'
                      );
                      await wait(10000);
                      await self(testConfig);
                      return;
                    }
                    throw error;
                  }
                  const queueArn = `arn:aws:sqs:${process.env.AWS_REGION}:${coreConfig.accountId}:${queueName}`;
                  const sourceMappingUuid = (testConfig.sourceMappingUuid =
                    await createEventSourceMapping(
                      testConfig.configuration.FunctionName,
                      queueArn
                    ));
                  let queueState;
                  do {
                    await wait(300);
                    queueState = (
                      await awsRequest(Lambda, 'getEventSourceMapping', {
                        UUID: sourceMappingUuid,
                      })
                    ).State;
                  } while (queueState !== 'Enabled');
                },
                beforeDelete: async (testConfig) => {
                  await Promise.all([
                    awsRequest(Lambda, 'deleteEventSourceMapping', {
                      UUID: testConfig.sourceMappingUuid,
                    }),
                    awsRequest(SQS, 'deleteQueue', { QueueUrl: testConfig.queueUrl }),
                  ]);
                },
              },
              invoke: async (testConfig) => {
                const startTime = process.hrtime.bigint();
                await awsRequest(SQS, 'sendMessage', {
                  QueueUrl: testConfig.queueUrl,
                  MessageBody: 'test',
                  MessageGroupId: String(Date.now()),
                  MessageDeduplicationId: String(Date.now()),
                });
                let pendingMessages;
                do {
                  await wait(300);
                  const { Attributes: attributes } = await awsRequest(SQS, 'getQueueAttributes', {
                    QueueUrl: testConfig.queueUrl,
                    AttributeNames: ['All'],
                  });
                  pendingMessages =
                    Number(attributes.ApproximateNumberOfMessages) +
                    Number(attributes.ApproximateNumberOfMessagesNotVisible) +
                    Number(attributes.ApproximateNumberOfMessagesDelayed);
                } while (pendingMessages);

                const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
                return { duration };
              },
              test: ({ invocationsData, testConfig }) => {
                for (const { trace, request } of invocationsData) {
                  const { tags } = trace.spans[0];

                  expect(tags.aws.lambda.eventSource).to.equal('aws.sqs');
                  expect(tags.aws.lambda.eventType).to.equal('aws.sqs');

                  expect(tags.aws.lambda.sqs.queueName).to.equal(testConfig.queueName);
                  expect(tags.aws.lambda.sqs.messageIds.length).to.equal(1);

                  expect(JSON.parse(request.data.requestData)).to.have.property('Records');
                }
              },
            },
          ],
          [
            'sns',
            {
              isAsyncInvocation: true,
              ignoreMultipleInvocations: true,
              hooks: {
                afterCreate: async function self(testConfig) {
                  const topicName = (testConfig.topicName = testConfig.configuration.FunctionName);
                  await awsRequest(SNS, 'createTopic', { Name: topicName });
                  const topicArn = (testConfig.topicArn =
                    `arn:aws:sns:${process.env.AWS_REGION}:` +
                    `${coreConfig.accountId}:${topicName}`);
                  await Promise.all([
                    awsRequest(Lambda, 'addPermission', {
                      FunctionName: testConfig.configuration.FunctionName,
                      Principal: '*',
                      Action: 'lambda:InvokeFunction',
                      SourceArn: topicArn,
                      StatementId: 'sns',
                    }),
                    awsRequest(SNS, 'subscribe', {
                      TopicArn: topicArn,
                      Protocol: 'lambda',
                      Endpoint:
                        `arn:aws:lambda:${process.env.AWS_REGION}:${coreConfig.accountId}` +
                        `:function:${testConfig.configuration.FunctionName}`,
                    }),
                  ]);
                },
                beforeDelete: async (testConfig) => {
                  await Promise.all([
                    awsRequest(SNS, 'deleteTopic', { TopicArn: testConfig.topicArn }),
                  ]);
                },
              },
              invoke: async (testConfig) => {
                const startTime = process.hrtime.bigint();
                await awsRequest(SNS, 'publish', {
                  TopicArn: testConfig.topicArn,
                  Message: 'test',
                });
                const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
                return { duration };
              },
              test: ({ invocationsData, testConfig }) => {
                for (const { trace, request } of invocationsData) {
                  const { tags } = trace.spans[0];

                  expect(tags.aws.lambda.eventSource).to.equal('aws.sns');
                  expect(tags.aws.lambda.eventType).to.equal('aws.sns');

                  expect(tags.aws.lambda.sns.topicName).to.equal(testConfig.topicName);
                  expect(tags.aws.lambda.sns.messageIds.length).to.equal(1);

                  expect(JSON.parse(request.data.requestData)).to.have.property('Records');
                }
              },
            },
          ],
        ]),
      },
    ],
    [
      'esbuild-from-esm-callback',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
      },
    ],
    [
      'thenable',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
      },
    ],
    [
      'callback-error',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
        config: { expectedOutcome: 'error:handled' },
      },
    ],
    [
      'thenable-error',
      {
        variants: new Map([
          ['v14', { configuration: { Runtime: 'nodejs14.x' } }],
          ['v16', { configuration: { Runtime: 'nodejs16.x' } }],
        ]),
        config: { expectedOutcome: 'error:handled' },
      },
    ],
    [
      'api-endpoint',
      {
        variants: new Map([
          [
            'rest-api',
            {
              hooks: {
                afterCreate: async (testConfig) => {
                  const restApiId = (testConfig.restApiId = (
                    await awsRequest(APIGateway, 'createRestApi', {
                      name: testConfig.configuration.FunctionName,
                    })
                  ).id);
                  const deferredAddPermission = awsRequest(Lambda, 'addPermission', {
                    FunctionName: testConfig.configuration.FunctionName,
                    Principal: '*',
                    Action: 'lambda:InvokeFunction',
                    SourceArn: `arn:aws:execute-api:${process.env.AWS_REGION}:${coreConfig.accountId}:${restApiId}/*/*`,
                    StatementId: 'rest-api',
                  });
                  const rootResourceId = (
                    await awsRequest(APIGateway, 'getResources', {
                      restApiId,
                    })
                  ).items[0].id;
                  const interimResourceId = (
                    await awsRequest(APIGateway, 'createResource', {
                      restApiId,
                      parentId: rootResourceId,
                      pathPart: 'some-path',
                    })
                  ).id;
                  const resourceId = (
                    await awsRequest(APIGateway, 'createResource', {
                      restApiId,
                      parentId: interimResourceId,
                      pathPart: '{param}',
                    })
                  ).id;
                  await awsRequest(APIGateway, 'putMethod', {
                    restApiId,
                    resourceId,
                    httpMethod: 'POST',
                    authorizationType: 'NONE',
                    requestParameters: { 'method.request.path.param': true },
                  });
                  await awsRequest(APIGateway, 'putIntegration', {
                    restApiId,
                    resourceId,
                    httpMethod: 'POST',
                    integrationHttpMethod: 'POST',
                    type: 'AWS_PROXY',
                    uri: `arn:aws:apigateway:${process.env.AWS_REGION}:lambda:path/2015-03-31/functions/${testConfig.functionArn}/invocations`,
                  });
                  await awsRequest(APIGateway, 'createDeployment', {
                    restApiId,
                    stageName: 'test',
                  });
                  await deferredAddPermission;
                },
                beforeDelete: async (testConfig) => {
                  await awsRequest(APIGateway, 'deleteRestApi', {
                    restApiId: testConfig.restApiId,
                  });
                },
              },
              invoke: async (testConfig) => {
                const startTime = process.hrtime.bigint();
                const response = await fetch(
                  `https://${testConfig.restApiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/test/some-path/some-param`,
                  {
                    method: 'POST',
                    body: JSON.stringify({ some: 'content' }),
                    headers: {
                      'Content-Type': 'application/json',
                    },
                  }
                );
                if (response.status !== 200) {
                  throw new Error(`Unexpected response status: ${response.status}`);
                }
                const payload = { raw: await response.text() };
                const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
                log.debug('invoke response payload %s', payload.raw);
                return { duration, payload };
              },
              test: ({ invocationsData, testConfig }) => {
                for (const { trace, request, response } of invocationsData) {
                  const { tags } = trace.spans[0];

                  expect(tags.aws.lambda.eventSource).to.equal('aws.apigateway');
                  expect(tags.aws.lambda.eventType).to.equal('aws.apigateway.rest');

                  expect(tags.aws.lambda.apiGateway).to.have.property('accountId');
                  expect(tags.aws.lambda.apiGateway.apiId).to.equal(testConfig.restApiId);
                  expect(tags.aws.lambda.apiGateway.apiStage).to.equal('test');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('id');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('timeEpoch');
                  expect(tags.aws.lambda.http).to.have.property('host');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('headers');
                  expect(tags.aws.lambda.http.method).to.equal('POST');
                  expect(tags.aws.lambda.http.path).to.equal('/test/some-path/some-param');
                  expect(tags.aws.lambda.apiGateway.request.pathParameters).to.equal(
                    JSON.stringify({ param: 'some-param' })
                  );

                  expect(tags.aws.lambda.http.statusCode.toString()).to.equal('200');

                  expect(JSON.parse(request.data.requestData)).to.have.property('httpMethod');
                  expect(response.data.responseData).to.equal('"ok"');
                }
              },
            },
          ],
          [
            'http-api-v1',
            {
              hooks: {
                afterCreate: getCreateHttpApi('1.0'),
                beforeDelete: async (testConfig) => {
                  await awsRequest(ApiGatewayV2, 'deleteApi', { ApiId: testConfig.apiId });
                },
              },
              invoke: async (testConfig) => {
                const startTime = process.hrtime.bigint();
                const response = await fetch(
                  `https://${testConfig.apiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/test`,
                  {
                    method: 'POST',
                    body: JSON.stringify({ some: 'content' }),
                    headers: {
                      'Content-Type': 'application/json',
                    },
                  }
                );
                if (response.status !== 200) {
                  throw new Error(`Unexpected response status: ${response.status}`);
                }
                const payload = { raw: await response.text() };
                const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
                log.debug('invoke response payload %s', payload.raw);
                return { duration, payload };
              },
              test: ({ invocationsData, testConfig }) => {
                for (const { trace, request, response } of invocationsData) {
                  const { tags } = trace.spans[0];

                  expect(tags.aws.lambda.eventSource).to.equal('aws.apigateway');
                  expect(tags.aws.lambda.eventType).to.equal('aws.apigatewayv2.http.v1');

                  expect(tags.aws.lambda.apiGateway).to.have.property('accountId');
                  expect(tags.aws.lambda.apiGateway.apiId).to.equal(testConfig.apiId);
                  expect(tags.aws.lambda.apiGateway.apiStage).to.equal('$default');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('id');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('timeEpoch');
                  expect(tags.aws.lambda.http).to.have.property('host');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('headers');
                  expect(tags.aws.lambda.http.method).to.equal('POST');
                  expect(tags.aws.lambda.http.path).to.equal('/test');

                  expect(tags.aws.lambda.http.statusCode.toString()).to.equal('200');

                  expect(JSON.parse(request.data.requestData)).to.have.property('httpMethod');
                  expect(response.data.responseData).to.equal('"ok"');
                }
              },
            },
          ],
          [
            'http-api-v2',
            {
              hooks: {
                afterCreate: getCreateHttpApi('2.0'),
                beforeDelete: async (testConfig) => {
                  await awsRequest(ApiGatewayV2, 'deleteApi', { ApiId: testConfig.apiId });
                },
              },
              invoke: async (testConfig) => {
                const startTime = process.hrtime.bigint();
                const response = await fetch(
                  `https://${testConfig.apiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/test`,
                  {
                    method: 'POST',
                    body: JSON.stringify({ some: 'content' }),
                    headers: {
                      'Content-Type': 'application/json',
                    },
                  }
                );
                if (response.status !== 200) {
                  throw new Error(`Unexpected response status: ${response.status}`);
                }
                const payload = { raw: await response.text() };
                const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
                log.debug('invoke response payload %s', payload.raw);
                return { duration, payload };
              },
              test: ({ invocationsData, testConfig }) => {
                for (const { trace, request, response } of invocationsData) {
                  const { tags } = trace.spans[0];

                  expect(tags.aws.lambda.eventSource).to.equal('aws.apigateway');
                  expect(tags.aws.lambda.eventType).to.equal('aws.apigatewayv2.http.v2');

                  expect(tags.aws.lambda.apiGateway).to.have.property('accountId');
                  expect(tags.aws.lambda.apiGateway.apiId).to.equal(testConfig.apiId);
                  expect(tags.aws.lambda.apiGateway.apiStage).to.equal('$default');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('id');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('timeEpoch');
                  expect(tags.aws.lambda.http).to.have.property('host');
                  expect(tags.aws.lambda.apiGateway.request).to.have.property('headers');
                  expect(tags.aws.lambda.http.method).to.equal('POST');
                  expect(tags.aws.lambda.http.path).to.equal('/test');

                  expect(tags.aws.lambda.http.statusCode.toString()).to.equal('200');

                  expect(JSON.parse(request.data.requestData)).to.have.property('rawPath');
                  expect(response.data.responseData).to.equal('"ok"');
                }
              },
            },
          ],
        ]),
      },
    ],
    [
      'http-requester',
      {
        variants: new Map([
          [
            'http',
            {
              test: ({ invocationsData }) => {
                for (const [, trace] of invocationsData.map((data) => data.trace).entries()) {
                  const httpRequestSpan = trace.spans[trace.spans.length - 1];

                  expect(httpRequestSpan.name).to.equal('node.http.request');

                  const { tags } = httpRequestSpan;
                  expect(tags.http.method).to.equal('GET');
                  expect(tags.http.protocol).to.equal('HTTP/1.1');
                  expect(tags.http.host).to.equal('localhost:3177');
                  expect(tags.http.path).to.equal('/');
                  expect(tags.http.query).to.equal('foo=bar');
                  expect(tags.http.statusCode.toString()).to.equal('200');
                }
              },
            },
          ],
          [
            'https',
            {
              hooks: {
                afterCreate: async function self(testConfig) {
                  const urlEndpointLambdaName =
                    (testConfig.urlEndpointLambdaName = `${testConfig.configuration.FunctionName}-endpoint`);
                  try {
                    await awsRequest(Lambda, 'createFunction', {
                      FunctionName: urlEndpointLambdaName,
                      Handler: 'api-endpoint.handler',
                      Role: coreConfig.roleArn,
                      Runtime: 'nodejs16.x',
                      Code: {
                        ZipFile: resolveFileZipBuffer(
                          path.resolve(fixturesDirname, 'api-endpoint.js')
                        ),
                      },
                      MemorySize: 1024,
                    });
                  } catch (error) {
                    if (
                      error.message.includes(
                        'The role defined for the function cannot be assumed by Lambda'
                      ) ||
                      error.message.includes('because the KMS key is invalid for CreateGrant')
                    ) {
                      // Occassional race condition issue on AWS side, retry
                      await self(testConfig);
                      return;
                    }
                    if (error.message.includes('Function already exist')) {
                      log.notice(
                        'Function %s already exists, deleting and re-creating',
                        testConfig.name
                      );
                      await awsRequest(Lambda, 'deleteFunction', {
                        FunctionName: urlEndpointLambdaName,
                      });
                      await self(testConfig);
                      return;
                    }
                    throw error;
                  }
                  await awsRequest(Lambda, 'createAlias', {
                    FunctionName: urlEndpointLambdaName,
                    FunctionVersion: '$LATEST',
                    Name: 'url',
                  });
                  const deferredFunctionUrl = (async () => {
                    try {
                      return (
                        await awsRequest(Lambda, 'createFunctionUrlConfig', {
                          AuthType: 'NONE',
                          FunctionName: urlEndpointLambdaName,
                          Qualifier: 'url',
                        })
                      ).FunctionUrl;
                    } catch (error) {
                      if (
                        error.message.includes('FunctionUrlConfig exists for this Lambda function')
                      ) {
                        return (
                          await awsRequest(Lambda, 'getFunctionUrlConfig', {
                            FunctionName: urlEndpointLambdaName,
                            Qualifier: 'url',
                          })
                        ).FunctionUrl;
                      }
                      throw error;
                    }
                  })();
                  await Promise.all([
                    deferredFunctionUrl,
                    awsRequest(Lambda, 'addPermission', {
                      FunctionName: urlEndpointLambdaName,
                      Qualifier: 'url',
                      FunctionUrlAuthType: 'NONE',
                      Principal: '*',
                      Action: 'lambda:InvokeFunctionUrl',
                      StatementId: 'public-function-url',
                    }),
                  ]);
                  testConfig.functionUrl = await deferredFunctionUrl;
                  let state;
                  do {
                    await wait(100);
                    ({
                      Configuration: { State: state },
                    } = await awsRequest(Lambda, 'getFunction', {
                      FunctionName: urlEndpointLambdaName,
                    }));
                  } while (state !== 'Active');
                },
                beforeDelete: async (testConfig) => {
                  await Promise.all([
                    awsRequest(Lambda, 'deleteFunctionUrlConfig', {
                      FunctionName: testConfig.urlEndpointLambdaName,
                      Qualifier: 'url',
                    }),
                    awsRequest(Lambda, 'deleteFunction', {
                      FunctionName: testConfig.urlEndpointLambdaName,
                    }),
                  ]);
                },
              },
              invokePayload: (testConfig) => {
                return { url: `${testConfig.functionUrl}?foo=bar` };
              },
              test: ({ invocationsData, testConfig: { functionUrl } }) => {
                for (const [, trace] of invocationsData.map((data) => data.trace).entries()) {
                  const httpRequestSpan = trace.spans[trace.spans.length - 1];

                  expect(httpRequestSpan.name).to.equal('node.https.request');

                  const { tags } = httpRequestSpan;
                  expect(tags.http.method).to.equal('GET');
                  expect(tags.http.protocol).to.equal('HTTP/1.1');
                  expect(tags.http.host).to.equal(functionUrl.slice('https://'.length, -1));
                  expect(tags.http.path).to.equal('/');
                  expect(tags.http.query).to.equal('foo=bar');
                  expect(tags.http.statusCode.toString()).to.equal('200');
                }
              },
            },
          ],
        ]),
      },
    ],
    ['aws-sdk-v2', { test: testAwsSdk }],
    ['aws-sdk-v3', { test: testAwsSdk }],
    [
      'express',
      {
        hooks: {
          afterCreate: getCreateHttpApi('2.0'),
          beforeDelete: async (testConfig) => {
            await awsRequest(ApiGatewayV2, 'deleteApi', { ApiId: testConfig.apiId });
          },
        },
        invoke: async (testConfig) => {
          const startTime = process.hrtime.bigint();
          const response = await fetch(
            `https://${testConfig.apiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/test`,
            {
              method: 'POST',
              body: JSON.stringify({ some: 'content' }),
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );
          if (response.status !== 200) {
            throw new Error(`Unexpected response status: ${response.status}`);
          }
          const payload = { raw: await response.text() };
          const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
          log.debug('invoke response payload %s', payload.raw);
          return { duration, payload };
        },
        test: ({ invocationsData, testConfig }) => {
          for (const [index, { trace, request, response }] of invocationsData.entries()) {
            const { tags: lambdaTags } = trace.spans[0];

            expect(lambdaTags.aws.lambda.eventSource).to.equal('aws.apigateway');
            expect(lambdaTags.aws.lambda.eventType).to.equal('aws.apigatewayv2.http.v2');

            expect(lambdaTags.aws.lambda.apiGateway).to.have.property('accountId');
            expect(lambdaTags.aws.lambda.apiGateway.apiId).to.equal(testConfig.apiId);
            expect(lambdaTags.aws.lambda.apiGateway.apiStage).to.equal('$default');
            expect(lambdaTags.aws.lambda.apiGateway.request).to.have.property('id');
            expect(lambdaTags.aws.lambda.apiGateway.request).to.have.property('timeEpoch');
            expect(lambdaTags.aws.lambda.http).to.have.property('host');
            expect(lambdaTags.aws.lambda.apiGateway.request).to.have.property('headers');
            expect(lambdaTags.aws.lambda.http.method).to.equal('POST');
            expect(lambdaTags.aws.lambda.http.path).to.equal('/test');

            expect(lambdaTags.aws.lambda.http.statusCode.toString()).to.equal('200');

            expect(JSON.parse(request.data.requestData)).to.have.property('rawPath');
            expect(response.data.responseData).to.equal('"ok"');

            const expressSpan = trace.spans[3 - index];
            const expressTags = expressSpan.tags;
            expect(expressTags.express.method).to.equal('POST');
            expect(expressTags.express.path).to.equal('/test');
            expect(expressTags.express.statusCode).to.equal(200);

            const middlewareSpans = trace.spans.slice(4 - index, -1);
            expect(middlewareSpans.map(({ name }) => name)).to.deep.equal([
              'express.middleware.query',
              'express.middleware.expressinit',
              'express.middleware.jsonparser',
              'express.middleware.router',
            ]);
            for (const middlewareSpan of middlewareSpans) {
              expect(String(middlewareSpan.parentSpanId)).to.equal(String(expressSpan.id));
            }
            const routerSpan = trace.spans[7 - index];
            const routeSpan = trace.spans[8 - index];
            expect(routeSpan.name).to.equal('express.middleware.route.post.anonymous');
            expect(String(routeSpan.parentSpanId)).to.equal(String(routerSpan.id));
          }
        },
      },
    ],
  ]);

  const testVariantsConfig = resolveTestVariantsConfig(useCasesConfig);

  before(async () => {
    await createCoreResources(coreConfig);
    for (const testConfig of testVariantsConfig) {
      testConfig.deferredResult = processFunction(testConfig, coreConfig).catch((error) => ({
        // As we process result promises sequentially step by step in next turn, allowing them to
        // reject will generate unhandled rejection.
        // Therefore this scenario is converted to successuful { error } resolution
        error,
      }));
    }
  });

  for (const testConfig of testVariantsConfig) {
    it(testConfig.name, async () => {
      const testResult = await testConfig.deferredResult;
      if (testResult.error) throw testResult.error;
      log.debug('%s test result: %o', testConfig.name, testResult);
      const { expectedOutcome } = testConfig;
      const { invocationsData } = testResult;
      if (expectedOutcome === 'success' || expectedOutcome === 'error:handled') {
        if (expectedOutcome === 'success' && !testConfig.isAsyncInvocation) {
          for (const { responsePayload } of invocationsData) {
            expect(responsePayload.raw).to.equal('"ok"');
          }
        }
        for (const [index, { trace }] of invocationsData.entries()) {
          const awsLambdaSpan = trace.spans[0];
          if (index === 0) {
            expect(trace.spans.map(({ name }) => name).slice(0, 3)).to.deep.equal([
              'aws.lambda',
              'aws.lambda.initialization',
              'aws.lambda.invocation',
            ]);
            expect(awsLambdaSpan.tags.aws.lambda.isColdstart).to.be.true;
          } else {
            expect(trace.spans.map(({ name }) => name).slice(0, 2)).to.deep.equal([
              'aws.lambda',
              'aws.lambda.invocation',
            ]);
            expect(awsLambdaSpan.tags.aws.lambda.isColdstart).to.be.false;
          }
          expect(trace.slsTags).to.deep.equal({
            orgId: process.env.SLS_ORG_ID,
            service: testConfig.configuration.FunctionName,
            sdk: { name: pkgJson.name, version: pkgJson.version },
          });
          expect(awsLambdaSpan.tags.aws.lambda).to.have.property('arch');
          expect(awsLambdaSpan.tags.aws.lambda.name).to.equal(
            testConfig.configuration.FunctionName
          );
          expect(awsLambdaSpan.tags.aws.lambda).to.have.property('requestId');
          expect(awsLambdaSpan.tags.aws.lambda).to.have.property('version');
          if (expectedOutcome === 'success') {
            expect(awsLambdaSpan.tags.aws.lambda.outcome).to.equal(1);
          } else {
            expect(awsLambdaSpan.tags.aws.lambda.outcome).to.equal(5);
            expect(awsLambdaSpan.tags.aws.lambda).to.have.property('errorExceptionMessage');
            expect(awsLambdaSpan.tags.aws.lambda).to.have.property('errorExceptionStacktrace');
          }
        }
      }
      if (testConfig.test) {
        testConfig.test({ invocationsData, testConfig });
      }
    });
  }

  after(async () => cleanup({ mode: 'core' }));
});
