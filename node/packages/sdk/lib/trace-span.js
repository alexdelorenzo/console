'use strict';

const ensureString = require('type/string/ensure');
const ensureBigInt = require('type/big-int/ensure');
const ensureIterable = require('type/iterable/ensure');
const isObject = require('type/object/is');
const ensurePlainObject = require('type/plain-object/ensure');
const ensurePlainFunction = require('type/plain-function/ensure');
const d = require('d');
const lazy = require('d/lazy');
const { AsyncLocalStorage } = require('async_hooks');
const ensureSpanName = require('./get-ensure-resource-name')('INVALID_TRACE_SPAN_NAME');
const emitter = require('./emitter');
const Tags = require('./tags');
const toLong = require('./to-long');
const generateId = require('./generate-id');
const resolveEpochTimestampString = require('./resolve-epoch-timestamp-string');

const toProtobufEpochTimestamp = (uptimeTimestamp) =>
  toLong(resolveEpochTimestampString(uptimeTimestamp));

const resolvePorotbufValue = (key, value) => {
  switch (key) {
    // enum cases
    case 'aws.lambda.outcome':
      switch (value) {
        case 'success':
          return 1;
        case 'error:handled':
          return 5;
        default:
          // Will error in tests
          return null;
      }
    default:
      if (Array.isArray(value)) {
        if (typeof value[0] === 'number') return value.map(toLong);
        return value;
      }
      return typeof value === 'number' ? toLong(value) : value;
  }
};

const snakeToCamelCase = (string) =>
  string.replace(/_(.)/g, (ignore, letter) => letter.toUpperCase());

class StringifiableSet extends Set {
  toJSON() {
    return Array.from(this);
  }
}

const asyncLocalStorage = new AsyncLocalStorage();

let rootSpan;

class TraceSpan {
  static resolveCurrentSpan() {
    return asyncLocalStorage.getStore() || rootSpan || null;
  }

  constructor(name, options = {}) {
    const defaultStartTime = process.hrtime.bigint();
    const startTime = ensureBigInt(options.startTime, { isOptional: true });
    if (startTime) {
      if (startTime > defaultStartTime) {
        throw Object.assign(
          new Error('Cannot intialize span: Start time cannot be set in the future'),
          { code: 'FUTURE_SPAN_START_TIME' }
        );
      }
    }
    this.startTime = startTime || defaultStartTime;
    this.name = ensureSpanName(name);

    const immediateDescendants = ensureIterable(options.immediateDescendants, {
      isOptional: true,
      ensureItem: ensureSpanName,
    });
    this._onCloseByRoot = ensurePlainFunction(options.onCloseByRoot, {
      isOptional: true,
      name: 'options.onCloseByRoot',
    });
    const tags = ensurePlainObject(options.tags, {
      isOptional: true,
      name: 'options.tags',
    });
    if (tags) this.tags.setMany(tags);
    if (options.input != null) this.input = options.input;
    if (options.output != null) this.output = options.output;
    if (!rootSpan) {
      rootSpan = this;
      this.parentSpan = null;
    } else {
      if (rootSpan.endTime) {
        throw Object.assign(new Error('Cannot intialize span: Trace is closed'), {
          code: 'UNREACHABLE_TRACE',
        });
      }
      this.parentSpan = TraceSpan.resolveCurrentSpan();
      while (this.parentSpan.endTime) this.parentSpan = this.parentSpan.parentSpan || rootSpan;
    }

    asyncLocalStorage.enterWith(this);

    if (this.parentSpan) this.parentSpan.subSpans.add(this);
    emitter.emit('trace-span-open', this);
    if (immediateDescendants && immediateDescendants.length) {
      // eslint-disable-next-line no-new
      new TraceSpan(immediateDescendants.shift(), {
        startTime: this.startTime,
        immediateDescendants,
      });
    }
  }
  closeContext() {
    if (asyncLocalStorage.getStore() !== this) return;
    if (this === rootSpan) {
      asyncLocalStorage.enterWith(this);
      return;
    }
    const openParentSpan = (function self(span) {
      if (!span.endTime) return span;
      return span.parentSpan ? self(span.parentSpan) : rootSpan;
    })(this.parentSpan);
    asyncLocalStorage.enterWith(openParentSpan);
  }
  close(options = {}) {
    const defaultEndTime = process.hrtime.bigint();
    if (this.endTime) {
      throw Object.assign(new Error('Cannot close span: Span already closed'), {
        code: 'CLOSURE_ON_CLOSED_SPAN',
      });
    }
    if (!isObject(options)) options = {};
    const targetEndTime = ensureBigInt(options.endTime, { isOptional: true });
    if (targetEndTime) {
      if (targetEndTime < this.startTime) {
        throw Object.assign(
          new Error('Cannot close span: End time cannot be earlier than start time'),
          { code: 'PAST_SPAN_END_TIME' }
        );
      }
      if (targetEndTime > defaultEndTime) {
        throw Object.assign(new Error('Cannot close span: End time cannot be set in the future'), {
          code: 'FUTURE_SPAN_END_TIME',
        });
      }
    }
    this.endTime = targetEndTime || defaultEndTime;
    if (this === rootSpan) {
      const leftoverSpans = [];
      for (const subSpan of this.spans) {
        if (subSpan.endTime) continue;
        if (subSpan._onCloseByRoot) subSpan._onCloseByRoot();
        if (subSpan.endTime) continue;
        leftoverSpans.push(subSpan.close({ endTime: this.endTime }));
      }
      if (leftoverSpans.length) {
        process.stderr.write(
          "Serverless SDK Warning: Following trace spans didn't end before end of " +
            `lambda invocation: ${leftoverSpans.map(({ name }) => name).join(', ')}\n`
        );
      }
      asyncLocalStorage.enterWith(this);
    } else {
      this.closeContext();
    }
    emitter.emit('trace-span-close', this);
    return this;
  }
  destroy() {
    this.closeContext();
    if (this.parentSpan) this.parentSpan.subSpans.delete(this);
    this.parentSpan = null;
  }
  toJSON() {
    return {
      traceId: this.traceId,
      id: this.id,
      name: this.name,
      startTime: resolveEpochTimestampString(this.startTime),
      endTime: this.endTime && resolveEpochTimestampString(this.endTime),
      input: this.input || undefined,
      output: this.output || undefined,
      tags: Object.fromEntries(this.tags),
    };
  }
  toProtobufObject() {
    const tags = {};
    for (const [key, value] of this.tags) {
      let context = tags;
      const keyTokens = key.split('.').map((token) => snakeToCamelCase(token));
      const lastToken = keyTokens.pop();
      for (const token of keyTokens) {
        if (!context[token]) context[token] = {};
        context = context[token];
      }
      context[lastToken] = resolvePorotbufValue(key, value);
    }
    return {
      id: Buffer.from(this.id),
      traceId: Buffer.from(this.traceId),
      parentSpanId: this.parentSpan ? Buffer.from(this.parentSpan.id) : undefined,
      name: this.name,
      startTimeUnixNano: toProtobufEpochTimestamp(this.startTime),
      endTimeUnixNano: this.endTime ? toProtobufEpochTimestamp(this.endTime) : undefined,
      input: this.input || undefined,
      output: this.output || undefined,
      tags,
    };
  }
  get spans() {
    return new StringifiableSet([
      this,
      ...Array.from(this.subSpans, (subSpan) => Array.from(subSpan.spans)).flat(Infinity),
    ]);
  }
  get input() {
    return this._input || null;
  }
  set input(body) {
    if (body == null) delete this._input;
    else this._input = ensureString(body);
  }
  get output() {
    return this._output || null;
  }
  set output(body) {
    if (body == null) delete this._output;
    else this._output = ensureString(body);
  }
}

TraceSpan._toProtobufEpochTimestamp = toProtobufEpochTimestamp;

Object.defineProperties(
  TraceSpan.prototype,
  lazy({
    traceId: d(function () {
      return this.parentSpan ? this.parentSpan.traceId : generateId();
    }),
    id: d(() => generateId()),
    subSpans: d(() => new Set()),
    tags: d(() => new Tags()),
  })
);

module.exports = TraceSpan;