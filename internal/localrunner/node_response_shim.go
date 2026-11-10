package localrunner

import (
	"fmt"
	"os"
	"path/filepath"
)

// The response-URL port shim.
//
// A CloudFormation custom-resource handler reports its result by sending a PUT
// to the request's pre-signed ResponseURL. The pinned CDK provider framework
// builds that PUT from the URL's hostname and path and drops the port, so it
// always connects to 443:
//
//	req = {hostname: parsedUrl.hostname, path: parsedUrl.path, method: "PUT", ...}
//	https.request(req, ...)
//	https://github.com/aws/aws-cdk/blob/main/packages/%40aws-cdk/custom-resource-provider/lib/__entrypoint__.ts
//
// Locally the endpoint is a runner-owned listener on an ephemeral port, so the
// framework's default port would reach nothing. The runner mounts one small
// preload that restores the port for exactly that host and only when the URL
// names none, and sets NODE_OPTIONS to it for a run that declares a
// handler-invoked custom resource. Nothing else about the request changes: the
// path, the method, the headers and the body are the handler's own.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
const nodeResponseShimPath = "/etc/apptheory-local/cfn-response-port.cjs"

// nodeResponseShimSource is the preload. It reads the port the runner listens on
// from APPTHEORY_LOCAL_CFN_PORT and applies it only to the response host.
const nodeResponseShimSource = `"use strict";
const https = require("https");
const target = process.env.APPTHEORY_LOCAL_CFN_PORT || "";
const host = process.env.APPTHEORY_LOCAL_CFN_HOST || "host.docker.internal";
if (!target) {
  return;
}
const request = https.request;
https.request = function patched(options, callback) {
  if (
    options &&
    typeof options === "object" &&
    options.hostname === host &&
    (options.port === undefined || options.port === null || options.port === "" || options.port === 443)
  ) {
    options = Object.assign({}, options, { port: Number(target) });
  }
  return request.call(https, options, callback);
};
`

// prepareNodeResponseShim writes the preload into the run scratch and returns
// the container path and the Node options value a function container needs.
func (r *Runner) prepareNodeResponseShim() (string, error) {
	dir := filepath.Join(r.scratch, "cfn-shim")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("create the response-URL shim directory %s: %w", dir, err)
	}
	path := filepath.Join(dir, "cfn-response-port.cjs")
	if err := os.WriteFile(path, []byte(nodeResponseShimSource), 0o600); err != nil {
		return "", fmt.Errorf("write the response-URL shim %s: %w", path, err)
	}
	return path, nil
}
