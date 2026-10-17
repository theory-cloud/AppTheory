package mcpfacade

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// dcrGroup names the RFC 7591 dynamic-client registration group the shared table
// carries, executed below through the real mounted registration handler.
const dcrGroup = "dcr"

// dcrCaseCount is the number of dcr rows the shared fixture must carry; a change
// to the table must also be a deliberate edit in the Go, TypeScript, and Python
// loaders, so no runtime can silently execute a smaller table.
const dcrCaseCount = 12

// dcrDefaultRepeat is the number of requests a row sends when it carries no
// explicit repeat.
const dcrDefaultRepeat = 1

// dcrFrameOverhead is the number of bytes the serialized pad member adds around
// its "a" run: `,"pad":"` plus `"}`.
const dcrFrameOverhead = len(`,"pad":"`) + len(`"}`)

// dcrConformanceDocument is the shared table's raw rows: the dcr rows are
// decoded one by one, because a `request` member that is not an object belongs
// to another group of the same table.
type dcrConformanceDocument struct {
	Cases []json.RawMessage `json:"cases"`
}

// dcrConformanceCase is a dcr row. A row carries the JSON registration request,
// how many times to present it, and what the last response must look like.
// pad_to_bytes builds a body of exactly that many bytes out of the row's request
// plus one ignored `pad` member; expect_header names a response header the row
// requires.
type dcrConformanceCase struct {
	ID               string         `json:"id"`
	Group            string         `json:"group"`
	Request          map[string]any `json:"request"`
	PadToBytes       int            `json:"pad_to_bytes"`
	Repeat           int            `json:"repeat"`
	ExpectStatus     int            `json:"expect_status"`
	ExpectBodyHas    []string       `json:"expect_body_has"`
	ExpectBodyAbsent []string       `json:"expect_body_absent"`
	ExpectNoStore    bool           `json:"expect_no_store"`
	ExpectHeader     string         `json:"expect_header"`
}

// requestBody builds the raw body the row presents. A row without pad_to_bytes
// presents its request verbatim as compact JSON; a padded row appends one ignored
// `pad` member sized so the serialized body is exactly pad_to_bytes.
func (row dcrConformanceCase) requestBody(t *testing.T) []byte {
	t.Helper()
	compact, err := json.Marshal(row.Request)
	require.NoErrorf(t, err, "row %q must serialize", row.ID)
	if row.PadToBytes == 0 {
		return compact
	}
	require.Truef(t, len(compact) > 1 && compact[len(compact)-1] == '}', "row %q must serialize to a JSON object", row.ID)
	padding := row.PadToBytes - (len(compact) - 1) - dcrFrameOverhead
	require.GreaterOrEqualf(t, padding, 1, "row %q cannot pad to %d bytes", row.ID, row.PadToBytes)

	body := make([]byte, 0, row.PadToBytes)
	body = append(body, compact[:len(compact)-1]...)
	body = append(body, `,"pad":"`...)
	body = append(body, bytes.Repeat([]byte("a"), padding)...)
	body = append(body, `"}`...)
	require.Lenf(t, body, row.PadToBytes, "row %q must present exactly %d body bytes", row.ID, row.PadToBytes)
	return body
}

// TestFrontChannelRegisterEnforcesTheSharedDCRTable pins the RFC 7591
// registration rule to the shared cross-runtime table through the real mounted
// POST .../register handler. Every row runs against a fresh harness, so the
// per-route registration bucket is deterministic and the rate-limited row's
// eleventh attempt is the first refusal.
func TestFrontChannelRegisterEnforcesTheSharedDCRTable(t *testing.T) {
	var document dcrConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]dcrConformanceCase, 0, len(document.Cases))
	for _, raw := range document.Cases {
		var row dcrConformanceCase
		if decodeFacadeConformanceCase(t, raw, dcrGroup, &row) {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, dcrCaseCount, len(rows), "loaded %d %q cases", len(rows), dcrGroup)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			harness := newFrontChannelHarness(t)
			body := row.requestBody(t)

			repeat := row.Repeat
			if repeat < 1 {
				repeat = dcrDefaultRepeat
			}
			var response apptheory.Response
			for attempt := 0; attempt < repeat; attempt++ {
				response = harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthRegisterPath), nil, body)
			}

			require.Equalf(t, row.ExpectStatus, response.Status, "row %q body %q", row.ID, body)

			var payload map[string]json.RawMessage
			require.NoErrorf(t, json.Unmarshal(response.Body, &payload), "row %q must return a JSON object body", row.ID)
			scanned := string(response.Body)
			for _, token := range row.ExpectBodyHas {
				require.Containsf(t, scanned, token, "row %q body", row.ID)
			}
			for _, token := range row.ExpectBodyAbsent {
				require.NotContainsf(t, scanned, token, "row %q body", row.ID)
			}
			if row.ExpectNoStore {
				require.Equalf(t, []string{"no-store"}, response.Headers["cache-control"], "row %q", row.ID)
				require.Equalf(t, []string{"no-cache"}, response.Headers["pragma"], "row %q", row.ID)
			}
			if row.ExpectHeader != "" {
				values := response.Headers[row.ExpectHeader]
				require.NotEmptyf(t, values, "row %q must carry the %s header", row.ID, row.ExpectHeader)
				seconds, err := strconv.Atoi(values[0])
				require.NoErrorf(t, err, "row %q must carry a whole-second %s header", row.ID, row.ExpectHeader)
				require.GreaterOrEqualf(t, seconds, 1, "row %q must not ask for a retry sooner than one second", row.ID)
			}
			if row.ExpectStatus == 201 {
				assertRegisteredDCRClient(t, harness, row.ID, payload)
			}
		})
	}

	require.Equalf(t, dcrCaseCount, executed, "executed %d %q cases", executed, dcrGroup)
}

// assertRegisteredDCRClient proves a 201 row persisted the client it minted: the
// id resolves in the client store, the record claims the public auth method, and
// its BoundRoute is the advertising route of the namespace kind, derived from the
// route algebra rather than from a literal.
func assertRegisteredDCRClient(t *testing.T, harness *frontChannelHarness, rowID string, payload map[string]json.RawMessage) {
	t.Helper()
	var clientID string
	require.NoErrorf(t, json.Unmarshal(payload["client_id"], &clientID), "row %q must carry a client_id", rowID)
	require.NotEmptyf(t, clientID, "row %q must carry a non-empty client_id", rowID)
	// The minted id is 32 random bytes, so it is 43 base64url characters: the
	// 22-character floor is the 128-bit minimum of DESIGN §8.3.
	require.GreaterOrEqualf(t, len(clientID), 22, "row %q must mint an id of at least 128 bits", rowID)
	require.Containsf(t, payload, "client_id_issued_at", "row %q must carry client_id_issued_at", rowID)

	record, err := harness.stores.Client.Get(context.Background(), oauthstore.HashKey(clientID))
	require.NoErrorf(t, err, "row %q must persist the registered client", rowID)
	require.Equalf(t, "none", record.TokenEndpointAuthMethod, "row %q", rowID)
	require.NotEmptyf(t, record.RedirectURIs, "row %q must persist the validated redirect URIs", rowID)
	require.Equalf(
		t,
		frontTestBaseURL+harness.path(mcproutes.EndpointPath.MCPPath),
		record.BoundRoute,
		"row %q must bind the client to the advertising route",
		rowID,
	)
}
