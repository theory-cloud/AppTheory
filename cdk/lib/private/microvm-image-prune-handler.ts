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
export const MICROVM_IMAGE_PRUNE_HANDLER_SOURCE = `'use strict';

var crypto = require('node:crypto');

var SERVICE_NAME = 'lambda';
var API_PATH_PREFIX = '/2025-09-09/microvm-images';
// The live Lambda MicroVMs control plane caps ListMicrovmImageVersions
// maxResults at 50 and rejects larger values with HTTP 400. Stay at or
// below the cap; the handler already paginates via nextToken.
var MAX_RESULTS = 50;
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
  // options: imageIdentifier, region, now, fetchImpl, nextToken, maxResults, logImpl
  var logImpl = options.logImpl || log;
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
      logImpl('list returned 404: image not present; nothing to prune');
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
      maxResults: MAX_RESULTS,
      logImpl: options.logImpl
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
