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

## Worker de render v2

Renders solicitados pela API pública permanecem em uma operação durável e são
executados fora do processo web:

```bash
npm run worker:v2:render
```

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
Operações do workspace podem ser descobertas por `GET /v1/operations`, usando
`limit`, cursor `after` e filtros exatos de `status`, `type` e `targetId`. O
cursor é opaco, estável e só pode continuar a mesma combinação de workspace e
filtros que o originou.

## Formatos

- **Vertical (9:16)** — Shorts, Reels, TikTok
- **Horizontal (16:9)** — YouTube

## Custo por vídeo

~R$0,13 a R$0,50 (transcrição + análise IA)

## Instruções para Claude Code

O arquivo `CLAUDE.md` contém todas as regras que o Claude Code deve seguir ao trabalhar neste projeto. Abra a pasta no Claude Code e ele lerá automaticamente.
