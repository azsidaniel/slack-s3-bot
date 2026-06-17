const DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_NATIVE_MIME_TYPE_PREFIX = 'application/vnd.google-apps.';

export const extractDriveFolderId = (input = '') => {
  const value = String(input).trim();

  if (!value) {
    return '';
  }

  const folderMatch = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);

  if (folderMatch) {
    return folderMatch[1];
  }

  const idMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);

  if (idMatch) {
    return idMatch[1];
  }

  return value;
};

const getDriveApiKey = () => {
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_DRIVE_API_KEY nao configurada.');
  }

  return apiKey;
};

const assertDriveResponseIsOk = async (response, action) => {
  if (response.ok) {
    return;
  }

  const body = await response.text();

  throw new Error(
    `Falha ao ${action} no Google Drive: HTTP ${response.status} ${body}`,
  );
};

export const isGoogleWorkspaceFile = (file) =>
  String(file.mimeType || '').startsWith(GOOGLE_DRIVE_NATIVE_MIME_TYPE_PREFIX);

export const listDriveFolderFiles = async (folderId) => {
  const apiKey = getDriveApiKey();
  const files = [];
  let pageToken;

  do {
    const url = new URL(`${DRIVE_API_BASE_URL}/files`);

    url.searchParams.set('key', apiKey);
    url.searchParams.set(
      'q',
      `'${folderId}' in parents and trashed = false`,
    );
    url.searchParams.set(
      'fields',
      'nextPageToken, files(id, name, mimeType, size, modifiedTime, md5Checksum)',
    );
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    url.searchParams.set('orderBy', 'name');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('supportsAllDrives', 'true');

    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url);

    await assertDriveResponseIsOk(response, 'listar arquivos');

    const result = await response.json();

    files.push(...(result.files || []));
    pageToken = result.nextPageToken;
  } while (pageToken);

  return files;
};

export const downloadDriveFile = async (fileId) => {
  const apiKey = getDriveApiKey();
  const url = new URL(`${DRIVE_API_BASE_URL}/files/${fileId}`);

  url.searchParams.set('alt', 'media');
  url.searchParams.set('key', apiKey);

  const response = await fetch(url);

  await assertDriveResponseIsOk(response, 'baixar arquivo');

  return Buffer.from(await response.arrayBuffer());
};
