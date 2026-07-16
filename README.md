# Apollo Video — Editor de Vídeo Automático com IA

Editor de vídeo local que automatiza a edição usando IA. Recebe vídeo bruto, transcreve, corta silêncios, gera cenas visuais sincronizadas e renderiza o resultado final.

## Stack

- **Next.js 16 + React 19** — Interface e API
- **Remotion 4.0.489** — Renderização programática de vídeo
- **Whisper API** (OpenAI) — Transcrição com timestamps
- **Claude API** (Anthropic) — Análise de conteúdo e cenas
- **FFmpeg/ffprobe** — Normalização e processamento por processos isolados
- **Prisma + SQLite** — Persistência local

## Pipeline

```
Upload → Normalização → Transcrição → Análise IA → Revisão → Render
```

## Setup

### Pré-requisitos

- Node.js 22 recomendado (mínimo 20.9)
- FFmpeg/ffprobe incluídos pelas dependências; `FFMPEG_PATH` e `FFPROBE_PATH` podem sobrescrever os binários
- Chaves API: OpenAI + Anthropic

### Instalação

```bash
git clone https://github.com/alpesdigital-adm/apollo-video.git
cd apollo-video

# Instalar dependências
npm install
cd remotion && npm install && cd ..

# Configurar banco
npx prisma db push

# Configurar variáveis de ambiente
cp .env.local.example .env.local
# Edite .env.local com suas chaves API

# Criar pastas
mkdir -p uploads renders

# Rodar (2 terminais)
npm run dev              # Next.js na porta 3333
npm run remotion:dev     # Remotion na porta 3001
```

Acesse: http://localhost:3333

## Validação contínua

O workflow de CI roda em pushes para `main` e em pull requests. Ele usa instalação
determinística pelo `package-lock.json` e bloqueia a integração quando falham:

- auditoria das dependências da aplicação e do renderer a partir de severidade baixa;
- typecheck, testes unitários e contratos públicos;
- validação e aplicação das migrations em Postgres 16;
- integração real de FFmpeg, bundle do Remotion, build de produção e integrações Prisma/API.

Para executar a auditoria localmente:

```bash
npm run security:audit
```

## Limites dos processos de mídia

As chamadas a FFmpeg e ffprobe possuem cancelamento por `AbortSignal`, limite de
saída e timeout. Os defaults podem ser ajustados pelo ambiente:

- `FFMPEG_TIMEOUT_MS`: 30 minutos;
- `FFPROBE_TIMEOUT_MS`: 60 segundos;
- `MEDIA_PROCESS_MAX_BUFFER_BYTES`: 8 MiB por stream.

Timeouts são limitados a 6 horas e buffers a 64 MiB. O executor não usa shell,
desabilita leitura interativa e retorna códigos distintos para cancelamento,
timeout, excesso de saída e falha do processo.

Arquivos derivados são escritos primeiro como parciais ocultos no mesmo
diretório do destino. Apenas arquivos não vazios e, quando aplicável, validados
por ffprobe são promovidos por `rename`; falhas preservam o derivado anterior e
removem o parcial.

## Manifest de artifact v2

Derivados podem ser inspecionados pelo adapter v2 para gerar um manifest
`media-artifact-manifest/v1` com SHA-256 streaming, tamanho, tipo/container,
recipe/version, hash dos parâmetros, fontes e probe. O manifest usa somente
chaves portáteis relativas, não persiste paths locais nem parâmetros brutos e
possui hash próprio para detectar adulteração.

Artifacts, manifests e relações de origem possuem persistência Postgres v2
isolada por workspace. A gravação é transacional e idempotente pela combinação
de canonical key, identidade imutável do conteúdo e `manifestHash`; source
ausente ou divergente desfaz toda a operação.

Declarações de direitos usam snapshots imutáveis e endereçados pelo hash do
conteúdo. O `PUT /v1/artifacts/{artifactId}/rights` é serializável: requests
simultâneos com o mesmo draft convergem para um snapshot, uma sequência e uma
única revisão do artifact. Conflitos de banco são repetidos até três vezes; uma
resposta perdida pode ser recuperada sem criar nova revisão.
O `GET` devolve um `ETag` forte derivado da revisão monotônica do artifact e o
`PUT` exige esse valor em `If-Match`. Ausência da precondição retorna 428;
revisão obsoleta retorna 412. Drafts idênticos ainda convergem como replay mesmo
quando repetidos após uma resposta perdida, enquanto drafts divergentes sobre a
mesma revisão admitem um único vencedor. O OpenAPI publica request e response
headers, e a capability de escrita foi elevada para `2.0.0`.

A autorização pública de materialização também é serializável. Duas avaliações
simultâneas com artifact, manifest, política de uso e chave idênticos convergem
para uma autorização e um conjunto de decisões. Se a resposta for perdida, o
retry devolve o mesmo receipt; mudar uso, mercado ou locale com a mesma chave
retorna conflito de payload.

## Worker de render v2

Renders solicitados pela API pública permanecem em uma operação durável e são
executados fora do processo web:

```bash
npm run worker:v2:render
```

O enqueue público é serializável e idempotente. Requests simultâneos com o mesmo
artifact, manifest, autorização e chave convergem para uma única operação e um
único contexto privado. Se a resposta 202 for perdida, repetir o request devolve
o mesmo operation ID; reutilizar a chave com outra autorização retorna conflito
de payload.

O processo exige Postgres e as raízes privadas de artifacts/outputs configuradas.
Claim, heartbeat e attempt impedem dois workers de concluir a mesma tentativa;
uma lease expirada pode ser recuperada com segurança por outro processo. O
status `succeeded` exige checkpoint do hash/probe do output; um arquivo já
comprometido é verificado e retomado sem nova codificação após restart.
Falhas recuperáveis respeitam uma espera exponencial persistida entre tentativas;
o esgotamento é marcado para tratamento administrativo sem expor dados internos no
contrato público v1. `APOLLO_V2_WORKER_RETRY_BASE_MS` e
`APOLLO_V2_WORKER_RETRY_MAX_MS` ajustam a base e o teto da espera.
Operações podem ser canceladas externamente por
`POST /v1/operations/{operationId}/cancel` com o scope `operations:cancel`;
o estado persistido invalida a lease e impede publicação pela tentativa antiga.
Operações `failed` ou `canceled` podem ser reabertas por
`POST /v1/operations/{operationId}/retry` com o scope `operations:retry`; uma
operação bem-sucedida nunca é reaberta.
Cancelamento e retry possuem idempotência natural: chamadas simultâneas convergem
para uma única transição, e repetir após uma resposta perdida não cancela nem
reabre a operação novamente. Em operações que esgotaram as tentativas, o retry
manual amplia `maxAttempts` apenas uma vez.
Operações do workspace podem ser descobertas por `GET /v1/operations`, usando
`limit`, cursor `after` e filtros exatos de `status`, `type` e `targetId`. O
cursor é opaco, estável e só pode continuar a mesma combinação de workspace e
filtros que o originou.
Operações que esgotaram retries automáticos podem ser descobertas separadamente
por `GET /v1/operations/dead-letter`; o mesmo item pode então ser reaberto pelo
command individual de retry, sem edição direta do banco.

## Eventos públicos v2

O envelope versionado e o catálogo inicial de eventos podem ser descobertos em
`GET /v1/events/catalog`. O catálogo referencia o JSON Schema público do envelope
e contém somente metadados estáticos, por isso não exige autenticação. A presença
de um tipo no catálogo não significa que ele já esteja sendo emitido: cada
transição ainda precisa ser conectada explicitamente ao outbox.

A criação de projeto já persiste `project.created` e `project.version.created`
no outbox, atomicamente com o projeto, sua versão inicial e o registro de
idempotência. Duas criações simultâneas com a mesma chave e o mesmo payload
convergem para o mesmo projeto; se os payloads diferirem, apenas uma vence e a
outra retorna conflito de idempotência. Se a resposta se perder depois do
commit, repetir a requisição recupera o projeto original sem duplicar versão,
snapshots ou eventos. Conflitos de serialização são tentados até três vezes e,
se persistirem, tornam-se um conflito explícito. As linhas ainda
permanecem pendentes internamente: dispatcher e entrega externa não fazem parte
deste incremento.

A administração externa de clientes em `POST /v1/workspaces/{workspaceId}/clients`
também é serializável e idempotente. Duas chamadas simultâneas com a mesma chave
e payload criam um único cliente e uma única credencial: somente a vencedora
recebe o bearer token one-shot, enquanto todos os replays são redigidos. Se a
primeira resposta for perdida, repetir a chamada recupera apenas os metadados;
o token não pode ser reaberto. Reutilizar a chave com outro payload produz um
único vencedor e conflito explícito para a chamada divergente.
A rotação em `POST /v1/workspaces/{workspaceId}/clients/{clientId}/credentials`
segue os mesmos invariantes: chamadas simultâneas idênticas criam uma única
credencial, aplicam o overlap uma única vez e divulgam somente um novo token.
Retry após resposta perdida devolve apenas metadados redigidos, e mudar o
overlap reutilizando a mesma chave é rejeitado como payload divergente.
A revogação em
`DELETE /v1/workspaces/{workspaceId}/clients/{clientId}/credentials/{credentialId}`
usa compare-and-set atômico. Chamadas simultâneas gravam um único `revokedAt`,
replays devolvem o mesmo estado e o bearer token deixa de autenticar assim que
a transição vence. Conflitos transitórios de escrita são repetidos até três
vezes.
A matriz de concorrência da API é verificada automaticamente contra o registry:
as 23 capabilities externas não-query precisam ter classificação explícita.
Vinte e um commands com escrita durável possuem evidência de simultaneidade e
resposta perdida, dois preflights são determinísticos e não fazem commit, e não
há lacuna de concorrência pendente no gate.

Endpoints e subscriptions de webhook possuem modelos duráveis separados, filtros
exatos pelo catálogo e referências opacas para secrets de assinatura. O núcleo de
challenge one-shot, HMAC sobre bytes exatos, timestamp e receipt anti-replay já é
durável e testado. O transporte interno do challenge resolve DNS a cada request,
rejeita qualquer endereço não público e prende a conexão HTTPS ao IP validado,
mantendo SNI e certificado do hostname. A API administrativa já permite listar e
ler endpoints e subscriptions em `GET /v1/webhooks/endpoints` e
`GET /v1/webhooks/subscriptions`, além das rotas individuais. Todas exigem
`webhooks:admin`, são isoladas por workspace e falham com 404 para recursos fora
do tenant. A URL completa nunca é devolvida: o contrato expõe somente a origem
HTTPS e seu fingerprint; secrets são apenas metadados de versão, fingerprint e
estado, sem `keyRef` ou material criptográfico. Os filtros exatos da subscription
são visíveis porque definem o comportamento contratado da entrega.

Novas subscriptions podem ser criadas por `POST /v1/webhooks/subscriptions`
para um endpoint existente. O command exige `Idempotency-Key`: repetir endpoint
e filtro idênticos com a mesma chave devolve o recurso original, enquanto reutilizar
a chave para outro filtro ou tentar duplicar o filtro com outra chave retorna
conflito explícito. A criação nasce ativa somente quando o endpoint está ativo;
endpoints ainda em challenge produzem uma subscription pendente.
Chamadas simultâneas com o mesmo endpoint e filtro convergem para uma única
subscription; resposta perdida pode ser repetida sem duplicação. Filtros
divergentes sob a mesma chave admitem somente um vencedor e retornam mismatch
para a chamada perdedora.

Endpoints também podem ser cadastrados por `POST /v1/webhooks/endpoints`,
informando somente a URL HTTPS e uma `Idempotency-Key`. Apollo gera o signing
secret internamente, persiste apenas seu envelope AES-256-GCM autenticado e
devolve metadados redigidos. O endpoint nasce pendente; sua ativação depende do
challenge explícito, que não é disparado silenciosamente durante o cadastro.
Cadastros simultâneos idênticos convergem para um endpoint, um secret e um
payload cifrado. Retry após resposta perdida recupera o mesmo recurso, enquanto
URLs divergentes sob a mesma chave produzem um único vencedor e conflito de
idempotência para a chamada perdedora.

Antes do challenge, o administrador deve provisionar a chave de verificação no
receptor por `POST /v1/webhooks/endpoints/{endpointId}/signing-secrets`, enviando
`baseRevision` e `Idempotency-Key`. A primeira resposta devolve
`secretBase64url` e `secretAvailable: true`; esse valor representa exatamente os
32 bytes da chave HMAC em Base64URL e deve ser transferido para o secret manager
do receptor sem entrar em logs. Replay da mesma requisição devolve os mesmos
metadados, mas nunca repete a chave (`secretAvailable: false`). Se a primeira
resposta for perdida, deve-se consultar a nova revisão do endpoint e provisionar
outra versão com uma nova chave idempotente. A versão anterior é aposentada na
mesma transação. Esse command só aceita endpoint ainda pendente.
Duas chamadas simultâneas idênticas também convergem: somente a vencedora recebe
`secretBase64url`; a concorrente recebe replay redigido. Quando a resposta
vencedora é perdida depois do commit, repetir a mesma chave confirma a versão
persistida, mas não reabre o material one-shot.

Para endpoint ativo, a rotação começa por
`POST /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations`, com
`baseRevision`, `overlapSeconds` e `Idempotency-Key`. Essa primeira fase prepara
e devolve a candidata uma única vez, mas mantém a chave atual assinando todas as
deliveries. O receptor pode instalar a candidata sem corrida com o tráfego em
curso. A preparação expira em 24 horas, somente uma pode ficar aberta por
endpoint e replay nunca repete `secretBase64url`. Depois que o receptor instalar
a candidata, o administrador confirma o corte por
`POST /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/activate`,
enviando a mesma `baseRevision`. O corte cria uma nova revisão, passa a assinar
somente com a candidata e mantém a versão anterior abrível apenas até
`overlapUntil`. O limite é exclusivo e não pode ser contornado pelo provider de
configuração legada. Repetir a ativação converge sem novo efeito ou segredo.
Uma preparação ainda não ativada pode ser descartada por
`POST /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/cancel`,
com a revisão original. O command destrói o envelope candidato, converge em
replay e também transforma preparo vencido em `expired`. Ele continua permitido
se o endpoint foi suspenso ou revogado, mas nunca desfaz uma rotação ativada.
O histórico redigido pode ser consultado por
`GET /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations`, com paginação
e filtro opcional de status, e o item exato por
`GET /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}`.
As respostas incluem lifecycle, fingerprint, overlap e revisão-base necessária
aos comandos, mas nunca retornam referências internas de chaves, IDs dos secrets
ou campos do envelope cifrado.
Material criptográfico que perdeu toda utilidade pode ser removido em lotes por
`POST /v1/webhooks/signing-secrets/hygiene`, com `limitPerKind`. A operação marca
preparos vencidos como `expired`, destrói seus envelopes e apaga payloads de
secrets revogados ou aposentados após o overlap. Metadados históricos permanecem
consultáveis, e a chave ativa nunca é candidata à higiene.
Chamadas simultâneas preservam o mesmo lifecycle: stage idempotente cria uma
única candidata e divulga o secret em apenas uma resposta; activate e cancel do
mesmo preparo têm um único vencedor; higienes concorrentes convergem sem contar
ou apagar o mesmo material duas vezes. Retry após perda de resposta nunca
recupera novamente um secret one-shot.

A ativação é solicitada por
`POST /v1/webhooks/endpoints/{endpointId}/challenge`, sem body. O Apollo faz um
POST HTTPS para a URL cadastrada com JSON canônico no formato
`{"type":"apollo.webhook.challenge","challengeId":"...","token":"...","expiresAt":"..."}`.
O receptor deve responder em até o timeout configurado, com status 200,
`Content-Type: application/json` e exatamente
`{"challengeId":"...","token":"..."}`, repetindo os dois valores recebidos e
sem campos extras. O hostname precisa resolver somente para endereços públicos,
ter certificado TLS válido e permanecer estável durante a conexão; IP privado,
loopback, redirect, resposta grande ou ambígua são rejeitados. Após a prova, o
endpoint e suas subscriptions pendentes ficam ativos atomicamente. Repetir o
command depois da ativação retorna sucesso com `replayed: true` sem nova chamada
externa; endpoints suspensos ou revogados não podem ser ativados.
Ativações simultâneas usam um lease durável separado da revisão pública do
endpoint: somente o líder emite o challenge e realiza o POST HTTPS, enquanto os
seguidores aguardam de forma limitada e convergem para o estado ativado. O lease
expira para permitir takeover após falha, usa token de fencing na verificação e é
removido pelo próprio líder em falha ou na mesma transação da ativação. Nenhuma
transação de banco permanece aberta durante a chamada de rede.

O status de uma subscription pode ser alterado por
`PUT /v1/webhooks/subscriptions/{subscriptionId}/status`. A resposta de consulta
fornece uma revisão opaca que deve ser enviada como `baseRevision`: alterações
concorrentes retornam conflito, enquanto repetir o mesmo estado converge sem
novo efeito. Subscriptions ativas podem ser pausadas ou revogadas; pausadas podem
ser retomadas somente se o endpoint estiver ativo; revogação é terminal.

O endpoint usa o mesmo modelo em
`PUT /v1/webhooks/endpoints/{endpointId}/status`. Suspender o endpoint pausa
atomicamente suas subscriptions ativas; retomá-lo não as religa automaticamente.
Revogar é terminal e revoga, na mesma transação, todas as subscriptions ainda
abertas e o signing secret ativo. A resposta informa os totais afetados sem
expor URL completa ou referência do secret.
Nos dois endpoints de status, requests simultâneos para o mesmo estado
convergem após até três retries de conflito serializável. Se os estados pedidos
forem diferentes, somente a revisão vencedora é aceita; a outra chamada recebe
conflito de revisão. Repetir o mesmo estado após perder a resposta recupera o
recurso persistido sem repetir cascatas.

Deliveries terminais podem ser reabertas de forma idempotente pela API externa,
individualmente ou por um event ID exato. O replay por evento avalia no máximo
100 deliveries, informa separadamente itens reagendados e ignorados e preserva
todo o histórico de attempts; replay por intervalo continua reservado para uma
operação durável com preflight.

O replay individual de delivery é serializável. Chamadas simultâneas com a
mesma chave ampliam o limite de tentativas apenas uma vez e devolvem o mesmo
diagnóstico. Se a resposta 202 for perdida, o retry recupera esse diagnóstico
sem reabrir novamente a delivery nem consumir outra tentativa permitida.
O replay por evento segue a mesma regra para o lote inteiro: o snapshot de itens
agendados ou ignorados é persistido uma vez, replays concorrentes devolvem o
mesmo lote e uma resposta perdida não reavalia nem reagenda as deliveries.

O worker de entrega pode ser iniciado com `npm run worker:v2:webhook`. Ele exige
Postgres e a chave mestra de payload protegido no ambiente de produção. Secrets
gerados pelo cadastro público são abertos diretamente do envelope cifrado no
banco. `APOLLO_V2_WEBHOOK_SIGNING_SECRETS_JSON` permanece como fallback opcional
para endpoints legados, com entradas no formato abaixo:

```json
[{"workspaceId":"workspace-1","endpointId":"00000000-0000-4000-8000-000000000001","keyRef":"vault://apollo/workspaces/workspace-1/webhooks/key-1","version":1,"secretBase64url":"<secret-base64url-de-32-bytes-ou-mais>"}]
```

O catálogo deve ser injetado pelo secret manager da plataforma e nunca
versionado. O adapter exige correspondência exata de workspace, endpoint,
referência e versão, enquanto o dispatcher ainda confere o fingerprint antes de
assinar. Réplicas do mesmo `APOLLO_V2_WEBHOOK_POOL_ID` disputam leases duráveis
e recebem automaticamente um dos slots definidos por
`APOLLO_V2_WEBHOOK_SHARD_COUNT`; não existe mais índice manual. Ritmo, lease e
failover usam `APOLLO_V2_WEBHOOK_SCAN_LIMIT`, `APOLLO_V2_WEBHOOK_POLL_MS`,
`APOLLO_V2_WEBHOOK_SHARD_LEASE_MS`, `APOLLO_V2_WEBHOOK_SHARD_HEARTBEAT_MS` e
`APOLLO_V2_WEBHOOK_SHARD_RETRY_MS`.

## Formatos

- **Vertical (9:16)** — Shorts, Reels, TikTok
- **Horizontal (16:9)** — YouTube

## Custo por vídeo

~R$0,13 a R$0,50 (transcrição + análise IA)

## Instruções para Claude Code

O arquivo `CLAUDE.md` contém todas as regras que o Claude Code deve seguir ao trabalhar neste projeto. Abra a pasta no Claude Code e ele lerá automaticamente.
