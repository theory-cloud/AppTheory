package localrunner

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// bucketDeploymentProperties is the Custom::CDKBucketDeployment surface the
// local runner reproduces. The custom resource is the deployment source of
// truth: the runner copies the assembly's asset directories/zips into the
// emulator bucket with the declared destination prefix and metadata instead of
// reading a hand-written file list.
type bucketDeploymentProperties struct {
	SourceObjectKeys           []string          `json:"SourceObjectKeys"`
	DestinationBucketName      json.RawMessage   `json:"DestinationBucketName"`
	DestinationBucketKeyPrefix string            `json:"DestinationBucketKeyPrefix"`
	Prune                      bool              `json:"Prune"`
	Extract                    *bool             `json:"Extract"`
	Include                    []string          `json:"Include"`
	Exclude                    []string          `json:"Exclude"`
	SystemMetadata             map[string]string `json:"SystemMetadata"`
	UserMetadata               map[string]string `json:"UserMetadata"`
}

type assetManifestFile struct {
	Source struct {
		Path      string `json:"path"`
		Packaging string `json:"packaging"`
	} `json:"source"`
	Destinations map[string]struct {
		ObjectKey string `json:"objectKey"`
	} `json:"destinations"`
}

type assetManifest struct {
	Files map[string]assetManifestFile `json:"files"`
}

// provisionDeployments copies every Custom::CDKBucketDeployment source into its
// provisioned bucket. It runs after provisionBuckets and only when the s3
// backend is configured.
func (r *Runner) provisionDeployments(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("s3")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the s3 backend has no loopback endpoint for the runner to deploy bucket contents")
	}
	client := newS3Client(backend.HostURL)
	manifests := map[string]map[string]string{}
	for _, resource := range spec.Resources {
		if resource.Type != typeBucketDeploy {
			continue
		}
		sources, err := r.assetSources(spec, resource.Stack, manifests)
		if err != nil {
			return err
		}
		if err := r.provisionDeployment(ctx, client, resource, sources); err != nil {
			return err
		}
	}
	return nil
}

// assetSources maps a stack's asset object keys to their local source path in
// the cloud assembly.
func (r *Runner) assetSources(spec *Spec, stack string, cache map[string]map[string]string) (map[string]string, error) {
	if sources, ok := cache[stack]; ok {
		return sources, nil
	}
	manifestPath := filepath.Join(spec.AssemblyDir, stack+".assets.json")
	raw, err := os.ReadFile(manifestPath) //nolint:gosec // assembly path derived from the synthesized app
	if err != nil {
		return nil, fmt.Errorf("read asset manifest for stack %s: %w", stack, err)
	}
	var manifest assetManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("parse asset manifest %s: %w", manifestPath, err)
	}
	sources := map[string]string{}
	for _, file := range manifest.Files {
		for _, destination := range file.Destinations {
			if destination.ObjectKey == "" || file.Source.Path == "" {
				continue
			}
			source := file.Source.Path
			if !filepath.IsAbs(source) {
				source = filepath.Join(spec.AssemblyDir, source)
			}
			sources[destination.ObjectKey] = source
		}
	}
	cache[stack] = sources
	return sources, nil
}

func (r *Runner) provisionDeployment(
	ctx context.Context,
	client *s3.Client,
	resource ResourceSpec,
	sources map[string]string,
) error {
	var props bucketDeploymentProperties
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("parse bucket deployment %s properties: %w", resource.LogicalID, err)
		}
	}
	if len(props.Include) > 0 || len(props.Exclude) > 0 {
		return unsupported(resource.LogicalID,
			"the deployment declares Include/Exclude patterns; the local deployment does not evaluate them")
	}
	if props.Extract != nil && !*props.Extract {
		return unsupported(resource.LogicalID,
			"the deployment sets Extract=false; the local deployment only extracts asset directories and zips")
	}
	bucket, err := r.deploymentBucket(resource, props)
	if err != nil {
		return err
	}
	prefix := strings.Trim(strings.TrimSpace(props.DestinationBucketKeyPrefix), "/")
	deployed := map[string]struct{}{}
	total := 0
	for _, key := range props.SourceObjectKeys {
		source, ok := sources[key]
		if !ok {
			return unsupported(resource.LogicalID,
				"deployment source %q is not an asset in this assembly; the local deployment supports asset sources only", key)
		}
		count, err := r.deploySource(ctx, client, bucket, prefix, source, props, deployed)
		if err != nil {
			return fmt.Errorf("deploy %s source %s: %w", resource.LogicalID, key, err)
		}
		total += count
	}
	if props.Prune {
		if err := r.pruneDeployment(ctx, client, bucket, prefix, deployed); err != nil {
			return fmt.Errorf("prune %s in bucket %s: %w", resource.LogicalID, bucket, err)
		}
	}
	r.logf("deployed %d object(s) from %s to s3://%s/%s", total, resource.LogicalID, bucket, prefix)
	return nil
}

func (r *Runner) deploymentBucket(resource ResourceSpec, props bucketDeploymentProperties) (string, error) {
	bucketID, ok := directRefID(props.DestinationBucketName)
	if !ok {
		return "", unsupported(resource.LogicalID,
			"DestinationBucketName is not a direct reference to a bucket in this assembly")
	}
	value, ok := r.resourceValues[resource.Stack+"/"+bucketID]
	if !ok || value.Type != typeS3Bucket {
		return "", unsupported(resource.LogicalID,
			"destination bucket %s was not provisioned; start the run with --backend s3proxy", bucketID)
	}
	return value.Name, nil
}

func (r *Runner) deploySource(
	ctx context.Context,
	client *s3.Client,
	bucket, prefix, source string,
	props bucketDeploymentProperties,
	deployed map[string]struct{},
) (int, error) {
	info, err := os.Stat(source)
	if err != nil {
		return 0, fmt.Errorf("stat asset source %s: %w", source, err)
	}
	if info.IsDir() {
		return r.deployDirectory(ctx, client, bucket, prefix, source, props, deployed)
	}
	if strings.EqualFold(filepath.Ext(source), ".zip") {
		return r.deployZip(ctx, client, bucket, prefix, source, props, deployed)
	}
	return 0, unsupported("bucket deployment",
		"asset source %s is a single file; the local deployment supports directory and zip asset sources", source)
}

func (r *Runner) deployDirectory(
	ctx context.Context,
	client *s3.Client,
	bucket, prefix, source string,
	props bucketDeploymentProperties,
	deployed map[string]struct{},
) (int, error) {
	var files []string
	err := filepath.WalkDir(source, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		files = append(files, filePath)
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("walk asset source %s: %w", source, err)
	}
	sort.Strings(files)
	count := 0
	for _, filePath := range files {
		relative, err := filepath.Rel(source, filePath)
		if err != nil {
			return count, err
		}
		body, err := os.ReadFile(filePath) //nolint:gosec // assembly asset path
		if err != nil {
			return count, fmt.Errorf("read asset %s: %w", filePath, err)
		}
		key := path.Join(prefix, filepath.ToSlash(relative))
		if err := r.putDeploymentObject(ctx, client, bucket, key, body, props); err != nil {
			return count, err
		}
		deployed[key] = struct{}{}
		count++
	}
	return count, nil
}

func (r *Runner) deployZip(
	ctx context.Context,
	client *s3.Client,
	bucket, prefix, source string,
	props bucketDeploymentProperties,
	deployed map[string]struct{},
) (int, error) {
	reader, err := zip.OpenReader(source)
	if err != nil {
		return 0, fmt.Errorf("open asset zip %s: %w", source, err)
	}
	defer func() { _ = reader.Close() }() //nolint:errcheck // the archive is only read
	type zipEntry struct {
		file *zip.File
		key  string
	}
	entries := make([]zipEntry, 0, len(reader.File))
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		key, err := deploymentObjectKey(prefix, file.Name)
		if err != nil {
			return 0, fmt.Errorf("asset zip %s: %w", source, err)
		}
		entries = append(entries, zipEntry{file: file, key: key})
	}
	count := 0
	for _, entry := range entries {
		body, err := readZipFile(entry.file)
		if err != nil {
			return count, err
		}
		if err := r.putDeploymentObject(ctx, client, bucket, entry.key, body, props); err != nil {
			return count, err
		}
		deployed[entry.key] = struct{}{}
		count++
	}
	return count, nil
}

// deploymentObjectKey joins a deployment prefix and a zip entry path. It refuses
// an entry that would leave the deployment's destination: an absolute path or a
// cleaned path with a ".." segment. Every entry is checked before the first
// PutObject so a crafted archive cannot partially deploy first.
func deploymentObjectKey(prefix, name string) (string, error) {
	cleaned := path.Clean(filepath.ToSlash(strings.ReplaceAll(name, "\\", "/")))
	if path.IsAbs(cleaned) {
		return "", fmt.Errorf("entry %q has an absolute path; the deployment refuses to write outside the destination prefix", name)
	}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == ".." {
			return "", fmt.Errorf("entry %q escapes the destination prefix; the deployment refuses a zip-slip path", name)
		}
	}
	return path.Join(prefix, cleaned), nil
}

func readZipFile(file *zip.File) ([]byte, error) {
	handle, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("open %s in asset zip: %w", file.Name, err)
	}
	defer func() { _ = handle.Close() }() //nolint:errcheck // the entry is fully read
	body, err := io.ReadAll(handle)
	if err != nil {
		return nil, fmt.Errorf("read %s from asset zip: %w", file.Name, err)
	}
	return body, nil
}

func (r *Runner) putDeploymentObject(
	ctx context.Context,
	client *s3.Client,
	bucket, key string,
	body []byte,
	props bucketDeploymentProperties,
) error {
	input := &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(deploymentContentType(key, props.SystemMetadata)),
	}
	if value := props.SystemMetadata["cache-control"]; value != "" {
		input.CacheControl = aws.String(value)
	}
	if value := props.SystemMetadata["content-disposition"]; value != "" {
		input.ContentDisposition = aws.String(value)
	}
	if value := props.SystemMetadata["content-encoding"]; value != "" {
		input.ContentEncoding = aws.String(value)
	}
	if value := props.SystemMetadata["content-language"]; value != "" {
		input.ContentLanguage = aws.String(value)
	}
	if value := props.SystemMetadata["expires"]; value != "" {
		parsed, err := http.ParseTime(value)
		if err != nil {
			return fmt.Errorf("deployment metadata expires %q is not an HTTP date: %w", value, err)
		}
		input.Expires = aws.Time(parsed)
	}
	if len(props.UserMetadata) > 0 {
		metadata := make(map[string]string, len(props.UserMetadata))
		for name, value := range props.UserMetadata {
			metadata[strings.ToLower(name)] = value
		}
		input.Metadata = metadata
	}
	if _, err := client.PutObject(ctx, input); err != nil {
		return fmt.Errorf("put s3://%s/%s: %w", bucket, key, err)
	}
	return nil
}

func (r *Runner) pruneDeployment(
	ctx context.Context,
	client *s3.Client,
	bucket, prefix string,
	deployed map[string]struct{},
) error {
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	})
	var stale []types.ObjectIdentifier
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list s3://%s/%s: %w", bucket, prefix, err)
		}
		for _, object := range page.Contents {
			key := aws.ToString(object.Key)
			if _, ok := deployed[key]; ok {
				continue
			}
			stale = append(stale, types.ObjectIdentifier{Key: aws.String(key)})
			if len(stale) == 1000 {
				if err := deleteDeploymentObjects(ctx, client, bucket, stale); err != nil {
					return err
				}
				stale = nil
			}
		}
	}
	if len(stale) > 0 {
		return deleteDeploymentObjects(ctx, client, bucket, stale)
	}
	return nil
}

func deleteDeploymentObjects(ctx context.Context, client *s3.Client, bucket string, objects []types.ObjectIdentifier) error {
	_, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(bucket),
		Delete: &types.Delete{Objects: objects, Quiet: aws.Bool(true)},
	})
	if err != nil {
		return fmt.Errorf("delete stale objects in s3://%s: %w", bucket, err)
	}
	return nil
}

// deploymentContentType mirrors the content-type the CDK deployment's AWS CLI
// infers from the object extension, unless the deployment declares one.
func deploymentContentType(key string, system map[string]string) string {
	if value := system["content-type"]; value != "" {
		return value
	}
	if value, ok := deploymentContentTypes[strings.ToLower(path.Ext(key))]; ok {
		return value
	}
	return "application/octet-stream"
}

var deploymentContentTypes = map[string]string{
	".html":  "text/html",
	".htm":   "text/html",
	".css":   "text/css",
	".js":    "text/javascript",
	".mjs":   "text/javascript",
	".cjs":   "text/javascript",
	".json":  "application/json",
	".map":   "application/json",
	".txt":   "text/plain",
	".xml":   "application/xml",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".pdf":   "application/pdf",
	".mp4":   "video/mp4",
	".webm":  "video/webm",
}
