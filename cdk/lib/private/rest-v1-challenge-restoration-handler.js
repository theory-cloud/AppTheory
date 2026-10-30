"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRestV1ChallengeRestorationHandlerCode = generateRestV1ChallengeRestorationHandlerCode;
/**
 * Self-contained Lambda@Edge handler source for `AppTheoryRestV1ChallengeRestoration`.
 *
 * AWS API Gateway REST API v1 remaps the origin's `WWW-Authenticate` response
 * header onto `x-amzn-remapped-www-authenticate`, so a canonical-only app loses
 * its challenge at the edge. This handler restores the canonical header on the
 * CloudFront origin response and removes the consumed source headers.
 *
 * The ordered **restore source list is embedded at synth time**, never resolved
 * at runtime. That is deliberate:
 *
 * - With the optional alias bridge disabled the code carries only the AWS remap
 *   artifact (`x-amzn-remapped-www-authenticate`) and the alias spellings do not
 *   appear in the deployed function source at all.
 * - With the alias bridge enabled the alias spellings are appended after the
 *   remap artifact, preserving the mandated priority order
 *   (`x-theory-www-authenticate`, then `mcp-www-authenticate`).
 *
 * The handler walks that list in order, adopts the first present non-empty
 * value as the canonical `WWW-Authenticate` header when the origin did not emit
 * one, then deletes every consumed source header.
 *
 * The generated handler is `async`: Lambda@Edge uses the returned promise as the
 * invocation result, whereas a plain synchronous return value is discarded.
 * Tests must await that promise instead of reading a detached early value.
 *
 * This module is internal to the CDK package and intentionally NOT exported from
 * `index.ts`, so it never appears in the jsii assembly or generated bindings.
 *
 * @internal
 */
function generateRestV1ChallengeRestorationHandlerCode(restoreSourceHeaders) {
    const sourceHeadersLiteral = restoreSourceHeaders
        .map((header) => `'${header}'`)
        .join(", ");
    const deleteStatements = restoreSourceHeaders
        .map((header) => `    delete headers['${header}'];`)
        .join("\n");
    return `'use strict';

// Ordered restore sources embedded at synth time. The alias spellings are only
// present when the optional alias bridge is enabled; AWS's own remap artifact is
// always first.
var CHALLENGE_HEADER = 'www-authenticate';
var RESTORE_SOURCE_HEADERS = [${sourceHeadersLiteral}];

exports.handler = async function (event) {
  var response = event.Records[0].cf.response;
  var headers = response.headers || {};

  if (!headers[CHALLENGE_HEADER]) {
    for (var index = 0; index < RESTORE_SOURCE_HEADERS.length; index += 1) {
      var candidate = headers[RESTORE_SOURCE_HEADERS[index]];
      if (candidate && candidate[0] && candidate[0].value) {
        headers[CHALLENGE_HEADER] = [{ key: 'WWW-Authenticate', value: candidate[0].value }];
        break;
      }
    }
  }

${deleteStatements}

  response.headers = headers;
  return response;
};
`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb24taGFuZGxlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJlc3QtdjEtY2hhbGxlbmdlLXJlc3RvcmF0aW9uLWhhbmRsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUErQkEsc0dBc0NDO0FBckVEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0E4Qkc7QUFDSCxTQUFnQiw2Q0FBNkMsQ0FDM0Qsb0JBQThCO0lBRTlCLE1BQU0sb0JBQW9CLEdBQUcsb0JBQW9CO1NBQzlDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsSUFBSSxNQUFNLEdBQUcsQ0FBQztTQUM5QixJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDZCxNQUFNLGdCQUFnQixHQUFHLG9CQUFvQjtTQUMxQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLHVCQUF1QixNQUFNLEtBQUssQ0FBQztTQUNuRCxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFFZCxPQUFPOzs7Ozs7Z0NBTXVCLG9CQUFvQjs7Ozs7Ozs7Ozs7Ozs7OztFQWdCbEQsZ0JBQWdCOzs7OztDQUtqQixDQUFDO0FBQ0YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2VsZi1jb250YWluZWQgTGFtYmRhQEVkZ2UgaGFuZGxlciBzb3VyY2UgZm9yIGBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbmAuXG4gKlxuICogQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIHJlbWFwcyB0aGUgb3JpZ2luJ3MgYFdXVy1BdXRoZW50aWNhdGVgIHJlc3BvbnNlXG4gKiBoZWFkZXIgb250byBgeC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVgLCBzbyBhIGNhbm9uaWNhbC1vbmx5IGFwcCBsb3Nlc1xuICogaXRzIGNoYWxsZW5nZSBhdCB0aGUgZWRnZS4gVGhpcyBoYW5kbGVyIHJlc3RvcmVzIHRoZSBjYW5vbmljYWwgaGVhZGVyIG9uIHRoZVxuICogQ2xvdWRGcm9udCBvcmlnaW4gcmVzcG9uc2UgYW5kIHJlbW92ZXMgdGhlIGNvbnN1bWVkIHNvdXJjZSBoZWFkZXJzLlxuICpcbiAqIFRoZSBvcmRlcmVkICoqcmVzdG9yZSBzb3VyY2UgbGlzdCBpcyBlbWJlZGRlZCBhdCBzeW50aCB0aW1lKiosIG5ldmVyIHJlc29sdmVkXG4gKiBhdCBydW50aW1lLiBUaGF0IGlzIGRlbGliZXJhdGU6XG4gKlxuICogLSBXaXRoIHRoZSBvcHRpb25hbCBhbGlhcyBicmlkZ2UgZGlzYWJsZWQgdGhlIGNvZGUgY2FycmllcyBvbmx5IHRoZSBBV1MgcmVtYXBcbiAqICAgYXJ0aWZhY3QgKGB4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZWApIGFuZCB0aGUgYWxpYXMgc3BlbGxpbmdzIGRvIG5vdFxuICogICBhcHBlYXIgaW4gdGhlIGRlcGxveWVkIGZ1bmN0aW9uIHNvdXJjZSBhdCBhbGwuXG4gKiAtIFdpdGggdGhlIGFsaWFzIGJyaWRnZSBlbmFibGVkIHRoZSBhbGlhcyBzcGVsbGluZ3MgYXJlIGFwcGVuZGVkIGFmdGVyIHRoZVxuICogICByZW1hcCBhcnRpZmFjdCwgcHJlc2VydmluZyB0aGUgbWFuZGF0ZWQgcHJpb3JpdHkgb3JkZXJcbiAqICAgKGB4LXRoZW9yeS13d3ctYXV0aGVudGljYXRlYCwgdGhlbiBgbWNwLXd3dy1hdXRoZW50aWNhdGVgKS5cbiAqXG4gKiBUaGUgaGFuZGxlciB3YWxrcyB0aGF0IGxpc3QgaW4gb3JkZXIsIGFkb3B0cyB0aGUgZmlyc3QgcHJlc2VudCBub24tZW1wdHlcbiAqIHZhbHVlIGFzIHRoZSBjYW5vbmljYWwgYFdXVy1BdXRoZW50aWNhdGVgIGhlYWRlciB3aGVuIHRoZSBvcmlnaW4gZGlkIG5vdCBlbWl0XG4gKiBvbmUsIHRoZW4gZGVsZXRlcyBldmVyeSBjb25zdW1lZCBzb3VyY2UgaGVhZGVyLlxuICpcbiAqIFRoZSBnZW5lcmF0ZWQgaGFuZGxlciBpcyBgYXN5bmNgOiBMYW1iZGFARWRnZSB1c2VzIHRoZSByZXR1cm5lZCBwcm9taXNlIGFzIHRoZVxuICogaW52b2NhdGlvbiByZXN1bHQsIHdoZXJlYXMgYSBwbGFpbiBzeW5jaHJvbm91cyByZXR1cm4gdmFsdWUgaXMgZGlzY2FyZGVkLlxuICogVGVzdHMgbXVzdCBhd2FpdCB0aGF0IHByb21pc2UgaW5zdGVhZCBvZiByZWFkaW5nIGEgZGV0YWNoZWQgZWFybHkgdmFsdWUuXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgaW50ZXJuYWwgdG8gdGhlIENESyBwYWNrYWdlIGFuZCBpbnRlbnRpb25hbGx5IE5PVCBleHBvcnRlZCBmcm9tXG4gKiBgaW5kZXgudHNgLCBzbyBpdCBuZXZlciBhcHBlYXJzIGluIHRoZSBqc2lpIGFzc2VtYmx5IG9yIGdlbmVyYXRlZCBiaW5kaW5ncy5cbiAqXG4gKiBAaW50ZXJuYWxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlUmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25IYW5kbGVyQ29kZShcbiAgcmVzdG9yZVNvdXJjZUhlYWRlcnM6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc291cmNlSGVhZGVyc0xpdGVyYWwgPSByZXN0b3JlU291cmNlSGVhZGVyc1xuICAgIC5tYXAoKGhlYWRlcikgPT4gYCcke2hlYWRlcn0nYClcbiAgICAuam9pbihcIiwgXCIpO1xuICBjb25zdCBkZWxldGVTdGF0ZW1lbnRzID0gcmVzdG9yZVNvdXJjZUhlYWRlcnNcbiAgICAubWFwKChoZWFkZXIpID0+IGAgICAgZGVsZXRlIGhlYWRlcnNbJyR7aGVhZGVyfSddO2ApXG4gICAgLmpvaW4oXCJcXG5cIik7XG5cbiAgcmV0dXJuIGAndXNlIHN0cmljdCc7XG5cbi8vIE9yZGVyZWQgcmVzdG9yZSBzb3VyY2VzIGVtYmVkZGVkIGF0IHN5bnRoIHRpbWUuIFRoZSBhbGlhcyBzcGVsbGluZ3MgYXJlIG9ubHlcbi8vIHByZXNlbnQgd2hlbiB0aGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIGlzIGVuYWJsZWQ7IEFXUydzIG93biByZW1hcCBhcnRpZmFjdCBpc1xuLy8gYWx3YXlzIGZpcnN0LlxudmFyIENIQUxMRU5HRV9IRUFERVIgPSAnd3d3LWF1dGhlbnRpY2F0ZSc7XG52YXIgUkVTVE9SRV9TT1VSQ0VfSEVBREVSUyA9IFske3NvdXJjZUhlYWRlcnNMaXRlcmFsfV07XG5cbmV4cG9ydHMuaGFuZGxlciA9IGFzeW5jIGZ1bmN0aW9uIChldmVudCkge1xuICB2YXIgcmVzcG9uc2UgPSBldmVudC5SZWNvcmRzWzBdLmNmLnJlc3BvbnNlO1xuICB2YXIgaGVhZGVycyA9IHJlc3BvbnNlLmhlYWRlcnMgfHwge307XG5cbiAgaWYgKCFoZWFkZXJzW0NIQUxMRU5HRV9IRUFERVJdKSB7XG4gICAgZm9yICh2YXIgaW5kZXggPSAwOyBpbmRleCA8IFJFU1RPUkVfU09VUkNFX0hFQURFUlMubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICB2YXIgY2FuZGlkYXRlID0gaGVhZGVyc1tSRVNUT1JFX1NPVVJDRV9IRUFERVJTW2luZGV4XV07XG4gICAgICBpZiAoY2FuZGlkYXRlICYmIGNhbmRpZGF0ZVswXSAmJiBjYW5kaWRhdGVbMF0udmFsdWUpIHtcbiAgICAgICAgaGVhZGVyc1tDSEFMTEVOR0VfSEVBREVSXSA9IFt7IGtleTogJ1dXVy1BdXRoZW50aWNhdGUnLCB2YWx1ZTogY2FuZGlkYXRlWzBdLnZhbHVlIH1dO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuJHtkZWxldGVTdGF0ZW1lbnRzfVxuXG4gIHJlc3BvbnNlLmhlYWRlcnMgPSBoZWFkZXJzO1xuICByZXR1cm4gcmVzcG9uc2U7XG59O1xuYDtcbn1cbiJdfQ==