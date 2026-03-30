# Video Editor IA — Instruções para Claude Code

## LEIA ISSO ANTES DE QUALQUER AÇÃO

Este é um editor de vídeo automático com IA. Ele recebe vídeo bruto, transcreve, corta silêncios, gera cenas visuais e renderiza o resultado final com Remotion.

O projeto já tem código funcional. Sua função é: corrigir erros, completar funcionalidades, e evoluir o sistema seguindo TODAS as regras abaixo.

---

## REGRAS INVIOLÁVEIS

### 1. VERSÕES FIXAS — Nunca atualize
```
Next.js        14.2.21
React          18.3.1
Remotion       4.0.434
@remotion/cli  4.0.434
@remotion/player 4.0.434
@remotion/renderer 4.0.434
```
Atualizar o Remotion QUEBRA o projeto. Se surgir erro de dependência, resolva sem mudar versão.

### 2. SISTEMA DE TIMING — startLeg (a regra mais importante)
- A IA (Claude API) NUNCA calcula frames diretamente
- As legendas da transcrição são numeradas: 0, 1, 2, 3...
- O Claude API retorna apenas o ÍNDICE da legenda onde cada cena começa (campo `startLeg`)
- A função `convertStartLegToFrame()` em `src/lib/utils/timing.ts` converte índice → frame exato
- Se você mudar essa lógica, as cenas vão dessincronizar da fala. NÃO MUDE.

### 3. NORMALIZAÇÃO OBRIGATÓRIA
- Todo vídeo bruto DEVE ser convertido para H.264, 30fps CFR, keyframe a cada 1s ANTES de qualquer processamento
- Sem isso, legendas descasam do áudio em vídeos longos
- Função: `normalizeVideo()` em `src/lib/services/ffmpeg.ts`

### 4. RECÁLCULO DE TIMESTAMPS APÓS CORTE
- Quando um silêncio é cortado, TODO conteúdo posterior se desloca para trás
- Esse recálculo é feito pelo CÓDIGO (aritmética), NUNCA pela IA
- Função: `recalculateTimingsAfterSilenceCut()` em `src/lib/utils/timing.ts`

### 5. DOIS PROJETOS SEPARADOS
- `src/` → Next.js (interface + API)
- `remotion/` → Remotion isolado (composições de vídeo)
- NUNCA misture dependências do Remotion no Next.js nem vice-versa
- Next.js roda na porta 3333
- Remotion roda na porta 3001

---

## ARQUITETURA

### Pipeline (6 etapas, nesta ordem)
```
Upload → Normalização → Transcrição → Análise → Revisão → Render
```

1. **Upload**: recebe MP4, detecta formato (9:16 ou 16:9) pelo aspect ratio
2. **Normalização**: FFmpeg converte para H.264, 30fps, keyframe 1s
3. **Transcrição**: Whisper API (verbose_json com word timestamps) + detecção de silêncios (FFmpeg silencedetect, threshold 0.8s)
4. **Análise**: Claude API recebe transcrição + lista de legendas numeradas → retorna cenas com startLeg
5. **Revisão**: preview com @remotion/player, edição de cenas, refinamento com IA
6. **Render**: Remotion renderiza MP4 final

### Formatos suportados
- **Vertical 9:16** (1080x1920): Shorts, Reels, TikTok — legendas TikTok-style (palavra-por-palavra)
- **Horizontal 16:9** (1920x1080): YouTube — legendas standard

### 10 Tipos de Cena
| ID | Tipo | Uso |
|----|------|-----|
| A | FullScreen | Frase de impacto em tela cheia |
| B | LowerThird | Rosto + texto embaixo |
| C+ | Split | Painel acima + rosto abaixo |
| D | SplitVertical | Comparativo lado a lado |
| E | Card | Card numerado com ícone |
| F | Message | Mensagem estilo WhatsApp |
| G | Number | Número/métrica animada |
| H | Flow | Fluxo de passos vertical |
| I | CTA | Call to action pulsante |
| J | StickFigures | Figuras de palito animadas |

### Camadas do vídeo final (sanduíche)
1. **Baixo**: vídeo original com silêncios cortados
2. **Meio**: cenas visuais com animações spring
3. **Cima**: legendas sincronizadas

---

## ESTRUTURA DE PASTAS

```
├── src/
│   ├── app/
│   │   ├── layout.tsx            # Root layout (dark theme, Sora font)
│   │   ├── page.tsx              # Dashboard (upload + lista de projetos)
│   │   ├── globals.css           # Estilos globais
│   │   ├── project/[id]/page.tsx # Editor principal
│   │   └── api/
│   │       ├── upload/route.ts
│   │       ├── projects/route.ts
│   │       ├── process/
│   │       │   ├── normalize/route.ts
│   │       │   ├── transcribe/route.ts
│   │       │   ├── analyze/route.ts
│   │       │   ├── render/route.ts
│   │       │   └── status/[id]/route.ts
│   │       ├── scenes/refine/route.ts
│   │       └── video/[id]/route.ts
│   ├── lib/
│   │   ├── db.ts                 # Prisma client singleton
│   │   ├── services/
│   │   │   ├── ffmpeg.ts         # Normalização + silêncios
│   │   │   ├── whisper.ts        # Transcrição OpenAI
│   │   │   └── claude.ts         # Análise de cenas
│   │   ├── types/
│   │   │   ├── project.ts        # Tipos de projeto
│   │   │   ├── scene.ts          # Tipos de cena
│   │   │   └── timing.ts         # Constantes de timing
│   │   └── utils/
│   │       ├── timing.ts         # startLeg → frame (CRÍTICO)
│   │       └── silence.ts        # Parse silêncios + gerar subtítulos
│   └── components/               # (criar conforme necessário)
├── remotion/
│   ├── src/
│   │   ├── Root.tsx              # Composições registradas
│   │   ├── VideoComposition.tsx  # Composição principal
│   │   ├── components/
│   │   │   ├── SubtitleTikTok.tsx
│   │   │   ├── SubtitleStandard.tsx
│   │   │   └── SubtitleOverlay.tsx
│   │   ├── scenes/               # 10 componentes de cena
│   │   └── lib/
│   │       ├── constants.ts
│   │       └── types.ts
│   ├── package.json
│   └── remotion.config.ts
├── prisma/schema.prisma
├── package.json
└── .env.local
```

---

## DESIGN

- Tema escuro: fundo #050508, cards #0a0a0f
- Acentos dourados: #FFB800
- Glass morphism: backdrop-blur + bordas translúcidas
- Fonte: Sora (Google Fonts) pesos 400/600/700/800
- Animações suaves, transições de 200-300ms

---

## COMANDOS

```bash
# Instalar dependências
npm install
cd remotion && npm install && cd ..

# Configurar banco
npx prisma db push

# Rodar Next.js (porta 3333)
npm run dev

# Rodar Remotion Studio (porta 3001) — em outro terminal
npm run remotion:dev

# Criar pastas necessárias
mkdir -p uploads renders
```

---

## VARIÁVEIS DE AMBIENTE (.env.local)

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_API_KEY=sk-ant-...
WAVESPEED_API_KEY=...
NEXT_PUBLIC_APP_URL=http://localhost:3333
```

---

## QUANDO CORRIGIR ERROS

1. Se der erro de import: verifique se o arquivo está no caminho correto conforme a estrutura acima
2. Se der erro de tipo: verifique os tipos em `src/lib/types/`
3. Se der erro de Prisma: rode `npx prisma db push` e `npx prisma generate`
4. Se legendas ficarem fora de sincronia: o problema é no timing — verifique `src/lib/utils/timing.ts`
5. Se o Remotion não renderizar: verifique se a versão é exatamente 4.0.434
6. Se o FFmpeg falhar: verifique se está instalado globalmente (`ffmpeg -version`)
7. NUNCA resolva erros atualizando versões de pacotes

---

## O QUE NÃO FAZER

- NÃO atualize versões de pacotes
- NÃO mude a lógica do startLeg
- NÃO peça para a IA calcular frames — use índices de legenda
- NÃO misture código do Remotion com código do Next.js
- NÃO pule a etapa de normalização
- NÃO faça recálculo de timestamps com IA — use código aritmético
- NÃO use `npm install pacote@latest` — use as versões fixas definidas
