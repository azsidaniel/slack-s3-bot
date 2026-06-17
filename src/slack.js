import slackBolt from '@slack/bolt';

import { buildAssetKey, getContentType, getSafeFilename } from './classifyAsset.js';
import {
  getSavedPrefix,
  listChannelConfigs,
  saveChannelConfig,
  saveDriveFolder,
  savePrefix,
} from './channelPrefixes.js';
import {
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
import { syncDriveFolderToS3 } from './syncDrive.js';

const { App } = slackBolt;

const COMMANDS = new Set([
  'drive-list',
  'help',
  'list',
  'set-drive-folder',
  'set-folder',
  'status',
  'sync-drive',
  'sync-drive-off',
  'sync-drive-on',
  'test',
  'upload',
]);
const BOT_MENTION_LABEL = '@info-s3';
const MAX_SYNC_DURATION_DAYS = 60;
const MIN_SYNC_DURATION_MS = 60 * 60 * 1000;
const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 1440;
const SCHEDULER_TICK_MS = 60 * 1000;

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
    `\`${BOT_MENTION_LABEL} status\` - mostra a configuracao deste canal.`,
    `\`${BOT_MENTION_LABEL} list\` - lista arquivos da pasta S3 configurada.`,
    `\`${BOT_MENTION_LABEL} drive-list\` - lista arquivos da pasta Drive configurada.`,
    `\`${BOT_MENTION_LABEL} upload --dry-run\` - mostra para onde os anexos da thread seriam enviados.`,
    `\`${BOT_MENTION_LABEL} upload\` - envia os anexos da thread para a pasta S3 configurada.`,
    `\`${BOT_MENTION_LABEL} sync-drive --dry-run\` - mostra quais arquivos do Drive seriam sincronizados no S3.`,
    `\`${BOT_MENTION_LABEL} sync-drive\` - sincroniza a pasta Drive configurada para o S3.`,
    `\`${BOT_MENTION_LABEL} sync-drive-on 5 7d\` - ativa sync automatico por canal, com expiracao obrigatoria.`,
    `\`${BOT_MENTION_LABEL} sync-drive-on\` - reativa o sync automatico com a configuracao anterior, sem reiniciar a expiracao.`,
    `\`${BOT_MENTION_LABEL} sync-drive-off\` - pausa o sync automatico neste canal, preservando a configuracao.`,
    '',
    'Antes de usar `list`, `upload` ou `sync-drive`, configure a pasta S3 deste canal:',
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

const formatDateTime = (isoDate) => {
  if (!isoDate) {
    return 'nunca';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(isoDate));
};

const parseDurationMs = (duration) => {
  const match = String(duration || '').match(/^(\d+)(h|d)$/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  return amount * (unit === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
};

const getSyncConfigError = ({ durationMs, intervalMinutes }) => {
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < MIN_SYNC_INTERVAL_MINUTES ||
    intervalMinutes > MAX_SYNC_INTERVAL_MINUTES
  ) {
    return `Intervalo invalido. Use um valor entre ${MIN_SYNC_INTERVAL_MINUTES} e ${MAX_SYNC_INTERVAL_MINUTES} minutos.`;
  }

  if (!durationMs) {
    return 'Duracao invalida. Use formatos como `2h`, `7d` ou `60d`.';
  }

  if (durationMs < MIN_SYNC_DURATION_MS) {
    return 'Duracao invalida. Use no minimo `1h`.';
  }

  if (durationMs > MAX_SYNC_DURATION_DAYS * 24 * 60 * 60 * 1000) {
    return `Duracao invalida. Use no maximo \`${MAX_SYNC_DURATION_DAYS}d\`.`;
  }

  return null;
};

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
      `A partir de agora, \`${BOT_MENTION_LABEL} drive-list\` e \`${BOT_MENTION_LABEL} sync-drive\` usarao essa pasta como fonte.`,
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

const getChannelStatusMessage = ({ channelName, config }) => {
  const sync = config?.driveSync;
  const syncStatus = sync?.enabled
    ? `ativo, a cada ${sync.intervalMinutes} minuto(s), expira em ${formatDateTime(sync.expiresAt)}`
    : 'desativado';

  return [
    `Status do canal #${channelName}:`,
    `S3: ${config?.prefix || 'nao configurado'}`,
    `Drive: ${config?.driveFolderId || 'nao configurado'}`,
    `Sync automatico: ${syncStatus}`,
    `Ultima sync: ${formatDateTime(sync?.lastRunAt)}`,
    `Proxima sync: ${formatDateTime(sync?.nextRunAt)}`,
    `Ultimo resultado: ${sync?.lastResult?.status || 'sem execucao'}`,
  ].join('\n');
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

const getSyncDriveResultMessage = ({ dryRun, result }) => {
  const header = dryRun
    ? 'Dry-run Drive: nenhum arquivo foi enviado.'
    : 'Sync Drive -> S3 concluido.';
  const changedLines = result.changedFiles.map(
    (item) => `- ${item.name} -> ${item.s3Uri}`,
  );
  const skippedLines = result.skippedFiles.map(
    (file) => `- Ignorado: ${file.name} (${file.mimeType})`,
  );

  if (changedLines.length === 0 && skippedLines.length === 0) {
    return [header, 'Nenhuma alteracao encontrada.'].join('\n');
  }

  return [
    header,
    `Arquivos alterados: ${changedLines.length}`,
    ...changedLines,
    ...skippedLines,
  ].join('\n');
};

const handleSyncDrive = async ({
  channelId,
  config,
  isDryRun,
  prefix,
  say,
  s3Client,
  threadTs,
}) => {
  if (!config?.driveFolderId) {
    await reply(say, {
      threadTs,
      text: getUnconfiguredDriveMessage(),
    });
    return;
  }

  const result = await syncDriveFolderToS3({
    config,
    dryRun: isDryRun,
    prefix,
    s3Client,
  });

  if (!isDryRun) {
    await saveChannelConfig(s3Client, channelId, {
      driveSync: result.nextDriveSyncState,
    });
  }

  await reply(say, {
    threadTs,
    text: getSyncDriveResultMessage({ dryRun: isDryRun, result }),
  });
};

const handleSyncDriveOn = async ({
  args,
  channelId,
  channelName,
  config,
  say,
  s3Client,
  threadTs,
}) => {
  const syncArgs = args.filter((arg) => !arg.startsWith('--'));

  if (syncArgs.length === 0) {
    const sync = config?.driveSync;

    if (!config?.prefix || !config?.driveFolderId) {
      await reply(say, {
        threadTs,
        text: [
          'Configure S3 e Drive antes de reativar o sync automatico.',
          `S3: \`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
          `Drive: \`${BOT_MENTION_LABEL} set-drive-folder link-ou-id-da-pasta\``,
        ].join('\n'),
      });
      return;
    }

    if (!sync?.intervalMinutes || !sync?.expiresAt) {
      await reply(say, {
        threadTs,
        text: [
          'Nao existe uma configuracao anterior de sync automatico para este canal.',
          `Crie uma nova com: \`${BOT_MENTION_LABEL} sync-drive-on 5 7d\``,
        ].join('\n'),
      });
      return;
    }

    if (new Date(sync.expiresAt).getTime() <= Date.now()) {
      await reply(say, {
        threadTs,
        text: [
          `A configuracao anterior expirou em ${formatDateTime(sync.expiresAt)}.`,
          `Crie uma nova com: \`${BOT_MENTION_LABEL} sync-drive-on 5 7d\``,
        ].join('\n'),
      });
      return;
    }

    const nextRunAt = new Date(
      Date.now() + sync.intervalMinutes * 60 * 1000,
    ).toISOString();

    await saveChannelConfig(s3Client, channelId, {
      channelName,
      driveSync: {
        ...sync,
        enabled: true,
        nextRunAt,
      },
    });

    await reply(say, {
      threadTs,
      text: [
        'Sync automatico do Drive reativado com a configuracao anterior.',
        `Intervalo: ${sync.intervalMinutes} minuto(s)`,
        `Expira em: ${formatDateTime(sync.expiresAt)}`,
        `Proxima execucao: ${formatDateTime(nextRunAt)}`,
      ].join('\n'),
    });
    return;
  }

  const [intervalArg, durationArg] = syncArgs;
  const intervalMinutes = Number(intervalArg);
  const durationMs = parseDurationMs(durationArg);
  const error = getSyncConfigError({ durationMs, intervalMinutes });

  if (error) {
    await reply(say, {
      threadTs,
      text: [
        error,
        `Exemplo: \`${BOT_MENTION_LABEL} sync-drive-on 5 7d\``,
      ].join('\n'),
    });
    return;
  }

  if (!config?.prefix || !config?.driveFolderId) {
    await reply(say, {
      threadTs,
      text: [
        'Configure S3 e Drive antes de ativar o sync automatico.',
        `S3: \`${BOT_MENTION_LABEL} set-folder nome-da-pasta\``,
        `Drive: \`${BOT_MENTION_LABEL} set-drive-folder link-ou-id-da-pasta\``,
      ].join('\n'),
    });
    return;
  }

  const now = Date.now();
  const nextRunAt = new Date(now + intervalMinutes * 60 * 1000).toISOString();
  const expiresAt = new Date(now + durationMs).toISOString();

  await saveChannelConfig(s3Client, channelId, {
    channelName,
    driveSync: {
      ...(config.driveSync || {}),
      enabled: true,
      expiresAt,
      intervalMinutes,
      nextRunAt,
      notify: 'changes',
    },
  });

  await reply(say, {
    threadTs,
    text: [
      'Sync automatico do Drive ativado.',
      `Intervalo: ${intervalMinutes} minuto(s)`,
      `Expira em: ${formatDateTime(expiresAt)}`,
      `Proxima execucao: ${formatDateTime(nextRunAt)}`,
      'O bot so notificara este canal quando houver arquivos alterados ou quando o sync expirar.',
    ].join('\n'),
  });
};

const handleSyncDriveOff = async ({
  channelId,
  config,
  say,
  s3Client,
  threadTs,
}) => {
  await saveChannelConfig(s3Client, channelId, {
    driveSync: {
      ...(config?.driveSync || {}),
      enabled: false,
      nextRunAt: null,
    },
  });

  await reply(say, {
    threadTs,
    text: 'Sync automatico do Drive pausado para este canal. A configuracao anterior foi preservada.',
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
  let isSyncSchedulerRunning = false;

  const getBotUserId = async (client) => {
    if (!botUserId) {
      const auth = await client.auth.test();
      botUserId = auth.user_id;
    }

    return botUserId;
  };

  app.event('app_mention', async ({ client, event, say }) => {
    const threadTs = event.thread_ts || event.ts;
    const { args, command, isDryRun, targetPrefix } = parseCommand(event.text);

    console.log(
      `app_mention recebido: channel=${event.channel} command=${command || '(vazio)'}`,
    );

    if (!COMMANDS.has(command)) {
      await reply(say, {
        threadTs,
        text: 'Comando invalido. Use: help, test, status, list, drive-list, set-folder, set-drive-folder, upload, sync-drive, sync-drive-on ou sync-drive-off.',
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
      const usesExplicitPrefix = ['list', 'test', 'upload'].includes(command);
      const prefix = usesExplicitPrefix ? targetPrefix || savedPrefix : savedPrefix;

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

      if (command === 'status') {
        await reply(say, {
          threadTs,
          text: getChannelStatusMessage({ channelName, config: savedConfig }),
        });
        return;
      }

      if (command === 'sync-drive-off') {
        await handleSyncDriveOff({
          channelId: event.channel,
          config: savedConfig,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      if (command === 'sync-drive-on') {
        await handleSyncDriveOn({
          args,
          channelId: event.channel,
          channelName,
          config: savedConfig,
          say,
          s3Client,
          threadTs,
        });
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

      if (command === 'sync-drive') {
        await handleSyncDrive({
          channelId: event.channel,
          config: savedConfig,
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

  const runDueDriveSyncs = async () => {
    if (isSyncSchedulerRunning) {
      return;
    }

    isSyncSchedulerRunning = true;

    try {
      const configs = await listChannelConfigs(s3Client);
      const now = Date.now();

      for (const [channelId, config] of Object.entries(configs)) {
        const sync = config.driveSync;

        if (!sync?.enabled || !config.prefix || !config.driveFolderId) {
          continue;
        }

        if (sync.expiresAt && new Date(sync.expiresAt).getTime() <= now) {
          await saveChannelConfig(s3Client, channelId, {
            driveSync: {
              ...sync,
              enabled: false,
              nextRunAt: null,
            },
          });
          continue;
        }

        if (!sync.nextRunAt || new Date(sync.nextRunAt).getTime() > now) {
          continue;
        }

        try {
          const result = await syncDriveFolderToS3({
            config,
            prefix: config.prefix,
            s3Client,
          });
          const nextRunAt = new Date(
            Date.now() + sync.intervalMinutes * 60 * 1000,
          ).toISOString();

          await saveChannelConfig(s3Client, channelId, {
            driveSync: {
              ...result.nextDriveSyncState,
              enabled: true,
              expiresAt: sync.expiresAt,
              intervalMinutes: sync.intervalMinutes,
              nextRunAt,
              notify: sync.notify || 'changes',
            },
          });

          if (result.changedFiles.length > 0) {
            await app.client.chat.postMessage({
              channel: channelId,
              text: getSyncDriveResultMessage({ dryRun: false, result }),
            });
          }
        } catch (error) {
          console.error(`Erro no sync automatico do canal ${channelId}:`, error);

          const nextRunAt = new Date(
            Date.now() + sync.intervalMinutes * 60 * 1000,
          ).toISOString();

          await saveChannelConfig(s3Client, channelId, {
            driveSync: {
              ...sync,
              lastResult: {
                error: error.message,
                status: 'error',
              },
              lastRunAt: new Date().toISOString(),
              nextRunAt,
            },
          });
        }
      }
    } catch (error) {
      console.error('Erro no scheduler de sync do Drive:', error);
    } finally {
      isSyncSchedulerRunning = false;
    }
  };

  setInterval(runDueDriveSyncs, SCHEDULER_TICK_MS);
  runDueDriveSyncs();

  return app;
};
