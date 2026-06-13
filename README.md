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
@bot test
@bot help
@bot info
@bot list
@bot set-folder nome-da-pasta
@bot upload --dry-run
@bot upload
```

- `test`: valida acesso ao bucket e mostra o prefixo do canal.
- `help` / `info`: lista todos os comandos e explica o uso.
- `list`: lista arquivos em `s3://<bucket>/<canal>/`.
- `set-folder nome-da-pasta`: salva a pasta S3 que este canal deve usar.
- `upload --dry-run`: mostra para onde os anexos da thread seriam enviados.
- `upload`: baixa os anexos da thread e envia para o S3.

O bot nao assume o nome do canal como pasta S3. Cada canal precisa ser
configurado explicitamente:

```text
@bot set-folder nome-da-pasta
```

O bot nao cria uma pasta nova automaticamente. Se a pasta informada nao tiver
arquivos no S3, ele pede o nome correto antes de salvar ou fazer upload.

Para salvar a pasta correta para um canal:

```text
@bot set-folder nome-da-pasta
```

Depois disso, neste canal, os comandos sem pasta explicita passam a usar a
pasta salva:

```text
@bot list
@bot upload --dry-run
@bot upload
```

Esse mapeamento fica salvo localmente em `data/channel-prefixes.json`.
Em AWS, use `PREFIX_STORE=s3` para salvar o mapeamento no proprio bucket.

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

Mesmo usando Socket Mode, o Slack so envia `@bot comando` se esse evento estiver
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

## Persistencia por S3

Para manter o mapeamento de canal para pasta S3 em ambiente hospedado, configure:

```env
PREFIX_STORE=s3
PREFIX_STORE_S3_KEY=_bot/channel-prefixes.json
```

Com isso, `@bot set-folder nome-da-pasta` grava o mapeamento em:

```text
s3://<bucket>/_bot/channel-prefixes.json
```

Isso evita depender do disco local em EC2/ECS/Lambda/App Runner.
