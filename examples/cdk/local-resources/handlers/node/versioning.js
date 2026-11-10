// The S3 versioning probe.
//
// The nodejs24.x image carries the AWS SDK for JavaScript v3 under
// /var/runtime/node_modules, so the handler requires it by that absolute path,
// the way the local-iam Node caller does. Every operation goes through the
// runner's injected S3 endpoint (the S3 front), which is what makes this row a
// proof of the front's versioning semantics rather than of a hand-written
// response.
//
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html
"use strict";

const SDK = "/var/runtime/node_modules/";
const {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} = require(SDK + "@aws-sdk/client-s3");

function proxy(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  const bucket = process.env.APPTHEORY_LOCAL_VERSIONED_BUCKET;
  const client = new S3Client({});
  const action = (event && event.action) || "put";
  const key = (event && event.key) || "doc.md";
  try {
    if (action === "env") {
      return proxy(200, {
        action,
        bucket,
        kmsEndpoint: process.env.KMS_ENDPOINT || null,
        ssmEndpoint: process.env.SSM_ENDPOINT || null,
        s3Endpoint: process.env.S3_ENDPOINT || null,
        dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT || null,
      });
    }
    if (action === "put") {
      const output = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: (event && event.body) || "",
          ContentType: "text/markdown",
        }),
      );
      return proxy(200, { action, key, versionId: output.VersionId || null, etag: output.ETag || null });
    }
    if (action === "copy") {
      const output = await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: `/${bucket}/${event.sourceKey}`,
        }),
      );
      return proxy(200, { action, key, versionId: output.VersionId || null, etag: output.CopyObjectResult?.ETag || null });
    }
    if (action === "multipart") {
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      const part = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: created.UploadId,
          PartNumber: 1,
          Body: (event && event.body) || "",
        }),
      );
      const output = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: created.UploadId,
          MultipartUpload: { Parts: [{ ETag: part.ETag, PartNumber: 1 }] },
        }),
      );
      return proxy(200, { action, key, versionId: output.VersionId || null, etag: output.ETag || null });
    }
    if (action === "get") {
      const output = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: event.versionId }),
      );
      const body = await output.Body.transformToString();
      return proxy(200, { action, key, versionId: output.VersionId || null, body });
    }
    if (action === "head") {
      const output = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: event.versionId }),
      );
      return proxy(200, { action, key, versionId: output.VersionId || null, contentLength: output.ContentLength });
    }
    if (action === "list") {
      const output = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: event.prefix }));
      return proxy(200, {
        action,
        versions: (output.Versions || []).map((version) => ({
          key: version.Key,
          versionId: version.VersionId,
          isLatest: Boolean(version.IsLatest),
          size: version.Size,
        })),
        markers: (output.DeleteMarkers || []).map((marker) => ({
          key: marker.Key,
          versionId: marker.VersionId,
          isLatest: Boolean(marker.IsLatest),
        })),
      });
    }
    return proxy(400, { action, error: "UnsupportedAction", message: `unknown action ${action}` });
  } catch (error) {
    // Report the status the store answered, so a missing object is the 404 the
    // caller expects rather than a blanket 500.
    const status =
      (error && error.$metadata && error.$metadata.httpStatusCode) || 500;
    return proxy(status, {
      action,
      error: (error && error.name) || "Error",
      message: (error && error.message) || String(error),
    });
  }
};
