import {
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

  return new S3Client({ region });
};

export const assertBucketAccess = async (s3Client) => {
  const { bucket } = getS3Config();

  await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
};

export const listProjectObjects = async (s3Client, channelName) => {
  const { bucket } = getS3Config();
  const prefix = `${channelName}/`;
  const objects = [];
  let ContinuationToken;

  do {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken,
        Prefix: prefix,
      }),
    );

    objects.push(...(result.Contents || []));
    ContinuationToken = result.NextContinuationToken;
  } while (ContinuationToken);

  return objects;
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

export const getS3Uri = (key) => {
  const { bucket } = getS3Config();

  return `s3://${bucket}/${key}`;
};
