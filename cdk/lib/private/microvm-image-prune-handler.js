"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MICROVM_IMAGE_PRUNE_HANDLER_SOURCE = void 0;
/**
 * Self-contained Lambda handler for `AppTheoryMicrovmImage` version pruning.
 *
 * The handler source is embedded as a string constant so the construct can deploy
 * it as inline Lambda code from every jsii target (TypeScript, Python, Go) without
 * a bundling or asset step. It talks to the Lambda MicroVMs control plane
 * (`ListMicrovmImageVersions` / `DeleteMicrovmImageVersion`) with raw SigV4-signed
 * HTTPS requests and has no runtime dependencies beyond the Node standard library
 * and the platform `fetch` global.
 *
 * Request shapes below mirror the pinned `lambdamicrovms` AWS SDK v1.0.0
 * (aws-sdk-go-v2 service model, smithy REST-JSON protocol):
 *
 * - ListMicrovmImageVersions: GET /2025-09-09/microvm-images/{imageIdentifier}/versions
 *   with optional `maxResults` / `nextToken` query parameters; response body
 *   `{ "items": [...], "nextToken": "..." }`.
 * - DeleteMicrovmImageVersion: DELETE /2025-09-09/microvm-images/{imageIdentifier}/versions/{imageVersion}
 *   with an empty body; response body `{ "imageIdentifier": "...", "imageVersion": "...", "state": "..." }`.
 *
 * SigV4 signing name is `lambda` and the endpoint host is `lambda.{region}.amazonaws.com`,
 * both taken from the pinned SDK (service auth trait and endpoint ruleset).
 * Path parameters are escaped with the SDK's Amazon path-escape style (every byte
 * outside `A-Za-z0-9-._~` percent-encoded, including `/`).
 *
 * This module is internal to the CDK package and intentionally NOT exported from
 * `index.ts`, so it never appears in the jsii assembly or generated bindings. The
 * compiled `.js` is loaded directly by the construct and by the handler unit tests.
 *
 * @internal
 */
exports.MICROVM_IMAGE_PRUNE_HANDLER_SOURCE = `'use strict';

var crypto = require('node:crypto');

var SERVICE_NAME = 'lambda';
var API_PATH_PREFIX = '/2025-09-09/microvm-images';
var MAX_RESULTS = 100;
var EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function log(message) {
  console.log('[microvm-image-prune] ' + message);
}

function requiredEnv(name) {
  var value = process.env[name];
  if (!value) {
    throw new Error('microvm-image-prune: missing required environment variable ' + name);
  }
  return value;
}

function resolveRegion() {
  var region = process.env.APPTHEORY_MICROVM_IMAGE_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error('microvm-image-prune: unable to determine AWS region');
  }
  return region;
}

function credentials() {
  var accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  var secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('microvm-image-prune: AWS credentials are not available in the Lambda environment');
  }
  return {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN || ''
  };
}

function escapePathComponent(value) {
  // Mirrors the pinned SDK's Amazon path-escape style: every byte outside
  // A-Za-z0-9-._~ is percent-encoded (including '/'), uppercase hex.
  var out = '';
  for (var i = 0; i < value.length; i++) {
    var c = value.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 95 || c === 126) {
      out += value[i];
    } else {
      out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function escapeQuery(value) {
  // RFC 3986 percent-encoding for query names and values.
  var out = '';
  for (var i = 0; i < value.length; i++) {
    var c = value.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 95 || c === 126) {
      out += value[i];
    } else {
      out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function iso8601Basic(date) {
  return date.toISOString().replace(/[:-]/g, '').replace(/\\.\\d{3}/g, '');
}

function canonicalQuery(query) {
  if (!query) {
    return '';
  }
  var keys = Object.keys(query).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    var key = escapeQuery(keys[i]);
    var value = query[keys[i]];
    parts.push(key + '=' + escapeQuery(value === undefined || value === null ? '' : String(value)));
  }
  return parts.join('&');
}

function canonicalRequest(method, path, queryString, headers, payloadHash) {
  var names = Object.keys(headers).sort();
  var canonicalHeaders = '';
  var signedHeaders = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i].toLowerCase();
    canonicalHeaders += name + ':' + String(headers[names[i]]).trim() + '\\n';
    signedHeaders.push(name);
  }
  return [method, path, queryString, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\\n');
}

function signV4(options) {
  var amzDate = iso8601Basic(options.now);
  var dateStamp = amzDate.slice(0, 8);
  var signingHeaders = {
    'host': options.host,
    'x-amz-content-sha256': options.payloadHash,
    'x-amz-date': amzDate
  };
  if (options.credentials.sessionToken) {
    signingHeaders['x-amz-security-token'] = options.credentials.sessionToken;
  }
  var queryString = canonicalQuery(options.query);
  var canonical = canonicalRequest(options.method, options.path, queryString, signingHeaders, options.payloadHash);
  var scope = dateStamp + '/' + options.region + '/' + SERVICE_NAME + '/aws4_request';
  var stringToSign = 'AWS4-HMAC-SHA256\\n' + amzDate + '\\n' + scope + '\\n' + sha256Hex(canonical);
  var dateKey = hmacSha256('AWS4' + options.credentials.secretAccessKey, dateStamp);
  var regionKey = hmacSha256(dateKey, options.region);
  var serviceKey = hmacSha256(regionKey, SERVICE_NAME);
  var signingKey = hmacSha256(serviceKey, 'aws4_request');
  var signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  var signedHeaders = Object.keys(signingHeaders).sort().join(';');
  return {
    headers: Object.assign({}, signingHeaders, {
      authorization: 'AWS4-HMAC-SHA256 Credential=' + options.credentials.accessKeyId + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
    }),
    queryString: queryString
  };
}

function buildUrl(host, path, queryString) {
  var url = 'https://' + host + path;
  if (queryString) {
    url += '?' + queryString;
  }
  return url;
}

async function microvmRequest(options) {
  // options: method, path, query, region, now, fetchImpl
  var host = 'lambda.' + options.region + '.amazonaws.com';
  var signed = signV4({
    method: options.method,
    path: options.path,
    query: options.query || {},
    host: host,
    region: options.region,
    now: options.now,
    payloadHash: EMPTY_SHA256,
    credentials: credentials()
  });
  var url = buildUrl(host, options.path, signed.queryString);
  var response = await options.fetchImpl(url, {
    method: options.method,
    headers: signed.headers
  });
  var bodyText = await response.text();
  var parsed = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      parsed = null;
    }
  }
  if (!response.ok) {
    var error = new Error('microvm-image-prune: ' + options.method + ' ' + options.path + ' failed with HTTP ' + response.status + ': ' + bodyText);
    error.statusCode = response.status;
    throw error;
  }
  return parsed;
}

async function listMicrovmImageVersions(options) {
  // options: imageIdentifier, region, now, fetchImpl, nextToken, maxResults
  var query = {};
  if (options.maxResults !== undefined && options.maxResults !== null) {
    query.maxResults = String(options.maxResults);
  }
  if (options.nextToken) {
    query.nextToken = options.nextToken;
  }
  var path = API_PATH_PREFIX + '/' + escapePathComponent(options.imageIdentifier) + '/versions';
  var parsed = await microvmRequest({
    method: 'GET',
    path: path,
    query: query,
    region: options.region,
    now: options.now,
    fetchImpl: options.fetchImpl
  });
  return {
    items: parsed && Array.isArray(parsed.items) ? parsed.items : [],
    nextToken: parsed && parsed.nextToken ? parsed.nextToken : undefined
  };
}

async function deleteMicrovmImageVersion(options) {
  // options: imageIdentifier, imageVersion, region, now, fetchImpl
  var path = API_PATH_PREFIX + '/' + escapePathComponent(options.imageIdentifier) + '/versions/' + escapePathComponent(options.imageVersion);
  await microvmRequest({
    method: 'DELETE',
    path: path,
    query: {},
    region: options.region,
    now: options.now,
    fetchImpl: options.fetchImpl
  });
}

async function listAllVersions(options) {
  var versions = [];
  var nextToken = undefined;
  var pageNumber = 0;
  while (true) {
    pageNumber += 1;
    if (pageNumber > 1000) {
      throw new Error('microvm-image-prune: version listing exceeded pagination guard');
    }
    var page = await listMicrovmImageVersions({
      imageIdentifier: options.imageIdentifier,
      region: options.region,
      now: options.now,
      fetchImpl: options.fetchImpl,
      nextToken: nextToken,
      maxResults: MAX_RESULTS
    });
    versions = versions.concat(page.items || []);
    nextToken = page.nextToken;
    if (!nextToken) {
      break;
    }
  }
  return versions;
}

function createdAtEpochSeconds(item) {
  var value = item && item.createdAt;
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    var parsed = Date.parse(value);
    if (!isNaN(parsed)) {
      return parsed / 1000;
    }
  }
  return 0;
}

function versionNumber(value) {
  if (/^\\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  return NaN;
}

function compareVersions(a, b) {
  var na = versionNumber(a);
  var nb = versionNumber(b);
  if (!isNaN(na) && !isNaN(nb)) {
    return na - nb;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function latestActiveVersion(versions) {
  var best = undefined;
  for (var i = 0; i < versions.length; i++) {
    var item = versions[i];
    if (!item) {
      continue;
    }
    if (String(item.status || '').toUpperCase() !== 'ACTIVE') {
      continue;
    }
    if (best === undefined) {
      best = item;
      continue;
    }
    var itemCreated = createdAtEpochSeconds(item);
    var bestCreated = createdAtEpochSeconds(best);
    if (itemCreated > bestCreated || (itemCreated === bestCreated && compareVersions(String(item.imageVersion || ''), String(best.imageVersion || '')) > 0)) {
      best = item;
    }
  }
  return best;
}

async function pruneMicrovmImageVersions(options) {
  // options: imageIdentifier, region, now, fetchImpl, logImpl
  var logImpl = options.logImpl || log;
  // A list failure (auth, transport, service) must fail the deployment loudly;
  // silent quota debt is the failure mode this handler exists to prevent.
  var versions = await listAllVersions(options);
  var keep = latestActiveVersion(versions);
  var keepVersion = keep ? String(keep.imageVersion || '') : '';
  var deleted = 0;
  var skipped = 0;
  for (var i = 0; i < versions.length; i++) {
    var item = versions[i];
    if (!item) {
      continue;
    }
    var version = String(item.imageVersion || '');
    if (!version) {
      continue;
    }
    if (version === keepVersion) {
      continue;
    }
    try {
      await deleteMicrovmImageVersion({
        imageIdentifier: options.imageIdentifier,
        imageVersion: version,
        region: options.region,
        now: options.now,
        fetchImpl: options.fetchImpl
      });
      deleted += 1;
    } catch (err) {
      // The service can refuse a deletion while a version is still in use by
      // running MicroVMs. A refusal must not fail the deployment: log it and
      // keep going. The next deployment retries the version.
      skipped += 1;
      logImpl('skipping version ' + version + ': ' + (err && err.message ? err.message : String(err)));
    }
  }
  var summary = {
    versionsSeen: versions.length,
    versionsDeleted: deleted,
    versionsSkipped: skipped
  };
  logImpl('prune summary: versions seen=' + summary.versionsSeen + ' deleted=' + summary.versionsDeleted + ' skipped=' + summary.versionsSkipped + ' kept=' + (keepVersion || '<none>'));
  return summary;
}

async function handler(event) {
  // Delete runs while CloudFormation deletes the whole image, so there is
  // nothing to prune and pruning must never block or fail deletion.
  if (event && event.RequestType === 'Delete') {
    return {};
  }
  var imageIdentifier = requiredEnv('APPTHEORY_MICROVM_IMAGE_ARN');
  var region = resolveRegion();
  var summary = await pruneMicrovmImageVersions({
    imageIdentifier: imageIdentifier,
    region: region,
    now: new Date(),
    fetchImpl: fetch,
    logImpl: log
  });
  return {
    Data: {
      VersionsSeen: summary.versionsSeen,
      VersionsDeleted: summary.versionsDeleted,
      VersionsSkipped: summary.versionsSkipped
    }
  };
}

module.exports = {
  handler: handler,
  pruneMicrovmImageVersions: pruneMicrovmImageVersions,
  listMicrovmImageVersions: listMicrovmImageVersions,
  deleteMicrovmImageVersion: deleteMicrovmImageVersion,
  latestActiveVersion: latestActiveVersion,
  signV4: signV4,
  escapePathComponent: escapePathComponent
};
`;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS1wcnVuZS1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1pbWFnZS1wcnVuZS1oYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTZCRztBQUNVLFFBQUEsa0NBQWtDLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E4WGpELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNlbGYtY29udGFpbmVkIExhbWJkYSBoYW5kbGVyIGZvciBgQXBwVGhlb3J5TWljcm92bUltYWdlYCB2ZXJzaW9uIHBydW5pbmcuXG4gKlxuICogVGhlIGhhbmRsZXIgc291cmNlIGlzIGVtYmVkZGVkIGFzIGEgc3RyaW5nIGNvbnN0YW50IHNvIHRoZSBjb25zdHJ1Y3QgY2FuIGRlcGxveVxuICogaXQgYXMgaW5saW5lIExhbWJkYSBjb2RlIGZyb20gZXZlcnkganNpaSB0YXJnZXQgKFR5cGVTY3JpcHQsIFB5dGhvbiwgR28pIHdpdGhvdXRcbiAqIGEgYnVuZGxpbmcgb3IgYXNzZXQgc3RlcC4gSXQgdGFsa3MgdG8gdGhlIExhbWJkYSBNaWNyb1ZNcyBjb250cm9sIHBsYW5lXG4gKiAoYExpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9uc2AgLyBgRGVsZXRlTWljcm92bUltYWdlVmVyc2lvbmApIHdpdGggcmF3IFNpZ1Y0LXNpZ25lZFxuICogSFRUUFMgcmVxdWVzdHMgYW5kIGhhcyBubyBydW50aW1lIGRlcGVuZGVuY2llcyBiZXlvbmQgdGhlIE5vZGUgc3RhbmRhcmQgbGlicmFyeVxuICogYW5kIHRoZSBwbGF0Zm9ybSBgZmV0Y2hgIGdsb2JhbC5cbiAqXG4gKiBSZXF1ZXN0IHNoYXBlcyBiZWxvdyBtaXJyb3IgdGhlIHBpbm5lZCBgbGFtYmRhbWljcm92bXNgIEFXUyBTREsgdjEuMC4wXG4gKiAoYXdzLXNkay1nby12MiBzZXJ2aWNlIG1vZGVsLCBzbWl0aHkgUkVTVC1KU09OIHByb3RvY29sKTpcbiAqXG4gKiAtIExpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9uczogR0VUIC8yMDI1LTA5LTA5L21pY3Jvdm0taW1hZ2VzL3tpbWFnZUlkZW50aWZpZXJ9L3ZlcnNpb25zXG4gKiAgIHdpdGggb3B0aW9uYWwgYG1heFJlc3VsdHNgIC8gYG5leHRUb2tlbmAgcXVlcnkgcGFyYW1ldGVyczsgcmVzcG9uc2UgYm9keVxuICogICBgeyBcIml0ZW1zXCI6IFsuLi5dLCBcIm5leHRUb2tlblwiOiBcIi4uLlwiIH1gLlxuICogLSBEZWxldGVNaWNyb3ZtSW1hZ2VWZXJzaW9uOiBERUxFVEUgLzIwMjUtMDktMDkvbWljcm92bS1pbWFnZXMve2ltYWdlSWRlbnRpZmllcn0vdmVyc2lvbnMve2ltYWdlVmVyc2lvbn1cbiAqICAgd2l0aCBhbiBlbXB0eSBib2R5OyByZXNwb25zZSBib2R5IGB7IFwiaW1hZ2VJZGVudGlmaWVyXCI6IFwiLi4uXCIsIFwiaW1hZ2VWZXJzaW9uXCI6IFwiLi4uXCIsIFwic3RhdGVcIjogXCIuLi5cIiB9YC5cbiAqXG4gKiBTaWdWNCBzaWduaW5nIG5hbWUgaXMgYGxhbWJkYWAgYW5kIHRoZSBlbmRwb2ludCBob3N0IGlzIGBsYW1iZGEue3JlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gKiBib3RoIHRha2VuIGZyb20gdGhlIHBpbm5lZCBTREsgKHNlcnZpY2UgYXV0aCB0cmFpdCBhbmQgZW5kcG9pbnQgcnVsZXNldCkuXG4gKiBQYXRoIHBhcmFtZXRlcnMgYXJlIGVzY2FwZWQgd2l0aCB0aGUgU0RLJ3MgQW1hem9uIHBhdGgtZXNjYXBlIHN0eWxlIChldmVyeSBieXRlXG4gKiBvdXRzaWRlIGBBLVphLXowLTktLl9+YCBwZXJjZW50LWVuY29kZWQsIGluY2x1ZGluZyBgL2ApLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIGludGVybmFsIHRvIHRoZSBDREsgcGFja2FnZSBhbmQgaW50ZW50aW9uYWxseSBOT1QgZXhwb3J0ZWQgZnJvbVxuICogYGluZGV4LnRzYCwgc28gaXQgbmV2ZXIgYXBwZWFycyBpbiB0aGUganNpaSBhc3NlbWJseSBvciBnZW5lcmF0ZWQgYmluZGluZ3MuIFRoZVxuICogY29tcGlsZWQgYC5qc2AgaXMgbG9hZGVkIGRpcmVjdGx5IGJ5IHRoZSBjb25zdHJ1Y3QgYW5kIGJ5IHRoZSBoYW5kbGVyIHVuaXQgdGVzdHMuXG4gKlxuICogQGludGVybmFsXG4gKi9cbmV4cG9ydCBjb25zdCBNSUNST1ZNX0lNQUdFX1BSVU5FX0hBTkRMRVJfU09VUkNFID0gYCd1c2Ugc3RyaWN0JztcblxudmFyIGNyeXB0byA9IHJlcXVpcmUoJ25vZGU6Y3J5cHRvJyk7XG5cbnZhciBTRVJWSUNFX05BTUUgPSAnbGFtYmRhJztcbnZhciBBUElfUEFUSF9QUkVGSVggPSAnLzIwMjUtMDktMDkvbWljcm92bS1pbWFnZXMnO1xudmFyIE1BWF9SRVNVTFRTID0gMTAwO1xudmFyIEVNUFRZX1NIQTI1NiA9ICdlM2IwYzQ0Mjk4ZmMxYzE0OWFmYmY0Yzg5OTZmYjkyNDI3YWU0MWU0NjQ5YjkzNGNhNDk1OTkxYjc4NTJiODU1JztcblxuZnVuY3Rpb24gbG9nKG1lc3NhZ2UpIHtcbiAgY29uc29sZS5sb2coJ1ttaWNyb3ZtLWltYWdlLXBydW5lXSAnICsgbWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVkRW52KG5hbWUpIHtcbiAgdmFyIHZhbHVlID0gcHJvY2Vzcy5lbnZbbmFtZV07XG4gIGlmICghdmFsdWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ21pY3Jvdm0taW1hZ2UtcHJ1bmU6IG1pc3NpbmcgcmVxdWlyZWQgZW52aXJvbm1lbnQgdmFyaWFibGUgJyArIG5hbWUpO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJlZ2lvbigpIHtcbiAgdmFyIHJlZ2lvbiA9IHByb2Nlc3MuZW52LkFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX1JFR0lPTiB8fCBwcm9jZXNzLmVudi5BV1NfUkVHSU9OIHx8IHByb2Nlc3MuZW52LkFXU19ERUZBVUxUX1JFR0lPTjtcbiAgaWYgKCFyZWdpb24pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ21pY3Jvdm0taW1hZ2UtcHJ1bmU6IHVuYWJsZSB0byBkZXRlcm1pbmUgQVdTIHJlZ2lvbicpO1xuICB9XG4gIHJldHVybiByZWdpb247XG59XG5cbmZ1bmN0aW9uIGNyZWRlbnRpYWxzKCkge1xuICB2YXIgYWNjZXNzS2V5SWQgPSBwcm9jZXNzLmVudi5BV1NfQUNDRVNTX0tFWV9JRDtcbiAgdmFyIHNlY3JldEFjY2Vzc0tleSA9IHByb2Nlc3MuZW52LkFXU19TRUNSRVRfQUNDRVNTX0tFWTtcbiAgaWYgKCFhY2Nlc3NLZXlJZCB8fCAhc2VjcmV0QWNjZXNzS2V5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdtaWNyb3ZtLWltYWdlLXBydW5lOiBBV1MgY3JlZGVudGlhbHMgYXJlIG5vdCBhdmFpbGFibGUgaW4gdGhlIExhbWJkYSBlbnZpcm9ubWVudCcpO1xuICB9XG4gIHJldHVybiB7XG4gICAgYWNjZXNzS2V5SWQ6IGFjY2Vzc0tleUlkLFxuICAgIHNlY3JldEFjY2Vzc0tleTogc2VjcmV0QWNjZXNzS2V5LFxuICAgIHNlc3Npb25Ub2tlbjogcHJvY2Vzcy5lbnYuQVdTX1NFU1NJT05fVE9LRU4gfHwgJydcbiAgfTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlUGF0aENvbXBvbmVudCh2YWx1ZSkge1xuICAvLyBNaXJyb3JzIHRoZSBwaW5uZWQgU0RLJ3MgQW1hem9uIHBhdGgtZXNjYXBlIHN0eWxlOiBldmVyeSBieXRlIG91dHNpZGVcbiAgLy8gQS1aYS16MC05LS5ffiBpcyBwZXJjZW50LWVuY29kZWQgKGluY2x1ZGluZyAnLycpLCB1cHBlcmNhc2UgaGV4LlxuICB2YXIgb3V0ID0gJyc7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgYyA9IHZhbHVlLmNoYXJDb2RlQXQoaSk7XG4gICAgaWYgKChjID49IDY1ICYmIGMgPD0gOTApIHx8IChjID49IDk3ICYmIGMgPD0gMTIyKSB8fCAoYyA+PSA0OCAmJiBjIDw9IDU3KSB8fCBjID09PSA0NSB8fCBjID09PSA0NiB8fCBjID09PSA5NSB8fCBjID09PSAxMjYpIHtcbiAgICAgIG91dCArPSB2YWx1ZVtpXTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0ICs9ICclJyArIGMudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKCkucGFkU3RhcnQoMiwgJzAnKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gZXNjYXBlUXVlcnkodmFsdWUpIHtcbiAgLy8gUkZDIDM5ODYgcGVyY2VudC1lbmNvZGluZyBmb3IgcXVlcnkgbmFtZXMgYW5kIHZhbHVlcy5cbiAgdmFyIG91dCA9ICcnO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhbHVlLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGMgPSB2YWx1ZS5jaGFyQ29kZUF0KGkpO1xuICAgIGlmICgoYyA+PSA2NSAmJiBjIDw9IDkwKSB8fCAoYyA+PSA5NyAmJiBjIDw9IDEyMikgfHwgKGMgPj0gNDggJiYgYyA8PSA1NykgfHwgYyA9PT0gNDUgfHwgYyA9PT0gNDYgfHwgYyA9PT0gOTUgfHwgYyA9PT0gMTI2KSB7XG4gICAgICBvdXQgKz0gdmFsdWVbaV07XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dCArPSAnJScgKyBjLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpLnBhZFN0YXJ0KDIsICcwJyk7XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIHNoYTI1NkhleChkYXRhKSB7XG4gIHJldHVybiBjcnlwdG8uY3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKGRhdGEsICd1dGY4JykuZGlnZXN0KCdoZXgnKTtcbn1cblxuZnVuY3Rpb24gaG1hY1NoYTI1NihrZXksIGRhdGEpIHtcbiAgcmV0dXJuIGNyeXB0by5jcmVhdGVIbWFjKCdzaGEyNTYnLCBrZXkpLnVwZGF0ZShkYXRhLCAndXRmOCcpLmRpZ2VzdCgpO1xufVxuXG5mdW5jdGlvbiBpc284NjAxQmFzaWMoZGF0ZSkge1xuICByZXR1cm4gZGF0ZS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6LV0vZywgJycpLnJlcGxhY2UoL1xcXFwuXFxcXGR7M30vZywgJycpO1xufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxRdWVyeShxdWVyeSkge1xuICBpZiAoIXF1ZXJ5KSB7XG4gICAgcmV0dXJuICcnO1xuICB9XG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXMocXVlcnkpLnNvcnQoKTtcbiAgdmFyIHBhcnRzID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7IGkrKykge1xuICAgIHZhciBrZXkgPSBlc2NhcGVRdWVyeShrZXlzW2ldKTtcbiAgICB2YXIgdmFsdWUgPSBxdWVyeVtrZXlzW2ldXTtcbiAgICBwYXJ0cy5wdXNoKGtleSArICc9JyArIGVzY2FwZVF1ZXJ5KHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwgPyAnJyA6IFN0cmluZyh2YWx1ZSkpKTtcbiAgfVxuICByZXR1cm4gcGFydHMuam9pbignJicpO1xufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxSZXF1ZXN0KG1ldGhvZCwgcGF0aCwgcXVlcnlTdHJpbmcsIGhlYWRlcnMsIHBheWxvYWRIYXNoKSB7XG4gIHZhciBuYW1lcyA9IE9iamVjdC5rZXlzKGhlYWRlcnMpLnNvcnQoKTtcbiAgdmFyIGNhbm9uaWNhbEhlYWRlcnMgPSAnJztcbiAgdmFyIHNpZ25lZEhlYWRlcnMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBuYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIHZhciBuYW1lID0gbmFtZXNbaV0udG9Mb3dlckNhc2UoKTtcbiAgICBjYW5vbmljYWxIZWFkZXJzICs9IG5hbWUgKyAnOicgKyBTdHJpbmcoaGVhZGVyc1tuYW1lc1tpXV0pLnRyaW0oKSArICdcXFxcbic7XG4gICAgc2lnbmVkSGVhZGVycy5wdXNoKG5hbWUpO1xuICB9XG4gIHJldHVybiBbbWV0aG9kLCBwYXRoLCBxdWVyeVN0cmluZywgY2Fub25pY2FsSGVhZGVycywgc2lnbmVkSGVhZGVycy5qb2luKCc7JyksIHBheWxvYWRIYXNoXS5qb2luKCdcXFxcbicpO1xufVxuXG5mdW5jdGlvbiBzaWduVjQob3B0aW9ucykge1xuICB2YXIgYW16RGF0ZSA9IGlzbzg2MDFCYXNpYyhvcHRpb25zLm5vdyk7XG4gIHZhciBkYXRlU3RhbXAgPSBhbXpEYXRlLnNsaWNlKDAsIDgpO1xuICB2YXIgc2lnbmluZ0hlYWRlcnMgPSB7XG4gICAgJ2hvc3QnOiBvcHRpb25zLmhvc3QsXG4gICAgJ3gtYW16LWNvbnRlbnQtc2hhMjU2Jzogb3B0aW9ucy5wYXlsb2FkSGFzaCxcbiAgICAneC1hbXotZGF0ZSc6IGFtekRhdGVcbiAgfTtcbiAgaWYgKG9wdGlvbnMuY3JlZGVudGlhbHMuc2Vzc2lvblRva2VuKSB7XG4gICAgc2lnbmluZ0hlYWRlcnNbJ3gtYW16LXNlY3VyaXR5LXRva2VuJ10gPSBvcHRpb25zLmNyZWRlbnRpYWxzLnNlc3Npb25Ub2tlbjtcbiAgfVxuICB2YXIgcXVlcnlTdHJpbmcgPSBjYW5vbmljYWxRdWVyeShvcHRpb25zLnF1ZXJ5KTtcbiAgdmFyIGNhbm9uaWNhbCA9IGNhbm9uaWNhbFJlcXVlc3Qob3B0aW9ucy5tZXRob2QsIG9wdGlvbnMucGF0aCwgcXVlcnlTdHJpbmcsIHNpZ25pbmdIZWFkZXJzLCBvcHRpb25zLnBheWxvYWRIYXNoKTtcbiAgdmFyIHNjb3BlID0gZGF0ZVN0YW1wICsgJy8nICsgb3B0aW9ucy5yZWdpb24gKyAnLycgKyBTRVJWSUNFX05BTUUgKyAnL2F3czRfcmVxdWVzdCc7XG4gIHZhciBzdHJpbmdUb1NpZ24gPSAnQVdTNC1ITUFDLVNIQTI1NlxcXFxuJyArIGFtekRhdGUgKyAnXFxcXG4nICsgc2NvcGUgKyAnXFxcXG4nICsgc2hhMjU2SGV4KGNhbm9uaWNhbCk7XG4gIHZhciBkYXRlS2V5ID0gaG1hY1NoYTI1NignQVdTNCcgKyBvcHRpb25zLmNyZWRlbnRpYWxzLnNlY3JldEFjY2Vzc0tleSwgZGF0ZVN0YW1wKTtcbiAgdmFyIHJlZ2lvbktleSA9IGhtYWNTaGEyNTYoZGF0ZUtleSwgb3B0aW9ucy5yZWdpb24pO1xuICB2YXIgc2VydmljZUtleSA9IGhtYWNTaGEyNTYocmVnaW9uS2V5LCBTRVJWSUNFX05BTUUpO1xuICB2YXIgc2lnbmluZ0tleSA9IGhtYWNTaGEyNTYoc2VydmljZUtleSwgJ2F3czRfcmVxdWVzdCcpO1xuICB2YXIgc2lnbmF0dXJlID0gY3J5cHRvLmNyZWF0ZUhtYWMoJ3NoYTI1NicsIHNpZ25pbmdLZXkpLnVwZGF0ZShzdHJpbmdUb1NpZ24sICd1dGY4JykuZGlnZXN0KCdoZXgnKTtcbiAgdmFyIHNpZ25lZEhlYWRlcnMgPSBPYmplY3Qua2V5cyhzaWduaW5nSGVhZGVycykuc29ydCgpLmpvaW4oJzsnKTtcbiAgcmV0dXJuIHtcbiAgICBoZWFkZXJzOiBPYmplY3QuYXNzaWduKHt9LCBzaWduaW5nSGVhZGVycywge1xuICAgICAgYXV0aG9yaXphdGlvbjogJ0FXUzQtSE1BQy1TSEEyNTYgQ3JlZGVudGlhbD0nICsgb3B0aW9ucy5jcmVkZW50aWFscy5hY2Nlc3NLZXlJZCArICcvJyArIHNjb3BlICtcbiAgICAgICAgJywgU2lnbmVkSGVhZGVycz0nICsgc2lnbmVkSGVhZGVycyArICcsIFNpZ25hdHVyZT0nICsgc2lnbmF0dXJlXG4gICAgfSksXG4gICAgcXVlcnlTdHJpbmc6IHF1ZXJ5U3RyaW5nXG4gIH07XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVXJsKGhvc3QsIHBhdGgsIHF1ZXJ5U3RyaW5nKSB7XG4gIHZhciB1cmwgPSAnaHR0cHM6Ly8nICsgaG9zdCArIHBhdGg7XG4gIGlmIChxdWVyeVN0cmluZykge1xuICAgIHVybCArPSAnPycgKyBxdWVyeVN0cmluZztcbiAgfVxuICByZXR1cm4gdXJsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtaWNyb3ZtUmVxdWVzdChvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IG1ldGhvZCwgcGF0aCwgcXVlcnksIHJlZ2lvbiwgbm93LCBmZXRjaEltcGxcbiAgdmFyIGhvc3QgPSAnbGFtYmRhLicgKyBvcHRpb25zLnJlZ2lvbiArICcuYW1hem9uYXdzLmNvbSc7XG4gIHZhciBzaWduZWQgPSBzaWduVjQoe1xuICAgIG1ldGhvZDogb3B0aW9ucy5tZXRob2QsXG4gICAgcGF0aDogb3B0aW9ucy5wYXRoLFxuICAgIHF1ZXJ5OiBvcHRpb25zLnF1ZXJ5IHx8IHt9LFxuICAgIGhvc3Q6IGhvc3QsXG4gICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICBub3c6IG9wdGlvbnMubm93LFxuICAgIHBheWxvYWRIYXNoOiBFTVBUWV9TSEEyNTYsXG4gICAgY3JlZGVudGlhbHM6IGNyZWRlbnRpYWxzKClcbiAgfSk7XG4gIHZhciB1cmwgPSBidWlsZFVybChob3N0LCBvcHRpb25zLnBhdGgsIHNpZ25lZC5xdWVyeVN0cmluZyk7XG4gIHZhciByZXNwb25zZSA9IGF3YWl0IG9wdGlvbnMuZmV0Y2hJbXBsKHVybCwge1xuICAgIG1ldGhvZDogb3B0aW9ucy5tZXRob2QsXG4gICAgaGVhZGVyczogc2lnbmVkLmhlYWRlcnNcbiAgfSk7XG4gIHZhciBib2R5VGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgdmFyIHBhcnNlZCA9IG51bGw7XG4gIGlmIChib2R5VGV4dCkge1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGJvZHlUZXh0KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHBhcnNlZCA9IG51bGw7XG4gICAgfVxuICB9XG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICB2YXIgZXJyb3IgPSBuZXcgRXJyb3IoJ21pY3Jvdm0taW1hZ2UtcHJ1bmU6ICcgKyBvcHRpb25zLm1ldGhvZCArICcgJyArIG9wdGlvbnMucGF0aCArICcgZmFpbGVkIHdpdGggSFRUUCAnICsgcmVzcG9uc2Uuc3RhdHVzICsgJzogJyArIGJvZHlUZXh0KTtcbiAgICBlcnJvci5zdGF0dXNDb2RlID0gcmVzcG9uc2Uuc3RhdHVzO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9ucyhvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IGltYWdlSWRlbnRpZmllciwgcmVnaW9uLCBub3csIGZldGNoSW1wbCwgbmV4dFRva2VuLCBtYXhSZXN1bHRzXG4gIHZhciBxdWVyeSA9IHt9O1xuICBpZiAob3B0aW9ucy5tYXhSZXN1bHRzICE9PSB1bmRlZmluZWQgJiYgb3B0aW9ucy5tYXhSZXN1bHRzICE9PSBudWxsKSB7XG4gICAgcXVlcnkubWF4UmVzdWx0cyA9IFN0cmluZyhvcHRpb25zLm1heFJlc3VsdHMpO1xuICB9XG4gIGlmIChvcHRpb25zLm5leHRUb2tlbikge1xuICAgIHF1ZXJ5Lm5leHRUb2tlbiA9IG9wdGlvbnMubmV4dFRva2VuO1xuICB9XG4gIHZhciBwYXRoID0gQVBJX1BBVEhfUFJFRklYICsgJy8nICsgZXNjYXBlUGF0aENvbXBvbmVudChvcHRpb25zLmltYWdlSWRlbnRpZmllcikgKyAnL3ZlcnNpb25zJztcbiAgdmFyIHBhcnNlZCA9IGF3YWl0IG1pY3Jvdm1SZXF1ZXN0KHtcbiAgICBtZXRob2Q6ICdHRVQnLFxuICAgIHBhdGg6IHBhdGgsXG4gICAgcXVlcnk6IHF1ZXJ5LFxuICAgIHJlZ2lvbjogb3B0aW9ucy5yZWdpb24sXG4gICAgbm93OiBvcHRpb25zLm5vdyxcbiAgICBmZXRjaEltcGw6IG9wdGlvbnMuZmV0Y2hJbXBsXG4gIH0pO1xuICByZXR1cm4ge1xuICAgIGl0ZW1zOiBwYXJzZWQgJiYgQXJyYXkuaXNBcnJheShwYXJzZWQuaXRlbXMpID8gcGFyc2VkLml0ZW1zIDogW10sXG4gICAgbmV4dFRva2VuOiBwYXJzZWQgJiYgcGFyc2VkLm5leHRUb2tlbiA/IHBhcnNlZC5uZXh0VG9rZW4gOiB1bmRlZmluZWRcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbihvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IGltYWdlSWRlbnRpZmllciwgaW1hZ2VWZXJzaW9uLCByZWdpb24sIG5vdywgZmV0Y2hJbXBsXG4gIHZhciBwYXRoID0gQVBJX1BBVEhfUFJFRklYICsgJy8nICsgZXNjYXBlUGF0aENvbXBvbmVudChvcHRpb25zLmltYWdlSWRlbnRpZmllcikgKyAnL3ZlcnNpb25zLycgKyBlc2NhcGVQYXRoQ29tcG9uZW50KG9wdGlvbnMuaW1hZ2VWZXJzaW9uKTtcbiAgYXdhaXQgbWljcm92bVJlcXVlc3Qoe1xuICAgIG1ldGhvZDogJ0RFTEVURScsXG4gICAgcGF0aDogcGF0aCxcbiAgICBxdWVyeToge30sXG4gICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICBub3c6IG9wdGlvbnMubm93LFxuICAgIGZldGNoSW1wbDogb3B0aW9ucy5mZXRjaEltcGxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RBbGxWZXJzaW9ucyhvcHRpb25zKSB7XG4gIHZhciB2ZXJzaW9ucyA9IFtdO1xuICB2YXIgbmV4dFRva2VuID0gdW5kZWZpbmVkO1xuICB2YXIgcGFnZU51bWJlciA9IDA7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgcGFnZU51bWJlciArPSAxO1xuICAgIGlmIChwYWdlTnVtYmVyID4gMTAwMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtaWNyb3ZtLWltYWdlLXBydW5lOiB2ZXJzaW9uIGxpc3RpbmcgZXhjZWVkZWQgcGFnaW5hdGlvbiBndWFyZCcpO1xuICAgIH1cbiAgICB2YXIgcGFnZSA9IGF3YWl0IGxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9ucyh7XG4gICAgICBpbWFnZUlkZW50aWZpZXI6IG9wdGlvbnMuaW1hZ2VJZGVudGlmaWVyLFxuICAgICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICAgIG5vdzogb3B0aW9ucy5ub3csXG4gICAgICBmZXRjaEltcGw6IG9wdGlvbnMuZmV0Y2hJbXBsLFxuICAgICAgbmV4dFRva2VuOiBuZXh0VG9rZW4sXG4gICAgICBtYXhSZXN1bHRzOiBNQVhfUkVTVUxUU1xuICAgIH0pO1xuICAgIHZlcnNpb25zID0gdmVyc2lvbnMuY29uY2F0KHBhZ2UuaXRlbXMgfHwgW10pO1xuICAgIG5leHRUb2tlbiA9IHBhZ2UubmV4dFRva2VuO1xuICAgIGlmICghbmV4dFRva2VuKSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZlcnNpb25zO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVkQXRFcG9jaFNlY29uZHMoaXRlbSkge1xuICB2YXIgdmFsdWUgPSBpdGVtICYmIGl0ZW0uY3JlYXRlZEF0O1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgIHZhciBwYXJzZWQgPSBEYXRlLnBhcnNlKHZhbHVlKTtcbiAgICBpZiAoIWlzTmFOKHBhcnNlZCkpIHtcbiAgICAgIHJldHVybiBwYXJzZWQgLyAxMDAwO1xuICAgIH1cbiAgfVxuICByZXR1cm4gMDtcbn1cblxuZnVuY3Rpb24gdmVyc2lvbk51bWJlcih2YWx1ZSkge1xuICBpZiAoL15cXFxcZCskLy50ZXN0KHZhbHVlKSkge1xuICAgIHJldHVybiBwYXJzZUludCh2YWx1ZSwgMTApO1xuICB9XG4gIHJldHVybiBOYU47XG59XG5cbmZ1bmN0aW9uIGNvbXBhcmVWZXJzaW9ucyhhLCBiKSB7XG4gIHZhciBuYSA9IHZlcnNpb25OdW1iZXIoYSk7XG4gIHZhciBuYiA9IHZlcnNpb25OdW1iZXIoYik7XG4gIGlmICghaXNOYU4obmEpICYmICFpc05hTihuYikpIHtcbiAgICByZXR1cm4gbmEgLSBuYjtcbiAgfVxuICBpZiAoYSA9PT0gYikge1xuICAgIHJldHVybiAwO1xuICB9XG4gIHJldHVybiBhIDwgYiA/IC0xIDogMTtcbn1cblxuZnVuY3Rpb24gbGF0ZXN0QWN0aXZlVmVyc2lvbih2ZXJzaW9ucykge1xuICB2YXIgYmVzdCA9IHVuZGVmaW5lZDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2ZXJzaW9ucy5sZW5ndGg7IGkrKykge1xuICAgIHZhciBpdGVtID0gdmVyc2lvbnNbaV07XG4gICAgaWYgKCFpdGVtKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKFN0cmluZyhpdGVtLnN0YXR1cyB8fCAnJykudG9VcHBlckNhc2UoKSAhPT0gJ0FDVElWRScpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYmVzdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBiZXN0ID0gaXRlbTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB2YXIgaXRlbUNyZWF0ZWQgPSBjcmVhdGVkQXRFcG9jaFNlY29uZHMoaXRlbSk7XG4gICAgdmFyIGJlc3RDcmVhdGVkID0gY3JlYXRlZEF0RXBvY2hTZWNvbmRzKGJlc3QpO1xuICAgIGlmIChpdGVtQ3JlYXRlZCA+IGJlc3RDcmVhdGVkIHx8IChpdGVtQ3JlYXRlZCA9PT0gYmVzdENyZWF0ZWQgJiYgY29tcGFyZVZlcnNpb25zKFN0cmluZyhpdGVtLmltYWdlVmVyc2lvbiB8fCAnJyksIFN0cmluZyhiZXN0LmltYWdlVmVyc2lvbiB8fCAnJykpID4gMCkpIHtcbiAgICAgIGJlc3QgPSBpdGVtO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYmVzdDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHJ1bmVNaWNyb3ZtSW1hZ2VWZXJzaW9ucyhvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IGltYWdlSWRlbnRpZmllciwgcmVnaW9uLCBub3csIGZldGNoSW1wbCwgbG9nSW1wbFxuICB2YXIgbG9nSW1wbCA9IG9wdGlvbnMubG9nSW1wbCB8fCBsb2c7XG4gIC8vIEEgbGlzdCBmYWlsdXJlIChhdXRoLCB0cmFuc3BvcnQsIHNlcnZpY2UpIG11c3QgZmFpbCB0aGUgZGVwbG95bWVudCBsb3VkbHk7XG4gIC8vIHNpbGVudCBxdW90YSBkZWJ0IGlzIHRoZSBmYWlsdXJlIG1vZGUgdGhpcyBoYW5kbGVyIGV4aXN0cyB0byBwcmV2ZW50LlxuICB2YXIgdmVyc2lvbnMgPSBhd2FpdCBsaXN0QWxsVmVyc2lvbnMob3B0aW9ucyk7XG4gIHZhciBrZWVwID0gbGF0ZXN0QWN0aXZlVmVyc2lvbih2ZXJzaW9ucyk7XG4gIHZhciBrZWVwVmVyc2lvbiA9IGtlZXAgPyBTdHJpbmcoa2VlcC5pbWFnZVZlcnNpb24gfHwgJycpIDogJyc7XG4gIHZhciBkZWxldGVkID0gMDtcbiAgdmFyIHNraXBwZWQgPSAwO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHZlcnNpb25zLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGl0ZW0gPSB2ZXJzaW9uc1tpXTtcbiAgICBpZiAoIWl0ZW0pIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB2YXIgdmVyc2lvbiA9IFN0cmluZyhpdGVtLmltYWdlVmVyc2lvbiB8fCAnJyk7XG4gICAgaWYgKCF2ZXJzaW9uKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHZlcnNpb24gPT09IGtlZXBWZXJzaW9uKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGRlbGV0ZU1pY3Jvdm1JbWFnZVZlcnNpb24oe1xuICAgICAgICBpbWFnZUlkZW50aWZpZXI6IG9wdGlvbnMuaW1hZ2VJZGVudGlmaWVyLFxuICAgICAgICBpbWFnZVZlcnNpb246IHZlcnNpb24sXG4gICAgICAgIHJlZ2lvbjogb3B0aW9ucy5yZWdpb24sXG4gICAgICAgIG5vdzogb3B0aW9ucy5ub3csXG4gICAgICAgIGZldGNoSW1wbDogb3B0aW9ucy5mZXRjaEltcGxcbiAgICAgIH0pO1xuICAgICAgZGVsZXRlZCArPSAxO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLy8gVGhlIHNlcnZpY2UgY2FuIHJlZnVzZSBhIGRlbGV0aW9uIHdoaWxlIGEgdmVyc2lvbiBpcyBzdGlsbCBpbiB1c2UgYnlcbiAgICAgIC8vIHJ1bm5pbmcgTWljcm9WTXMuIEEgcmVmdXNhbCBtdXN0IG5vdCBmYWlsIHRoZSBkZXBsb3ltZW50OiBsb2cgaXQgYW5kXG4gICAgICAvLyBrZWVwIGdvaW5nLiBUaGUgbmV4dCBkZXBsb3ltZW50IHJldHJpZXMgdGhlIHZlcnNpb24uXG4gICAgICBza2lwcGVkICs9IDE7XG4gICAgICBsb2dJbXBsKCdza2lwcGluZyB2ZXJzaW9uICcgKyB2ZXJzaW9uICsgJzogJyArIChlcnIgJiYgZXJyLm1lc3NhZ2UgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKSk7XG4gICAgfVxuICB9XG4gIHZhciBzdW1tYXJ5ID0ge1xuICAgIHZlcnNpb25zU2VlbjogdmVyc2lvbnMubGVuZ3RoLFxuICAgIHZlcnNpb25zRGVsZXRlZDogZGVsZXRlZCxcbiAgICB2ZXJzaW9uc1NraXBwZWQ6IHNraXBwZWRcbiAgfTtcbiAgbG9nSW1wbCgncHJ1bmUgc3VtbWFyeTogdmVyc2lvbnMgc2Vlbj0nICsgc3VtbWFyeS52ZXJzaW9uc1NlZW4gKyAnIGRlbGV0ZWQ9JyArIHN1bW1hcnkudmVyc2lvbnNEZWxldGVkICsgJyBza2lwcGVkPScgKyBzdW1tYXJ5LnZlcnNpb25zU2tpcHBlZCArICcga2VwdD0nICsgKGtlZXBWZXJzaW9uIHx8ICc8bm9uZT4nKSk7XG4gIHJldHVybiBzdW1tYXJ5O1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG4gIC8vIERlbGV0ZSBydW5zIHdoaWxlIENsb3VkRm9ybWF0aW9uIGRlbGV0ZXMgdGhlIHdob2xlIGltYWdlLCBzbyB0aGVyZSBpc1xuICAvLyBub3RoaW5nIHRvIHBydW5lIGFuZCBwcnVuaW5nIG11c3QgbmV2ZXIgYmxvY2sgb3IgZmFpbCBkZWxldGlvbi5cbiAgaWYgKGV2ZW50ICYmIGV2ZW50LlJlcXVlc3RUeXBlID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiB7fTtcbiAgfVxuICB2YXIgaW1hZ2VJZGVudGlmaWVyID0gcmVxdWlyZWRFbnYoJ0FQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX0FSTicpO1xuICB2YXIgcmVnaW9uID0gcmVzb2x2ZVJlZ2lvbigpO1xuICB2YXIgc3VtbWFyeSA9IGF3YWl0IHBydW5lTWljcm92bUltYWdlVmVyc2lvbnMoe1xuICAgIGltYWdlSWRlbnRpZmllcjogaW1hZ2VJZGVudGlmaWVyLFxuICAgIHJlZ2lvbjogcmVnaW9uLFxuICAgIG5vdzogbmV3IERhdGUoKSxcbiAgICBmZXRjaEltcGw6IGZldGNoLFxuICAgIGxvZ0ltcGw6IGxvZ1xuICB9KTtcbiAgcmV0dXJuIHtcbiAgICBEYXRhOiB7XG4gICAgICBWZXJzaW9uc1NlZW46IHN1bW1hcnkudmVyc2lvbnNTZWVuLFxuICAgICAgVmVyc2lvbnNEZWxldGVkOiBzdW1tYXJ5LnZlcnNpb25zRGVsZXRlZCxcbiAgICAgIFZlcnNpb25zU2tpcHBlZDogc3VtbWFyeS52ZXJzaW9uc1NraXBwZWRcbiAgICB9XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBoYW5kbGVyOiBoYW5kbGVyLFxuICBwcnVuZU1pY3Jvdm1JbWFnZVZlcnNpb25zOiBwcnVuZU1pY3Jvdm1JbWFnZVZlcnNpb25zLFxuICBsaXN0TWljcm92bUltYWdlVmVyc2lvbnM6IGxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9ucyxcbiAgZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbjogZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbixcbiAgbGF0ZXN0QWN0aXZlVmVyc2lvbjogbGF0ZXN0QWN0aXZlVmVyc2lvbixcbiAgc2lnblY0OiBzaWduVjQsXG4gIGVzY2FwZVBhdGhDb21wb25lbnQ6IGVzY2FwZVBhdGhDb21wb25lbnRcbn07XG5gO1xuIl19