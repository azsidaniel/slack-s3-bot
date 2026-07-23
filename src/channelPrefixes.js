import fs from 'fs';
import path from 'path';

import { getObjectText, putJsonObject } from './s3.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PREFIXES_PATH = path.resolve(DATA_DIR, 'channel-prefixes.json');
const DEFAULT_S3_KEY = '_bot/channel-prefixes.json';

const getStoreType = () => process.env.PREFIX_STORE || 'local';

const getS3Key = () => process.env.PREFIX_STORE_S3_KEY || DEFAULT_S3_KEY;

const isMissingS3Object = (error) =>
  error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

const readPrefixes = () => {
  if (!fs.existsSync(PREFIXES_PATH)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(PREFIXES_PATH, 'utf8') || '{}');
};

const writePrefixes = (prefixes) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PREFIXES_PATH, `${JSON.stringify(prefixes, null, 2)}\n`);
};

const readS3Prefixes = async (s3Client) => {
  try {
    return JSON.parse(await getObjectText(s3Client, getS3Key()));
  } catch (error) {
    if (isMissingS3Object(error)) {
      return {};
    }

    throw error;
  }
};

const writeS3Prefixes = async (s3Client, prefixes) => {
  await putJsonObject(s3Client, {
    key: getS3Key(),
    value: prefixes,
  });
};

const readConfiguredPrefixes = async (s3Client) => {
  if (getStoreType() === 's3') {
    return readS3Prefixes(s3Client);
  }

  return readPrefixes();
};

const writeConfiguredPrefixes = async (s3Client, prefixes) => {
  if (getStoreType() === 's3') {
    await writeS3Prefixes(s3Client, prefixes);
    return;
  }

  writePrefixes(prefixes);
};

export const getSavedPrefix = async (s3Client, channelId) =>
  (await readConfiguredPrefixes(s3Client))[channelId];

export const listChannelConfigs = async (s3Client) =>
  readConfiguredPrefixes(s3Client);

export const saveChannelConfig = async (s3Client, channelId, config) => {
  const prefixes = await readConfiguredPrefixes(s3Client);
  const currentConfig = prefixes[channelId] || {};

  prefixes[channelId] = {
    ...currentConfig,
    ...config,
    updatedAt: new Date().toISOString(),
  };

  await writeConfiguredPrefixes(s3Client, prefixes);
};

export const savePrefix = async (s3Client, { channelId, channelName, prefix }) => {
  await saveChannelConfig(s3Client, channelId, {
    channelName,
    prefix,
  });
};

export const saveDriveFolder = async (
  s3Client,
  { channelId, channelName, driveFolderId },
) => {
  await saveChannelConfig(s3Client, channelId, {
    channelName,
    driveFolderId,
  });
};

export const saveS3SourceFolder = async (
  s3Client,
  {
    channelId,
    channelName,
    s3SourceBucket,
    s3SourceDataPrefix,
    s3SourceFolder,
  },
) => {
  await saveChannelConfig(s3Client, channelId, {
    channelName,
    s3SourceBucket,
    s3SourceDataPrefix,
    s3SourceFolder,
  });
};
