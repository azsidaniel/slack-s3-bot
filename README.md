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

Use mencionando o bot em uma thread.

### Base

- `help`: lista todos os comandos e explica o uso.
- `status`: mostra a configuracao geral do canal.
- `test`: valida acesso ao bucket e mostra a pasta S3 configurada para o canal.

```text
@info-s3 help
@info-s3 status
@info-s3 test
```

### Configuracao

- `set-s3-folder nome-da-pasta`: salva a pasta S3 de destino deste canal.
- `set-s3-source-folder pasta-ou-s3://bucket/pasta`: salva a origem S3 para copiar dados.
- `set-drive-source-folder link-ou-id-da-pasta`: salva a pasta publica do Google Drive usada como fonte.

```text
@info-s3 set-s3-folder nome-da-pasta
@info-s3 set-s3-source-folder nome-da-pasta-origem
@info-s3 set-s3-source-folder s3://infogbucket/pesquisas-eleicoes/2026/quaest
@info-s3 set-drive-source-folder link-ou-id-da-pasta
```

### S3

- `s3-list`: lista arquivos da pasta S3 configurada.
- `s3-download data/arquivo.txt`: baixa um arquivo de `data/` no S3 e anexa na thread.
- `s3-sync --dry-run`: mostra o sync de `data/` entre a origem S3 e o destino deste canal.
- `s3-sync`: copia novos/alterados de `data/` da pasta origem para a pasta deste canal.
- `s3-sync --delete`: espelha `data/` e remove do destino arquivos ausentes na origem.
- `s3-sync-on <minutos> <duracao>`: ativa sync automatico S3 com expiracao obrigatoria.
- `s3-sync-on <minutos> <duracao> --delete`: ativa sync automatico S3 espelhando `data/`.
- `s3-sync-on`: reativa o sync automatico S3 com a configuracao anterior.
- `s3-sync-off`: pausa sync automatico S3 e preserva a configuracao.
- `s3-sync-schedule`: salva uma agenda JSON de datas/horas exatas para sync S3.
- `s3-sync-schedule-off`: pausa a agenda S3 e preserva as datas configuradas.
- `s3-sync-schedule []`: apaga a agenda S3 deste canal.

```text
@info-s3 s3-list
@info-s3 s3-download data/arquivo.txt
@info-s3 s3-sync --dry-run
@info-s3 s3-sync
@info-s3 s3-sync --delete
@info-s3 s3-sync-on 5 7d
@info-s3 s3-sync-on 5 7d --delete
@info-s3 s3-sync-on
@info-s3 s3-sync-off
@info-s3 s3-sync-schedule [{"data":"14/08/2026","hora":"18:15:00"}]
@info-s3 s3-sync-schedule-off
@info-s3 s3-sync-schedule []
```

### Drive

- `drive-list`: lista arquivos da pasta Drive configurada.
- `drive-sync --dry-run`: mostra quais arquivos do Drive seriam sincronizados no S3.
- `drive-sync`: sincroniza manualmente a pasta Drive configurada para o S3.
- `drive-sync-on <minutos> <duracao>`: ativa sync automatico com expiracao obrigatoria.
- `drive-sync-on`: reativa o sync automatico com a configuracao anterior, sem reiniciar a expiracao.
- `drive-sync-off`: pausa sync automatico e preserva a configuracao.

```text
@info-s3 drive-list
@info-s3 drive-sync --dry-run
@info-s3 drive-sync
@info-s3 drive-sync-on 5 7d
@info-s3 drive-sync-on
@info-s3 drive-sync-off
```

### Slack

- `slack-upload --dry-run`: mostra para onde os anexos da thread seriam enviados.
- `slack-upload`: baixa os anexos da thread e envia para o S3.

```text
@info-s3 slack-upload --dry-run
@info-s3 slack-upload
```

O bot nao assume o nome do canal como pasta S3. Cada canal precisa ser
configurado explicitamente:

```text
@info-s3 set-s3-folder nome-da-pasta
```

O bot nao cria uma pasta nova automaticamente. Se a pasta informada nao tiver
arquivos no S3, ele pede o nome correto antes de salvar ou usar os comandos de
upload/sync.

Para salvar a pasta correta para um canal:

```text
@info-s3 set-s3-folder nome-da-pasta
```

Para salvar a pasta publica do Google Drive que sera usada como fonte:

```text
@info-s3 set-drive-source-folder https://drive.google.com/drive/folders/id-da-pasta
```

Depois disso, neste canal, os comandos sem pasta explicita passam a usar a
pasta salva:

```text
@info-s3 s3-list
@info-s3 s3-download data/arquivo.txt
@info-s3 slack-upload --dry-run
@info-s3 slack-upload
@info-s3 drive-list
@info-s3 s3-sync --dry-run
@info-s3 s3-sync
@info-s3 s3-sync-on 5 7d
@info-s3 s3-sync-on
@info-s3 s3-sync-schedule [{"data":"14/08/2026","hora":"18:15:00"}]
@info-s3 drive-sync --dry-run
@info-s3 drive-sync
@info-s3 drive-sync-on 5 7d
@info-s3 drive-sync-on
@info-s3 status
```

Esse mapeamento fica salvo localmente em `data/channel-prefixes.json`.
Em AWS, use `PREFIX_STORE=s3` para salvar o mapeamento no proprio bucket.

Para copiar arquivos `data/` de outra pasta S3 para a pasta deste canal, informe
somente a pasta quando ela estiver no bucket configurado em `S3_BUCKET`, ou use
o caminho completo quando a origem estiver em outro bucket:

```text
@info-s3 set-s3-source-folder nome-da-pasta-origem
@info-s3 set-s3-source-folder s3://infogbucket/pesquisas-eleicoes/2026/quaest
@info-s3 s3-sync --dry-run
@info-s3 s3-sync
```

Ao informar somente uma pasta, o bot le `data/` dentro dela. Ao informar um
caminho completo `s3://`, ele trata esse caminho como a propria pasta de dados.
Portanto, o segundo exemplo le a origem
`s3://infogbucket/pesquisas-eleicoes/2026/quaest/` e copia para
`s3://<S3_BUCKET>/<pasta-do-canal>/data/`. A credencial AWS precisa ter
`s3:ListBucket` e `s3:GetObject` no bucket de origem, alem das permissoes de
escrita no bucket de destino.

Use `--delete` apenas quando quiser espelhar completamente `data/`, removendo do
destino arquivos que nao existem mais na origem:

```text
@info-s3 s3-sync --delete
```

Para ativar sync automatico S3, use:

```text
@info-s3 s3-sync-on 5 7d
```

Para ativar sync automatico S3 espelhando `data/` com remocao no destino:

```text
@info-s3 s3-sync-on 5 7d --delete
```

Para pausar e reativar sem reiniciar a expiracao:

```text
@info-s3 s3-sync-off
@info-s3 s3-sync-on
```

Para agendar sync S3 em datas e horas exatas, cole um array JSON depois do
comando. Datas usam `DD/MM/AAAA` e horas usam `HH:mm:ss` no fuso
`America/Sao_Paulo`. Itens sem `hora` sao ignorados.

```text
@info-s3 s3-sync-schedule
[
  { "data": "14/08/2026", "hora": "18:15:00" },
  { "data": "02/09/2026", "hora": "10:30:00" },
  { "data": "03/10/2026", "hora": "" }
]
```

Use `--delete` para salvar a agenda em modo espelhamento:

```text
@info-s3 s3-sync-schedule --delete
[
  { "data": "14/08/2026", "hora": "18:15:00" }
]
```

Para pausar a agenda sem apagar as datas salvas:

```text
@info-s3 s3-sync-schedule-off
```

Para apagar completamente a agenda e suas execucoes pendentes:

```text
@info-s3 s3-sync-schedule []
```

Se o bot estiver indisponivel no horario exato e voltar depois, execucoes
pendentes sao executadas assim que o scheduler rodar novamente.

O sync automatico do Drive tambem e por canal. Exemplo:

```text
@info-s3 drive-sync-on 5 7d
```

Esse comando sincroniza a pasta Drive configurada para o S3 a cada 5 minutos por
7 dias. A duracao e obrigatoria, aceita formatos como `2h`, `7d` e `60d`, e o
limite maximo e 60 dias. O bot so notifica o canal quando houver arquivos
alterados.

Para pausar sem perder a agenda:

```text
@info-s3 drive-sync-off
```

Para reativar a agenda anterior sem reiniciar a contagem da expiracao:

```text
@info-s3 drive-sync-on
```

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
files:write
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
s3:GetObject
s3:ListBucket
s3:PutObject
s3:DeleteObject
```

`s3:DeleteObject` so e necessario para `s3-sync --delete`. Se
`S3_ACL=public-read`, tambem precisa de permissao para aplicar ACL.

## Google Drive

Para usar Drive como fonte, a pasta precisa estar publica para qualquer pessoa
com o link e a Google Drive API precisa estar habilitada para a API key.

Configure:

```env
GOOGLE_DRIVE_API_KEY=your-google-drive-api-key
```

Arquivos normais sao baixados e enviados para o S3. Itens nativos do Google
Drive, como Docs, Sheets, Slides, Forms, atalhos e subpastas, sao listados, mas
ignorados no sync do Drive porque precisam de exportacao ou tratamento especifico.

## Persistencia por S3

Para manter o mapeamento de canal para pasta S3 em ambiente hospedado, configure:

```env
PREFIX_STORE=s3
PREFIX_STORE_S3_KEY=_bot/channel-prefixes.json
```

Com isso, `@info-s3 set-s3-folder nome-da-pasta` grava o mapeamento em:

```text
s3://<bucket>/_bot/channel-prefixes.json
```

Isso evita depender do disco local em EC2/ECS/Lambda/App Runner.
