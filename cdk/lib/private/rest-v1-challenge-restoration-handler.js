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

exports.handler = function (event) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb24taGFuZGxlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJlc3QtdjEtY2hhbGxlbmdlLXJlc3RvcmF0aW9uLWhhbmRsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUEyQkEsc0dBc0NDO0FBakVEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTBCRztBQUNILFNBQWdCLDZDQUE2QyxDQUMzRCxvQkFBOEI7SUFFOUIsTUFBTSxvQkFBb0IsR0FBRyxvQkFBb0I7U0FDOUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxJQUFJLE1BQU0sR0FBRyxDQUFDO1NBQzlCLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNkLE1BQU0sZ0JBQWdCLEdBQUcsb0JBQW9CO1NBQzFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsdUJBQXVCLE1BQU0sS0FBSyxDQUFDO1NBQ25ELElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUVkLE9BQU87Ozs7OztnQ0FNdUIsb0JBQW9COzs7Ozs7Ozs7Ozs7Ozs7O0VBZ0JsRCxnQkFBZ0I7Ozs7O0NBS2pCLENBQUM7QUFDRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTZWxmLWNvbnRhaW5lZCBMYW1iZGFARWRnZSBoYW5kbGVyIHNvdXJjZSBmb3IgYEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uYC5cbiAqXG4gKiBBV1MgQVBJIEdhdGV3YXkgUkVTVCBBUEkgdjEgcmVtYXBzIHRoZSBvcmlnaW4ncyBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2VcbiAqIGhlYWRlciBvbnRvIGB4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZWAsIHNvIGEgY2Fub25pY2FsLW9ubHkgYXBwIGxvc2VzXG4gKiBpdHMgY2hhbGxlbmdlIGF0IHRoZSBlZGdlLiBUaGlzIGhhbmRsZXIgcmVzdG9yZXMgdGhlIGNhbm9uaWNhbCBoZWFkZXIgb24gdGhlXG4gKiBDbG91ZEZyb250IG9yaWdpbiByZXNwb25zZSBhbmQgcmVtb3ZlcyB0aGUgY29uc3VtZWQgc291cmNlIGhlYWRlcnMuXG4gKlxuICogVGhlIG9yZGVyZWQgKipyZXN0b3JlIHNvdXJjZSBsaXN0IGlzIGVtYmVkZGVkIGF0IHN5bnRoIHRpbWUqKiwgbmV2ZXIgcmVzb2x2ZWRcbiAqIGF0IHJ1bnRpbWUuIFRoYXQgaXMgZGVsaWJlcmF0ZTpcbiAqXG4gKiAtIFdpdGggdGhlIG9wdGlvbmFsIGFsaWFzIGJyaWRnZSBkaXNhYmxlZCB0aGUgY29kZSBjYXJyaWVzIG9ubHkgdGhlIEFXUyByZW1hcFxuICogICBhcnRpZmFjdCAoYHgtYW16bi1yZW1hcHBlZC13d3ctYXV0aGVudGljYXRlYCkgYW5kIHRoZSBhbGlhcyBzcGVsbGluZ3MgZG8gbm90XG4gKiAgIGFwcGVhciBpbiB0aGUgZGVwbG95ZWQgZnVuY3Rpb24gc291cmNlIGF0IGFsbC5cbiAqIC0gV2l0aCB0aGUgYWxpYXMgYnJpZGdlIGVuYWJsZWQgdGhlIGFsaWFzIHNwZWxsaW5ncyBhcmUgYXBwZW5kZWQgYWZ0ZXIgdGhlXG4gKiAgIHJlbWFwIGFydGlmYWN0LCBwcmVzZXJ2aW5nIHRoZSBtYW5kYXRlZCBwcmlvcml0eSBvcmRlclxuICogICAoYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuIGBtY3Atd3d3LWF1dGhlbnRpY2F0ZWApLlxuICpcbiAqIFRoZSBoYW5kbGVyIHdhbGtzIHRoYXQgbGlzdCBpbiBvcmRlciwgYWRvcHRzIHRoZSBmaXJzdCBwcmVzZW50IG5vbi1lbXB0eVxuICogdmFsdWUgYXMgdGhlIGNhbm9uaWNhbCBgV1dXLUF1dGhlbnRpY2F0ZWAgaGVhZGVyIHdoZW4gdGhlIG9yaWdpbiBkaWQgbm90IGVtaXRcbiAqIG9uZSwgdGhlbiBkZWxldGVzIGV2ZXJ5IGNvbnN1bWVkIHNvdXJjZSBoZWFkZXIuXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgaW50ZXJuYWwgdG8gdGhlIENESyBwYWNrYWdlIGFuZCBpbnRlbnRpb25hbGx5IE5PVCBleHBvcnRlZCBmcm9tXG4gKiBgaW5kZXgudHNgLCBzbyBpdCBuZXZlciBhcHBlYXJzIGluIHRoZSBqc2lpIGFzc2VtYmx5IG9yIGdlbmVyYXRlZCBiaW5kaW5ncy5cbiAqXG4gKiBAaW50ZXJuYWxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlUmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25IYW5kbGVyQ29kZShcbiAgcmVzdG9yZVNvdXJjZUhlYWRlcnM6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc291cmNlSGVhZGVyc0xpdGVyYWwgPSByZXN0b3JlU291cmNlSGVhZGVyc1xuICAgIC5tYXAoKGhlYWRlcikgPT4gYCcke2hlYWRlcn0nYClcbiAgICAuam9pbihcIiwgXCIpO1xuICBjb25zdCBkZWxldGVTdGF0ZW1lbnRzID0gcmVzdG9yZVNvdXJjZUhlYWRlcnNcbiAgICAubWFwKChoZWFkZXIpID0+IGAgICAgZGVsZXRlIGhlYWRlcnNbJyR7aGVhZGVyfSddO2ApXG4gICAgLmpvaW4oXCJcXG5cIik7XG5cbiAgcmV0dXJuIGAndXNlIHN0cmljdCc7XG5cbi8vIE9yZGVyZWQgcmVzdG9yZSBzb3VyY2VzIGVtYmVkZGVkIGF0IHN5bnRoIHRpbWUuIFRoZSBhbGlhcyBzcGVsbGluZ3MgYXJlIG9ubHlcbi8vIHByZXNlbnQgd2hlbiB0aGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIGlzIGVuYWJsZWQ7IEFXUydzIG93biByZW1hcCBhcnRpZmFjdCBpc1xuLy8gYWx3YXlzIGZpcnN0LlxudmFyIENIQUxMRU5HRV9IRUFERVIgPSAnd3d3LWF1dGhlbnRpY2F0ZSc7XG52YXIgUkVTVE9SRV9TT1VSQ0VfSEVBREVSUyA9IFske3NvdXJjZUhlYWRlcnNMaXRlcmFsfV07XG5cbmV4cG9ydHMuaGFuZGxlciA9IGZ1bmN0aW9uIChldmVudCkge1xuICB2YXIgcmVzcG9uc2UgPSBldmVudC5SZWNvcmRzWzBdLmNmLnJlc3BvbnNlO1xuICB2YXIgaGVhZGVycyA9IHJlc3BvbnNlLmhlYWRlcnMgfHwge307XG5cbiAgaWYgKCFoZWFkZXJzW0NIQUxMRU5HRV9IRUFERVJdKSB7XG4gICAgZm9yICh2YXIgaW5kZXggPSAwOyBpbmRleCA8IFJFU1RPUkVfU09VUkNFX0hFQURFUlMubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICB2YXIgY2FuZGlkYXRlID0gaGVhZGVyc1tSRVNUT1JFX1NPVVJDRV9IRUFERVJTW2luZGV4XV07XG4gICAgICBpZiAoY2FuZGlkYXRlICYmIGNhbmRpZGF0ZVswXSAmJiBjYW5kaWRhdGVbMF0udmFsdWUpIHtcbiAgICAgICAgaGVhZGVyc1tDSEFMTEVOR0VfSEVBREVSXSA9IFt7IGtleTogJ1dXVy1BdXRoZW50aWNhdGUnLCB2YWx1ZTogY2FuZGlkYXRlWzBdLnZhbHVlIH1dO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuJHtkZWxldGVTdGF0ZW1lbnRzfVxuXG4gIHJlc3BvbnNlLmhlYWRlcnMgPSBoZWFkZXJzO1xuICByZXR1cm4gcmVzcG9uc2U7XG59O1xuYDtcbn1cbiJdfQ==