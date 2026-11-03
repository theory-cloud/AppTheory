package localrunner

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// s3Origin serves one CloudFront S3 origin from the runner's s3proxy backend.
//
// The origin models the S3 REST behavior CloudFront relies on: GET and HEAD
// return the object with its metadata headers, a Range request returns 206, and
// OPTIONS follows the bucket's CORS configuration. Bucket CORS rules are not
// provisioned locally, so an OPTIONS request to a bucket that declares CORS is
// refused rather than answered with invented CORS headers; a bucket without CORS
// returns the 403 AccessForbidden S3 returns when no rule matches.
//
// An OAC or OAI origin has s3:GetObject but not s3:ListBucket. S3 hides the
// difference between a missing object and a denied one without ListBucket, so a
// missing object is 403 AccessDenied for such an origin and 404 NoSuchKey for a
// public S3 origin:
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-best-practices.html
// https://repost.aws/knowledge-center/403-vs-404-error-s3
type s3Origin struct {
	originID     string
	bucket       string
	client       *s3.Client
	noListBucket bool
	hasCORS      bool
	requestID    func() string
}

func (o *s3Origin) Fetch(ctx context.Context, request localcloudfront.OriginRequest) (localcloudfront.OriginResponse, error) {
	query := request.Query
	if request.SuppressS3ResponseOverrides {
		query = localcloudfront.FilterS3ResponseOverrides(query)
	}
	switch request.Method {
	case http.MethodGet:
		return o.get(ctx, request, query, false)
	case http.MethodHead:
		return o.get(ctx, request, query, true)
	case http.MethodOptions:
		return o.options(request), nil
	default:
		return localcloudfront.OriginResponse{}, &localcloudfront.OriginUnavailableError{
			OriginID: o.originID,
			Reason: fmt.Sprintf(
				"the local S3 origin serves GET, HEAD and OPTIONS; method %s is not implemented locally",
				request.Method,
			),
		}
	}
}

func (o *s3Origin) get(
	ctx context.Context,
	request localcloudfront.OriginRequest,
	query string,
	head bool,
) (localcloudfront.OriginResponse, error) {
	key, ok := s3ObjectKey(request.Path())
	if !ok {
		return o.missing(request), nil
	}
	input := &s3.GetObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(key)}
	if values, err := url.ParseQuery(query); err == nil {
		if version := values.Get("versionId"); version != "" {
			input.VersionId = aws.String(version)
		}
	}
	if request.Range != "" {
		input.Range = aws.String(request.Range)
	}
	if request.Header != nil {
		input.IfMatch = optionalHeader(request.Header, "If-Match")
		input.IfNoneMatch = optionalHeader(request.Header, "If-None-Match")
		if modified := optionalHeader(request.Header, "If-Modified-Since"); modified != nil {
			if parsed, err := http.ParseTime(*modified); err == nil {
				input.IfModifiedSince = aws.Time(parsed)
			}
		}
		if unmodified := optionalHeader(request.Header, "If-Unmodified-Since"); unmodified != nil {
			if parsed, err := http.ParseTime(*unmodified); err == nil {
				input.IfUnmodifiedSince = aws.Time(parsed)
			}
		}
	}
	if head {
		return o.headObject(ctx, input, request, query)
	}
	output, err := o.client.GetObject(ctx, input)
	if err != nil {
		return o.mapError(err, request)
	}
	defer func() { _ = output.Body.Close() }() //nolint:errcheck // the body is fully read below
	body, readErr := io.ReadAll(output.Body)
	if readErr != nil {
		return localcloudfront.OriginResponse{}, fmt.Errorf("read s3 object %s/%s: %w", o.bucket, key, readErr)
	}
	response := localcloudfront.OriginResponse{
		StatusCode: http.StatusOK,
		Header:     s3GetObjectHeader(output),
		Body:       body,
	}
	if output.ContentRange != nil && aws.ToString(output.ContentRange) != "" {
		response.StatusCode = http.StatusPartialContent
	}
	applyS3ResponseOverrides(response.Header, query)
	return response, nil
}

func (o *s3Origin) headObject(
	ctx context.Context,
	input *s3.GetObjectInput,
	request localcloudfront.OriginRequest,
	query string,
) (localcloudfront.OriginResponse, error) {
	// Ask for the object's full metadata. The pinned s3proxy backend ignores
	// Range on HEAD (it answers 200 with the full Content-Length and no
	// Content-Range), so the ranged response is derived below from that length
	// instead of trusting the backend to apply the range.
	output, err := o.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket:            input.Bucket,
		Key:               input.Key,
		VersionId:         input.VersionId,
		IfMatch:           input.IfMatch,
		IfNoneMatch:       input.IfNoneMatch,
		IfModifiedSince:   input.IfModifiedSince,
		IfUnmodifiedSince: input.IfUnmodifiedSince,
	})
	if err != nil {
		return o.mapError(err, request)
	}
	header := http.Header{}
	setS3Header(header, "Content-Type", output.ContentType)
	setS3Header(header, "Content-Length", output.ContentLength)
	setS3Header(header, "ETag", output.ETag)
	if output.LastModified != nil {
		header.Set("Last-Modified", output.LastModified.UTC().Format(http.TimeFormat))
	}
	setS3Header(header, "Cache-Control", output.CacheControl)
	setS3Header(header, "Content-Disposition", output.ContentDisposition)
	setS3Header(header, "Content-Encoding", output.ContentEncoding)
	setS3Header(header, "Content-Language", output.ContentLanguage)
	setS3Expires(header, output.ExpiresString)
	setS3Header(header, "Content-Range", output.ContentRange)
	header.Set("Accept-Ranges", "bytes")
	addS3Metadata(header, output.Metadata)
	applyS3ResponseOverrides(header, query)
	// S3 documents HeadObject as returning the same response as GetObject
	// except with no body, and a satisfiable GetObject Range as 206 Partial
	// Content with Content-Range; an unsatisfiable range is 416.
	// https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
	// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
	status := http.StatusOK
	if request.Range != "" && output.ContentLength != nil {
		switch applyHeadRange(header, request.Range, *output.ContentLength) {
		case headRangePartial:
			status = http.StatusPartialContent
		case headRangeUnsatisfiable:
			response := s3ErrorResponse(http.StatusRequestedRangeNotSatisfiable, "InvalidRange",
				"The requested range is not satisfiable", o.newRequestID(), request)
			response.Header.Set("Content-Range", fmt.Sprintf("bytes */%d", *output.ContentLength))
			return response, nil
		}
	}
	return localcloudfront.OriginResponse{StatusCode: status, Header: header}, nil
}

type headRangeResult int

const (
	// headRangeFull keeps the full-object metadata: no usable single byte
	// range was requested.
	headRangeFull headRangeResult = iota
	// headRangePartial sets Content-Range and the ranged Content-Length.
	headRangePartial
	// headRangeUnsatisfiable is the 416 case with "bytes */total".
	headRangeUnsatisfiable
)

// applyHeadRange turns full-object HEAD metadata into the response a Range
// produces. Only one byte range is applied: S3 does not support multiple
// ranges per request, so a multi-range (or otherwise unparseable) value is
// ignored and the full object's metadata is returned, as RFC 9110 permits.
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
// https://www.rfc-editor.org/rfc/rfc9110#section-14.2
func applyHeadRange(header http.Header, raw string, total int64) headRangeResult {
	start, end, result := parseHeadRange(raw, total)
	if result != headRangePartial {
		return result
	}
	header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
	header.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	return headRangePartial
}

// parseHeadRange parses one bytes range. first-byte-pos, open-ended and
// suffix-byte-range-spec forms follow RFC 9110; the last-byte-pos is clamped
// to the object size. A syntactically invalid spec, a non-bytes unit or a
// multi-range spec is ignored (headRangeFull); a syntactically valid range
// that cannot overlap the object is headRangeUnsatisfiable.
func parseHeadRange(raw string, total int64) (int64, int64, headRangeResult) {
	unit, spec, found := strings.Cut(strings.TrimSpace(raw), "=")
	if !found || !strings.EqualFold(strings.TrimSpace(unit), "bytes") {
		return 0, 0, headRangeFull
	}
	spec = strings.TrimSpace(spec)
	if strings.Contains(spec, ",") {
		return 0, 0, headRangeFull
	}
	first, last, found := strings.Cut(spec, "-")
	if !found {
		return 0, 0, headRangeFull
	}
	first = strings.TrimSpace(first)
	last = strings.TrimSpace(last)
	if first == "" {
		return parseSuffixHeadRange(last, total)
	}
	return parseClosedHeadRange(first, last, total)
}

// parseSuffixHeadRange parses the "-length" form: the last length bytes,
// clamped to the object size.
func parseSuffixHeadRange(last string, total int64) (int64, int64, headRangeResult) {
	length, err := strconv.ParseInt(last, 10, 64)
	if err != nil {
		return 0, 0, headRangeFull
	}
	if length == 0 || total == 0 {
		return 0, 0, headRangeUnsatisfiable
	}
	if length > total {
		length = total
	}
	return total - length, total - 1, headRangePartial
}

// parseClosedHeadRange parses the "first-" and "first-last" forms; last is
// clamped to the object size.
func parseClosedHeadRange(first, last string, total int64) (int64, int64, headRangeResult) {
	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil {
		return 0, 0, headRangeFull
	}
	if start >= total {
		return 0, 0, headRangeUnsatisfiable
	}
	end := total - 1
	if last != "" {
		end, err = strconv.ParseInt(last, 10, 64)
		if err != nil || end < start {
			return 0, 0, headRangeFull
		}
		if end >= total {
			end = total - 1
		}
	}
	return start, end, headRangePartial
}

func (o *s3Origin) options(request localcloudfront.OriginRequest) localcloudfront.OriginResponse {
	if o.hasCORS {
		return s3ErrorResponse(http.StatusNotImplemented, "NotImplemented",
			"S3 bucket CORS rules are declared in the assembly but the local S3 origin does not emulate them", o.newRequestID(), request)
	}
	return s3ErrorResponse(http.StatusForbidden, "AccessForbidden",
		"the bucket has no CORS configuration, so S3 refuses the preflight request", o.newRequestID(), request)
}

func (o *s3Origin) missing(request localcloudfront.OriginRequest) localcloudfront.OriginResponse {
	if o.noListBucket {
		return s3ErrorResponse(http.StatusForbidden, "AccessDenied",
			"Access Denied: the origin has no s3:ListBucket permission, so S3 does not reveal whether the object exists", o.newRequestID(), request)
	}
	return s3ErrorResponse(http.StatusNotFound, "NoSuchKey",
		"The specified key does not exist.", o.newRequestID(), request)
}

func (o *s3Origin) mapError(err error, request localcloudfront.OriginRequest) (localcloudfront.OriginResponse, error) {
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		switch coded.ErrorCode() {
		case "NoSuchKey", "NotFound":
			return o.missing(request), nil
		case "AccessDenied", "AllAccessDisabled", "InvalidAccessKeyId", "SignatureDoesNotMatch":
			return s3ErrorResponse(http.StatusForbidden, "AccessDenied", "Access Denied", o.newRequestID(), request), nil
		case "InvalidRange":
			return s3ErrorResponse(http.StatusRequestedRangeNotSatisfiable, "InvalidRange",
				"The requested range is not satisfiable", o.newRequestID(), request), nil
		}
	}
	// A conditional GET or HEAD that S3 answers with 304 Not Modified or 412
	// Precondition Failed reaches the SDK as an error. CloudFront passes the
	// origin's status and validators through; it does not turn either into a
	// gateway error. A 304 has no body; the local 412 likewise carries only the
	// origin's validators.
	// https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
	var responseErr *awshttp.ResponseError
	if errors.As(err, &responseErr) {
		switch status := responseErr.HTTPStatusCode(); status {
		case http.StatusNotModified, http.StatusPreconditionFailed:
			return s3ConditionalResponse(status, responseErr.HTTPResponse().Header), nil
		}
	}
	var statusErr interface{ HTTPStatusCode() int }
	if errors.As(err, &statusErr) {
		switch statusErr.HTTPStatusCode() {
		case http.StatusNotFound:
			return o.missing(request), nil
		case http.StatusForbidden:
			return s3ErrorResponse(http.StatusForbidden, "AccessDenied", "Access Denied", o.newRequestID(), request), nil
		case http.StatusRequestedRangeNotSatisfiable:
			return s3ErrorResponse(http.StatusRequestedRangeNotSatisfiable, "InvalidRange",
				"The requested range is not satisfiable", o.newRequestID(), request), nil
		}
	}
	return localcloudfront.OriginResponse{}, fmt.Errorf("s3 origin %s: get object: %w", o.originID, err)
}

func (o *s3Origin) newRequestID() string {
	if o.requestID == nil {
		return ""
	}
	return o.requestID()
}

func s3ObjectKey(path string) (string, bool) {
	key := strings.TrimPrefix(path, "/")
	if key == "" {
		return "", false
	}
	if decoded, err := url.PathUnescape(key); err == nil {
		key = decoded
	}
	return key, true
}

func optionalHeader(header http.Header, name string) *string {
	values := header.Values(name)
	if len(values) == 0 {
		return nil
	}
	return aws.String(values[0])
}

func s3GetObjectHeader(output *s3.GetObjectOutput) http.Header {
	header := http.Header{}
	setS3Header(header, "Content-Type", output.ContentType)
	setS3Header(header, "Content-Length", output.ContentLength)
	setS3Header(header, "ETag", output.ETag)
	if output.LastModified != nil {
		header.Set("Last-Modified", output.LastModified.UTC().Format(http.TimeFormat))
	}
	setS3Header(header, "Cache-Control", output.CacheControl)
	setS3Header(header, "Content-Disposition", output.ContentDisposition)
	setS3Header(header, "Content-Encoding", output.ContentEncoding)
	setS3Header(header, "Content-Language", output.ContentLanguage)
	setS3Expires(header, output.ExpiresString)
	setS3Header(header, "Content-Range", output.ContentRange)
	header.Set("Accept-Ranges", "bytes")
	addS3Metadata(header, output.Metadata)
	return header
}

func setS3Expires(header http.Header, raw *string) {
	if raw != nil && *raw != "" {
		header.Set("Expires", *raw)
	}
}

func setS3Header(header http.Header, name string, value any) {
	switch typed := value.(type) {
	case *string:
		if typed != nil && *typed != "" {
			header.Set(name, *typed)
		}
	case *int64:
		if typed != nil {
			header.Set(name, strconv.FormatInt(*typed, 10))
		}
	}
}

func addS3Metadata(header http.Header, metadata map[string]string) {
	for name, value := range metadata {
		header.Add("x-amz-meta-"+name, value)
	}
}

// applyS3ResponseOverrides applies the response-* query overrides S3 documents
// for an authenticated GetObject request. A managed origin request policy strips
// three of them before the origin, so the object's own metadata wins there.
func applyS3ResponseOverrides(header http.Header, query string) {
	values, err := url.ParseQuery(query)
	if err != nil {
		return
	}
	overrides := map[string]string{
		"response-content-type":        "Content-Type",
		"response-content-language":    "Content-Language",
		"response-expires":             "Expires",
		"response-cache-control":       "Cache-Control",
		"response-content-disposition": "Content-Disposition",
		"response-content-encoding":    "Content-Encoding",
	}
	for parameter, name := range overrides {
		if value := values.Get(parameter); value != "" {
			header.Set(name, value)
		}
	}
}

// s3ConditionalResponse passes a 304 Not Modified or 412 Precondition Failed
// through with the validators S3 attached to it and no body.
func s3ConditionalResponse(status int, origin http.Header) localcloudfront.OriginResponse {
	header := http.Header{}
	for _, name := range []string{"ETag", "Last-Modified"} {
		for _, value := range origin.Values(name) {
			header.Add(name, value)
		}
	}
	return localcloudfront.OriginResponse{
		StatusCode:        status,
		StatusDescription: http.StatusText(status),
		Header:            header,
	}
}

type s3ErrorBody struct {
	XMLName   xml.Name `xml:"Error"`
	Code      string   `xml:"Code"`
	Message   string   `xml:"Message"`
	RequestID string   `xml:"RequestId"`
}

func s3ErrorResponse(
	status int,
	code, message, requestID string,
	request localcloudfront.OriginRequest,
) localcloudfront.OriginResponse {
	body, _ := xml.Marshal(s3ErrorBody{Code: code, Message: message, RequestID: requestID}) //nolint:errcheck // fixed shape
	header := http.Header{"Content-Type": []string{"application/xml"}}
	if requestID != "" {
		header.Set("x-amz-request-id", requestID)
	}
	if request.Method == http.MethodHead {
		body = nil
	}
	return localcloudfront.OriginResponse{
		StatusCode:        status,
		StatusDescription: http.StatusText(status),
		Header:            header,
		Body:              body,
	}
}
