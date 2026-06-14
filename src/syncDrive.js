import { buildAssetKey, getContentType } from './classifyAsset.js';
import {
  downloadDriveFile,
  isGoogleWorkspaceFile,
  listDriveFolderFiles,
} from './drive.js';
import { getS3Uri, uploadObject } from './s3.js';

const getFileFingerprint = (file) => ({
  md5Checksum: file.md5Checksum || null,
  mimeType: file.mimeType || null,
  modifiedTime: file.modifiedTime || null,
  name: file.name,
  size: file.size || null,
});

const hasFileChanged = ({ file, previousFileState, s3Key }) => {
  if (!previousFileState) {
    return true;
  }

  const fingerprint = getFileFingerprint(file);

  return (
    previousFileState.name !== fingerprint.name ||
    previousFileState.size !== fingerprint.size ||
    previousFileState.mimeType !== fingerprint.mimeType ||
    previousFileState.modifiedTime !== fingerprint.modifiedTime ||
    previousFileState.md5Checksum !== fingerprint.md5Checksum ||
    previousFileState.s3Key !== s3Key
  );
};

export const syncDriveFolderToS3 = async ({
  config,
  dryRun = false,
  prefix,
  s3Client,
}) => {
  const files = await listDriveFolderFiles(config.driveFolderId);
  const previousFiles = config.driveSync?.files || {};
  const skippedFiles = files.filter(isGoogleWorkspaceFile);
  const downloadableFiles = files.filter((file) => !isGoogleWorkspaceFile(file));
  const changedFiles = [];
  const unchangedFiles = [];

  for (const file of downloadableFiles) {
    const s3Key = buildAssetKey({ channelName: prefix, filename: file.name });
    const previousFileState = previousFiles[file.id];
    const changed = hasFileChanged({ file, previousFileState, s3Key });
    const item = {
      ...file,
      contentType: file.mimeType || getContentType(file.name),
      s3Key,
      s3Uri: getS3Uri(s3Key),
    };

    if (changed) {
      changedFiles.push(item);
    } else {
      unchangedFiles.push(item);
    }
  }

  if (!dryRun) {
    for (const file of changedFiles) {
      const body = await downloadDriveFile(file.id);

      await uploadObject(s3Client, {
        body,
        contentType: file.contentType,
        key: file.s3Key,
      });
    }
  }

  const nextFiles = { ...previousFiles };

  if (!dryRun) {
    for (const file of downloadableFiles) {
      const s3Key = buildAssetKey({ channelName: prefix, filename: file.name });

      nextFiles[file.id] = {
        ...getFileFingerprint(file),
        s3Key,
      };
    }
  }

  return {
    changedFiles,
    nextDriveSyncState: dryRun
      ? config.driveSync
      : {
          ...(config.driveSync || {}),
          files: nextFiles,
          lastResult: {
            changedCount: changedFiles.length,
            skippedCount: skippedFiles.length,
            status: changedFiles.length > 0 ? 'changed' : 'no_changes',
          },
          lastRunAt: new Date().toISOString(),
        },
    skippedFiles,
    unchangedFiles,
  };
};
