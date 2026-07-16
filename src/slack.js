import slackBolt from '@slack/bolt';

import { buildAssetKey, getContentType, getSafeFilename } from './classifyAsset.js';
import {
  getSavedPrefix,
  listChannelConfigs,
  saveChannelConfig,
  saveDriveFolder,
  savePrefix,
  saveS3SourceFolder,
} from './channelPrefixes.js';
import {
  extractDriveFolderId,
  isGoogleWorkspaceFile,
  listDriveFolderFiles,
} from './drive.js';
import {
  assertBucketAccess,
  createS3Client,
  getObjectBuffer,
  getS3Config,
  getS3Uri,
  listObjectsByPrefix,
  listProjectObjects,
  uploadObject,
} from './s3.js';
import { syncDriveFolderToS3 } from './syncDrive.js';
import { syncS3DataFolder } from './syncS3Data.js';

const { App } = slackBolt;

const COMMANDS = new Set([
  's3-download',
  'drive-list',
  'help',
  's3-list',
  'set-drive-source-folder',
  'set-s3-folder',
  'set-s3-source-folder',
  'status',
  'drive-sync',
  'drive-sync-off',
  'drive-sync-on',
  's3-sync',
  's3-sync-off',
  's3-sync-on',
  's3-sync-schedule',
  'test',
  'slack-upload',
]);
const BOT_MENTION_LABEL = '@info-s3';
const MAX_SYNC_DURATION_DAYS = 60;
const MIN_SYNC_DURATION_MS = 60 * 60 * 1000;
const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 1440;
const SCHEDULER_TICK_MS = 60 * 1000;
const SCHEDULE_TIME_ZONE = 'America/Sao_Paulo';

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

const getCommandPayload = (text = '', command = '') => {
  const cleanText = getCommandText(text);
  const commandIndex = cleanText.toLowerCase().indexOf(command);

  if (commandIndex < 0) {
    return '';
  }

  return cleanText.slice(commandIndex + command.length).trim();
};

const getHelpMessage = () =>
  [
    'Comandos disponiveis:',
    '',
    'Base:',
    `\`${BOT_MENTION_LABEL} help\` - lista os comandos e o uso.`,
    `\`${BOT_MENTION_LABEL} status\` - mostra a configuracao deste canal.`,
    `\`${BOT_MENTION_LABEL} test\` - valida Slack, AWS e mostra a pasta S3 configurada para o canal.`,
    '',
    'Configuracao:',
    `\`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\` - salva a pasta S3 de destino deste canal.`,
    `\`${BOT_MENTION_LABEL} set-s3-source-folder nome-da-pasta\` - salva a pasta S3 de origem para copiar data/.`,
    `\`${BOT_MENTION_LABEL} set-drive-source-folder link-ou-id-da-pasta\` - salva a pasta publica do Google Drive usada como fonte.`,
    '',
    'S3:',
    `\`${BOT_MENTION_LABEL} s3-list\` - lista arquivos da pasta S3 configurada.`,
    `\`${BOT_MENTION_LABEL} s3-download data/arquivo.txt\` - baixa um arquivo de data/ no S3 e anexa na thread.`,
    `\`${BOT_MENTION_LABEL} s3-sync --dry-run\` - mostra o sync de data/ entre pasta origem e destino no mesmo bucket.`,
    `\`${BOT_MENTION_LABEL} s3-sync\` - copia novos/alterados de data/ da pasta origem para a pasta deste canal.`,
    `\`${BOT_MENTION_LABEL} s3-sync --delete\` - espelha data/ e remove do destino arquivos ausentes na origem.`,
    `\`${BOT_MENTION_LABEL} s3-sync-on 5 7d\` - ativa sync automatico S3 por canal.`,
    `\`${BOT_MENTION_LABEL} s3-sync-on 5 7d --delete\` - ativa sync automatico S3 espelhando data/.`,
    `\`${BOT_MENTION_LABEL} s3-sync-on\` - reativa o sync automatico S3 com a configuracao anterior.`,
    `\`${BOT_MENTION_LABEL} s3-sync-off\` - pausa o sync automatico S3, preservando a configuracao.`,
    `\`${BOT_MENTION_LABEL} s3-sync-schedule\` - salva agenda JSON de datas exatas para sync S3.`,
    '',
    'Drive:',
    `\`${BOT_MENTION_LABEL} drive-list\` - lista arquivos da pasta Drive configurada.`,
    `\`${BOT_MENTION_LABEL} drive-sync --dry-run\` - mostra quais arquivos do Drive seriam sincronizados no S3.`,
    `\`${BOT_MENTION_LABEL} drive-sync\` - sincroniza a pasta Drive configurada para o S3.`,
    `\`${BOT_MENTION_LABEL} drive-sync-on 5 7d\` - ativa sync automatico por canal, com expiracao obrigatoria.`,
    `\`${BOT_MENTION_LABEL} drive-sync-on\` - reativa o sync automatico com a configuracao anterior, sem reiniciar a expiracao.`,
    `\`${BOT_MENTION_LABEL} drive-sync-off\` - pausa o sync automatico neste canal, preservando a configuracao.`,
    '',
    'Slack:',
    `\`${BOT_MENTION_LABEL} slack-upload --dry-run\` - mostra para onde os anexos da thread seriam enviados.`,
    `\`${BOT_MENTION_LABEL} slack-upload\` - envia os anexos da thread para a pasta S3 configurada.`,
    '',
    'Antes de usar S3, Drive ou Slack upload, configure a pasta S3 de destino:',
    `\`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
    'Para usar Drive como fonte:',
    `\`${BOT_MENTION_LABEL} set-drive-source-folder link-ou-id-da-pasta\``,
    'Para usar S3 como fonte:',
    `\`${BOT_MENTION_LABEL} set-s3-source-folder nome-da-pasta-origem\``,
  ].join('\n');

const getUnconfiguredChannelMessage = (channelName) =>
  [
    `Este canal ainda nao tem uma pasta S3 configurada.`,
    `Canal Slack: ${channelName}`,
    'Informe a pasta existente no S3 com:',
    `\`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
    'Exemplo:',
    `\`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
  ].join('\n');

const normalizeS3DataPath = (input = '') => {
  const filePath = String(input).trim().replace(/^\/+/, '');

  if (
    !filePath ||
    !filePath.startsWith('data/') ||
    filePath.endsWith('/') ||
    filePath.includes('..') ||
    filePath.includes('\\')
  ) {
    return null;
  }

  return filePath;
};

const normalizeS3FolderName = (input = '') => {
  const folder = String(input).trim().replace(/^\/+|\/+$/g, '');

  if (!folder || folder.includes('..') || folder.includes('\\')) {
    return null;
  }

  return folder;
};

const formatFileList = (files, formatter, limit = 20) => {
  const visibleFiles = files.slice(0, limit);
  const lines = visibleFiles.map(formatter);
  const extraCount = files.length - visibleFiles.length;

  if (extraCount > 0) {
    lines.push(`...mais ${extraCount} arquivo(s).`);
  }

  return lines;
};

const parseS3SchedulePayload = (payload) => {
  const jsonStart = payload.indexOf('[');

  if (jsonStart < 0) {
    throw new Error('Cole um array JSON depois do comando.');
  }

  const parsed = JSON.parse(payload.slice(jsonStart));

  if (!Array.isArray(parsed)) {
    throw new Error('A agenda precisa ser um array JSON.');
  }

  const ignoredRuns = [];
  const runs = [];

  parsed.forEach((item, index) => {
    const data = String(item?.data || '').trim();
    const hora = String(item?.hora || '').trim();

    if (!hora) {
      ignoredRuns.push({
        data,
        index,
        reason: 'sem hora definida',
      });
      return;
    }

    const runAt = parseSaoPauloDateTime({ data, hora });

    if (!runAt) {
      ignoredRuns.push({
        data,
        hora,
        index,
        reason: 'data ou hora invalida',
      });
      return;
    }

    runs.push({
      label: `${data} ${hora}`,
      runAt,
      status: 'pending',
    });
  });

  runs.sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime());

  return { ignoredRuns, runs };
};

const getScheduleLines = (runs, limit = 10) =>
  formatFileList(runs, (run) => `- ${run.label}`, limit);

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

const getSaoPauloOffsetMs = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );

  return asUtc - date.getTime();
};

const parseSaoPauloDateTime = ({ data, hora }) => {
  const dateMatch = String(data || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const timeMatch = String(hora || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const [, day, month, year] = dateMatch;
  const [, hour, minute, second = '00'] = timeMatch;
  const utcGuess = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  const offsetMs = getSaoPauloOffsetMs(utcGuess);
  const date = new Date(utcGuess.getTime() - offsetMs);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
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
    `\`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
    `Depois disso, \`${BOT_MENTION_LABEL} s3-list\`, \`${BOT_MENTION_LABEL} slack-upload --dry-run\` e \`${BOT_MENTION_LABEL} slack-upload\` usarao essa pasta automaticamente.`,
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
      text: `Informe a pasta S3. Exemplo: \`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
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

const handleSetSourceFolder = async ({
  channelId,
  channelName,
  say,
  s3Client,
  sourceFolder,
  threadTs,
}) => {
  const s3SourceFolder = normalizeS3FolderName(sourceFolder);

  if (!s3SourceFolder) {
    await reply(say, {
      threadTs,
      text: `Informe a pasta S3 de origem. Exemplo: \`${BOT_MENTION_LABEL} set-s3-source-folder nome-da-pasta-origem\``,
    });
    return;
  }

  const dataObjects = await listObjectsByPrefix(s3Client, `${s3SourceFolder}/data/`);

  if (dataObjects.length === 0) {
    await reply(say, {
      threadTs,
      text: [
        `Nao encontrei arquivos em ${getS3Uri(`${s3SourceFolder}/data/`)}`,
        'Confirme se a pasta origem esta correta e se ela possui arquivos em data/.',
      ].join('\n'),
    });
    return;
  }

  await saveS3SourceFolder(s3Client, {
    channelId,
    channelName,
    s3SourceFolder,
  });

  await reply(say, {
    threadTs,
    text: [
      `Pasta S3 de origem salva para este canal: ${s3SourceFolder}`,
      `Origem data/: ${getS3Uri(`${s3SourceFolder}/data/`)}`,
      `Arquivos encontrados agora: ${dataObjects.length}`,
      `Use \`${BOT_MENTION_LABEL} s3-sync --dry-run\` para conferir antes de copiar.`,
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
      text: `Informe a pasta do Google Drive. Exemplo: \`${BOT_MENTION_LABEL} set-drive-source-folder link-ou-id-da-pasta\``,
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
      `A partir de agora, \`${BOT_MENTION_LABEL} drive-list\` e \`${BOT_MENTION_LABEL} drive-sync\` usarao essa pasta como fonte.`,
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
  const driveSync = config?.driveSync;
  const s3Sync = config?.s3Sync;
  const s3SyncSchedule = config?.s3SyncSchedule;
  const driveSyncStatus = driveSync?.enabled
    ? `ativo, a cada ${driveSync.intervalMinutes} minuto(s), expira em ${formatDateTime(driveSync.expiresAt)}`
    : 'desativado';
  const s3SyncMode = s3Sync?.deleteExtra ? 'espelhar com delete' : 'copiar novos/alterados';
  const s3SyncStatus = s3Sync?.enabled
    ? `ativo, a cada ${s3Sync.intervalMinutes} minuto(s), expira em ${formatDateTime(s3Sync.expiresAt)}, modo: ${s3SyncMode}`
    : 'desativado';
  const pendingScheduleRuns = (s3SyncSchedule?.runs || []).filter(
    (run) => run.status === 'pending',
  );
  const scheduleStatus = s3SyncSchedule?.enabled
    ? `ativo, pendentes: ${pendingScheduleRuns.length}, modo: ${s3SyncSchedule.deleteExtra ? 'espelhar com delete' : 'copiar novos/alterados'}`
    : 'desativado';
  const nextScheduleRun = pendingScheduleRuns[0];

  return [
    `Status do canal #${channelName}:`,
    `S3: ${config?.prefix || 'nao configurado'}`,
    `S3 origem: ${config?.s3SourceFolder || 'nao configurado'}`,
    `Drive: ${config?.driveFolderId || 'nao configurado'}`,
    `Drive sync automatico: ${driveSyncStatus}`,
    `Drive ultima sync: ${formatDateTime(driveSync?.lastRunAt)}`,
    `Drive proxima sync: ${formatDateTime(driveSync?.nextRunAt)}`,
    `Drive ultimo resultado: ${driveSync?.lastResult?.status || 'sem execucao'}`,
    `S3 sync automatico: ${s3SyncStatus}`,
    `S3 ultima sync: ${formatDateTime(s3Sync?.lastRunAt)}`,
    `S3 proxima sync: ${formatDateTime(s3Sync?.nextRunAt)}`,
    `S3 ultimo resultado: ${s3Sync?.lastResult?.status || 'sem execucao'}`,
    `S3 agenda por data: ${scheduleStatus}`,
    `S3 agenda proxima execucao: ${nextScheduleRun ? formatDateTime(nextScheduleRun.runAt) : 'nunca'}`,
    `S3 agenda ultimo resultado: ${s3SyncSchedule?.lastResult?.status || 'sem execucao'}`,
  ].join('\n');
};

const getSyncS3ResultMessage = ({ deleteExtra, dryRun, result }) => {
  const header = dryRun
    ? 'Dry-run S3 data -> S3 data: nenhum arquivo foi alterado.'
    : 'Sync S3 data -> S3 data concluido.';
  const createdLines = formatFileList(
    result.createdFiles,
    (file) => `- Novo: ${file.relativeKey} -> ${file.targetUri}`,
  );
  const updatedLines = formatFileList(
    result.updatedFiles,
    (file) => `- Atualizado: ${file.relativeKey} -> ${file.targetUri}`,
  );
  const deletedLines = formatFileList(
    result.deletedFiles,
    (file) => `- Removido: ${file.relativeKey} (${file.targetUri})`,
  );

  return [
    header,
    `Origem: ${getS3Uri(result.sourcePrefix)}`,
    `Destino: ${getS3Uri(result.targetPrefix)}`,
    `Novos: ${result.createdFiles.length}`,
    `Alterados: ${result.updatedFiles.length}`,
    `Iguais: ${result.unchangedFiles.length}`,
    `A remover: ${result.deletedFiles.length}${deleteExtra ? '' : ' (--delete nao usado)'}`,
    ...createdLines,
    ...updatedLines,
    ...deletedLines,
  ].join('\n');
};

const handleSyncS3 = async ({
  config,
  deleteExtra,
  dryRun,
  prefix,
  say,
  s3Client,
  threadTs,
}) => {
  if (!config?.s3SourceFolder) {
    await reply(say, {
      threadTs,
      text: [
        'Este canal ainda nao tem uma pasta S3 de origem configurada.',
        `Configure com: \`${BOT_MENTION_LABEL} set-s3-source-folder nome-da-pasta-origem\``,
      ].join('\n'),
    });
    return;
  }

  if (config.s3SourceFolder === prefix) {
    await reply(say, {
      threadTs,
      text: 'A pasta S3 de origem e igual a pasta de destino deste canal. Configure uma pasta origem diferente.',
    });
    return;
  }

  const result = await syncS3DataFolder({
    deleteExtra,
    dryRun,
    s3Client,
    sourceFolder: config.s3SourceFolder,
    targetFolder: prefix,
  });

  await reply(say, {
    threadTs,
    text: getSyncS3ResultMessage({ deleteExtra, dryRun, result }),
  });
};

const getS3SyncConfigMissingMessage = () =>
  [
    'Configure a pasta S3 de destino e a pasta S3 de origem antes de ativar o sync automatico S3.',
    `Destino: \`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
    `Origem: \`${BOT_MENTION_LABEL} set-s3-source-folder nome-da-pasta-origem\``,
  ].join('\n');

const handleSyncS3On = async ({
  args,
  channelId,
  channelName,
  config,
  say,
  s3Client,
  threadTs,
}) => {
  const syncArgs = args.filter((arg) => !arg.startsWith('--'));
  const deleteExtra = args.includes('--delete');

  if (!config?.prefix || !config?.s3SourceFolder) {
    await reply(say, {
      threadTs,
      text: getS3SyncConfigMissingMessage(),
    });
    return;
  }

  if (config.s3SourceFolder === config.prefix) {
    await reply(say, {
      threadTs,
      text: 'A pasta S3 de origem e igual a pasta de destino deste canal. Configure uma pasta origem diferente.',
    });
    return;
  }

  if (syncArgs.length === 0) {
    const sync = config?.s3Sync;

    if (!sync?.intervalMinutes || !sync?.expiresAt) {
      await reply(say, {
        threadTs,
        text: [
          'Nao existe uma configuracao anterior de sync automatico S3 para este canal.',
          `Crie uma nova com: \`${BOT_MENTION_LABEL} s3-sync-on 5 7d\``,
        ].join('\n'),
      });
      return;
    }

    if (new Date(sync.expiresAt).getTime() <= Date.now()) {
      await reply(say, {
        threadTs,
        text: [
          `A configuracao anterior expirou em ${formatDateTime(sync.expiresAt)}.`,
          `Crie uma nova com: \`${BOT_MENTION_LABEL} s3-sync-on 5 7d\``,
        ].join('\n'),
      });
      return;
    }

    const nextRunAt = new Date(
      Date.now() + sync.intervalMinutes * 60 * 1000,
    ).toISOString();

    await saveChannelConfig(s3Client, channelId, {
      channelName,
      s3Sync: {
        ...sync,
        enabled: true,
        nextRunAt,
      },
    });

    await reply(say, {
      threadTs,
      text: [
        'Sync automatico S3 reativado com a configuracao anterior.',
        `Intervalo: ${sync.intervalMinutes} minuto(s)`,
        `Modo: ${sync.deleteExtra ? 'espelhar com delete' : 'copiar novos/alterados'}`,
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
        `Exemplo: \`${BOT_MENTION_LABEL} s3-sync-on 5 7d\``,
      ].join('\n'),
    });
    return;
  }

  const now = Date.now();
  const nextRunAt = new Date(now + intervalMinutes * 60 * 1000).toISOString();
  const expiresAt = new Date(now + durationMs).toISOString();

  await saveChannelConfig(s3Client, channelId, {
    channelName,
    s3Sync: {
      ...(config.s3Sync || {}),
      deleteExtra,
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
      'Sync automatico S3 ativado.',
      `Intervalo: ${intervalMinutes} minuto(s)`,
      `Modo: ${deleteExtra ? 'espelhar com delete' : 'copiar novos/alterados'}`,
      `Expira em: ${formatDateTime(expiresAt)}`,
      `Proxima execucao: ${formatDateTime(nextRunAt)}`,
      'O bot so notificara este canal quando houver arquivos criados, alterados ou removidos.',
    ].join('\n'),
  });
};

const handleSyncS3Off = async ({
  channelId,
  config,
  say,
  s3Client,
  threadTs,
}) => {
  await saveChannelConfig(s3Client, channelId, {
    s3Sync: {
      ...(config?.s3Sync || {}),
      enabled: false,
      nextRunAt: null,
    },
  });

  await reply(say, {
    threadTs,
    text: 'Sync automatico S3 pausado para este canal. A configuracao anterior foi preservada.',
  });
};

const handleSyncS3Schedule = async ({
  channelId,
  channelName,
  config,
  deleteExtra,
  payload,
  say,
  s3Client,
  threadTs,
}) => {
  if (!config?.prefix || !config?.s3SourceFolder) {
    await reply(say, {
      threadTs,
      text: getS3SyncConfigMissingMessage(),
    });
    return;
  }

  if (config.s3SourceFolder === config.prefix) {
    await reply(say, {
      threadTs,
      text: 'A pasta S3 de origem e igual a pasta de destino deste canal. Configure uma pasta origem diferente.',
    });
    return;
  }

  let parsedSchedule;

  try {
    parsedSchedule = parseS3SchedulePayload(payload);
  } catch (error) {
    await reply(say, {
      threadTs,
      text: [
        `Agenda invalida: ${error.message}`,
        `Exemplo: \`${BOT_MENTION_LABEL} s3-sync-schedule [{"data":"14/08/2026","hora":"18:15:00"}]\``,
      ].join('\n'),
    });
    return;
  }

  const { ignoredRuns, runs } = parsedSchedule;

  if (runs.length === 0) {
    await reply(say, {
      threadTs,
      text: [
        'Nenhuma execucao valida encontrada na agenda.',
        `Itens ignorados: ${ignoredRuns.length}`,
      ].join('\n'),
    });
    return;
  }

  await saveChannelConfig(s3Client, channelId, {
    channelName,
    s3SyncSchedule: {
      deleteExtra,
      enabled: true,
      ignoredRuns,
      lastResult: null,
      runs,
      timezone: SCHEDULE_TIME_ZONE,
    },
  });

  await reply(say, {
    threadTs,
    text: [
      'Agenda S3 salva.',
      `Origem: ${getS3Uri(`${config.s3SourceFolder}/data/`)}`,
      `Destino: ${getS3Uri(`${config.prefix}/data/`)}`,
      `Timezone: ${SCHEDULE_TIME_ZONE}`,
      `Modo: ${deleteExtra ? 'espelhar com delete' : 'copiar novos/alterados'}`,
      `Agendados: ${runs.length}`,
      `Ignorados: ${ignoredRuns.length}`,
      'Proximas execucoes:',
      ...getScheduleLines(runs),
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

const handleDownloadS3 = async ({
  channelId,
  client,
  filePath,
  prefix,
  say,
  s3Client,
  threadTs,
}) => {
  const normalizedPath = normalizeS3DataPath(filePath);

  if (!normalizedPath) {
    await reply(say, {
      threadTs,
      text: [
        'Informe o caminho completo de um arquivo dentro de `data/`.',
        `Exemplo: \`${BOT_MENTION_LABEL} s3-download data/arquivo.txt\``,
      ].join('\n'),
    });
    return;
  }

  const key = `${prefix}/${normalizedPath}`;

  try {
    const { body } = await getObjectBuffer(s3Client, key);
    const filename = getSafeFilename(normalizedPath);

    await client.files.uploadV2({
      channel_id: channelId,
      file: body,
      filename,
      initial_comment: `Download de ${getS3Uri(key)}`,
      thread_ts: threadTs,
      title: filename,
    });
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(error?.name)) {
      await reply(say, {
        threadTs,
        text: `Arquivo nao encontrado no S3: ${getS3Uri(key)}`,
      });
      return;
    }

    throw error;
  }
};

const getUnconfiguredDriveMessage = () =>
  [
    'Este canal ainda nao tem uma pasta do Google Drive configurada.',
    'Informe a pasta publica do Drive com:',
    `\`${BOT_MENTION_LABEL} set-drive-source-folder link-ou-id-da-pasta\``,
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
          `S3: \`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
          `Drive: \`${BOT_MENTION_LABEL} set-drive-source-folder link-ou-id-da-pasta\``,
        ].join('\n'),
      });
      return;
    }

    if (!sync?.intervalMinutes || !sync?.expiresAt) {
      await reply(say, {
        threadTs,
        text: [
          'Nao existe uma configuracao anterior de sync automatico para este canal.',
          `Crie uma nova com: \`${BOT_MENTION_LABEL} drive-sync-on 5 7d\``,
        ].join('\n'),
      });
      return;
    }

    if (new Date(sync.expiresAt).getTime() <= Date.now()) {
      await reply(say, {
        threadTs,
        text: [
          `A configuracao anterior expirou em ${formatDateTime(sync.expiresAt)}.`,
          `Crie uma nova com: \`${BOT_MENTION_LABEL} drive-sync-on 5 7d\``,
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
        `Exemplo: \`${BOT_MENTION_LABEL} drive-sync-on 5 7d\``,
      ].join('\n'),
    });
    return;
  }

  if (!config?.prefix || !config?.driveFolderId) {
    await reply(say, {
      threadTs,
      text: [
        'Configure S3 e Drive antes de ativar o sync automatico.',
        `S3: \`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
        `Drive: \`${BOT_MENTION_LABEL} set-drive-source-folder link-ou-id-da-pasta\``,
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
        text: 'Comando invalido. Use `@info-s3 help` para ver os comandos disponiveis.',
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
      const usesExplicitPrefix = ['s3-list', 'test', 'slack-upload'].includes(command);
      const prefix = usesExplicitPrefix ? targetPrefix || savedPrefix : savedPrefix;

      if (command === 'set-s3-folder') {
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

      if (command === 'set-drive-source-folder') {
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

      if (command === 'set-s3-source-folder') {
        await handleSetSourceFolder({
          channelId: event.channel,
          channelName,
          say,
          s3Client,
          sourceFolder: targetPrefix,
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

      if (command === 'drive-sync-off') {
        await handleSyncDriveOff({
          channelId: event.channel,
          config: savedConfig,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      if (command === 'drive-sync-on') {
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

      if (command === 's3-sync-off') {
        await handleSyncS3Off({
          channelId: event.channel,
          config: savedConfig,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      if (command === 's3-sync-on') {
        await handleSyncS3On({
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

      if (command === 's3-sync-schedule') {
        await handleSyncS3Schedule({
          channelId: event.channel,
          channelName,
          config: savedConfig,
          deleteExtra: args.includes('--delete'),
          payload: getCommandPayload(event.text, command),
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

      if (command === 's3-list') {
        await handleList({ channelName, prefix, say, s3Client, threadTs });
        return;
      }

      if (command === 's3-download') {
        await handleDownloadS3({
          channelId: event.channel,
          client,
          filePath: targetPrefix,
          prefix,
          say,
          s3Client,
          threadTs,
        });
        return;
      }

      if (command === 'drive-sync') {
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

      if (command === 's3-sync') {
        await handleSyncS3({
          config: savedConfig,
          deleteExtra: args.includes('--delete'),
          dryRun: isDryRun,
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
        `\`${BOT_MENTION_LABEL} set-s3-folder nome-da-pasta\``,
        `Depois veja todos os comandos com \`${BOT_MENTION_LABEL} help\`.`,
      ].join('\n'),
    });
  });

  const runDueSyncs = async () => {
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

      for (const [channelId, config] of Object.entries(configs)) {
        const sync = config.s3Sync;

        if (!sync?.enabled || !config.prefix || !config.s3SourceFolder) {
          continue;
        }

        if (sync.expiresAt && new Date(sync.expiresAt).getTime() <= now) {
          await saveChannelConfig(s3Client, channelId, {
            s3Sync: {
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
          const result = await syncS3DataFolder({
            deleteExtra: Boolean(sync.deleteExtra),
            s3Client,
            sourceFolder: config.s3SourceFolder,
            targetFolder: config.prefix,
          });
          const nextRunAt = new Date(
            Date.now() + sync.intervalMinutes * 60 * 1000,
          ).toISOString();
          const changedCount =
            result.createdFiles.length +
            result.updatedFiles.length +
            result.deletedFiles.length;

          await saveChannelConfig(s3Client, channelId, {
            s3Sync: {
              ...sync,
              enabled: true,
              lastResult: {
                createdCount: result.createdFiles.length,
                deletedCount: result.deletedFiles.length,
                status: changedCount > 0 ? 'changed' : 'no_changes',
                updatedCount: result.updatedFiles.length,
              },
              lastRunAt: new Date().toISOString(),
              nextRunAt,
              notify: sync.notify || 'changes',
            },
          });

          if (changedCount > 0) {
            await app.client.chat.postMessage({
              channel: channelId,
              text: getSyncS3ResultMessage({
                deleteExtra: Boolean(sync.deleteExtra),
                dryRun: false,
                result,
              }),
            });
          }
        } catch (error) {
          console.error(`Erro no sync automatico S3 do canal ${channelId}:`, error);

          const nextRunAt = new Date(
            Date.now() + sync.intervalMinutes * 60 * 1000,
          ).toISOString();

          await saveChannelConfig(s3Client, channelId, {
            s3Sync: {
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

      for (const [channelId, config] of Object.entries(configs)) {
        const schedule = config.s3SyncSchedule;

        if (!schedule?.enabled || !config.prefix || !config.s3SourceFolder) {
          continue;
        }

        const pendingRunIndex = (schedule.runs || []).findIndex(
          (run) => run.status === 'pending' && new Date(run.runAt).getTime() <= now,
        );

        if (pendingRunIndex < 0) {
          continue;
        }

        const runs = [...schedule.runs];
        const run = runs[pendingRunIndex];

        try {
          runs[pendingRunIndex] = {
            ...run,
            status: 'running',
          };
          await saveChannelConfig(s3Client, channelId, {
            s3SyncSchedule: {
              ...schedule,
              runs,
            },
          });

          const result = await syncS3DataFolder({
            deleteExtra: Boolean(schedule.deleteExtra),
            s3Client,
            sourceFolder: config.s3SourceFolder,
            targetFolder: config.prefix,
          });
          const changedCount =
            result.createdFiles.length +
            result.updatedFiles.length +
            result.deletedFiles.length;
          const executedAt = new Date().toISOString();

          runs[pendingRunIndex] = {
            ...run,
            executedAt,
            result: {
              createdCount: result.createdFiles.length,
              deletedCount: result.deletedFiles.length,
              status: changedCount > 0 ? 'changed' : 'no_changes',
              updatedCount: result.updatedFiles.length,
            },
            status: 'done',
          };

          await saveChannelConfig(s3Client, channelId, {
            s3SyncSchedule: {
              ...schedule,
              lastResult: runs[pendingRunIndex].result,
              lastRunAt: executedAt,
              runs,
            },
          });

          await app.client.chat.postMessage({
            channel: channelId,
            text: [
              `Execucao agendada S3 concluida: ${run.label}`,
              getSyncS3ResultMessage({
                deleteExtra: Boolean(schedule.deleteExtra),
                dryRun: false,
                result,
              }),
            ].join('\n'),
          });
        } catch (error) {
          console.error(`Erro no sync S3 agendado do canal ${channelId}:`, error);

          runs[pendingRunIndex] = {
            ...run,
            error: error.message,
            executedAt: new Date().toISOString(),
            status: 'error',
          };

          await saveChannelConfig(s3Client, channelId, {
            s3SyncSchedule: {
              ...schedule,
              lastResult: {
                error: error.message,
                status: 'error',
              },
              lastRunAt: runs[pendingRunIndex].executedAt,
              runs,
            },
          });
        }
      }
    } catch (error) {
      console.error('Erro no scheduler de sync:', error);
    } finally {
      isSyncSchedulerRunning = false;
    }
  };

  setInterval(runDueSyncs, SCHEDULER_TICK_MS);
  runDueSyncs();

  return app;
};
