# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.4.0](https://github.com/serverless/console/compare/@serverless/sdk@0.3.1...@serverless/sdk@0.4.0) (2023-01-19)

### ⚠ BREAKING CHANGES

- Root (global) tags are no longer stored on the root span. Instead they're stored on SDK directly and are expected to be considered as trace-wide tags

### Bug Fixes

- Ensure not to crash on invalid `serverless.setTag` input ([c5f28ff](https://github.com/serverless/console/commit/c5f28ff552fc023c24819e24ec90a88ff00d4d73))
- Fix `expressApp` instrumentation endpoint ([11314b4](https://github.com/serverless/console/commit/11314b434b4d62f6e7dde25a9ca8a09e6f584fde))
- Warn instead of throw when SDK is used without initialization ([fe64a4f](https://github.com/serverless/console/commit/fe64a4f53529285e89a64f7d50ec9528a3c4ce57))

### Maintenance Improvements

- Enable customization of event data via private options ([a5e8f36](https://github.com/serverless/console/commit/a5e8f365ad8e4e700ffb31e47a1f9bd7bba2af2c))
- Store global tags on SDK directly (not on root span) ([9a72787](https://github.com/serverless/console/commit/9a727875ac4f694552d987a346473a09191104ce))

### [0.3.1](https://github.com/serverless/console/compare/@serverless/sdk@0.3.0...@serverless/sdk@0.3.1) (2023-01-13)

### Features

- `serverlessSdk.setTag` ([c546bcd](https://github.com/serverless/console/commit/c546bcd85bc8ee6d77926ad655c2696eea270ef1))
- Automatically resolve `.traceSpans.root` ([99eb5e2](https://github.com/serverless/console/commit/99eb5e2f20cd60c3e99c75d7e33e70845ef7f9b2))

## [0.3.0](https://github.com/serverless/console/compare/@serverless/sdk@0.2.4...@serverless/sdk@0.3.0) (2023-01-12)

### ⚠ BREAKING CHANGES

- `sdk.createTraceSpan` is removed. The functionality of creating custom spans is not considered part of public API at the time being (a new method for that will be introduced in one of the following releases)

### Features

- Make `createTraceSpan` private ([017ef10](https://github.com/serverless/console/commit/017ef109c1f6ad23adb6b020121b41a4ca539d35))
- Dedicated handling for structured warnings issued by the SDK ([1d38f5f](https://github.com/serverless/console/commit/1d38f5f59e435139ad7fac3c27f30e861cc3fdf2))
- Relax tag name format restriction ([414108f](https://github.com/serverless/console/commit/414108f57dbeb7189c000fb20bc0ac177e85bbfb))
- Log error instead of throwing on invalid capturedEvent user input ([b958948](https://github.com/serverless/console/commit/b958948fa7396a3e26a16606b2bcd98c652bb4fa))

### Maintenance Improvements

- Fixed typings file ([#369](https://github.com/serverless/console/issues/369)) ([2deeb4b](https://github.com/serverless/console/commit/2deeb4b49b196eadde6ca85fc87f7fb9c00f453c))
- Revert problematic TS addition ([ad88aab](https://github.com/serverless/console/commit/ad88aab5c2ff39429ddbe56804c34192e1b3b4d0))

### [0.2.4](https://github.com/serverless/console/compare/@serverless/sdk@0.2.3...@serverless/sdk@0.2.4) (2023-01-11)

### Features

- Support custom fingerprints ([b29b1e5](https://github.com/serverless/console/commit/b29b1e5bb430a8909dc77d536602b8986c904d3b))

### [0.2.3](https://github.com/serverless/console/compare/@serverless/sdk@0.2.2...@serverless/sdk@0.2.3) (2023-01-09)

### Bug Fixes

- Adjusted typescript implementation for sdk ([#360](https://github.com/serverless/console/issues/360)) ([e8a7066](https://github.com/serverless/console/commit/e8a7066b7c02833a00d38aa8b8456d0e26b417a9))

### [0.2.2](https://github.com/serverless/console/compare/@serverless/sdk@0.2.1...@serverless/sdk@0.2.2) (2023-01-09)

### Bug Fixes

- Ensure `_origin` on created events before they're emited ([#353](https://github.com/serverless/console/issues/353)) ([9c6bef2](https://github.com/serverless/console/commit/9c6bef28c57c41cb838ee0c95733809882f7150d))

### [0.2.1](https://github.com/serverless/console/compare/@serverless/sdk@0.2.0...@serverless/sdk@0.2.1) (2023-01-05)

### Features

- `serverless.captureWarning` utility ([f559a2e](https://github.com/serverless/console/commit/f559a2ed11301cdb6b7f9a9577ff22f804eac881))
- Instrument `console.error` ([0647848](https://github.com/serverless/console/commit/0647848572a0c5a8405fe29c289487bda2d476d5))
- Instrument `console.warn` ([9088bbe](https://github.com/serverless/console/commit/9088bbe1ba8e18649d0d5cce9867090275ef7a3f))

### Maintenance Improvements

- Differentiate events sourced from `console.*` calls ([bea40aa](https://github.com/serverless/console/commit/bea40aa8f7fd234c70f0b9e7e59c1c9b8304190a))
- Fix location of `createErrorCapturedEvent` module ([07210b1](https://github.com/serverless/console/commit/07210b121957658b6f854a82dd6a652e1401bcb3))
- Simplify `console.error` args handling ([8d3d254](https://github.com/serverless/console/commit/8d3d254a046b8ed65251526b11a994393c871257))

## [0.2.0](https://github.com/serverless/console/compare/@serverless/sdk@0.1.0...@serverless/sdk@0.2.0) (2022-12-22)

### ⚠ BREAKING CHANGES

- Remove resolution of `aws.lambda.outcome` tag enum. This needs to be done in the context of `aws-lambda-sdk`
- Trace span event emitter is generalized (to be not only Trace span specific) and relocated, it is accessible now at `_eventsEmitter` instead of `_traceSpanEmitter` property on SDK
- Trace span events are renamed from `open` to `trace-span-open` and `close` to `trace-span-close`

### Features

- `serverless.captureError` with internal `CapturedEvent` interface ([b808b8a](https://github.com/serverless/console/commit/b808b8aecb29e862a5b13365b2a6160f169a6cdd))
- Remove AWS specific logic ([2ab35d0](https://github.com/serverless/console/commit/2ab35d0961b59191acbc090df21c4c0ada736c04))

### Maintenance Improvements

- Exclude `resolveEpochTimestampString` ([284908c](https://github.com/serverless/console/commit/284908ced51271bafd81f23777dcf03e609330a8))
- Exclude `Tags` interface from `TraceSpan` context ([1cafe8b](https://github.com/serverless/console/commit/1cafe8b976fd67394cb25ea1f1e3ad6038586c1c))
- Exclude `toLong` utility ([8571198](https://github.com/serverless/console/commit/8571198206d8bb8a9523ef5b103b7353c815c78c))
- Fix typo in internal function name ([a1bd97c](https://github.com/serverless/console/commit/a1bd97c06d52f0faba99f93e81552fa5ca6f18c4))
- Generalize `ensureXName` logic ([e93607b](https://github.com/serverless/console/commit/e93607b91452fc5f4ad8f068c79755a2c90fe3dd))
- Generalize internal event emitter ([80c5961](https://github.com/serverless/console/commit/80c5961a981959f5fce060a9e882fd6c952b8ddf))
- Implement `tags.toJSON()` ([7d9fc1f](https://github.com/serverless/console/commit/7d9fc1f619c005a9e99628fa310a7d38a8af2d5c))
- Remove dead code ([14f3613](https://github.com/serverless/console/commit/14f3613c73788885f627f36be483b2ec574bd486))
- Seclude `generateId` utility ([e8842c7](https://github.com/serverless/console/commit/e8842c734714cb6c21b598b6d4f088f4769d5f5a))
- Seclude `toProtobufEpochTimestamp` ([e886a5e](https://github.com/serverless/console/commit/e886a5e88e2c6e2f8496d48df1d433cb4018b66b))
- Seclude `toProtobuTags` utility ([47f2598](https://github.com/serverless/console/commit/47f2598a8dd15a05cd8f3dc69964536c02f531a4))
- Simplify `traceSpan.startTime` validation ([60d62f6](https://github.com/serverless/console/commit/60d62f66daa5914066722686215ad09d40427af4))

### 0.1.0 (2022-12-15)

### Features

- Initial version (taken out from `@serverless/aws-lambda-sdk`) ([4a41a0a](https://github.com/serverless/console/commit/4a41a0af11996c8c8fb83ebdbe3d96fb243998c9))
