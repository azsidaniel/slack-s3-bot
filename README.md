# Slack S3 Assets Bot

Bot simples para publicar anexos de threads do Slack diretamente no S3.

Contrato:

```text
canal Slack = pasta S3
```

Exemplo no canal `#nome-do-canal` apontando para a pasta `nome-da-pasta`:

```text
s3://meu-bucket/nome-da-pasta/data/arquivo.txt
s3://meu-bucket/nome-da-pasta/media/images/share.jpg
```

## Comandos

Use mencionando o bot em uma thread:

```text
@info-s3 test
@info-s3 help
@info-s3 status
@info-s3 list
@info-s3 drive-list
@info-s3 set-folder nome-da-pasta
@info-s3 set-drive-folder link-ou-id-da-pasta
@info-s3 upload --dry-run
@info-s3 upload
@info-s3 sync-drive --dry-run
@info-s3 sync-drive
@info-s3 sync-drive-on 5 7d
@info-s3 sync-drive-off
```

- `test`: valida acesso ao bucket e mostra o prefixo do canal.
- `help`: lista todos os comandos e explica o uso.
- `status`: mostra a configuracao geral do canal.
- `list`: lista arquivos da pasta S3 configurada.
- `drive-list`: lista arquivos da pasta publica do Google Drive configurada.
- `set-folder nome-da-pasta`: salva a pasta S3 que este canal deve usar.
- `set-drive-folder link-ou-id-da-pasta`: salva a pasta publica do Google Drive usada como fonte.
- `upload --dry-run`: mostra para onde os anexos da thread seriam enviados.
- `upload`: baixa os anexos da thread e envia para o S3.
- `sync-drive --dry-run`: mostra quais arquivos do Drive seriam sincronizados no S3.
- `sync-drive`: sincroniza manualmente a pasta Drive configurada para o S3.
- `sync-drive-on <minutos> <duracao>`: ativa sync automatico com expiracao obrigatoria.
- `sync-drive-off`: desativa sync automatico.

O bot nao assume o nome do canal como pasta S3. Cada canal precisa ser
configurado explicitamente:

```text
@info-s3 set-folder nome-da-pasta
```

O bot nao cria uma pasta nova automaticamente. Se a pasta informada nao tiver
arquivos no S3, ele pede o nome correto antes de salvar ou fazer upload.

Para salvar a pasta correta para um canal:

```text
@info-s3 set-folder nome-da-pasta
```

Para salvar a pasta publica do Google Drive que sera usada como fonte:

```text
@info-s3 set-drive-folder https://drive.google.com/drive/folders/id-da-pasta
```

Depois disso, neste canal, os comandos sem pasta explicita passam a usar a
pasta salva:

```text
@info-s3 list
@info-s3 upload --dry-run
@info-s3 upload
@info-s3 drive-list
@info-s3 sync-drive --dry-run
@info-s3 sync-drive
@info-s3 sync-drive-on 5 7d
@info-s3 status
```

Esse mapeamento fica salvo localmente em `data/channel-prefixes.json`.
Em AWS, use `PREFIX_STORE=s3` para salvar o mapeamento no proprio bucket.

O sync automatico e por canal. Exemplo:

```text
@info-s3 sync-drive-on 5 7d
```

Esse comando sincroniza a pasta Drive configurada para o S3 a cada 5 minutos por
7 dias. A duracao e obrigatoria, aceita formatos como `2h`, `7d` e `60d`, e o
limite maximo e 60 dias. O bot so notifica o canal quando houver arquivos
alterados.

## Mapeamento

```text
.txt, .json, .csv, .tsv, .xml -> data/
.png, .jpg, .jpeg, .webp, .gif, .svg, .avif -> media/images/
.mp4, .mov, .webm -> media/videos/
.pdf, .doc, .docx, .ppt, .pptx, .xls, .xlsx -> documents/
outros -> files/
```

## Setup local

```bash
npm install
cp .env.example .env
npm start
```

O bot usa Socket Mode, entao nao precisa de URL publica. Ele responde enquanto o processo local estiver rodando.

## Variaveis de ambiente

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
S3_BUCKET=meu-bucket
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
GOOGLE_DRIVE_API_KEY=your-google-drive-api-key
S3_CACHE_CONTROL=public,max-age=60
S3_ACL=public-read
ALLOW_UPLOAD=true
PREFIX_STORE=local
PREFIX_STORE_S3_KEY=_bot/channel-prefixes.json
```

Use `S3_ACL=none` se o bucket bloquear ACLs.

## Permissoes no Slack

OAuth scopes sugeridos para o bot:

```text
app_mentions:read
channels:join
channels:history
channels:read
chat:write
files:read
groups:history
groups:read
```

Socket Mode precisa de um App-Level Token com:

```text
connections:write
```

Convide o bot para cada canal de projeto.

Em `Event Subscriptions`, habilite eventos e assine o evento de bot:

```text
Subscribe to bot events -> app_mention
Subscribe to bot events -> member_joined_channel
```

Mesmo usando Socket Mode, o Slack so envia `@info-s3 comando` se esse evento estiver
assinado. O evento `member_joined_channel` permite o bot explicar a configuracao
quando for adicionado a um canal.

## Permissoes AWS

O usuario/role AWS precisa conseguir listar e escrever no bucket:

```text
s3:HeadBucket
s3:ListBucket
s3:PutObject
```

Se `S3_ACL=public-read`, tambem precisa de permissao para aplicar ACL.

## Google Drive

Para usar Drive como fonte, a pasta precisa estar publica para qualquer pessoa
com o link e a Google Drive API precisa estar habilitada para a API key.

Configure:

```env
GOOGLE_DRIVE_API_KEY=your-google-drive-api-key
```

Arquivos normais sao baixados e enviados para o S3. Arquivos Google Workspace
como Docs, Sheets e Slides sao listados, mas ignorados no upload inicial porque
precisam de exportacao para um formato definido.

## Persistencia por S3

Para manter o mapeamento de canal para pasta S3 em ambiente hospedado, configure:

```env
PREFIX_STORE=s3
PREFIX_STORE_S3_KEY=_bot/channel-prefixes.json
```

Com isso, `@info-s3 set-folder nome-da-pasta` grava o mapeamento em:

```text
s3://<bucket>/_bot/channel-prefixes.json
```

Isso evita depender do disco local em EC2/ECS/Lambda/App Runner.
