import path from 'path';

const DATA_EXTENSIONS = new Set(['.csv', '.json', '.tsv', '.txt', '.xml']);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.webm']);
const DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx']);

const CONTENT_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.tsv', 'text/tab-separated-values; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

export const getSafeFilename = (filename) => path.basename(String(filename || '').trim());

export const getAssetFolder = (filename) => {
  const extension = path.extname(filename).toLowerCase();

  if (DATA_EXTENSIONS.has(extension)) {
    return 'data';
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'media/images';
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'media/videos';
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return 'documents';
  }

  return 'files';
};

export const getContentType = (filename) => {
  const extension = path.extname(filename).toLowerCase();

  return CONTENT_TYPES.get(extension) || 'application/octet-stream';
};

export const buildAssetKey = ({ channelName, filename }) => {
  const safeFilename = getSafeFilename(filename);

  if (!safeFilename) {
    throw new Error('Nome de arquivo vazio.');
  }

  return `${channelName}/${getAssetFolder(safeFilename)}/${safeFilename}`;
};
