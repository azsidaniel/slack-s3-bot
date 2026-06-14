import { App } from '@slack/bolt';

import { buildAssetKey, getContentType, getSafeFilename } from './classifyAsset.js';
import { getSavedPrefix, saveDriveFolder, savePrefix } from './channelPrefixes.js';
import {
  downloadDriveFile,
  extractDriveFolderId,
  isGoogleWorkspaceFile,
  listDriveFolderFiles,
} from './drive.js';
import {
  assertBucketAccess,
  createS3Client,
  getS3Config,
  getS3Uri,
  listProjectObjects,
  uploadObject,
} from './s3.js';

const COMMANDS = new Set([
  'drive-list',
  'help',
  'list',
  'set-drive-folder',
  'set-folder',
  'test',
  'upload',
  'upload-drive',
]);
const BOT_MENTION_LABEL = '@info-s3';

const BUCKET_ERROR_NAMES = new Set([
  'AccessDenied',
  'Forbidden',
  'NoSuchBucket',
  'NotFound',
]);

const isBucketAccessError = (error) =>
  BUCKET_ERROR_NAMES.has(error?.name) ||
  [403, 404].includes(error?.$metadata?.httpStatusCode);

const getBucketAccessErrorMessage = (error) => {
  const { bucket, region } = getS3Config();

  return [
    `Nao consegui acessar o bucket S3 configurado: ${bucket}`,
    `Regiao: ${region}`,
    `Erro AWS: ${error.name || error.message}`,
    'Qual e o novo nome do bucket que devo usar?',
    'Depois de confirmar, atualize S3_BUCKET no arquivo .env e reinicie o bot.',
  ].join('\n');
};

const formatBytes = (bytes = 0) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
};

const getCommandText = (text = '') =>
  text.replace(/<@[A-Z0-9]+>/g, '').trim();

const parseCommand = (text) => {
  const cleanText = getCommandText(text);
  const [command = '', ...args] = cleanText.split(/\s+/).filter(Boolean);
  const targetPrefix = args.find((arg) => !arg.startsWith('--'));

  return {
    args,
    command: command.toLowerCase(),
    isDryRun: args.includes('--dry-run'),
    targetPrefix,
  };
};

const getHelpMessage = () =>
  [
    'Comandos disponiveis:',
    `\`${BOT_MENTION_LABEL} help\` - lista os comandos e o uso.`,
    `\`${BOT_MENTION_LABEL} set-folder nome-da-pasta\` - salva a pasta S3 que este canal deve usar.`,
    `\`${BOT_MENTION_LABEL} set-drive-folder link-ou-id-da-pasta\` - salva a pasta publica do Google Drive que este canal deve usar como fonte.`,
    `\`${BOT_MENTION_LABEL} test\` - valida Slack, AWS e mostra a pasta S3 configurada para o canal.`,
    `\`${BOT_MENTION_LABEL} list\` - lista arquivos da pasta S3 configurada.`,
    `\`${BOT_MENTION_LABEL} drive-list\` - lista arquivos da pasta Drive configurada.`,
    `\`${BOT_MENTION_LABEL} upload --dry-run\` - mostra para onde os anexos da thread seriam enviados.`,
    `\`${BOT_MENTION_LABEL} upload\` - envia os anexos da thread para a pasta S3 configurada.`,
    `\`${BOT_MENTION_LABEL} upload-drive --dry-run\` - mostra para onde os arquivos do Drive seriam enviados.`,
    `\`${BOT_MENTION_LABEL} upload-drive\` - baixa os arquivos do Drive e envia para a pasta S3 configurada.`,
    '',
    'Antes de usar `list`, `upload` ou `upload-drive`, configure a pasta S3 deste canal:',
    `\`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
    'Para usar Drive como fonte, configure tambem:',
    `\`${BOT_MENTION_LABEL} set-drive-folder link-ou-id-da-pasta\``,
  ].join('\n');

const getUnconfiguredChannelMessage = (channelName) =>
  [
    `Este canal ainda nao tem uma pasta S3 configurada.`,
    `Canal Slack: ${channelName}`,
    'Informe a pasta existente no S3 com:',
    `\`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
    'Exemplo:',
    `\`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
  ].join('\n');

const getChannelName = async (client, channelId) => {
  const result = await client.conversations.info({ channel: channelId });
  const channelName = result.channel?.name;

  if (!channelName) {
    throw new Error(`Nao foi possivel descobrir o nome do canal ${channelId}.`);
  }

  return channelName;
};

const getThreadMessages = async (client, { channel, messageTs, threadTs }) => {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs || messageTs,
  });

  return result.messages || [];
};

const getThreadFiles = (messages) =>
  messages
    .flatMap((message) => message.files || [])
    .filter((file) => file.url_private_download || file.url_private)
    .map((file) => ({
      id: file.id,
      name: getSafeFilename(file.name || file.title),
      size: file.size,
      url: file.url_private_download || file.url_private,
    }))
    .filter((file) => file.name);

const downloadSlackFile = async (file) => {
  const response = await fetch(file.url, {
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar ${file.name}: HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
};

const reply = async (say, { text, threadTs }) =>
  say({
    text,
    thread_ts: threadTs,
  });

const buildUploadPlan = ({ files, prefix }) =>
  files.map((file) => {
    const key = buildAssetKey({ channelName: prefix, filename: file.name });

    return {
      ...file,
      contentType: getContentType(file.name),
      key,
      s3Uri: getS3Uri(key),
    };
  });

const buildDriveUploadPlan = ({ files, prefix }) =>
  files.map((file) => {
    const key = buildAssetKey({ channelName: prefix, filename: file.name });

    return {
      ...file,
      contentType: file.mimeType || getContentType(file.name),
      key,
      s3Uri: getS3Uri(key),
    };
  });

const getMissingPrefixMessage = ({ channelName, prefix }) =>
  [
    `Nao encontrei arquivos na pasta S3: ${getS3Uri(`${prefix}/`)}`,
    `Canal Slack: ${channelName}`,
    'Se a pasta do S3 tiver outro nome, salve a pasta correta para este canal:',
    `\`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
    `Depois disso, \`${BOT_MENTION_LABEL} list\`, \`${BOT_MENTION_LABEL} upload --dry-run\` e \`${BOT_MENTION_LABEL} upload\` usarao essa pasta automaticamente.`,
  ].join('\n');

const handleSetFolder = async ({
  channelId,
  channelName,
  prefix,
  say,
  s3Client,
  threadTs,
}) => {
  if (!prefix) {
    await reply(say, {
      threadTs,
      text: `Informe a pasta S3. Exemplo: \`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
    });
    return;
  }

  const objects = await listProjectObjects(s3Client, prefix);

  if (objects.length === 0) {
    await reply(say, {
      threadTs,
      text: getMissingPrefixMessage({ channelName, prefix }),
    });
    return;
  }

  await savePrefix(s3Client, { channelId, channelName, prefix });

  await reply(say, {
    threadTs,
    text: [
      `Pasta S3 salva para este canal: ${prefix}`,
      `Destino base: ${getS3Uri(`${prefix}/`)}`,
      'A partir de agora, os comandos sem pasta explicita usarao essa pasta.',
    ].join('\n'),
  });
};

const handleSetDriveFolder = async ({
  channelId,
  channelName,
  driveFolderInput,
  say,
  s3Client,
  threadTs,
}) => {
  const driveFolderId = extractDriveFolderId(driveFolderInput);

  if (!driveFolderId) {
    await reply(say, {
      threadTs,
      text: `Informe a pasta do Google Drive. Exemplo: \`${BOT_MENTION_LABEL} set-drive-folder link-ou-id-da-pasta\``,
    });
    return;
  }

  const files = await listDriveFolderFiles(driveFolderId);

  if (files.length === 0) {
    await reply(say, {
      threadTs,
      text: [
        `Nao encontrei arquivos na pasta Drive: ${driveFolderId}`,
        'Confirme se a pasta esta publica para qualquer pessoa com o link e se a Google Drive API Key esta correta.',
      ].join('\n'),
    });
    return;
  }

  await saveDriveFolder(s3Client, { channelId, channelName, driveFolderId });

  await reply(say, {
    threadTs,
    text: [
      `Pasta Drive salva para este canal: ${driveFolderId}`,
      `Arquivos encontrados agora: ${files.length}`,
      `A partir de agora, \`${BOT_MENTION_LABEL} drive-list\` e \`${BOT_MENTION_LABEL} upload-drive\` usarao essa pasta como fonte.`,
    ].join('\n'),
  });
};

const handleTest = async ({ channelName, prefix, say, s3Client, threadTs }) => {
  const { bucket, cacheControl, region } = getS3Config();

  await assertBucketAccess(s3Client);

  await reply(say, {
    threadTs,
    text: [
      'OK. Bot conectado e bucket acessivel.',
      `Canal Slack: ${channelName}`,
      `Pasta S3 usada: ${prefix}`,
      `Bucket: ${bucket}`,
      `Regiao: ${region}`,
      `Cache-Control: ${cacheControl}`,
    ].join('\n'),
  });
};

const handleList = async ({ channelName, prefix, say, s3Client, threadTs }) => {
  const objects = await listProjectObjects(s3Client, prefix);

  if (objects.length === 0) {
    await reply(say, {
      threadTs,
      text: getMissingPrefixMessage({ channelName, prefix }),
    });
    return;
  }

  const visibleObjects = objects.slice(0, 40);
  const lines = visibleObjects.map(
    (object) => `- ${object.Key} (${formatBytes(object.Size)})`,
  );
  const suffix =
    objects.length > visibleObjects.length
      ? `\n...mais ${objects.length - visibleObjects.length} arquivo(s).`
      : '';

  await reply(say, {
    threadTs,
    text: [`Arquivos em ${getS3Uri(`${prefix}/`)}:`, ...lines].join('\n') + suffix,
  });
};

const getUnconfiguredDriveMessage = () =>
  [
    'Este canal ainda nao tem uma pasta do Google Drive configurada.',
    'Informe a pasta publica do Drive com:',
    `\`${BOT_MENTION_LABEL} set-drive-folder link-ou-id-da-pasta\``,
  ].join('\n');

const getDriveFileLines = (files) =>
  files.map((file) => {
    const size = file.size ? ` (${formatBytes(Number(file.size))})` : '';
    const unsupported = isGoogleWorkspaceFile(file)
      ? ' - ignorado: arquivo Google Workspace'
      : '';

    return `- ${file.name}${size}${unsupported}`;
  });

const handleDriveList = async ({ driveFolderId, say, threadTs }) => {
  if (!driveFolderId) {
    await reply(say, {
      threadTs,
      text: getUnconfiguredDriveMessage(),
    });
    return;
  }

  const files = await listDriveFolderFiles(driveFolderId);

  if (files.length === 0) {
    await reply(say, {
      threadTs,
      text: `Nenhum arquivo encontrado na pasta Drive: ${driveFolderId}`,
    });
    return;
  }

  const visibleFiles = files.slice(0, 40);
  const suffix =
    files.length > visibleFiles.length
      ? `\n...mais ${files.length - visibleFiles.length} arquivo(s).`
      : '';

  await reply(say, {
    threadTs,
    text: [`Arquivos no Drive (${driveFolderId}):`, ...getDriveFileLines(visibleFiles)].join('\n') + suffix,
  });
};

const handleUpload = async ({
  channelName,
  client,
  event,
  isDryRun,
  prefix,
  say,
  s3Client,
  threadTs,
}) => {
  const currentObjects = await listProjectObjects(s3Client, prefix);

  if (currentObjects.length === 0) {
    await reply(say, {
      threadTs,
      text: getMissingPrefixMessage({ channelName, prefix }),
    });
    return;
  }

  const messages = await getThreadMessages(client, {
    channel: event.channel,
    messageTs: event.ts,
    threadTs: event.thread_ts,
  });
  const files = getThreadFiles(messages);

  if (files.length === 0) {
    await reply(say, {
      threadTs,
      text: 'Nenhum anexo encontrado nesta thread.',
    });
    return;
  }

  const plan = buildUploadPlan({ files, prefix });

  if (isDryRun) {
    await reply(say, {
      threadTs,
      text: [
        'Dry-run: nenhum arquivo foi enviado.',
        ...plan.map((item) => `- ${item.name} -> ${item.s3Uri}`),
      ].join('\n'),
    });
    return;
  }

  if (process.env.ALLOW_UPLOAD === 'false') {
    await reply(say, {
      threadTs,
      text: 'Upload bloqueado por ALLOW_UPLOAD=false.',
    });
    return;
  }

  const uploaded = [];

  for (const item of plan) {
    const body = await downloadSlackFile(item);

    await uploadObject(s3Client, {
      body,
      contentType: item.contentType,
      key: item.key,
    });

    uploaded.push(item);
  }

  await reply(say, {
    threadTs,
    text: ['Upload finalizado:', ...uploaded.map((item) => `- ${item.s3Uri}`)].join('\n'),
  });
};

const handleUploadDrive = async ({
  driveFolderId,
  isDryRun,
  prefix,
  say,
  s3Client,
  threadTs,
}) => {
  if (!driveFolderId) {
    await reply(say, {
      threadTs,
      text: getUnconfiguredDriveMessage(),
    });
    return;
  }

  const files = await listDriveFolderFiles(driveFolderId);
  const downloadableFiles = files.filter((file) => !isGoogleWorkspaceFile(file));
  const skippedFiles = files.filter(isGoogleWorkspaceFile);

  if (downloadableFiles.length === 0) {
    await reply(say, {
      threadTs,
      text: [
        `Nenhum arquivo baixavel encontrado na pasta Drive: ${driveFolderId}`,
        ...skippedFiles.map((file) => `- Ignorado: ${file.name} (${file.mimeType})`),
      ].join('\n'),
    });
    return;
  }

  const plan = buildDriveUploadPlan({ files: downloadableFiles, prefix });
  const skippedLines = skippedFiles.map(
    (file) => `- Ignorado: ${file.name} (${file.mimeType})`,
  );

  if (isDryRun) {
    await reply(say, {
      threadTs,
      text: [
        'Dry-run Drive: nenhum arquivo foi enviado.',
        ...plan.map((item) => `- ${item.name} -> ${item.s3Uri}`),
        ...skippedLines,
      ].join('\n'),
    });
    return;
  }

  if (process.env.ALLOW_UPLOAD === 'false') {
    await reply(say, {
      threadTs,
      text: 'Upload bloqueado por ALLOW_UPLOAD=false.',
    });
    return;
  }

  const uploaded = [];

  for (const item of plan) {
    const body = await downloadDriveFile(item.id);

    await uploadObject(s3Client, {
      body,
      contentType: item.contentType,
      key: item.key,
    });

    uploaded.push(item);
  }

  await reply(say, {
    threadTs,
    text: [
      'Upload do Drive finalizado:',
      ...uploaded.map((item) => `- ${item.s3Uri}`),
      ...skippedLines,
    ].join('\n'),
  });
};

export const createSlackApp = () => {
  const app = new App({
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    token: process.env.SLACK_BOT_TOKEN,
  });
  const s3Client = createS3Client();
  let botUserId;

  const getBotUserId = async (client) => {
    if (!botUserId) {
      const auth = await client.auth.test();
      botUserId = auth.user_id;
    }

    return botUserId;
  };

  app.event('app_mention', async ({ client, event, say }) => {
    const threadTs = event.thread_ts || event.ts;
    const { command, isDryRun, targetPrefix } = parseCommand(event.text);

    console.log(
      `app_mention recebido: channel=${event.channel} command=${command || '(vazio)'}`,
    );

    if (!COMMANDS.has(command)) {
      await reply(say, {
        threadTs,
        text: 'Comando invalido. Use: help, test, list, drive-list, set-folder, set-drive-folder, upload, upload-drive ou upload --dry-run.',
      });
      return;
    }

    try {
      if (command === 'help') {
        await reply(say, {
          threadTs,
          text: getHelpMessage(),
        });
        return;
      }

      const channelName = await getChannelName(client, event.channel);
      const savedConfig = await getSavedPrefix(s3Client, event.channel);
      const savedPrefix = savedConfig?.prefix;
      const driveFolderId = savedConfig?.driveFolderId;
      const prefix = targetPrefix || savedPrefix;

      if (command === 'set-folder') {
        await handleSetFolder({
          channelId: event.channel,
          channelName,
          prefix: targetPrefix,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      if (command === 'set-drive-folder') {
        await handleSetDriveFolder({
          channelId: event.channel,
          channelName,
          driveFolderInput: targetPrefix,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      if (command === 'drive-list') {
        await handleDriveList({ driveFolderId, say, threadTs });
        return;
      }

      if (!prefix) {
        await reply(say, {
          threadTs,
          text: getUnconfiguredChannelMessage(channelName),
        });
        return;
      }

      if (command === 'test') {
        await handleTest({ channelName, prefix, say, s3Client, threadTs });
        return;
      }

      if (command === 'list') {
        await handleList({ channelName, prefix, say, s3Client, threadTs });
        return;
      }

      if (command === 'upload-drive') {
        await handleUploadDrive({
          driveFolderId,
          isDryRun,
          prefix,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      await handleUpload({
        channelName,
        client,
        event,
        isDryRun,
        prefix,
        say,
        s3Client,
        threadTs,
      });
    } catch (error) {
      if (isBucketAccessError(error)) {
        await reply(say, {
          threadTs,
          text: getBucketAccessErrorMessage(error),
        });
        return;
      }

      await reply(say, {
        threadTs,
        text: `Erro: ${error.message}`,
      });
    }
  });

  app.event('member_joined_channel', async ({ client, event }) => {
    const currentBotUserId = await getBotUserId(client);

    if (event.user !== currentBotUserId) {
      return;
    }

    const channelName = await getChannelName(client, event.channel);

    await client.chat.postMessage({
      channel: event.channel,
      text: [
        `Ola! Obrigado por me adicionar ao canal #${channelName}.`,
        'Eu ajudo a publicar arquivos no S3. Posso subir anexos de threads do Slack ou arquivos de uma pasta publica do Google Drive.',
        'Para comecar, configure a pasta S3 de destino deste canal:',
        `\`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
        `Depois veja todos os comandos com \`${BOT_MENTION_LABEL} help\`.`,
      ].join('\n'),
    });
  });

  return app;
};
