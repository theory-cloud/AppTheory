'use strict';

// CloudFront Functions executor harness. It runs the exact FunctionCode string
// from the cloud assembly inside a fresh Node vm context per case. The host
// side (Go) sends {runtime, code, timeoutMs, cases:[{event}]} on stdin and
// receives {results:[...]} on stdout.
const vm = require('vm');
const fs = require('fs');
const nodeCrypto = require('crypto');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const runtime2 = input.runtime === 'cloudfront-js-2.0';
const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 1000;

const results = [];
async function main() {
  for (const item of input.cases) {
    results.push(await runCase(item.event));
  }
  process.stdout.write(JSON.stringify({ results }));
}

async function runCase(event) {
  const logs = [];
  try {
    if (!event || !event.request || !event.context || !event.context.eventType) {
      throw cfError('invalid-event', 'the event has no request or context.eventType');
    }
    const context = createContext(logs);
    // CloudFront Functions runs in strict mode. The directive is the runtime's
    // prologue; the FunctionCode body itself is not rewritten.
    const script = new vm.Script('"use strict";\n' + prepareCode(input.code, runtime2), { filename: 'cloudfront-function.js' });
    script.runInContext(context, { timeout: timeoutMs });

    const handler = context.handler;
    if (typeof handler !== 'function') {
      throw cfError('invalid-function', 'the function code does not define handler(event)');
    }

    context.__cfEventJSON = JSON.stringify(event);
    const eventObject = vm.runInContext('JSON.parse(__cfEventJSON)', context);
    delete context.__cfEventJSON;
    context.__cfEventObject = eventObject;
    const call = new vm.Script('handler(__cfEventObject)', { filename: 'cloudfront-invoke.js' });
    let returned = call.runInContext(context, { timeout: timeoutMs });
    // Runtime 2.0 supports an async handler because the key value store
    // helpers return promises. The vm timeout does not cover promise waits, so
    // the wait races the function timeout.
    if (runtime2 && returned && typeof returned.then === 'function') {
      returned = await promiseWithTimeout(returned, timeoutMs);
    }
    delete context.__cfEventObject;

    const validated = validateReturn(event, returned);
    return { ok: true, kind: validated.kind, ...validated.value, logs };
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    const code = error && error.cfCode ? error.cfCode : 'function-error';
    const stack = error && error.stack ? String(error.stack) : undefined;
    return { ok: false, error: { code, message, stack }, logs };
  }
}

function promiseWithTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(cfError('timeout', 'the CloudFront function did not finish within the timeout')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runtime 2.0 code is an ES module. CloudFront documents importing the
// cloudfront module and Node's crypto module; the vm harness has no module
// loader, so those two documented imports become the require() bindings the
// sandbox exposes. Every other import is left untouched and fails as it would
// on CloudFront.
function prepareCode(code, runtime2) {
  if (!runtime2) {
    return code;
  }
  return code
    .replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]cloudfront['"]\s*;?/gm,
      'const $1 = require("cloudfront");')
    .replace(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]cloudfront['"]\s*;?/gm,
      'const $1 = require("cloudfront");')
    .replace(/^\s*import\s*\{([^}]*)\}\s*from\s+['"]crypto['"]\s*;?/gm,
      'const {$1} = require("crypto");');
}

function cfError(code, message) {
  const error = new Error(message);
  error.cfCode = code;
  return error;
}

function validateReturn(event, returned) {
  if (returned && typeof returned.then === 'function') {
    throw cfError('invalid-return', 'CloudFront Functions must return the request or response object synchronously, not a Promise');
  }
  const eventType = event.context.eventType;
  if (eventType === 'viewer-request') {
    if (isResponse(returned) && isRequest(returned)) {
      throw cfError('invalid-return', 'the returned object looks like both a request and a response');
    }
    if (isResponse(returned)) {
      return { kind: 'response', value: { response: normalizeResponse(returned, event) } };
    }
    if (isRequest(returned)) {
      return { kind: 'request', value: { request: normalizeRequest(returned, event) } };
    }
    throw cfError('invalid-return', 'viewer-request must return a request or response object');
  }
  if (eventType === 'viewer-response') {
    if (isRequest(returned)) {
      throw cfError('invalid-return', 'viewer-response must return a response object, not a request');
    }
    if (!isResponse(returned)) {
      throw cfError('invalid-return', 'viewer-response must return a response object');
    }
    return { kind: 'response', value: { response: normalizeResponse(returned, event) } };
  }
  throw cfError('invalid-event', `unsupported event type ${eventType}`);
}

function isRequest(value) {
  return isPlainObject(value) && typeof value.method === 'string' && typeof value.uri === 'string';
}

function isResponse(value) {
  return isPlainObject(value) && typeof value.statusCode === 'number';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequest(request, event) {
  assertKeys(request, ['method', 'uri', 'querystring', 'headers', 'cookies'], 'request');
  for (const field of ['querystring', 'headers', 'cookies']) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      throw cfError('invalid-return', `request object is missing ${field}`);
    }
  }
  if (request.method !== event.request.method) {
    throw cfError('read-only-method', 'request.method is read-only');
  }
  if (typeof request.uri !== 'string' || !request.uri.startsWith('/')) {
    throw cfError('invalid-request', 'request.uri must be a string that begins with /');
  }
  const originals = event.request;
  const headers = normalizeHeaders(request.headers, 'request', originals.headers);
  if (Object.prototype.hasOwnProperty.call(headers, 'set-cookie')) {
    throw cfError('forbidden-header', 'a viewer-request function cannot add a Set-Cookie header; use the cookies object');
  }
  return {
    method: request.method,
    uri: request.uri,
    querystring: normalizeQuery(request.querystring, originals.querystring),
    headers,
    cookies: normalizeRequestCookies(request.cookies, originals.cookies),
  };
}

function normalizeResponse(response, event) {
  assertKeys(response, ['statusCode', 'statusDescription', 'headers', 'cookies', 'body'], 'response');
  if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
    throw cfError('invalid-response', 'response.statusCode must be an integer between 100 and 599');
  }
  if (response.statusDescription !== undefined && typeof response.statusDescription !== 'string') {
    throw cfError('invalid-response', 'response.statusDescription must be a string');
  }
  const originals = event.response || {};
  const headers = normalizeHeaders(response.headers, 'response', originals.headers);
  if (Object.prototype.hasOwnProperty.call(headers, 'set-cookie')) {
    throw cfError('forbidden-header', 'a response cannot carry Set-Cookie in headers; use the cookies object');
  }
  const normalized = {
    statusCode: response.statusCode,
    headers,
    cookies: normalizeResponseCookies(response.cookies, originals.cookies),
  };
  if (response.statusDescription !== undefined) {
    normalized.statusDescription = response.statusDescription;
  }
  const body = normalizeBody(response.body);
  if (body !== undefined) {
    normalized.body = body;
  }
  return normalized;
}

function assertKeys(value, allowed, context) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw cfError('invalid-return', `${context} object has an unknown field ${key}`);
    }
  }
}

function normalizeHeaders(headers, context, originals) {
  if (headers === undefined || headers === null) {
    return {};
  }
  if (!isPlainObject(headers)) {
    throw cfError('invalid-return', `${context} headers must be an object`);
  }
  const source = isPlainObject(originals) ? originals : {};
  const normalized = {};
  for (const name of Object.keys(headers)) {
    const lower = String(name).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(normalized, lower)) {
      throw cfError('invalid-return', `header ${name} appears more than once after lower-casing`);
    }
    const value = normalizeValue(headers[name], `header ${name}`, source[lower]);
    if (value !== undefined) {
      normalized[lower] = value;
    }
  }
  return normalized;
}

// CloudFront documents how a modified query string, header or cookie that has a
// multiValue array is applied: a modified multiValue array wins and value's
// first element is ignored; otherwise a modified value wins and the remaining
// multiValue entries are unchanged. See "Duplicate query strings, headers, and
// cookies (multiValue array)" in the CloudFront Functions event structure:
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html#functions-event-structure-multivalue
// The returned field is compared with the event input so an unmodified
// multiValue array does not mask an edit to value.
function normalizeValue(value, context, original) {
  if (!isPlainObject(value) || typeof value.value !== 'string') {
    throw cfError('invalid-return', `${context} must be an object with a string value`);
  }
  const normalized = { value: value.value };
  let multiValue;
  if (value.multiValue !== undefined) {
    if (!Array.isArray(value.multiValue)) {
      throw cfError('invalid-return', `${context}.multiValue must be an array`);
    }
    multiValue = value.multiValue.map((entry, index) => {
      if (!isPlainObject(entry) || typeof entry.value !== 'string') {
        throw cfError('invalid-return', `${context}.multiValue[${index}] must have a string value`);
      }
      return { value: entry.value };
    });
  }
  const originalMulti = originalMultiValue(original);
  if (multiValue !== undefined && !sameHeaderValues(multiValue, originalMulti)) {
    if (multiValue.length === 0) {
      return undefined;
    }
    normalized.multiValue = multiValue;
    normalized.value = multiValue[0].value;
    return normalized;
  }
  if (originalMulti !== undefined && originalMulti.length > 1) {
    normalized.multiValue = [{ value: normalized.value }].concat(originalMulti.slice(1));
  }
  return normalized;
}

function normalizeQuery(query, original) {
  if (query === undefined || query === null) {
    return {};
  }
  if (typeof query === 'string') {
    return query;
  }
  if (!isPlainObject(query)) {
    throw cfError('invalid-return', 'request.querystring must be an object or a string');
  }
  const originals = isPlainObject(original) ? original : {};
  const normalized = {};
  for (const name of Object.keys(query)) {
    const value = normalizeValue(query[name], `querystring ${name}`, originals[name]);
    if (value !== undefined) {
      normalized[name] = value;
    }
  }
  return normalized;
}

function normalizeRequestCookies(cookies, original) {
  if (cookies === undefined || cookies === null) {
    return {};
  }
  if (!isPlainObject(cookies)) {
    throw cfError('invalid-return', 'request.cookies must be an object');
  }
  const originals = isPlainObject(original) ? original : {};
  const normalized = {};
  for (const name of Object.keys(cookies)) {
    const value = normalizeValue(cookies[name], `cookie ${name}`, originals[name]);
    if (value !== undefined) {
      normalized[name] = value;
    }
  }
  return normalized;
}

function normalizeResponseCookies(cookies, original) {
  if (cookies === undefined || cookies === null) {
    return {};
  }
  if (!isPlainObject(cookies)) {
    throw cfError('invalid-return', 'response.cookies must be an object');
  }
  const originals = isPlainObject(original) ? original : {};
  const normalized = {};
  for (const name of Object.keys(cookies)) {
    const value = normalizeCookieValue(cookies[name], `cookie ${name}`, originals[name]);
    if (value !== undefined) {
      normalized[name] = value;
    }
  }
  return normalized;
}

function normalizeCookieValue(value, context, original) {
  if (!isPlainObject(value) || typeof value.value !== 'string') {
    throw cfError('invalid-return', `${context} must be an object with a string value`);
  }
  const normalized = { value: value.value };
  if (value.attributes !== undefined) {
    if (typeof value.attributes !== 'string') {
      throw cfError('invalid-return', `${context}.attributes must be a string`);
    }
    normalized.attributes = value.attributes;
  }
  let multiValue;
  if (value.multiValue !== undefined) {
    if (!Array.isArray(value.multiValue)) {
      throw cfError('invalid-return', `${context}.multiValue must be an array`);
    }
    multiValue = value.multiValue.map((entry, index) => {
      const child = normalizeCookieValue(entry, `${context}.multiValue[${index}]`);
      if (child === undefined) {
        throw cfError('invalid-return', `${context}.multiValue[${index}] must have a value`);
      }
      return child;
    });
  }
  const originalMulti = originalMultiValue(original);
  if (multiValue !== undefined && !sameCookieValues(multiValue, originalMulti)) {
    if (multiValue.length === 0) {
      return undefined;
    }
    normalized.multiValue = multiValue;
    normalized.value = multiValue[0].value;
    if (multiValue[0].attributes !== undefined) {
      normalized.attributes = multiValue[0].attributes;
    } else {
      delete normalized.attributes;
    }
    return normalized;
  }
  if (originalMulti !== undefined && originalMulti.length > 1) {
    if (normalized.attributes === undefined && isPlainObject(original) && typeof original.attributes === 'string') {
      normalized.attributes = original.attributes;
    }
    const first = { value: normalized.value };
    if (normalized.attributes !== undefined) {
      first.attributes = normalized.attributes;
    }
    normalized.multiValue = [first].concat(originalMulti.slice(1).map(copyCookie));
  }
  return normalized;
}

function originalMultiValue(original) {
  if (!isPlainObject(original) || !Array.isArray(original.multiValue)) {
    return undefined;
  }
  return original.multiValue;
}

function sameHeaderValues(left, right) {
  if (right === undefined || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index].value !== right[index].value) {
      return false;
    }
  }
  return true;
}

function sameCookieValues(left, right) {
  if (right === undefined || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index].value !== right[index].value) {
      return false;
    }
    const leftAttributes = left[index].attributes === undefined ? '' : left[index].attributes;
    const rightAttributes = right[index].attributes === undefined ? '' : right[index].attributes;
    if (leftAttributes !== rightAttributes) {
      return false;
    }
  }
  return true;
}

function copyCookie(entry) {
  const copy = { value: entry && typeof entry.value === 'string' ? entry.value : '' };
  if (entry && typeof entry.attributes === 'string') {
    copy.attributes = entry.attributes;
  }
  return copy;
}

function normalizeBody(body) {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return { encoding: 'text', data: body };
  }
  if (!isPlainObject(body) || typeof body.data !== 'string') {
    throw cfError('invalid-return', 'response.body must be a string or an object with data');
  }
  const encoding = body.encoding === undefined ? 'text' : body.encoding;
  if (encoding !== 'text' && encoding !== 'base64') {
    throw cfError('invalid-return', 'response.body.encoding must be text or base64');
  }
  return { encoding, data: body.data };
}

// createContext builds one fresh CloudFront Functions global environment.
function createContext(logs) {
  const sandbox = {};
  const context = vm.createContext(sandbox, {
    name: 'cloudfront-function',
    codeGeneration: { strings: false, wasm: false },
  });
  const bridges = {
    log(message) {
      logs.push(String(message));
    },
    now() {
      return Date.now();
    },
    hash(algorithm, chunks, keyBase64, encoding) {
      const allowed = ['md5', 'sha1', 'sha256'];
      if (!allowed.includes(String(algorithm))) {
        throw new Error(`crypto algorithm ${algorithm} is not supported`);
      }
      const target = keyBase64 === null
        ? nodeCrypto.createHash(String(algorithm))
        : nodeCrypto.createHmac(String(algorithm), Buffer.from(String(keyBase64), 'base64'));
      for (const chunk of chunks) {
        target.update(Buffer.from(String(chunk), 'base64'));
      }
      return target.digest(encoding ? String(encoding) : 'base64');
    },
    textToBase64(text, encoding) {
      return Buffer.from(String(text), String(encoding || 'utf8')).toString('base64');
    },
    base64ToText(base64, encoding) {
      return Buffer.from(String(base64), 'base64').toString(String(encoding || 'utf8'));
    },
    base64ToArray(base64) {
      return Array.from(Buffer.from(String(base64), 'base64'));
    },
    arrayToBase64(array) {
      return Buffer.from(array).toString('base64');
    },
  };
  sandbox.__cfRuntime = input.runtime;
  sandbox.__cfBridges = bridges;
  sandbox.__cfKVS = input.kvs || null;
  vm.runInContext(BOOTSTRAP, context, { filename: 'cloudfront-bootstrap.js' });
  return context;
}

const BOOTSTRAP = String.raw`
(function () {
  var B = __cfBridges;
  var runtime = __cfRuntime;
  delete globalThis.__cfBridges;
  delete globalThis.__cfRuntime;
  var runtime2 = runtime === 'cloudfront-js-2.0';

  // CloudFront Functions runs in strict mode and has no dynamic code
  // evaluation. vm's codeGeneration option enforces the latter; deleting the
  // globals also makes the restriction visible to ordinary code.
  delete globalThis.eval;
  delete globalThis.Function;
  delete globalThis.WebAssembly;
  delete globalThis.process;
  delete globalThis.global;
  delete globalThis.fetch;
  delete globalThis.XMLHttpRequest;
  delete globalThis.WebSocket;
  delete globalThis.setTimeout;
  delete globalThis.setInterval;
  delete globalThis.setImmediate;
  delete globalThis.clearTimeout;
  delete globalThis.clearInterval;
  delete globalThis.clearImmediate;
  delete globalThis.queueMicrotask;
  delete globalThis.structuredClone;
  delete globalThis.atob;
  delete globalThis.btoa;
  delete globalThis.URL;
  delete globalThis.URLSearchParams;

  var logBridge = B.log;
  globalThis.console = {
    log: function (message) {
      if (arguments.length !== 1) {
        throw new TypeError('console.log() accepts one string argument in CloudFront Functions');
      }
      if (typeof message !== 'string') {
        throw new TypeError('console.log() accepts a string in CloudFront Functions');
      }
      logBridge(message);
    }
  };

  // Date returns the function start time for every current-time query.
  var RealDate = Date;
  var fixedNow = B.now();
  function CFDate() {
    if (!(this instanceof CFDate)) {
      return new RealDate(fixedNow).toString();
    }
    var args = Array.prototype.slice.call(arguments);
    if (args.length === 0) {
      return new RealDate(fixedNow);
    }
    return Reflect.construct(RealDate, args);
  }
  CFDate.prototype = RealDate.prototype;
  CFDate.now = function () { return fixedNow; };
  CFDate.parse = RealDate.parse;
  CFDate.UTC = RealDate.UTC;
  globalThis.Date = CFDate;

  function toBase64(data) {
    if (typeof data === 'string') {
      return B.textToBase64(data, 'utf8');
    }
    if (data instanceof CFBuffer) {
      return B.arrayToBase64(Array.from(data));
    }
    throw new TypeError('crypto.update() accepts a string or Buffer');
  }

  function makeHash(algorithm) {
    var chunks = [];
    return {
      update: function (data) {
        chunks.push(toBase64(data));
        return this;
      },
      digest: function (encoding) {
        var result = B.hash(algorithm, chunks, null, encoding || 'base64');
        if (encoding) {
          return result;
        }
        if (runtime2) {
          return bufferFromBase64(result);
        }
        return B.base64ToText(result, 'binary');
      }
    };
  }

  function makeHmac(algorithm, key) {
    var chunks = [];
    var keyBase64 = toBase64(key);
    return {
      update: function (data) {
        chunks.push(toBase64(data));
        return this;
      },
      digest: function (encoding) {
        var result = B.hash(algorithm, chunks, keyBase64, encoding || 'base64');
        if (encoding) {
          return result;
        }
        if (runtime2) {
          return bufferFromBase64(result);
        }
        return B.base64ToText(result, 'binary');
      }
    };
  }

  var cryptoModule = {
    createHash: function (algorithm) { return makeHash(algorithm); },
    createHmac: function (algorithm, key) { return makeHmac(algorithm, key); }
  };

  function querystringEscape(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function querystringParse(text, separator, equals, options) {
    separator = separator === undefined ? '&' : separator;
    equals = equals === undefined ? '=' : equals;
    var decode = options && options.decodeURIComponent ? options.decodeURIComponent : function (value) {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    };
    var maxKeys = options && typeof options.maxKeys === 'number' ? options.maxKeys : 1000;
    var result = {};
    if (typeof text !== 'string' || text.length === 0) {
      return result;
    }
    var parts = separator === '' ? text.split('') : text.split(separator);
    var count = 0;
    for (var index = 0; index < parts.length; index++) {
      if (maxKeys > 0 && count >= maxKeys) {
        break;
      }
      var part = parts[index];
      var splitAt = part.indexOf(equals);
      var key;
      var value;
      if (splitAt >= 0) {
        key = part.slice(0, splitAt);
        value = part.slice(splitAt + equals.length);
      } else {
        key = part;
        value = '';
      }
      try {
        key = decode(key);
        value = decode(value);
      } catch (error) {
        continue;
      }
      count++;
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        if (Array.isArray(result[key])) {
          result[key].push(value);
        } else {
          result[key] = [result[key], value];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  function querystringStringify(object, separator, equals, options) {
    separator = separator === undefined ? '&' : separator;
    equals = equals === undefined ? '=' : equals;
    var encode = options && options.encodeURIComponent ? options.encodeURIComponent : querystringEscape;
    var pairs = [];
    if (!object || typeof object !== 'object') {
      return '';
    }
    for (var key of Object.keys(object)) {
      var value = object[key];
      if (Array.isArray(value)) {
        for (var index = 0; index < value.length; index++) {
          pairs.push(encode(key) + equals + encode(value[index] === undefined ? '' : value[index]));
        }
      } else {
        pairs.push(encode(key) + equals + encode(value === undefined ? '' : value));
      }
    }
    return pairs.join(separator);
  }

  var querystringModule = {
    escape: querystringEscape,
    unescape: function (value) { return decodeURIComponent(String(value)); },
    parse: querystringParse,
    decode: querystringParse,
    stringify: querystringStringify,
    encode: querystringStringify
  };

  // Minimal Buffer surface for runtime 2.0. It is a Uint8Array subclass with
  // the methods CloudFront documents; string conversion goes through the host
  // bridge so encodings match Node.
  function bufferFromArray(array) {
    return new CFBuffer(array);
  }
  function bufferFromBase64(base64) {
    return new CFBuffer(B.base64ToArray(base64));
  }
  class CFBuffer extends Uint8Array {
    toString(encoding, start, end) {
      var slice = Array.from(this.subarray(start, end));
      return B.base64ToText(B.arrayToBase64(slice), encoding || 'utf8');
    }
    toJSON() {
      return { type: 'Buffer', data: Array.from(this) };
    }
    equals(other) {
      if (!other || this.length !== other.length) {
        return false;
      }
      for (var index = 0; index < this.length; index++) {
        if (this[index] !== other[index]) {
          return false;
        }
      }
      return true;
    }
    static from(value, encoding) {
      if (typeof value === 'string') {
        return bufferFromBase64(B.textToBase64(value, encoding || 'utf8'));
      }
      if (value instanceof CFBuffer) {
        return new CFBuffer(Array.from(value));
      }
      if (Array.isArray(value)) {
        return new CFBuffer(value);
      }
      if (value instanceof ArrayBuffer) {
        return new CFBuffer(Array.from(new Uint8Array(value)));
      }
      if (value && typeof value.length === 'number') {
        return new CFBuffer(Array.from(value));
      }
      throw new TypeError('Buffer.from() does not support this value');
    }
    static alloc(size, fill) {
      var buffer = new CFBuffer(size);
      if (fill !== undefined) {
        buffer.fill(typeof fill === 'number' ? fill : 0);
      }
      return buffer;
    }
    static concat(list, totalLength) {
      var length = 0;
      for (var index = 0; index < list.length; index++) {
        length += list[index].length;
      }
      if (typeof totalLength === 'number') {
        length = totalLength;
      }
      var out = CFBuffer.alloc(length);
      var offset = 0;
      for (var item of list) {
        out.set(item, offset);
        offset += item.length;
      }
      return out;
    }
    static byteLength(value, encoding) {
      return CFBuffer.from(value, encoding).length;
    }
    static isBuffer(value) {
      return value instanceof CFBuffer;
    }
  }
  if (runtime2) {
    globalThis.Buffer = CFBuffer;
  }

  function installTextCodec() {
    if (!runtime2) {
      return;
    }
    globalThis.TextEncoder = function TextEncoder() {};
    globalThis.TextEncoder.prototype.encode = function (value) {
      return new Uint8Array(B.base64ToArray(B.textToBase64(String(value), 'utf8')));
    };
    globalThis.TextEncoder.prototype.encodeInto = function (value, destination) {
      var bytes = this.encode(value);
      destination.set(bytes.subarray(0, destination.length));
      return { read: String(value).length, written: Math.min(bytes.length, destination.length) };
    };
    globalThis.TextDecoder = function TextDecoder(encoding, options) {
      this.encoding = encoding || 'utf-8';
      this.fatal = Boolean(options && options.fatal);
      this.ignoreBOM = Boolean(options && options.ignoreBOM);
    };
    globalThis.TextDecoder.prototype.decode = function (input) {
      var bytes = input === undefined ? [] : Array.from(input);
      return B.base64ToText(B.arrayToBase64(bytes), 'utf8');
    };
  }
  installTextCodec();

  var kvsStore = globalThis.__cfKVS || null;
  delete globalThis.__cfKVS;

  // CloudFront KeyValueStore helpers. "The get, exists and meta methods
  // return a promise." get() "will return an error when the key that you
  // requested doesn't exist" and accepts {format: 'string'|'json'|'bytes'}.
  // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-custom-methods.html
  function createKVSHandle(store) {
    var values = store.values || {};
    return {
      get: function (key, options) {
        return new Promise(function (resolve, reject) {
          if (!Object.prototype.hasOwnProperty.call(values, key)) {
            reject(new Error("CloudFront KeyValueStore: key '" + key + "' does not exist"));
            return;
          }
          var format = options && options.format ? String(options.format) : 'string';
          var value = values[key];
          if (format === 'json') {
            try {
              resolve(JSON.parse(value));
            } catch (error) {
              reject(error);
            }
            return;
          }
          if (format === 'bytes') {
            resolve(new Uint8Array(B.base64ToArray(B.textToBase64(value, 'utf8'))));
            return;
          }
          resolve(value);
        });
      },
      exists: function (key) {
        return Promise.resolve(Object.prototype.hasOwnProperty.call(values, key));
      },
      meta: function () {
        return Promise.resolve({
          creationDateTime: store.createdAt,
          lastUpdatedDateTime: store.updatedAt,
          keyCount: Object.keys(values).length
        });
      }
    };
  }

  var cloudfrontModule = {
    kvs: function () {
      if (!kvsStore) {
        throw new Error('CloudFront KeyValueStore is not available: the function has no KeyValueStoreAssociations');
      }
      return createKVSHandle(kvsStore);
    }
  };

  globalThis.require = function require(name) {
    switch (name) {
      case 'crypto':
        return cryptoModule;
      case 'querystring':
        return querystringModule;
      case 'buffer':
        if (runtime2) {
          return { Buffer: globalThis.Buffer };
        }
        break;
      case 'cloudfront':
        if (runtime2) {
          return cloudfrontModule;
        }
        break;
    }
    throw new Error("Cannot find module '" + name + "'");
  };
})();
`;

main();
