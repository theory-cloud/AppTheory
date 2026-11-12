package mcpfacade

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
)

// The refresh-rotation-recovery contract's vendored conformance corpus. The
// documents are copied verbatim from the Factory contract
// (contracts/refresh-rotation-recovery/v0.1); see the directory's PROVENANCE.md.
const refreshRecoveryCorpusDir = "../../contract-tests/conformance/refresh-rotation-recovery-v0.1"

// The contract's fixture vocabulary, as the shared schema states it.
var (
	refreshRecoveryMintActions    = map[string]bool{"rotate": true, "rescue_mint": true}
	refreshRecoveryFailClosedWire = map[string]bool{
		"temporarily_unavailable_503": true,
		"replay_budget_exhausted_503": true,
	}
	refreshRecoveryTransientWires = map[string]bool{
		"temporarily_unavailable_503": true,
		"replay_budget_exhausted_503": true,
	}
	refreshRecoveryR5Triggers = map[string]bool{
		"out_of_window_replay": true,
		"containment":          true,
		"explicit":             true,
	}
)

// refreshRecoveryFixture is one conformant or banned scenario trace.
type refreshRecoveryFixture struct {
	Contract          string                      `json:"contract"`
	CaseID            string                      `json:"case_id"`
	Description       string                      `json:"description"`
	ExpectedOutcome   string                      `json:"expected_outcome"`
	ExpectedViolation string                      `json:"expected_violation"`
	StageConfig       refreshRecoveryStageConfig  `json:"stage_config"`
	Scenario          []refreshRecoveryEvent      `json:"scenario"`
	Expect            refreshRecoveryExpectations `json:"expect"`
}

type refreshRecoveryStageConfig struct {
	ServeWindowSeconds   int     `json:"serve_window_seconds"`
	AccessTokenTTL       int     `json:"access_token_ttl_seconds"`
	RefreshDueFraction   float64 `json:"refresh_due_fraction"`
	SweepIntervalSeconds int     `json:"sweep_interval_seconds"`
	GenerationBound      int     `json:"generation_bound"`
	Margin               float64 `json:"margin"`
	WindowSource         string  `json:"window_source"`
}

type refreshRecoveryEvent struct {
	TOffsetSeconds int    `json:"t_offset_seconds"`
	Actor          string `json:"actor"`
	Action         string `json:"action"`
	Generation     string `json:"generation"`
	Successor      string `json:"successor"`
	Minted         *bool  `json:"minted"`
	ArtifactAtomic *bool  `json:"artifact_atomic"`
	Wire           string `json:"wire"`
	InWindow       *bool  `json:"in_window"`
	Recovery       string `json:"recovery"`
	Reason         string `json:"reason"`
	TriggerError   string `json:"trigger_error"`
	Hops           int    `json:"hops"`
}

type refreshRecoveryExpectations struct {
	FamilyRevoked     bool   `json:"family_revoked"`
	Recovery          string `json:"recovery"`
	TerminalWireError string `json:"terminal_wire_error"`
	TransientWire     string `json:"transient_wire"`
	ReceiptEmitted    bool   `json:"receipt_emitted"`
}

// refreshRecoveryViolation is one rule violation the port detects. Its rule id
// is the contract rule the trace breaks.
type refreshRecoveryViolation struct {
	Rule   string
	Detail string
}

func (v *refreshRecoveryViolation) Error() string { return v.Rule + ": " + v.Detail }

func requireRule(rule string, ok bool, format string, args ...any) error {
	if ok {
		return nil
	}
	return &refreshRecoveryViolation{Rule: rule, Detail: fmt.Sprintf(format, args...)}
}

// checkRefreshRecoveryFixture ports the contract's rule evaluation: rules are
// evaluated in order and the first violation is the case's verdict.
func checkRefreshRecoveryFixture(fx refreshRecoveryFixture) error {
	cfg := fx.StageConfig
	events := fx.Scenario
	exp := fx.Expect

	// FX: the trace must be ordered.
	for index := 1; index < len(events); index++ {
		if err := requireRule("FX", events[index].TOffsetSeconds >= events[index-1].TOffsetSeconds,
			"scenario t_offset_seconds must be non-decreasing"); err != nil {
			return err
		}
	}

	// R1 — chain continuity.
	for _, event := range events {
		if !refreshRecoveryMintActions[event.Action] {
			continue
		}
		if event.Minted == nil {
			return requireRule("R1", false, "%s at t=%d does not declare minted", event.Action, event.TOffsetSeconds)
		}
		if *event.Minted {
			if err := requireRule("R1", event.ArtifactAtomic != nil && *event.ArtifactAtomic,
				"%s minted %s without the artifact in the same transaction", event.Action, event.Successor); err != nil {
				return err
			}
			if err := requireRule("R1", event.Generation != event.Successor,
				"%s minted a successor identical to the consumed generation", event.Action); err != nil {
				return err
			}
			continue
		}
		if err := requireRule("R1", refreshRecoveryFailClosedWire[event.Wire],
			"%s failed closed with wire %q, expected a transient 503 before minting", event.Action, event.Wire); err != nil {
			return err
		}
	}

	// R2 — one rescue mint per generation.
	rescues := map[string]bool{}
	for _, event := range events {
		if event.Action != "rescue_mint" || event.Minted == nil || !*event.Minted {
			continue
		}
		if err := requireRule("R2", !rescues[event.Generation],
			"more than one rescue mint for generation %s", event.Generation); err != nil {
			return err
		}
		rescues[event.Generation] = true
	}

	// R3 — the serve window derives from measured recovery latency.
	if err := requireRule("R3", cfg.WindowSource != "steward_sleep",
		"serve window derived from steward sleep duration"); err != nil {
		return err
	}
	minimumGenerationInterval := cfg.RefreshDueFraction * float64(cfg.AccessTokenTTL)
	if err := requireRule("R3", minimumGenerationInterval < float64(cfg.ServeWindowSeconds),
		"g_min %gs is not below the serve window", minimumGenerationInterval); err != nil {
		return err
	}

	// R4 — the generation bound is a hop budget, never a revocation predicate.
	requiredBound := math.Ceil(float64(cfg.ServeWindowSeconds)/minimumGenerationInterval) * cfg.Margin
	if err := requireRule("R4", float64(cfg.GenerationBound) >= requiredBound,
		"generation_bound %d < ceil(W/g_min) x margin = %g", cfg.GenerationBound, requiredBound); err != nil {
		return err
	}
	for _, event := range events {
		if event.Action == "revoke" {
			if err := requireRule("R4", event.Reason != "count_exceeded",
				"generation count used as a revocation predicate"); err != nil {
				return err
			}
		}
	}

	// R5 — the revocation triggers are exhaustive.
	for _, event := range events {
		if event.Action != "revoke" {
			continue
		}
		if err := requireRule("R5", refreshRecoveryR5Triggers[event.Reason],
			"revocation trigger %q is not one of the permitted triggers", event.Reason); err != nil {
			return err
		}
	}

	// R6 — the verdict transport.
	revoked := false
	for _, event := range events {
		if event.Action == "revoke" || event.Action == "family_kill" {
			revoked = true
		}
		if event.Action == "present" && event.Wire == "invalid_grant" {
			inWindow := event.InWindow != nil && *event.InWindow
			if err := requireRule("R6", !inWindow || revoked,
				"recovery-available staleness answered with terminal invalid_grant"); err != nil {
				return err
			}
		}
	}

	// R7 — the facade family-kills only on contract-terminal verdicts. The
	// fixture's declared trigger goes through the runtime's own taxonomy, so the
	// banned per-request-error case is impossible by construction.
	for _, event := range events {
		if event.Action != "family_kill" {
			continue
		}
		if err := requireRule("R7", oauth.IsTerminalTokenVerdict(event.TriggerError),
			"facade family-kill on non-terminal error %q", event.TriggerError); err != nil {
			return err
		}
	}

	// R8 — every revocation emits a receipt.
	revocations := 0
	for _, event := range events {
		if event.Action == "revoke" || event.Action == "family_kill" {
			revocations++
		}
	}
	if err := requireRule("R8", exp.ReceiptEmitted == (revocations > 0),
		"receipt_emitted does not match the revocation events"); err != nil {
		return err
	}

	// FX — the expectation block must agree with the trace.
	if err := requireRule("FX", exp.FamilyRevoked == (revocations > 0),
		"family_revoked does not match the revocation events"); err != nil {
		return err
	}
	terminal := false
	for _, event := range events {
		if event.Action == "present" && event.Wire == "invalid_grant" {
			terminal = true
		}
	}
	if err := requireRule("FX", (exp.TerminalWireError == "invalid_grant") == terminal,
		"terminal_wire_error does not match present events"); err != nil {
		return err
	}
	transients := map[string]bool{}
	for _, event := range events {
		if refreshRecoveryTransientWires[event.Wire] {
			transients[event.Wire] = true
		}
	}
	if err := requireRule("FX", len(transients) <= 1,
		"mixed transient wires %v; keep one per fixture", sortedKeys(transients)); err != nil {
		return err
	}
	expectedTransient := "none"
	for wire := range transients {
		expectedTransient = wire
	}
	if err := requireRule("FX", exp.TransientWire == expectedTransient,
		"transient_wire does not match the trace"); err != nil {
		return err
	}
	walked := false
	for _, event := range events {
		if event.Action == "present" && event.Recovery == "walk_serve" {
			walked = true
		}
	}
	if err := requireRule("FX", (exp.Recovery == "walk_serve") == walked,
		"recovery does not match walk-serve events"); err != nil {
		return err
	}
	return nil
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// loadRefreshRecoveryFixtures reads the vendored corpus, so a re-vendored
// revision is executed without touching this test.
func loadRefreshRecoveryFixtures(t *testing.T) map[string][]refreshRecoveryFixture {
	t.Helper()
	corpus := map[string][]refreshRecoveryFixture{}
	for _, kind := range []string{"valid", "invalid"} {
		paths, err := filepath.Glob(filepath.Join(refreshRecoveryCorpusDir, "fixtures", kind, "*.json"))
		require.NoError(t, err)
		require.NotEmptyf(t, paths, "the %s fixture directory must not be empty", kind)
		for _, path := range paths {
			raw, err := os.ReadFile(path) // #nosec G304 -- the path is globbed from the vendored corpus directory.
			require.NoError(t, err)
			var fixture refreshRecoveryFixture
			require.NoErrorf(t, json.Unmarshal(raw, &fixture), "parse %s", path)
			corpus[kind] = append(corpus[kind], fixture)
		}
	}
	return corpus
}

// TestRefreshRotationRecoveryContractConsumption consumes the vendored
// theorycloud_refresh_rotation_recovery.v0.1 corpus: every valid fixture must
// conform, every invalid one must fail with exactly its declared rule, and the
// facade's own verdict taxonomy must agree with the contract's terminal set.
func TestRefreshRotationRecoveryContractConsumption(t *testing.T) {
	corpus := loadRefreshRecoveryFixtures(t)
	require.Len(t, corpus["valid"], 6)
	require.Len(t, corpus["invalid"], 8)

	seen := map[string]bool{}
	for _, kind := range []string{"valid", "invalid"} {
		for _, fixture := range corpus[kind] {
			t.Run(fixture.CaseID, func(t *testing.T) {
				require.Equal(t, "theorycloud_refresh_rotation_recovery.v0.1", fixture.Contract)
				require.NotEmpty(t, fixture.Description)
				require.Falsef(t, seen[fixture.CaseID], "duplicate case_id %q", fixture.CaseID)
				seen[fixture.CaseID] = true

				expectedOutcome := "conformant"
				if kind == "invalid" {
					expectedOutcome = "nonconformant"
				}
				require.Equal(t, expectedOutcome, fixture.ExpectedOutcome)
				if kind == "valid" {
					require.Empty(t, fixture.ExpectedViolation)
				} else {
					require.NotEmpty(t, fixture.ExpectedViolation)
				}

				err := checkRefreshRecoveryFixture(fixture)
				if kind == "valid" {
					require.NoErrorf(t, err, "expected conformant")
					return
				}
				require.Error(t, err)
				var violation *refreshRecoveryViolation
				require.ErrorAs(t, err, &violation)
				require.Equalf(t, fixture.ExpectedViolation, violation.Rule,
					"expected %s, got %s", fixture.ExpectedViolation, err)
			})
		}
	}
	require.Len(t, seen, 14)
}

// TestRefreshRecoveryTerminalTaxonomyMatchesTheContract pins the facade-side
// contract rule (R7) against the corpus: every code the corpus uses as a
// family-kill trigger is classified terminal only when it is the contract's
// terminal code, and every per-request client code is not.
func TestRefreshRecoveryTerminalTaxonomyMatchesTheContract(t *testing.T) {
	for _, code := range []string{
		"invalid_scope",
		"invalid_request",
		"access_denied",
		"expired_token",
		"invalid_token",
		"invalid_client",
		"unauthorized_client",
		"reauth_required",
		"temporarily_unavailable",
		"something_new",
	} {
		require.Falsef(t, oauth.IsTerminalTokenVerdict(code), "%q must not be a family verdict", code)
	}
	require.True(t, oauth.IsTerminalTokenVerdict("invalid_grant"))
	require.Equal(t, []string{"invalid_grant"}, oauth.TerminalTokenVerdictCodes())
	for _, code := range oauth.TerminalTokenVerdictCodes() {
		require.Falsef(t, oauth.IsPerRequestTokenVerdict(code), "%q is both terminal and per-request", code)
	}
}
