package localcloudfront

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Local CloudFront control-plane API.
//
// The runner serves the CreateInvalidation, GetInvalidation and
// ListInvalidations calls the SDK and the AWS CLI make, so an application (or a
// developer with the CLI) can invalidate the local cache exactly as it would
// invalidate a deployed distribution. The request and response bodies follow
// the CloudFront API reference.
//
// https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CreateInvalidation.html
// https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_GetInvalidation.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html

const (
	cloudFrontAPIPrefix   = "/2020-05-31"
	cloudFrontXMLNS       = "http://cloudfront.amazonaws.com/doc/2020-05-31/"
	invalidationCompleted = "Completed"
	invalidationProgress  = "InProgress"
)

// Invalidation is one local invalidation request.
type Invalidation struct {
	ID              string    `json:"id"`
	DistributionID  string    `json:"distributionId"`
	Status          string    `json:"status"`
	CreateTime      time.Time `json:"createTime"`
	Paths           []string  `json:"paths"`
	CallerReference string    `json:"callerReference"`
}

// InvalidationAPI serves the local CloudFront invalidation API.
type InvalidationAPI struct {
	mu            sync.Mutex
	distributions map[string]*Cache
	logicalIDs    map[string]string
	invalidations map[string]*Invalidation
	order         []string
	now           func() time.Time
	logf          func(format string, args ...any)
}

// NewInvalidationAPI builds an empty control-plane API.
func NewInvalidationAPI(now func() time.Time, logf func(string, ...any)) *InvalidationAPI {
	if now == nil {
		now = time.Now
	}
	return &InvalidationAPI{
		distributions: map[string]*Cache{},
		logicalIDs:    map[string]string{},
		invalidations: map[string]*Invalidation{},
		now:           now,
		logf:          logf,
	}
}

// DistributionID derives the local physical id for a distribution logical id.
// It has the CloudFront id shape (an E followed by upper-case hex).
func DistributionID(logicalID string) string {
	sum := localPhysicalID("cloudfront", logicalID)
	return "E" + strings.ToUpper(sum)
}

// Register makes one distribution's cache reachable by the API.
func (api *InvalidationAPI) Register(logicalID string, cache *Cache) string {
	id := DistributionID(logicalID)
	api.mu.Lock()
	defer api.mu.Unlock()
	api.distributions[id] = cache
	api.logicalIDs[id] = logicalID
	return id
}

// Invalidations returns a copy of every recorded invalidation, newest first.
func (api *InvalidationAPI) Invalidations() []Invalidation {
	api.mu.Lock()
	defer api.mu.Unlock()
	out := make([]Invalidation, 0, len(api.order))
	for index := len(api.order) - 1; index >= 0; index-- {
		if invalidation, ok := api.invalidations[api.order[index]]; ok {
			out = append(out, *invalidation)
		}
	}
	return out
}

func (api *InvalidationAPI) distribution(id string) (*Cache, string, bool) {
	api.mu.Lock()
	defer api.mu.Unlock()
	cache, ok := api.distributions[id]
	return cache, api.logicalIDs[id], ok
}

type invalidationBatchXML struct {
	XMLName xml.Name `xml:"InvalidationBatch"`
	Paths   struct {
		Quantity int `xml:"Quantity"`
		Items    struct {
			Path []string `xml:"Path"`
		} `xml:"Items"`
	} `xml:"Paths"`
	CallerReference string `xml:"CallerReference"`
}

type invalidationXML struct {
	XMLName           xml.Name              `xml:"Invalidation"`
	XMLNS             string                `xml:"xmlns,attr"`
	ID                string                `xml:"Id"`
	Status            string                `xml:"Status"`
	CreateTime        string                `xml:"CreateTime"`
	InvalidationBatch invalidationBatchBody `xml:"InvalidationBatch"`
}

type invalidationBatchBody struct {
	Paths struct {
		Quantity int `xml:"Quantity"`
		Items    struct {
			Path []string `xml:"Path"`
		} `xml:"Items"`
	} `xml:"Paths"`
	CallerReference string `xml:"CallerReference"`
}

type invalidationListXML struct {
	XMLName     xml.Name          `xml:"InvalidationList"`
	XMLNS       string            `xml:"xmlns,attr"`
	Marker      string            `xml:"Marker"`
	MaxItems    int               `xml:"MaxItems"`
	IsTruncated bool              `xml:"IsTruncated"`
	Quantity    int               `xml:"Quantity"`
	Items       []invalidationSum `xml:"Items>InvalidationSummary"`
}

type invalidationSum struct {
	ID         string `xml:"Id"`
	CreateTime string `xml:"CreateTime"`
	Status     string `xml:"Status"`
}

type errorResponseXML struct {
	XMLName xml.Name `xml:"ErrorResponse"`
	XMLNS   string   `xml:"xmlns,attr"`
	Error   struct {
		Type    string `xml:"Type"`
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	} `xml:"Error"`
	RequestID string `xml:"RequestId"`
}

// ServeHTTP routes one control-plane call.
func (api *InvalidationAPI) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	path := strings.TrimSuffix(request.URL.Path, "/")
	if !strings.HasPrefix(path, cloudFrontAPIPrefix+"/distribution/") {
		api.writeError(writer, request, http.StatusNotFound, "NoSuchDistribution", "the local CloudFront API serves /2020-05-31/distribution/{id}")
		return
	}
	rest := strings.TrimPrefix(path, cloudFrontAPIPrefix+"/distribution/")
	id, suffix, hasSuffix := strings.Cut(rest, "/")
	if !hasSuffix {
		suffix = ""
	}
	if _, _, ok := api.distribution(id); !ok {
		api.writeError(writer, request, http.StatusNotFound, "NoSuchDistribution", fmt.Sprintf("distribution %s is not served by this run", id))
		return
	}
	switch {
	case suffix == "invalidation" && request.Method == http.MethodPost:
		api.createInvalidation(writer, request, id)
	case suffix == "invalidation" && request.Method == http.MethodGet:
		api.listInvalidations(writer, request, id)
	case strings.HasPrefix(suffix, "invalidation/") && request.Method == http.MethodGet:
		api.getInvalidation(writer, request, id, strings.TrimPrefix(suffix, "invalidation/"))
	default:
		api.writeError(writer, request, http.StatusMethodNotAllowed, "MethodNotAllowed",
			fmt.Sprintf("%s %s is not served by the local CloudFront API", request.Method, request.URL.Path))
	}
}

func (api *InvalidationAPI) createInvalidation(writer http.ResponseWriter, request *http.Request, distributionID string) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 4<<20))
	if err != nil {
		api.writeError(writer, request, http.StatusBadRequest, "InvalidArgument", err.Error())
		return
	}
	var batch invalidationBatchXML
	if err := xml.Unmarshal(body, &batch); err != nil {
		api.writeError(writer, request, http.StatusBadRequest, "InvalidArgument", "the invalidation batch is not valid XML: "+err.Error())
		return
	}
	paths := batch.Paths.Items.Path
	if batch.Paths.Quantity != len(paths) {
		api.writeError(writer, request, http.StatusBadRequest, "InvalidArgument", fmt.Sprintf(
			"the invalidation batch declares Quantity %d but lists %d paths", batch.Paths.Quantity, len(paths)))
		return
	}
	if err := ValidateInvalidationPaths(paths); err != nil {
		api.writeError(writer, request, http.StatusBadRequest, "InvalidArgument", err.Error())
		return
	}
	// "If you make a second invalidation request with the same value for
	// CallerReference, and if the rest of the request is the same, CloudFront
	// doesn't create a new invalidation request. Instead, CloudFront returns
	// information about the invalidation request that you previously created
	// with the same CallerReference." With a different path, "CloudFront returns
	// an InvalidationBatchAlreadyExists error."
	// https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CreateInvalidation.html
	if existing, ok := api.invalidationForCallerReference(distributionID, batch.CallerReference); ok {
		if !sameInvalidationPaths(existing.Paths, paths) {
			api.writeError(writer, request, http.StatusBadRequest, "InvalidationBatchAlreadyExists", fmt.Sprintf(
				"CallerReference %q was already used with different paths", batch.CallerReference))
			return
		}
		writer.Header().Set("Location", cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation/"+existing.ID)
		writer.Header().Set("Content-Type", "text/xml")
		writer.WriteHeader(http.StatusCreated)
		api.writeInvalidation(writer, &existing)
		return
	}
	cache, logicalID, _ := api.distribution(distributionID)
	removed := cache.Invalidate(paths)
	invalidation := &Invalidation{
		ID:              newInvalidationID(),
		DistributionID:  distributionID,
		Status:          invalidationCompleted,
		CreateTime:      api.now().UTC(),
		Paths:           append([]string(nil), paths...),
		CallerReference: batch.CallerReference,
	}
	api.mu.Lock()
	api.invalidations[invalidation.ID] = invalidation
	api.order = append(api.order, invalidation.ID)
	api.mu.Unlock()
	if api.logf != nil {
		api.logf("cloudfront invalidation %s for %s removed %d cached object(s): %s",
			invalidation.ID, logicalID, removed, strings.Join(paths, ", "))
	}
	writer.Header().Set("Location", cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation/"+invalidation.ID)
	writer.Header().Set("Content-Type", "text/xml")
	writer.WriteHeader(http.StatusCreated)
	api.writeInvalidation(writer, invalidation)
}

func (api *InvalidationAPI) getInvalidation(writer http.ResponseWriter, request *http.Request, distributionID, invalidationID string) {
	api.mu.Lock()
	invalidation, ok := api.invalidations[invalidationID]
	api.mu.Unlock()
	if !ok || invalidation.DistributionID != distributionID {
		api.writeError(writer, request, http.StatusNotFound, "NoSuchInvalidation",
			fmt.Sprintf("invalidation %s is not recorded for distribution %s", invalidationID, distributionID))
		return
	}
	writer.Header().Set("Content-Type", "text/xml")
	writer.WriteHeader(http.StatusOK)
	api.writeInvalidation(writer, invalidation)
}

func (api *InvalidationAPI) listInvalidations(writer http.ResponseWriter, _ *http.Request, distributionID string) {
	api.mu.Lock()
	summaries := make([]invalidationSum, 0, len(api.order))
	for index := len(api.order) - 1; index >= 0; index-- {
		invalidation, ok := api.invalidations[api.order[index]]
		if !ok || invalidation.DistributionID != distributionID {
			continue
		}
		summaries = append(summaries, invalidationSum{
			ID:         invalidation.ID,
			CreateTime: invalidation.CreateTime.Format(time.RFC3339),
			Status:     invalidation.Status,
		})
	}
	api.mu.Unlock()
	list := invalidationListXML{
		XMLNS:    cloudFrontXMLNS,
		Marker:   "",
		MaxItems: 100,
		Quantity: len(summaries),
		Items:    summaries,
	}
	writer.Header().Set("Content-Type", "text/xml")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(xml.Header)) //nolint:errcheck // response already committed
	_ = xml.NewEncoder(writer).Encode(list) //nolint:errcheck // response already committed
}

func (api *InvalidationAPI) writeInvalidation(writer http.ResponseWriter, invalidation *Invalidation) {
	document := invalidationXML{
		XMLNS:      cloudFrontXMLNS,
		ID:         invalidation.ID,
		Status:     invalidation.Status,
		CreateTime: invalidation.CreateTime.Format(time.RFC3339),
	}
	document.InvalidationBatch.CallerReference = invalidation.CallerReference
	document.InvalidationBatch.Paths.Quantity = len(invalidation.Paths)
	document.InvalidationBatch.Paths.Items.Path = append([]string(nil), invalidation.Paths...)
	_, _ = writer.Write([]byte(xml.Header))     //nolint:errcheck // response already committed
	_ = xml.NewEncoder(writer).Encode(document) //nolint:errcheck // response already committed
}

func (api *InvalidationAPI) writeError(writer http.ResponseWriter, _ *http.Request, status int, code, message string) {
	document := errorResponseXML{XMLNS: cloudFrontXMLNS, RequestID: fmt.Sprintf("local-%d", time.Now().UnixNano())}
	document.Error.Type = "Sender"
	document.Error.Code = code
	document.Error.Message = message
	writer.Header().Set("Content-Type", "text/xml")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(xml.Header))     //nolint:errcheck // response already committed
	_ = xml.NewEncoder(writer).Encode(document) //nolint:errcheck // response already committed
}

// invalidationForCallerReference returns the invalidation a previous request
// with the same CallerReference created for the distribution.
func (api *InvalidationAPI) invalidationForCallerReference(distributionID, callerReference string) (Invalidation, bool) {
	api.mu.Lock()
	defer api.mu.Unlock()
	for _, id := range api.order {
		invalidation, ok := api.invalidations[id]
		if !ok || invalidation.DistributionID != distributionID {
			continue
		}
		if invalidation.CallerReference == callerReference {
			return *invalidation, true
		}
	}
	return Invalidation{}, false
}

func sameInvalidationPaths(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func newInvalidationID() string {
	return "I" + strings.ToUpper(newLocalID())
}

// newLocalID returns a random hex id in the shape the local APIs report.
func newLocalID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw[:])
}

// localPhysicalID derives a stable physical id for an assembly resource.
func localPhysicalID(kind, logicalID string) string {
	sum := sha256.Sum256([]byte(kind + "/" + logicalID))
	return hex.EncodeToString(sum[:])[:10]
}
