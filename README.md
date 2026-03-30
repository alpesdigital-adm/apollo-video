# Apollo Video — Editor de Vídeo Automático com IA

Editor de vídeo local que automatiza a edição usando IA. Recebe vídeo bruto, transcreve, corta silêncios, gera cenas visuais sincronizadas e renderiza o resultado final.

## Stack

- **Next.js 14** — Interface e API
- **Remotion 4.0.434** — Renderização programática de vídeo
- **Whisper API** (OpenAI) — Transcrição com timestamps
- **Claude API** (Anthropic) — Análise de conteúdo e cenas
- **FFmpeg** — Normalização e processamento de áudio/vídeo
- **Prisma + SQLite** — Persistência local

## Pipeline

```
Upload → Normalização → Transcrição → Análise IA → Revisão → Render
```

## Setup

### Pré-requisitos

- Node.js v20+
- FFmpeg instalado globalmente
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

## Formatos

- **Vertical (9:16)** — Shorts, Reels, TikTok
- **Horizontal (16:9)** — YouTube

## Custo por vídeo

~R$0,13 a R$0,50 (transcrição + análise IA)

## Instruções para Claude Code

O arquivo `CLAUDE.md` contém todas as regras que o Claude Code deve seguir ao trabalhar neste projeto. Abra a pasta no Claude Code e ele lerá automaticamente.
