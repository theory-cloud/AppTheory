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
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
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
	output, err := o.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket:          input.Bucket,
		Key:             input.Key,
		VersionId:       input.VersionId,
		Range:           input.Range,
		IfMatch:         input.IfMatch,
		IfNoneMatch:     input.IfNoneMatch,
		IfModifiedSince: input.IfModifiedSince,
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
	setS3Expires(header, output.ExpiresString, output.Expires)
	setS3Header(header, "Content-Range", output.ContentRange)
	header.Set("Accept-Ranges", "bytes")
	addS3Metadata(header, output.Metadata)
	applyS3ResponseOverrides(header, query)
	return localcloudfront.OriginResponse{StatusCode: http.StatusOK, Header: header}, nil
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
	setS3Expires(header, output.ExpiresString, output.Expires)
	setS3Header(header, "Content-Range", output.ContentRange)
	header.Set("Accept-Ranges", "bytes")
	addS3Metadata(header, output.Metadata)
	return header
}

func setS3Expires(header http.Header, raw *string, parsed *time.Time) {
	if raw != nil && *raw != "" {
		header.Set("Expires", *raw)
		return
	}
	if parsed != nil {
		header.Set("Expires", parsed.UTC().Format(http.TimeFormat))
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
