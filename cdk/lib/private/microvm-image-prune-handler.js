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
 * outside `A-Za-z0-9-._~` percent-encoded, including `/`). The SigV4 canonical URI is
 * the SDK's DOUBLE-encoded form: the signer re-escapes the already-escaped wire path
 * (`escapePath(uriPath, false)`), so `%3A` in the wire path becomes `%253A` in the
 * canonical request; the wire path sent to the service stays single-encoded.
 *
 * A 404 (`ResourceNotFoundException`) from the version list means the image does not
 * exist yet (fresh stack CREATE runs the prune before `AWS::Lambda::MicrovmImage` is
 * created) and is treated as nothing to prune.
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

function canonicalUriPath(path) {
  // SigV4 canonical URI: the SDK signer re-escapes the already-escaped wire
  // path (httpbinding.EscapePath(uriPath, false)): '/' separators are left
  // as-is and every other byte outside A-Za-z0-9-._~ is percent-encoded, so
  // the '%' of an existing escape becomes '%25' (double-encoded). The wire
  // path is unchanged. The wire path is pure ASCII at this point, so a
  // per-code-unit pass is byte-accurate.
  var out = '';
  for (var i = 0; i < path.length; i++) {
    var c = path[i];
    if (c === '/') {
      out += c;
    } else {
      out += escapePathComponent(c);
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
  var canonical = canonicalRequest(options.method, canonicalUriPath(options.path), queryString, signingHeaders, options.payloadHash);
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
    queryString: queryString,
    canonicalRequest: canonical
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
  var parsed;
  try {
    parsed = await microvmRequest({
      method: 'GET',
      path: path,
      query: query,
      region: options.region,
      now: options.now,
      fetchImpl: options.fetchImpl
    });
  } catch (err) {
    // A fresh stack CREATE runs the prune custom resource before
    // AWS::Lambda::MicrovmImage exists, so the control plane answers the
    // version list with 404 (ResourceNotFoundException). There is nothing
    // to prune yet: treat a 404 on the list as success with zero versions.
    // This is deliberately not a blanket Create skip, so a re-invocation
    // after partial state (image exists, list succeeds) still prunes.
    // Any other list failure (auth, transport, service) still fails loudly.
    if (err && err.statusCode === 404) {
      return { items: [], nextToken: undefined };
    }
    throw err;
  }
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

function keepActiveVersions(versions) {
  // Keeps the two newest ACTIVE versions (newest first). Running MicroVMs may
  // still reference the previously active version, so keeping only the newest
  // would rely entirely on service-side refusal (409) to protect running VMs;
  // keeping the previous ACTIVE version as a safety copy still bounds the
  // version count (everything older is pruned on every deploy).
  var active = [];
  for (var i = 0; i < versions.length; i++) {
    var item = versions[i];
    if (!item) {
      continue;
    }
    if (String(item.status || '').toUpperCase() !== 'ACTIVE') {
      continue;
    }
    active.push(item);
  }
  active.sort(function (a, b) {
    var ac = createdAtEpochSeconds(a);
    var bc = createdAtEpochSeconds(b);
    if (ac !== bc) {
      return bc - ac;
    }
    // Same createdAt: higher version number first.
    return compareVersions(String(b.imageVersion || ''), String(a.imageVersion || ''));
  });
  return active.slice(0, 2);
}

async function pruneMicrovmImageVersions(options) {
  // options: imageIdentifier, region, now, fetchImpl, logImpl
  var logImpl = options.logImpl || log;
  // A list failure (auth, transport, service) must fail the deployment loudly;
  // silent quota debt is the failure mode this handler exists to prevent. The
  // single exception is a 404 on the list, handled inside listMicrovmImageVersions:
  // the image does not exist yet (fresh stack CREATE) and there is nothing to prune.
  var versions = await listAllVersions(options);
  var keep = keepActiveVersions(versions);
  var keepSet = {};
  var keptLabel = '<none>';
  for (var j = 0; j < keep.length; j++) {
    var keptVersion = String(keep[j].imageVersion || '');
    keepSet[keptVersion] = true;
    keptLabel = keptLabel === '<none>' ? keptVersion : keptLabel + ',' + keptVersion;
  }
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
    if (keepSet[version]) {
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
  logImpl('prune summary: versions seen=' + summary.versionsSeen + ' deleted=' + summary.versionsDeleted + ' skipped=' + summary.versionsSkipped + ' kept=' + keptLabel);
  return summary;
}

async function handler(event) {
  // Delete runs while CloudFormation deletes the whole image, so there is
  // nothing to prune and pruning must never block or fail deletion.
  // Create/Update both run the prune: on a fresh stack CREATE the image does
  // not exist yet, the version list 404s, and that is treated as nothing to
  // prune, so the create succeeds.
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
  keepActiveVersions: keepActiveVersions,
  signV4: signV4,
  canonicalRequest: canonicalRequest,
  canonicalUriPath: canonicalUriPath,
  escapePathComponent: escapePathComponent
};
`;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS1wcnVuZS1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1pbWFnZS1wcnVuZS1oYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FvQ0c7QUFDVSxRQUFBLGtDQUFrQyxHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb2JqRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTZWxmLWNvbnRhaW5lZCBMYW1iZGEgaGFuZGxlciBmb3IgYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZWAgdmVyc2lvbiBwcnVuaW5nLlxuICpcbiAqIFRoZSBoYW5kbGVyIHNvdXJjZSBpcyBlbWJlZGRlZCBhcyBhIHN0cmluZyBjb25zdGFudCBzbyB0aGUgY29uc3RydWN0IGNhbiBkZXBsb3lcbiAqIGl0IGFzIGlubGluZSBMYW1iZGEgY29kZSBmcm9tIGV2ZXJ5IGpzaWkgdGFyZ2V0IChUeXBlU2NyaXB0LCBQeXRob24sIEdvKSB3aXRob3V0XG4gKiBhIGJ1bmRsaW5nIG9yIGFzc2V0IHN0ZXAuIEl0IHRhbGtzIHRvIHRoZSBMYW1iZGEgTWljcm9WTXMgY29udHJvbCBwbGFuZVxuICogKGBMaXN0TWljcm92bUltYWdlVmVyc2lvbnNgIC8gYERlbGV0ZU1pY3Jvdm1JbWFnZVZlcnNpb25gKSB3aXRoIHJhdyBTaWdWNC1zaWduZWRcbiAqIEhUVFBTIHJlcXVlc3RzIGFuZCBoYXMgbm8gcnVudGltZSBkZXBlbmRlbmNpZXMgYmV5b25kIHRoZSBOb2RlIHN0YW5kYXJkIGxpYnJhcnlcbiAqIGFuZCB0aGUgcGxhdGZvcm0gYGZldGNoYCBnbG9iYWwuXG4gKlxuICogUmVxdWVzdCBzaGFwZXMgYmVsb3cgbWlycm9yIHRoZSBwaW5uZWQgYGxhbWJkYW1pY3Jvdm1zYCBBV1MgU0RLIHYxLjAuMFxuICogKGF3cy1zZGstZ28tdjIgc2VydmljZSBtb2RlbCwgc21pdGh5IFJFU1QtSlNPTiBwcm90b2NvbCk6XG4gKlxuICogLSBMaXN0TWljcm92bUltYWdlVmVyc2lvbnM6IEdFVCAvMjAyNS0wOS0wOS9taWNyb3ZtLWltYWdlcy97aW1hZ2VJZGVudGlmaWVyfS92ZXJzaW9uc1xuICogICB3aXRoIG9wdGlvbmFsIGBtYXhSZXN1bHRzYCAvIGBuZXh0VG9rZW5gIHF1ZXJ5IHBhcmFtZXRlcnM7IHJlc3BvbnNlIGJvZHlcbiAqICAgYHsgXCJpdGVtc1wiOiBbLi4uXSwgXCJuZXh0VG9rZW5cIjogXCIuLi5cIiB9YC5cbiAqIC0gRGVsZXRlTWljcm92bUltYWdlVmVyc2lvbjogREVMRVRFIC8yMDI1LTA5LTA5L21pY3Jvdm0taW1hZ2VzL3tpbWFnZUlkZW50aWZpZXJ9L3ZlcnNpb25zL3tpbWFnZVZlcnNpb259XG4gKiAgIHdpdGggYW4gZW1wdHkgYm9keTsgcmVzcG9uc2UgYm9keSBgeyBcImltYWdlSWRlbnRpZmllclwiOiBcIi4uLlwiLCBcImltYWdlVmVyc2lvblwiOiBcIi4uLlwiLCBcInN0YXRlXCI6IFwiLi4uXCIgfWAuXG4gKlxuICogU2lnVjQgc2lnbmluZyBuYW1lIGlzIGBsYW1iZGFgIGFuZCB0aGUgZW5kcG9pbnQgaG9zdCBpcyBgbGFtYmRhLntyZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICogYm90aCB0YWtlbiBmcm9tIHRoZSBwaW5uZWQgU0RLIChzZXJ2aWNlIGF1dGggdHJhaXQgYW5kIGVuZHBvaW50IHJ1bGVzZXQpLlxuICogUGF0aCBwYXJhbWV0ZXJzIGFyZSBlc2NhcGVkIHdpdGggdGhlIFNESydzIEFtYXpvbiBwYXRoLWVzY2FwZSBzdHlsZSAoZXZlcnkgYnl0ZVxuICogb3V0c2lkZSBgQS1aYS16MC05LS5ffmAgcGVyY2VudC1lbmNvZGVkLCBpbmNsdWRpbmcgYC9gKS4gVGhlIFNpZ1Y0IGNhbm9uaWNhbCBVUkkgaXNcbiAqIHRoZSBTREsncyBET1VCTEUtZW5jb2RlZCBmb3JtOiB0aGUgc2lnbmVyIHJlLWVzY2FwZXMgdGhlIGFscmVhZHktZXNjYXBlZCB3aXJlIHBhdGhcbiAqIChgZXNjYXBlUGF0aCh1cmlQYXRoLCBmYWxzZSlgKSwgc28gYCUzQWAgaW4gdGhlIHdpcmUgcGF0aCBiZWNvbWVzIGAlMjUzQWAgaW4gdGhlXG4gKiBjYW5vbmljYWwgcmVxdWVzdDsgdGhlIHdpcmUgcGF0aCBzZW50IHRvIHRoZSBzZXJ2aWNlIHN0YXlzIHNpbmdsZS1lbmNvZGVkLlxuICpcbiAqIEEgNDA0IChgUmVzb3VyY2VOb3RGb3VuZEV4Y2VwdGlvbmApIGZyb20gdGhlIHZlcnNpb24gbGlzdCBtZWFucyB0aGUgaW1hZ2UgZG9lcyBub3RcbiAqIGV4aXN0IHlldCAoZnJlc2ggc3RhY2sgQ1JFQVRFIHJ1bnMgdGhlIHBydW5lIGJlZm9yZSBgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZWAgaXNcbiAqIGNyZWF0ZWQpIGFuZCBpcyB0cmVhdGVkIGFzIG5vdGhpbmcgdG8gcHJ1bmUuXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgaW50ZXJuYWwgdG8gdGhlIENESyBwYWNrYWdlIGFuZCBpbnRlbnRpb25hbGx5IE5PVCBleHBvcnRlZCBmcm9tXG4gKiBgaW5kZXgudHNgLCBzbyBpdCBuZXZlciBhcHBlYXJzIGluIHRoZSBqc2lpIGFzc2VtYmx5IG9yIGdlbmVyYXRlZCBiaW5kaW5ncy4gVGhlXG4gKiBjb21waWxlZCBgLmpzYCBpcyBsb2FkZWQgZGlyZWN0bHkgYnkgdGhlIGNvbnN0cnVjdCBhbmQgYnkgdGhlIGhhbmRsZXIgdW5pdCB0ZXN0cy5cbiAqXG4gKiBAaW50ZXJuYWxcbiAqL1xuZXhwb3J0IGNvbnN0IE1JQ1JPVk1fSU1BR0VfUFJVTkVfSEFORExFUl9TT1VSQ0UgPSBgJ3VzZSBzdHJpY3QnO1xuXG52YXIgY3J5cHRvID0gcmVxdWlyZSgnbm9kZTpjcnlwdG8nKTtcblxudmFyIFNFUlZJQ0VfTkFNRSA9ICdsYW1iZGEnO1xudmFyIEFQSV9QQVRIX1BSRUZJWCA9ICcvMjAyNS0wOS0wOS9taWNyb3ZtLWltYWdlcyc7XG52YXIgTUFYX1JFU1VMVFMgPSAxMDA7XG52YXIgRU1QVFlfU0hBMjU2ID0gJ2UzYjBjNDQyOThmYzFjMTQ5YWZiZjRjODk5NmZiOTI0MjdhZTQxZTQ2NDliOTM0Y2E0OTU5OTFiNzg1MmI4NTUnO1xuXG5mdW5jdGlvbiBsb2cobWVzc2FnZSkge1xuICBjb25zb2xlLmxvZygnW21pY3Jvdm0taW1hZ2UtcHJ1bmVdICcgKyBtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gcmVxdWlyZWRFbnYobmFtZSkge1xuICB2YXIgdmFsdWUgPSBwcm9jZXNzLmVudltuYW1lXTtcbiAgaWYgKCF2YWx1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcignbWljcm92bS1pbWFnZS1wcnVuZTogbWlzc2luZyByZXF1aXJlZCBlbnZpcm9ubWVudCB2YXJpYWJsZSAnICsgbmFtZSk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlUmVnaW9uKCkge1xuICB2YXIgcmVnaW9uID0gcHJvY2Vzcy5lbnYuQVBQVEhFT1JZX01JQ1JPVk1fSU1BR0VfUkVHSU9OIHx8IHByb2Nlc3MuZW52LkFXU19SRUdJT04gfHwgcHJvY2Vzcy5lbnYuQVdTX0RFRkFVTFRfUkVHSU9OO1xuICBpZiAoIXJlZ2lvbikge1xuICAgIHRocm93IG5ldyBFcnJvcignbWljcm92bS1pbWFnZS1wcnVuZTogdW5hYmxlIHRvIGRldGVybWluZSBBV1MgcmVnaW9uJyk7XG4gIH1cbiAgcmV0dXJuIHJlZ2lvbjtcbn1cblxuZnVuY3Rpb24gY3JlZGVudGlhbHMoKSB7XG4gIHZhciBhY2Nlc3NLZXlJZCA9IHByb2Nlc3MuZW52LkFXU19BQ0NFU1NfS0VZX0lEO1xuICB2YXIgc2VjcmV0QWNjZXNzS2V5ID0gcHJvY2Vzcy5lbnYuQVdTX1NFQ1JFVF9BQ0NFU1NfS0VZO1xuICBpZiAoIWFjY2Vzc0tleUlkIHx8ICFzZWNyZXRBY2Nlc3NLZXkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ21pY3Jvdm0taW1hZ2UtcHJ1bmU6IEFXUyBjcmVkZW50aWFscyBhcmUgbm90IGF2YWlsYWJsZSBpbiB0aGUgTGFtYmRhIGVudmlyb25tZW50Jyk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhY2Nlc3NLZXlJZDogYWNjZXNzS2V5SWQsXG4gICAgc2VjcmV0QWNjZXNzS2V5OiBzZWNyZXRBY2Nlc3NLZXksXG4gICAgc2Vzc2lvblRva2VuOiBwcm9jZXNzLmVudi5BV1NfU0VTU0lPTl9UT0tFTiB8fCAnJ1xuICB9O1xufVxuXG5mdW5jdGlvbiBlc2NhcGVQYXRoQ29tcG9uZW50KHZhbHVlKSB7XG4gIC8vIE1pcnJvcnMgdGhlIHBpbm5lZCBTREsncyBBbWF6b24gcGF0aC1lc2NhcGUgc3R5bGU6IGV2ZXJ5IGJ5dGUgb3V0c2lkZVxuICAvLyBBLVphLXowLTktLl9+IGlzIHBlcmNlbnQtZW5jb2RlZCAoaW5jbHVkaW5nICcvJyksIHVwcGVyY2FzZSBoZXguXG4gIHZhciBvdXQgPSAnJztcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkrKykge1xuICAgIHZhciBjID0gdmFsdWUuY2hhckNvZGVBdChpKTtcbiAgICBpZiAoKGMgPj0gNjUgJiYgYyA8PSA5MCkgfHwgKGMgPj0gOTcgJiYgYyA8PSAxMjIpIHx8IChjID49IDQ4ICYmIGMgPD0gNTcpIHx8IGMgPT09IDQ1IHx8IGMgPT09IDQ2IHx8IGMgPT09IDk1IHx8IGMgPT09IDEyNikge1xuICAgICAgb3V0ICs9IHZhbHVlW2ldO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXQgKz0gJyUnICsgYy50b1N0cmluZygxNikudG9VcHBlckNhc2UoKS5wYWRTdGFydCgyLCAnMCcpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBjYW5vbmljYWxVcmlQYXRoKHBhdGgpIHtcbiAgLy8gU2lnVjQgY2Fub25pY2FsIFVSSTogdGhlIFNESyBzaWduZXIgcmUtZXNjYXBlcyB0aGUgYWxyZWFkeS1lc2NhcGVkIHdpcmVcbiAgLy8gcGF0aCAoaHR0cGJpbmRpbmcuRXNjYXBlUGF0aCh1cmlQYXRoLCBmYWxzZSkpOiAnLycgc2VwYXJhdG9ycyBhcmUgbGVmdFxuICAvLyBhcy1pcyBhbmQgZXZlcnkgb3RoZXIgYnl0ZSBvdXRzaWRlIEEtWmEtejAtOS0uX34gaXMgcGVyY2VudC1lbmNvZGVkLCBzb1xuICAvLyB0aGUgJyUnIG9mIGFuIGV4aXN0aW5nIGVzY2FwZSBiZWNvbWVzICclMjUnIChkb3VibGUtZW5jb2RlZCkuIFRoZSB3aXJlXG4gIC8vIHBhdGggaXMgdW5jaGFuZ2VkLiBUaGUgd2lyZSBwYXRoIGlzIHB1cmUgQVNDSUkgYXQgdGhpcyBwb2ludCwgc28gYVxuICAvLyBwZXItY29kZS11bml0IHBhc3MgaXMgYnl0ZS1hY2N1cmF0ZS5cbiAgdmFyIG91dCA9ICcnO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHBhdGgubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgYyA9IHBhdGhbaV07XG4gICAgaWYgKGMgPT09ICcvJykge1xuICAgICAgb3V0ICs9IGM7XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dCArPSBlc2NhcGVQYXRoQ29tcG9uZW50KGMpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBlc2NhcGVRdWVyeSh2YWx1ZSkge1xuICAvLyBSRkMgMzk4NiBwZXJjZW50LWVuY29kaW5nIGZvciBxdWVyeSBuYW1lcyBhbmQgdmFsdWVzLlxuICB2YXIgb3V0ID0gJyc7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgYyA9IHZhbHVlLmNoYXJDb2RlQXQoaSk7XG4gICAgaWYgKChjID49IDY1ICYmIGMgPD0gOTApIHx8IChjID49IDk3ICYmIGMgPD0gMTIyKSB8fCAoYyA+PSA0OCAmJiBjIDw9IDU3KSB8fCBjID09PSA0NSB8fCBjID09PSA0NiB8fCBjID09PSA5NSB8fCBjID09PSAxMjYpIHtcbiAgICAgIG91dCArPSB2YWx1ZVtpXTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0ICs9ICclJyArIGMudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKCkucGFkU3RhcnQoMiwgJzAnKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gc2hhMjU2SGV4KGRhdGEpIHtcbiAgcmV0dXJuIGNyeXB0by5jcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUoZGF0YSwgJ3V0ZjgnKS5kaWdlc3QoJ2hleCcpO1xufVxuXG5mdW5jdGlvbiBobWFjU2hhMjU2KGtleSwgZGF0YSkge1xuICByZXR1cm4gY3J5cHRvLmNyZWF0ZUhtYWMoJ3NoYTI1NicsIGtleSkudXBkYXRlKGRhdGEsICd1dGY4JykuZGlnZXN0KCk7XG59XG5cbmZ1bmN0aW9uIGlzbzg2MDFCYXNpYyhkYXRlKSB7XG4gIHJldHVybiBkYXRlLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzotXS9nLCAnJykucmVwbGFjZSgvXFxcXC5cXFxcZHszfS9nLCAnJyk7XG59XG5cbmZ1bmN0aW9uIGNhbm9uaWNhbFF1ZXJ5KHF1ZXJ5KSB7XG4gIGlmICghcXVlcnkpIHtcbiAgICByZXR1cm4gJyc7XG4gIH1cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhxdWVyeSkuc29ydCgpO1xuICB2YXIgcGFydHMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGtleSA9IGVzY2FwZVF1ZXJ5KGtleXNbaV0pO1xuICAgIHZhciB2YWx1ZSA9IHF1ZXJ5W2tleXNbaV1dO1xuICAgIHBhcnRzLnB1c2goa2V5ICsgJz0nICsgZXNjYXBlUXVlcnkodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCA/ICcnIDogU3RyaW5nKHZhbHVlKSkpO1xuICB9XG4gIHJldHVybiBwYXJ0cy5qb2luKCcmJyk7XG59XG5cbmZ1bmN0aW9uIGNhbm9uaWNhbFJlcXVlc3QobWV0aG9kLCBwYXRoLCBxdWVyeVN0cmluZywgaGVhZGVycywgcGF5bG9hZEhhc2gpIHtcbiAgdmFyIG5hbWVzID0gT2JqZWN0LmtleXMoaGVhZGVycykuc29ydCgpO1xuICB2YXIgY2Fub25pY2FsSGVhZGVycyA9ICcnO1xuICB2YXIgc2lnbmVkSGVhZGVycyA9IFtdO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5hbWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIG5hbWUgPSBuYW1lc1tpXS50b0xvd2VyQ2FzZSgpO1xuICAgIGNhbm9uaWNhbEhlYWRlcnMgKz0gbmFtZSArICc6JyArIFN0cmluZyhoZWFkZXJzW25hbWVzW2ldXSkudHJpbSgpICsgJ1xcXFxuJztcbiAgICBzaWduZWRIZWFkZXJzLnB1c2gobmFtZSk7XG4gIH1cbiAgcmV0dXJuIFttZXRob2QsIHBhdGgsIHF1ZXJ5U3RyaW5nLCBjYW5vbmljYWxIZWFkZXJzLCBzaWduZWRIZWFkZXJzLmpvaW4oJzsnKSwgcGF5bG9hZEhhc2hdLmpvaW4oJ1xcXFxuJyk7XG59XG5cbmZ1bmN0aW9uIHNpZ25WNChvcHRpb25zKSB7XG4gIHZhciBhbXpEYXRlID0gaXNvODYwMUJhc2ljKG9wdGlvbnMubm93KTtcbiAgdmFyIGRhdGVTdGFtcCA9IGFtekRhdGUuc2xpY2UoMCwgOCk7XG4gIHZhciBzaWduaW5nSGVhZGVycyA9IHtcbiAgICAnaG9zdCc6IG9wdGlvbnMuaG9zdCxcbiAgICAneC1hbXotY29udGVudC1zaGEyNTYnOiBvcHRpb25zLnBheWxvYWRIYXNoLFxuICAgICd4LWFtei1kYXRlJzogYW16RGF0ZVxuICB9O1xuICBpZiAob3B0aW9ucy5jcmVkZW50aWFscy5zZXNzaW9uVG9rZW4pIHtcbiAgICBzaWduaW5nSGVhZGVyc1sneC1hbXotc2VjdXJpdHktdG9rZW4nXSA9IG9wdGlvbnMuY3JlZGVudGlhbHMuc2Vzc2lvblRva2VuO1xuICB9XG4gIHZhciBxdWVyeVN0cmluZyA9IGNhbm9uaWNhbFF1ZXJ5KG9wdGlvbnMucXVlcnkpO1xuICB2YXIgY2Fub25pY2FsID0gY2Fub25pY2FsUmVxdWVzdChvcHRpb25zLm1ldGhvZCwgY2Fub25pY2FsVXJpUGF0aChvcHRpb25zLnBhdGgpLCBxdWVyeVN0cmluZywgc2lnbmluZ0hlYWRlcnMsIG9wdGlvbnMucGF5bG9hZEhhc2gpO1xuICB2YXIgc2NvcGUgPSBkYXRlU3RhbXAgKyAnLycgKyBvcHRpb25zLnJlZ2lvbiArICcvJyArIFNFUlZJQ0VfTkFNRSArICcvYXdzNF9yZXF1ZXN0JztcbiAgdmFyIHN0cmluZ1RvU2lnbiA9ICdBV1M0LUhNQUMtU0hBMjU2XFxcXG4nICsgYW16RGF0ZSArICdcXFxcbicgKyBzY29wZSArICdcXFxcbicgKyBzaGEyNTZIZXgoY2Fub25pY2FsKTtcbiAgdmFyIGRhdGVLZXkgPSBobWFjU2hhMjU2KCdBV1M0JyArIG9wdGlvbnMuY3JlZGVudGlhbHMuc2VjcmV0QWNjZXNzS2V5LCBkYXRlU3RhbXApO1xuICB2YXIgcmVnaW9uS2V5ID0gaG1hY1NoYTI1NihkYXRlS2V5LCBvcHRpb25zLnJlZ2lvbik7XG4gIHZhciBzZXJ2aWNlS2V5ID0gaG1hY1NoYTI1NihyZWdpb25LZXksIFNFUlZJQ0VfTkFNRSk7XG4gIHZhciBzaWduaW5nS2V5ID0gaG1hY1NoYTI1NihzZXJ2aWNlS2V5LCAnYXdzNF9yZXF1ZXN0Jyk7XG4gIHZhciBzaWduYXR1cmUgPSBjcnlwdG8uY3JlYXRlSG1hYygnc2hhMjU2Jywgc2lnbmluZ0tleSkudXBkYXRlKHN0cmluZ1RvU2lnbiwgJ3V0ZjgnKS5kaWdlc3QoJ2hleCcpO1xuICB2YXIgc2lnbmVkSGVhZGVycyA9IE9iamVjdC5rZXlzKHNpZ25pbmdIZWFkZXJzKS5zb3J0KCkuam9pbignOycpO1xuICByZXR1cm4ge1xuICAgIGhlYWRlcnM6IE9iamVjdC5hc3NpZ24oe30sIHNpZ25pbmdIZWFkZXJzLCB7XG4gICAgICBhdXRob3JpemF0aW9uOiAnQVdTNC1ITUFDLVNIQTI1NiBDcmVkZW50aWFsPScgKyBvcHRpb25zLmNyZWRlbnRpYWxzLmFjY2Vzc0tleUlkICsgJy8nICsgc2NvcGUgK1xuICAgICAgICAnLCBTaWduZWRIZWFkZXJzPScgKyBzaWduZWRIZWFkZXJzICsgJywgU2lnbmF0dXJlPScgKyBzaWduYXR1cmVcbiAgICB9KSxcbiAgICBxdWVyeVN0cmluZzogcXVlcnlTdHJpbmcsXG4gICAgY2Fub25pY2FsUmVxdWVzdDogY2Fub25pY2FsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVXJsKGhvc3QsIHBhdGgsIHF1ZXJ5U3RyaW5nKSB7XG4gIHZhciB1cmwgPSAnaHR0cHM6Ly8nICsgaG9zdCArIHBhdGg7XG4gIGlmIChxdWVyeVN0cmluZykge1xuICAgIHVybCArPSAnPycgKyBxdWVyeVN0cmluZztcbiAgfVxuICByZXR1cm4gdXJsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtaWNyb3ZtUmVxdWVzdChvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IG1ldGhvZCwgcGF0aCwgcXVlcnksIHJlZ2lvbiwgbm93LCBmZXRjaEltcGxcbiAgdmFyIGhvc3QgPSAnbGFtYmRhLicgKyBvcHRpb25zLnJlZ2lvbiArICcuYW1hem9uYXdzLmNvbSc7XG4gIHZhciBzaWduZWQgPSBzaWduVjQoe1xuICAgIG1ldGhvZDogb3B0aW9ucy5tZXRob2QsXG4gICAgcGF0aDogb3B0aW9ucy5wYXRoLFxuICAgIHF1ZXJ5OiBvcHRpb25zLnF1ZXJ5IHx8IHt9LFxuICAgIGhvc3Q6IGhvc3QsXG4gICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICBub3c6IG9wdGlvbnMubm93LFxuICAgIHBheWxvYWRIYXNoOiBFTVBUWV9TSEEyNTYsXG4gICAgY3JlZGVudGlhbHM6IGNyZWRlbnRpYWxzKClcbiAgfSk7XG4gIHZhciB1cmwgPSBidWlsZFVybChob3N0LCBvcHRpb25zLnBhdGgsIHNpZ25lZC5xdWVyeVN0cmluZyk7XG4gIHZhciByZXNwb25zZSA9IGF3YWl0IG9wdGlvbnMuZmV0Y2hJbXBsKHVybCwge1xuICAgIG1ldGhvZDogb3B0aW9ucy5tZXRob2QsXG4gICAgaGVhZGVyczogc2lnbmVkLmhlYWRlcnNcbiAgfSk7XG4gIHZhciBib2R5VGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgdmFyIHBhcnNlZCA9IG51bGw7XG4gIGlmIChib2R5VGV4dCkge1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGJvZHlUZXh0KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHBhcnNlZCA9IG51bGw7XG4gICAgfVxuICB9XG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICB2YXIgZXJyb3IgPSBuZXcgRXJyb3IoJ21pY3Jvdm0taW1hZ2UtcHJ1bmU6ICcgKyBvcHRpb25zLm1ldGhvZCArICcgJyArIG9wdGlvbnMucGF0aCArICcgZmFpbGVkIHdpdGggSFRUUCAnICsgcmVzcG9uc2Uuc3RhdHVzICsgJzogJyArIGJvZHlUZXh0KTtcbiAgICBlcnJvci5zdGF0dXNDb2RlID0gcmVzcG9uc2Uuc3RhdHVzO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9ucyhvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IGltYWdlSWRlbnRpZmllciwgcmVnaW9uLCBub3csIGZldGNoSW1wbCwgbmV4dFRva2VuLCBtYXhSZXN1bHRzXG4gIHZhciBxdWVyeSA9IHt9O1xuICBpZiAob3B0aW9ucy5tYXhSZXN1bHRzICE9PSB1bmRlZmluZWQgJiYgb3B0aW9ucy5tYXhSZXN1bHRzICE9PSBudWxsKSB7XG4gICAgcXVlcnkubWF4UmVzdWx0cyA9IFN0cmluZyhvcHRpb25zLm1heFJlc3VsdHMpO1xuICB9XG4gIGlmIChvcHRpb25zLm5leHRUb2tlbikge1xuICAgIHF1ZXJ5Lm5leHRUb2tlbiA9IG9wdGlvbnMubmV4dFRva2VuO1xuICB9XG4gIHZhciBwYXRoID0gQVBJX1BBVEhfUFJFRklYICsgJy8nICsgZXNjYXBlUGF0aENvbXBvbmVudChvcHRpb25zLmltYWdlSWRlbnRpZmllcikgKyAnL3ZlcnNpb25zJztcbiAgdmFyIHBhcnNlZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBhd2FpdCBtaWNyb3ZtUmVxdWVzdCh7XG4gICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgcGF0aDogcGF0aCxcbiAgICAgIHF1ZXJ5OiBxdWVyeSxcbiAgICAgIHJlZ2lvbjogb3B0aW9ucy5yZWdpb24sXG4gICAgICBub3c6IG9wdGlvbnMubm93LFxuICAgICAgZmV0Y2hJbXBsOiBvcHRpb25zLmZldGNoSW1wbFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBBIGZyZXNoIHN0YWNrIENSRUFURSBydW5zIHRoZSBwcnVuZSBjdXN0b20gcmVzb3VyY2UgYmVmb3JlXG4gICAgLy8gQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZSBleGlzdHMsIHNvIHRoZSBjb250cm9sIHBsYW5lIGFuc3dlcnMgdGhlXG4gICAgLy8gdmVyc2lvbiBsaXN0IHdpdGggNDA0IChSZXNvdXJjZU5vdEZvdW5kRXhjZXB0aW9uKS4gVGhlcmUgaXMgbm90aGluZ1xuICAgIC8vIHRvIHBydW5lIHlldDogdHJlYXQgYSA0MDQgb24gdGhlIGxpc3QgYXMgc3VjY2VzcyB3aXRoIHplcm8gdmVyc2lvbnMuXG4gICAgLy8gVGhpcyBpcyBkZWxpYmVyYXRlbHkgbm90IGEgYmxhbmtldCBDcmVhdGUgc2tpcCwgc28gYSByZS1pbnZvY2F0aW9uXG4gICAgLy8gYWZ0ZXIgcGFydGlhbCBzdGF0ZSAoaW1hZ2UgZXhpc3RzLCBsaXN0IHN1Y2NlZWRzKSBzdGlsbCBwcnVuZXMuXG4gICAgLy8gQW55IG90aGVyIGxpc3QgZmFpbHVyZSAoYXV0aCwgdHJhbnNwb3J0LCBzZXJ2aWNlKSBzdGlsbCBmYWlscyBsb3VkbHkuXG4gICAgaWYgKGVyciAmJiBlcnIuc3RhdHVzQ29kZSA9PT0gNDA0KSB7XG4gICAgICByZXR1cm4geyBpdGVtczogW10sIG5leHRUb2tlbjogdW5kZWZpbmVkIH07XG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxuICByZXR1cm4ge1xuICAgIGl0ZW1zOiBwYXJzZWQgJiYgQXJyYXkuaXNBcnJheShwYXJzZWQuaXRlbXMpID8gcGFyc2VkLml0ZW1zIDogW10sXG4gICAgbmV4dFRva2VuOiBwYXJzZWQgJiYgcGFyc2VkLm5leHRUb2tlbiA/IHBhcnNlZC5uZXh0VG9rZW4gOiB1bmRlZmluZWRcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbihvcHRpb25zKSB7XG4gIC8vIG9wdGlvbnM6IGltYWdlSWRlbnRpZmllciwgaW1hZ2VWZXJzaW9uLCByZWdpb24sIG5vdywgZmV0Y2hJbXBsXG4gIHZhciBwYXRoID0gQVBJX1BBVEhfUFJFRklYICsgJy8nICsgZXNjYXBlUGF0aENvbXBvbmVudChvcHRpb25zLmltYWdlSWRlbnRpZmllcikgKyAnL3ZlcnNpb25zLycgKyBlc2NhcGVQYXRoQ29tcG9uZW50KG9wdGlvbnMuaW1hZ2VWZXJzaW9uKTtcbiAgYXdhaXQgbWljcm92bVJlcXVlc3Qoe1xuICAgIG1ldGhvZDogJ0RFTEVURScsXG4gICAgcGF0aDogcGF0aCxcbiAgICBxdWVyeToge30sXG4gICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICBub3c6IG9wdGlvbnMubm93LFxuICAgIGZldGNoSW1wbDogb3B0aW9ucy5mZXRjaEltcGxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RBbGxWZXJzaW9ucyhvcHRpb25zKSB7XG4gIHZhciB2ZXJzaW9ucyA9IFtdO1xuICB2YXIgbmV4dFRva2VuID0gdW5kZWZpbmVkO1xuICB2YXIgcGFnZU51bWJlciA9IDA7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgcGFnZU51bWJlciArPSAxO1xuICAgIGlmIChwYWdlTnVtYmVyID4gMTAwMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtaWNyb3ZtLWltYWdlLXBydW5lOiB2ZXJzaW9uIGxpc3RpbmcgZXhjZWVkZWQgcGFnaW5hdGlvbiBndWFyZCcpO1xuICAgIH1cbiAgICB2YXIgcGFnZSA9IGF3YWl0IGxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9ucyh7XG4gICAgICBpbWFnZUlkZW50aWZpZXI6IG9wdGlvbnMuaW1hZ2VJZGVudGlmaWVyLFxuICAgICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICAgIG5vdzogb3B0aW9ucy5ub3csXG4gICAgICBmZXRjaEltcGw6IG9wdGlvbnMuZmV0Y2hJbXBsLFxuICAgICAgbmV4dFRva2VuOiBuZXh0VG9rZW4sXG4gICAgICBtYXhSZXN1bHRzOiBNQVhfUkVTVUxUU1xuICAgIH0pO1xuICAgIHZlcnNpb25zID0gdmVyc2lvbnMuY29uY2F0KHBhZ2UuaXRlbXMgfHwgW10pO1xuICAgIG5leHRUb2tlbiA9IHBhZ2UubmV4dFRva2VuO1xuICAgIGlmICghbmV4dFRva2VuKSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZlcnNpb25zO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVkQXRFcG9jaFNlY29uZHMoaXRlbSkge1xuICB2YXIgdmFsdWUgPSBpdGVtICYmIGl0ZW0uY3JlYXRlZEF0O1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgIHZhciBwYXJzZWQgPSBEYXRlLnBhcnNlKHZhbHVlKTtcbiAgICBpZiAoIWlzTmFOKHBhcnNlZCkpIHtcbiAgICAgIHJldHVybiBwYXJzZWQgLyAxMDAwO1xuICAgIH1cbiAgfVxuICByZXR1cm4gMDtcbn1cblxuZnVuY3Rpb24gdmVyc2lvbk51bWJlcih2YWx1ZSkge1xuICBpZiAoL15cXFxcZCskLy50ZXN0KHZhbHVlKSkge1xuICAgIHJldHVybiBwYXJzZUludCh2YWx1ZSwgMTApO1xuICB9XG4gIHJldHVybiBOYU47XG59XG5cbmZ1bmN0aW9uIGNvbXBhcmVWZXJzaW9ucyhhLCBiKSB7XG4gIHZhciBuYSA9IHZlcnNpb25OdW1iZXIoYSk7XG4gIHZhciBuYiA9IHZlcnNpb25OdW1iZXIoYik7XG4gIGlmICghaXNOYU4obmEpICYmICFpc05hTihuYikpIHtcbiAgICByZXR1cm4gbmEgLSBuYjtcbiAgfVxuICBpZiAoYSA9PT0gYikge1xuICAgIHJldHVybiAwO1xuICB9XG4gIHJldHVybiBhIDwgYiA/IC0xIDogMTtcbn1cblxuZnVuY3Rpb24ga2VlcEFjdGl2ZVZlcnNpb25zKHZlcnNpb25zKSB7XG4gIC8vIEtlZXBzIHRoZSB0d28gbmV3ZXN0IEFDVElWRSB2ZXJzaW9ucyAobmV3ZXN0IGZpcnN0KS4gUnVubmluZyBNaWNyb1ZNcyBtYXlcbiAgLy8gc3RpbGwgcmVmZXJlbmNlIHRoZSBwcmV2aW91c2x5IGFjdGl2ZSB2ZXJzaW9uLCBzbyBrZWVwaW5nIG9ubHkgdGhlIG5ld2VzdFxuICAvLyB3b3VsZCByZWx5IGVudGlyZWx5IG9uIHNlcnZpY2Utc2lkZSByZWZ1c2FsICg0MDkpIHRvIHByb3RlY3QgcnVubmluZyBWTXM7XG4gIC8vIGtlZXBpbmcgdGhlIHByZXZpb3VzIEFDVElWRSB2ZXJzaW9uIGFzIGEgc2FmZXR5IGNvcHkgc3RpbGwgYm91bmRzIHRoZVxuICAvLyB2ZXJzaW9uIGNvdW50IChldmVyeXRoaW5nIG9sZGVyIGlzIHBydW5lZCBvbiBldmVyeSBkZXBsb3kpLlxuICB2YXIgYWN0aXZlID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmVyc2lvbnMubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgaXRlbSA9IHZlcnNpb25zW2ldO1xuICAgIGlmICghaXRlbSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChTdHJpbmcoaXRlbS5zdGF0dXMgfHwgJycpLnRvVXBwZXJDYXNlKCkgIT09ICdBQ1RJVkUnKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgYWN0aXZlLnB1c2goaXRlbSk7XG4gIH1cbiAgYWN0aXZlLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICB2YXIgYWMgPSBjcmVhdGVkQXRFcG9jaFNlY29uZHMoYSk7XG4gICAgdmFyIGJjID0gY3JlYXRlZEF0RXBvY2hTZWNvbmRzKGIpO1xuICAgIGlmIChhYyAhPT0gYmMpIHtcbiAgICAgIHJldHVybiBiYyAtIGFjO1xuICAgIH1cbiAgICAvLyBTYW1lIGNyZWF0ZWRBdDogaGlnaGVyIHZlcnNpb24gbnVtYmVyIGZpcnN0LlxuICAgIHJldHVybiBjb21wYXJlVmVyc2lvbnMoU3RyaW5nKGIuaW1hZ2VWZXJzaW9uIHx8ICcnKSwgU3RyaW5nKGEuaW1hZ2VWZXJzaW9uIHx8ICcnKSk7XG4gIH0pO1xuICByZXR1cm4gYWN0aXZlLnNsaWNlKDAsIDIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcnVuZU1pY3Jvdm1JbWFnZVZlcnNpb25zKG9wdGlvbnMpIHtcbiAgLy8gb3B0aW9uczogaW1hZ2VJZGVudGlmaWVyLCByZWdpb24sIG5vdywgZmV0Y2hJbXBsLCBsb2dJbXBsXG4gIHZhciBsb2dJbXBsID0gb3B0aW9ucy5sb2dJbXBsIHx8IGxvZztcbiAgLy8gQSBsaXN0IGZhaWx1cmUgKGF1dGgsIHRyYW5zcG9ydCwgc2VydmljZSkgbXVzdCBmYWlsIHRoZSBkZXBsb3ltZW50IGxvdWRseTtcbiAgLy8gc2lsZW50IHF1b3RhIGRlYnQgaXMgdGhlIGZhaWx1cmUgbW9kZSB0aGlzIGhhbmRsZXIgZXhpc3RzIHRvIHByZXZlbnQuIFRoZVxuICAvLyBzaW5nbGUgZXhjZXB0aW9uIGlzIGEgNDA0IG9uIHRoZSBsaXN0LCBoYW5kbGVkIGluc2lkZSBsaXN0TWljcm92bUltYWdlVmVyc2lvbnM6XG4gIC8vIHRoZSBpbWFnZSBkb2VzIG5vdCBleGlzdCB5ZXQgKGZyZXNoIHN0YWNrIENSRUFURSkgYW5kIHRoZXJlIGlzIG5vdGhpbmcgdG8gcHJ1bmUuXG4gIHZhciB2ZXJzaW9ucyA9IGF3YWl0IGxpc3RBbGxWZXJzaW9ucyhvcHRpb25zKTtcbiAgdmFyIGtlZXAgPSBrZWVwQWN0aXZlVmVyc2lvbnModmVyc2lvbnMpO1xuICB2YXIga2VlcFNldCA9IHt9O1xuICB2YXIga2VwdExhYmVsID0gJzxub25lPic7XG4gIGZvciAodmFyIGogPSAwOyBqIDwga2VlcC5sZW5ndGg7IGorKykge1xuICAgIHZhciBrZXB0VmVyc2lvbiA9IFN0cmluZyhrZWVwW2pdLmltYWdlVmVyc2lvbiB8fCAnJyk7XG4gICAga2VlcFNldFtrZXB0VmVyc2lvbl0gPSB0cnVlO1xuICAgIGtlcHRMYWJlbCA9IGtlcHRMYWJlbCA9PT0gJzxub25lPicgPyBrZXB0VmVyc2lvbiA6IGtlcHRMYWJlbCArICcsJyArIGtlcHRWZXJzaW9uO1xuICB9XG4gIHZhciBkZWxldGVkID0gMDtcbiAgdmFyIHNraXBwZWQgPSAwO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHZlcnNpb25zLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGl0ZW0gPSB2ZXJzaW9uc1tpXTtcbiAgICBpZiAoIWl0ZW0pIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB2YXIgdmVyc2lvbiA9IFN0cmluZyhpdGVtLmltYWdlVmVyc2lvbiB8fCAnJyk7XG4gICAgaWYgKCF2ZXJzaW9uKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGtlZXBTZXRbdmVyc2lvbl0pIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbih7XG4gICAgICAgIGltYWdlSWRlbnRpZmllcjogb3B0aW9ucy5pbWFnZUlkZW50aWZpZXIsXG4gICAgICAgIGltYWdlVmVyc2lvbjogdmVyc2lvbixcbiAgICAgICAgcmVnaW9uOiBvcHRpb25zLnJlZ2lvbixcbiAgICAgICAgbm93OiBvcHRpb25zLm5vdyxcbiAgICAgICAgZmV0Y2hJbXBsOiBvcHRpb25zLmZldGNoSW1wbFxuICAgICAgfSk7XG4gICAgICBkZWxldGVkICs9IDE7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBUaGUgc2VydmljZSBjYW4gcmVmdXNlIGEgZGVsZXRpb24gd2hpbGUgYSB2ZXJzaW9uIGlzIHN0aWxsIGluIHVzZSBieVxuICAgICAgLy8gcnVubmluZyBNaWNyb1ZNcy4gQSByZWZ1c2FsIG11c3Qgbm90IGZhaWwgdGhlIGRlcGxveW1lbnQ6IGxvZyBpdCBhbmRcbiAgICAgIC8vIGtlZXAgZ29pbmcuIFRoZSBuZXh0IGRlcGxveW1lbnQgcmV0cmllcyB0aGUgdmVyc2lvbi5cbiAgICAgIHNraXBwZWQgKz0gMTtcbiAgICAgIGxvZ0ltcGwoJ3NraXBwaW5nIHZlcnNpb24gJyArIHZlcnNpb24gKyAnOiAnICsgKGVyciAmJiBlcnIubWVzc2FnZSA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpKTtcbiAgICB9XG4gIH1cbiAgdmFyIHN1bW1hcnkgPSB7XG4gICAgdmVyc2lvbnNTZWVuOiB2ZXJzaW9ucy5sZW5ndGgsXG4gICAgdmVyc2lvbnNEZWxldGVkOiBkZWxldGVkLFxuICAgIHZlcnNpb25zU2tpcHBlZDogc2tpcHBlZFxuICB9O1xuICBsb2dJbXBsKCdwcnVuZSBzdW1tYXJ5OiB2ZXJzaW9ucyBzZWVuPScgKyBzdW1tYXJ5LnZlcnNpb25zU2VlbiArICcgZGVsZXRlZD0nICsgc3VtbWFyeS52ZXJzaW9uc0RlbGV0ZWQgKyAnIHNraXBwZWQ9JyArIHN1bW1hcnkudmVyc2lvbnNTa2lwcGVkICsgJyBrZXB0PScgKyBrZXB0TGFiZWwpO1xuICByZXR1cm4gc3VtbWFyeTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuICAvLyBEZWxldGUgcnVucyB3aGlsZSBDbG91ZEZvcm1hdGlvbiBkZWxldGVzIHRoZSB3aG9sZSBpbWFnZSwgc28gdGhlcmUgaXNcbiAgLy8gbm90aGluZyB0byBwcnVuZSBhbmQgcHJ1bmluZyBtdXN0IG5ldmVyIGJsb2NrIG9yIGZhaWwgZGVsZXRpb24uXG4gIC8vIENyZWF0ZS9VcGRhdGUgYm90aCBydW4gdGhlIHBydW5lOiBvbiBhIGZyZXNoIHN0YWNrIENSRUFURSB0aGUgaW1hZ2UgZG9lc1xuICAvLyBub3QgZXhpc3QgeWV0LCB0aGUgdmVyc2lvbiBsaXN0IDQwNHMsIGFuZCB0aGF0IGlzIHRyZWF0ZWQgYXMgbm90aGluZyB0b1xuICAvLyBwcnVuZSwgc28gdGhlIGNyZWF0ZSBzdWNjZWVkcy5cbiAgaWYgKGV2ZW50ICYmIGV2ZW50LlJlcXVlc3RUeXBlID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiB7fTtcbiAgfVxuICB2YXIgaW1hZ2VJZGVudGlmaWVyID0gcmVxdWlyZWRFbnYoJ0FQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX0FSTicpO1xuICB2YXIgcmVnaW9uID0gcmVzb2x2ZVJlZ2lvbigpO1xuICB2YXIgc3VtbWFyeSA9IGF3YWl0IHBydW5lTWljcm92bUltYWdlVmVyc2lvbnMoe1xuICAgIGltYWdlSWRlbnRpZmllcjogaW1hZ2VJZGVudGlmaWVyLFxuICAgIHJlZ2lvbjogcmVnaW9uLFxuICAgIG5vdzogbmV3IERhdGUoKSxcbiAgICBmZXRjaEltcGw6IGZldGNoLFxuICAgIGxvZ0ltcGw6IGxvZ1xuICB9KTtcbiAgcmV0dXJuIHtcbiAgICBEYXRhOiB7XG4gICAgICBWZXJzaW9uc1NlZW46IHN1bW1hcnkudmVyc2lvbnNTZWVuLFxuICAgICAgVmVyc2lvbnNEZWxldGVkOiBzdW1tYXJ5LnZlcnNpb25zRGVsZXRlZCxcbiAgICAgIFZlcnNpb25zU2tpcHBlZDogc3VtbWFyeS52ZXJzaW9uc1NraXBwZWRcbiAgICB9XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBoYW5kbGVyOiBoYW5kbGVyLFxuICBwcnVuZU1pY3Jvdm1JbWFnZVZlcnNpb25zOiBwcnVuZU1pY3Jvdm1JbWFnZVZlcnNpb25zLFxuICBsaXN0TWljcm92bUltYWdlVmVyc2lvbnM6IGxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9ucyxcbiAgZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbjogZGVsZXRlTWljcm92bUltYWdlVmVyc2lvbixcbiAga2VlcEFjdGl2ZVZlcnNpb25zOiBrZWVwQWN0aXZlVmVyc2lvbnMsXG4gIHNpZ25WNDogc2lnblY0LFxuICBjYW5vbmljYWxSZXF1ZXN0OiBjYW5vbmljYWxSZXF1ZXN0LFxuICBjYW5vbmljYWxVcmlQYXRoOiBjYW5vbmljYWxVcmlQYXRoLFxuICBlc2NhcGVQYXRoQ29tcG9uZW50OiBlc2NhcGVQYXRoQ29tcG9uZW50XG59O1xuYDtcbiJdfQ==