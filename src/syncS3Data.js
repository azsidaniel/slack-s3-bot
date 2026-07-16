import { copyObject, deleteObject, getS3Uri, listObjectsByPrefix } from './s3.js';

const DATA_FOLDER = 'data/';

const getDataPrefix = (folder) => `${folder}/${DATA_FOLDER}`;

const getRelativeDataKey = (key, folder) => key.slice(getDataPrefix(folder).length);

const getFingerprint = (object) => ({
  eTag: object.ETag || null,
  lastModified: object.LastModified?.toISOString?.() || null,
  size: object.Size ?? null,
});

const isSourceNewer = (source, target) => {
  if (!source.LastModified || !target.LastModified) {
    return false;
  }

  return source.LastModified.getTime() > target.LastModified.getTime();
};

const hasObjectChanged = (source, target) => {
  if (!target) {
    return true;
  }

  return (
    source.ETag !== target.ETag ||
    source.Size !== target.Size ||
    isSourceNewer(source, target)
  );
};

const mapObjectsByRelativeKey = (objects, folder) => {
  const mapped = new Map();

  for (const object of objects) {
    const relativeKey = getRelativeDataKey(object.Key, folder);

    if (relativeKey) {
      mapped.set(relativeKey, object);
    }
  }

  return mapped;
};

export const syncS3DataFolder = async ({
  deleteExtra = false,
  dryRun = false,
  s3Client,
  sourceFolder,
  targetFolder,
}) => {
  const sourceObjects = await listObjectsByPrefix(s3Client, getDataPrefix(sourceFolder));
  const targetObjects = await listObjectsByPrefix(s3Client, getDataPrefix(targetFolder));
  const sourceByRelativeKey = mapObjectsByRelativeKey(sourceObjects, sourceFolder);
  const targetByRelativeKey = mapObjectsByRelativeKey(targetObjects, targetFolder);
  const createdFiles = [];
  const deletedFiles = [];
  const unchangedFiles = [];
  const updatedFiles = [];

  for (const [relativeKey, sourceObject] of sourceByRelativeKey.entries()) {
    const targetObject = targetByRelativeKey.get(relativeKey);
    const sourceKey = sourceObject.Key;
    const targetKey = `${getDataPrefix(targetFolder)}${relativeKey}`;
    const item = {
      relativeKey,
      sourceKey,
      sourceUri: getS3Uri(sourceKey),
      targetKey,
      targetUri: getS3Uri(targetKey),
      ...getFingerprint(sourceObject),
    };

    if (!targetObject) {
      createdFiles.push(item);
      continue;
    }

    if (hasObjectChanged(sourceObject, targetObject)) {
      updatedFiles.push(item);
      continue;
    }

    unchangedFiles.push(item);
  }

  if (deleteExtra) {
    for (const [relativeKey, targetObject] of targetByRelativeKey.entries()) {
      if (sourceByRelativeKey.has(relativeKey)) {
        continue;
      }

      deletedFiles.push({
        relativeKey,
        targetKey: targetObject.Key,
        targetUri: getS3Uri(targetObject.Key),
        ...getFingerprint(targetObject),
      });
    }
  }

  if (!dryRun) {
    for (const file of [...createdFiles, ...updatedFiles]) {
      await copyObject(s3Client, {
        destinationKey: file.targetKey,
        sourceKey: file.sourceKey,
      });
    }

    for (const file of deletedFiles) {
      await deleteObject(s3Client, file.targetKey);
    }
  }

  return {
    createdFiles,
    deletedFiles,
    sourcePrefix: getDataPrefix(sourceFolder),
    targetPrefix: getDataPrefix(targetFolder),
    unchangedFiles,
    updatedFiles,
  };
};
