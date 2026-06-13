import { App } from '@slack/bolt';

import { buildAssetKey, getContentType, getSafeFilename } from './classifyAsset.js';
import { getSavedPrefix, savePrefix } from './channelPrefixes.js';
import {
  assertBucketAccess,
  createS3Client,
  getS3Config,
  getS3Uri,
  listProjectObjects,
  uploadObject,
} from './s3.js';

const COMMANDS = new Set(['help', 'info', 'list', 'set-folder', 'test', 'upload']);

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
    '`@bot help` ou `@bot info` - lista os comandos e o uso.',
    '`@bot set-folder nome-da-pasta` - salva a pasta S3 que este canal deve usar.',
    '`@bot test` - valida Slack, AWS e mostra a pasta S3 configurada para o canal.',
    '`@bot list` - lista arquivos da pasta S3 configurada.',
    '`@bot upload --dry-run` - mostra para onde os anexos da thread seriam enviados.',
    '`@bot upload` - envia os anexos da thread para a pasta S3 configurada.',
    '',
    'Antes de usar `list` ou `upload`, configure a pasta deste canal:',
    '`@bot set-folder nome-da-pasta`',
  ].join('\n');

const getUnconfiguredChannelMessage = (channelName) =>
  [
    `Este canal ainda nao tem uma pasta S3 configurada.`,
    `Canal Slack: ${channelName}`,
    'Informe a pasta existente no S3 com:',
    '`@bot set-folder nome-da-pasta`',
    'Exemplo:',
    '`@bot set-folder nome-da-pasta`',
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

const getMissingPrefixMessage = ({ channelName, prefix }) =>
  [
    `Nao encontrei arquivos na pasta S3: ${getS3Uri(`${prefix}/`)}`,
    `Canal Slack: ${channelName}`,
    'Se a pasta do S3 tiver outro nome, salve a pasta correta para este canal:',
    '`@bot set-folder nome-da-pasta`',
    'Depois disso, `@bot list`, `@bot upload --dry-run` e `@bot upload` usarao essa pasta automaticamente.',
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
      text: 'Informe a pasta S3. Exemplo: `@bot set-folder nome-da-pasta`',
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
        text: 'Comando invalido. Use: help, info, test, list, set-folder, upload ou upload --dry-run.',
      });
      return;
    }

    try {
      if (command === 'help' || command === 'info') {
        await reply(say, {
          threadTs,
          text: getHelpMessage(),
        });
        return;
      }

      const channelName = await getChannelName(client, event.channel);
      const savedPrefix = (await getSavedPrefix(s3Client, event.channel))?.prefix;
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
        `Obrigado por me adicionar ao canal #${channelName}.`,
        'Antes de listar ou subir arquivos, configure qual pasta S3 este canal deve usar:',
        '`@bot set-folder nome-da-pasta`',
        'Para ver todos os comandos: `@bot help`',
      ].join('\n'),
    });
  });

  return app;
};
