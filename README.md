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

## Formatos

- **Vertical (9:16)** — Shorts, Reels, TikTok
- **Horizontal (16:9)** — YouTube

## Custo por vídeo

~R$0,13 a R$0,50 (transcrição + análise IA)

## Instruções para Claude Code

O arquivo `CLAUDE.md` contém todas as regras que o Claude Code deve seguir ao trabalhar neste projeto. Abra a pasta no Claude Code e ele lerá automaticamente.
