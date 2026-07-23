import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const getAcl = () => {
  const acl = process.env.S3_ACL || 'public-read';

  if (['false', 'none', ''].includes(acl.toLowerCase())) {
    return undefined;
  }

  return acl;
};

export const getS3Config = () => ({
  acl: getAcl(),
  bucket: process.env.S3_BUCKET,
  cacheControl: process.env.S3_CACHE_CONTROL || 'public,max-age=60',
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
});

export const createS3Client = () => {
  const { region } = getS3Config();

  return new S3Client({ followRegionRedirects: true, region });
};

export const assertBucketAccess = async (s3Client) => {
  const { bucket } = getS3Config();

  await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
};

export const listProjectObjects = async (s3Client, channelName) => {
  const { bucket } = getS3Config();
  const prefix = `${channelName}/`;
  return listObjectsByPrefix(s3Client, prefix);
};

export const listObjectsByPrefix = async (s3Client, prefix, { bucket } = {}) => {
  const targetBucket = bucket || getS3Config().bucket;
  const objects = [];
  let ContinuationToken;

  do {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: targetBucket,
        ContinuationToken,
        Prefix: prefix,
      }),
    );

    objects.push(...(result.Contents || []));
    ContinuationToken = result.NextContinuationToken;
  } while (ContinuationToken);

  return objects;
};

export const copyObject = async (
  s3Client,
  { destinationKey, sourceBucket, sourceKey },
) => {
  const { acl, bucket: destinationBucket } = getS3Config();
  const copySourceBucket = sourceBucket || destinationBucket;

  await s3Client.send(
    new CopyObjectCommand({
      ACL: acl,
      Bucket: destinationBucket,
      CopySource: `${copySourceBucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
      Key: destinationKey,
      MetadataDirective: 'COPY',
    }),
  );
};

export const deleteObject = async (s3Client, key) => {
  const { bucket } = getS3Config();

  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
};

export const uploadObject = async (s3Client, { body, contentType, key }) => {
  const { acl, bucket, cacheControl } = getS3Config();

  await s3Client.send(
    new PutObjectCommand({
      ACL: acl,
      Body: body,
      Bucket: bucket,
      CacheControl: cacheControl,
      ContentType: contentType,
      Key: key,
    }),
  );
};

export const getObjectText = async (s3Client, key) => {
  const { bucket } = getS3Config();

  const result = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return result.Body.transformToString();
};

export const getObjectBuffer = async (s3Client, key) => {
  const { bucket } = getS3Config();

  const result = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return {
    body: Buffer.from(await result.Body.transformToByteArray()),
    contentType: result.ContentType,
  };
};

export const putJsonObject = async (s3Client, { key, value }) => {
  const { acl, bucket, cacheControl } = getS3Config();

  await s3Client.send(
    new PutObjectCommand({
      ACL: acl,
      Body: `${JSON.stringify(value, null, 2)}\n`,
      Bucket: bucket,
      CacheControl: cacheControl,
      ContentType: 'application/json; charset=utf-8',
      Key: key,
    }),
  );
};

export const getS3Uri = (key, bucket) => {
  const targetBucket = bucket || getS3Config().bucket;

  return `s3://${targetBucket}/${key}`;
};

export const parseS3Location = (input = '') => {
  const rawValue = String(input).trim();
  const slackLink = rawValue.match(/^<([^>|]+)(?:\|[^>]*)?>$/);
  const value = slackLink ? slackLink[1] : rawValue;

  if (!value.startsWith('s3://')) {
    return null;
  }

  const location = value.slice('s3://'.length).replace(/^\/+|\/+$/g, '');
  const separatorIndex = location.indexOf('/');
  const bucket = separatorIndex < 0 ? location : location.slice(0, separatorIndex);
  const prefix = separatorIndex < 0 ? '' : location.slice(separatorIndex + 1);

  if (!bucket || !prefix || bucket.includes('..') || prefix.includes('..') || /\\/.test(location)) {
    return null;
  }

  return { bucket, prefix };
};
