package localrunner

import (
	"sort"
	"time"
)

// Runner-issued credentials.
//
// Every function the run starts receives an access key the runner minted and
// bound to the role the function's template declares. That binding is what lets
// the IAM gate answer "who is calling?" from a signature alone: the access key
// resolves to a principal ARN and to the base role ARN aws:PrincipalArn is
// compared with. The keys are recorded in the shared IAM plane, so a call from
// one run's function can be verified by another run.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html

const (
	// iamBaseCredentialLifetime bounds a function credential. A deployed
	// function's role credentials do not expire; a local run's do, so a stale
	// plane entry cannot outlive the run that minted it.
	iamBaseCredentialLifetime = 24 * time.Hour
	// iamSTSEndpointEnv is the SDK endpoint variable the run injects for STS.
	// Every AWS SDK resolves a service-specific variable before the global one.
	// https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html
	iamSTSEndpointEnv = "AWS_ENDPOINT_URL_STS"
	// iamLocalUserPrefix names the principal a run issues to a container that
	// declares no role, and to the preflight probe.
	iamLocalUserPrefix = "apptheory-local-runner"
)

// issueCredentials mints one credential per runtime function and one for the
// preflight probe.
func (r *Runner) issueCredentials(spec *Spec, targets []string) error {
	if r.iam == nil {
		return errIAMPlaneUnavailable
	}
	r.iamMu.Lock()
	r.iamCredentials = map[string]iamCredentialRecord{}
	r.iamFunctionCredentials = map[string]iamCredentialRecord{}
	r.iamMu.Unlock()
	now := time.Now().UTC()
	for _, functionID := range targets {
		function, ok := spec.Function(functionID)
		if !ok {
			continue
		}
		roleARN := spec.functionRoleARN(function)
		account := stackAccountFor(spec, spec.stackOf(function))
		principal := roleARN
		base := roleARN
		if roleARN == "" {
			// A function that declares no role still needs a principal the gate
			// can resolve; a local user stands in, which is what AWS reports for
			// a caller whose role the account does not define.
			principal = "arn:" + LocalPartition + ":iam::" + account + ":user/" + iamLocalUserPrefix + "-" + r.runID
			base = principal
		}
		if _, err := r.mintCredential(iamCredentialRecord{
			PrincipalARN: principal,
			BaseARN:      base,
			Account:      account,
			Function:     functionID,
			IssuedAt:     now,
			ExpiresAt:    now.Add(iamBaseCredentialLifetime),
		}); err != nil {
			return err
		}
	}
	probe, err := r.mintCredential(iamCredentialRecord{
		PrincipalARN: "arn:" + LocalPartition + ":iam::" + LocalAccountID + ":user/" + iamLocalUserPrefix + "-probe-" + r.runID,
		BaseARN:      "arn:" + LocalPartition + ":iam::" + LocalAccountID + ":user/" + iamLocalUserPrefix + "-probe-" + r.runID,
		Account:      LocalAccountID,
		IssuedAt:     now,
		ExpiresAt:    now.Add(iamBaseCredentialLifetime),
	})
	if err != nil {
		return err
	}
	r.probeCredential = probe
	r.logf("local IAM: issued %d function credential(s) and one preflight credential", len(targets))
	return nil
}

// mintCredential creates and registers one credential record.
func (r *Runner) mintCredential(record iamCredentialRecord) (iamCredentialRecord, error) {
	secret, err := newSecretKey()
	if err != nil {
		return iamCredentialRecord{}, err
	}
	record.AccessKeyID = newAccessKeyID()
	record.Secret = secret
	record.Kind = iamCredentialFileType
	if record.IssuedAt.IsZero() {
		record.IssuedAt = time.Now().UTC()
	}
	if err := r.addIAMCredential(record); err != nil {
		return iamCredentialRecord{}, err
	}
	return record, nil
}

// stackOf returns the stack a function spec belongs to.
func (s *Spec) stackOf(function FunctionSpec) string {
	if function.Stack != "" {
		return function.Stack
	}
	for _, resource := range s.Resources {
		if resource.Type == typeLambdaFunction && resource.LogicalID == function.LogicalID {
			return resource.Stack
		}
	}
	return ""
}

// iamCredentialSummary reports the credentials the run issued, without their
// secrets, for session describe.
func (r *Runner) iamCredentialSummary() []map[string]any {
	r.iamMu.RLock()
	keys := make([]string, 0, len(r.iamCredentials))
	for functionID := range r.iamCredentials {
		keys = append(keys, functionID)
	}
	records := make(map[string]iamCredentialRecord, len(r.iamCredentials))
	for functionID, record := range r.iamCredentials {
		records[functionID] = record
	}
	r.iamMu.RUnlock()
	sort.Strings(keys)
	out := make([]map[string]any, 0, len(keys))
	for _, functionID := range keys {
		record := records[functionID]
		out = append(out, map[string]any{
			"function":     functionID,
			"accessKeyId":  record.AccessKeyID,
			"principalArn": record.PrincipalARN,
			"account":      record.Account,
			"expiresAt":    record.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	if r.probeCredential.AccessKeyID != "" {
		out = append(out, map[string]any{
			"function":     "preflight",
			"accessKeyId":  r.probeCredential.AccessKeyID,
			"principalArn": r.probeCredential.PrincipalARN,
			"account":      r.probeCredential.Account,
			"expiresAt":    r.probeCredential.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// iamDescription is the session's report of the IAM path: the plane, the STS
// endpoint, the roles and the credentials.
func (r *Runner) iamDescription(spec *Spec) map[string]any {
	description := map[string]any{
		"credentials": r.iamCredentialSummary(),
		"stsEndpoint": r.iamSTSURL,
	}
	if r.iam != nil {
		description["plane"] = r.iam.dir
		description["shared"] = r.iam.shared
		description["runId"] = r.iam.runID
	}
	roles := make([]map[string]any, 0, len(spec.IAMRoles))
	for _, role := range spec.IAMRoles {
		roles = append(roles, map[string]any{
			"arn":            role.ARN,
			"account":        role.Account,
			"logicalId":      role.Logical,
			"trustPolicy":    len(role.Trust) > 0,
			"identityPolicy": len(role.Identity),
		})
	}
	description["roles"] = roles
	return description
}
