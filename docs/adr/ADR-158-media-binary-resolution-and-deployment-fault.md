# ADR-158 — O binário de mídia é resolvido em quatro passos, e binário ausente é falha de implantação

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** Wave 20, correção de infraestrutura
- **Relacionado:** [ADR-001](ADR-001-v2-modular-architecture.md), [ADR-122](ADR-122-manual-edit-and-proxy-first-render.md), `docs/specs/09-external-api-and-automation.md` §10

## Contexto

`ffmpeg-static` responde `path.join(__dirname, 'ffmpeg.exe')`. Isso está certo
quando o módulo é carregado de `node_modules`, e errado no instante em que um
bundler reescreve `__dirname`: sob `next build` o módulo cai em
`.next/server/chunks`, então todo provider do servidor construído aponta para
`.next/server/chunks/ffmpeg.exe`, que não existe (`ffmpeg-binary.ts:9-21`).

Nada dizia isso. O spawn falhava, o provider reportava um render que não pôde
ser executado, e o envelope público respondia **422 `RENDER_EXECUTION_FAILED`**
— uma frase sobre o render para uma falha da implantação. A jornada de navegador
da Wave 20 só passou desse ponto porque nomeou `FFMPEG_BIN` no ambiente do
servidor, o que conserta um teste e nenhuma implantação.

A documentação era pior que silenciosa. A única linha do conjunto que falava de
resolução de binário — `ADR-001`, "runtime baseline da Fundação" — descrevia uma
precedência de três passos que não existe mais, sem as variáveis `APOLLO_*`, sem
o aviso de que o caminho empacotado é inválido dentro de um bundle e sem
obrigação nenhuma de implantação.

## Decisão

**O caminho é decidido num lugar só, em quatro passos** (`resolveMediaBinary`,
`ffmpeg-binary.ts:197-225`):

1. **O que a implantação disse**, verbatim: primeiro uma opção de construtor,
   depois as variáveis, na ordem em que ganham. Para ffmpeg,
   `FFMPEG_PATH_ENVIRONMENT_VARIABLES` = `APOLLO_V2_FFMPEG_PATH`, `FFMPEG_PATH`,
   `APOLLO_FFMPEG_PATH`, `FFMPEG_BIN`; para ffprobe,
   `FFPROBE_PATH_ENVIRONMENT_VARIABLES` = `APOLLO_V2_FFPROBE_PATH`,
   `FFPROBE_PATH`. Tomado sem conferir, de propósito: quem nomeia um caminho tem
   direito ao erro de spawn daquele caminho, e as suítes que apontam o ffmpeg
   para `process.execPath` para ver um provider falhar dependem disso.
2. **O binário empacotado, se estiver em disco.** A resposta do `*-static` é
   correta fora de um bundle e conferível dentro dele, então ela é conferida em
   vez de confiada.
3. **Uma resolução que sobrevive ao bundling:** `node_modules/<pacote>/…`
   procurado a partir do diretório de trabalho e da localização do próprio
   módulo, subindo ancestrais como a resolução do Node faz. O diretório de
   trabalho vem primeiro, e essa ordem foi medida e não suposta: no `next build`
   deste repositório o webpack congelou `import.meta.url` dentro do chunk como o
   caminho de origem da máquina de build (`ffmpeg-binary.ts:98-113`).
4. **`PATH`.** Um contêiner que instalou o ffmpeg pelo gerenciador de pacotes
   tem binário real e nenhum `node_modules`. A entrada é encontrada no `PATH` e
   nomeada de forma absoluta, ou não é encontrada — o código antigo cobria esse
   caso devolvendo o nome nu `'ffmpeg'` e torcendo.

**Não achar é recusa nomeada, não palpite.** `PERSISTENCE_NOT_CONFIGURED`, com
`details.binary`, `details.variables`, `details.bundled` e `details.searched`
(`ffmpeg-binary.ts:212-224`). Para `ffprobe`, e só para ele, o nome nu continua
sendo o último recurso quando o chamador não pede o contrário com
`fallback: null`, porque todo chamador existente foi escrito contra um
resolvedor que nunca lançava.

**Todo spawn de ffmpeg e ffprobe em `src/` passa por aqui**, e isso é
estrutural: `tests/v2/ffmpeg-binary-resolution.test.mjs` recusa um provider que
importe `ffmpeg-static` direto, que é a única forma de trazer o defeito de
volta.

**`PERSISTENCE_NOT_CONFIGURED` deixou de ser retryable.** O commit `2b84067e`
tirou o código do grupo 503 retryable para um grupo próprio, `retryable: false`
(`public-error-catalog.ts:256-267`), e o presenter passou a publicar
`details.binary` e `details.variables` (`error-presenter.ts:136-146`).
`details.searched` fica no servidor: listagem de diretório do disco do servidor
não é assunto do chamador. `AUTH_NOT_CONFIGURED` e `INVALID_CAPABILITY_POLICY`
seguem com a resposta do grupo que dividiam — é um código que se moveu, não uma
classe.

## A obrigação de implantação

**Uma implantação tem de tornar o ffmpeg alcançável, e ela é que decide como.**
Ou o binário existe em `node_modules/ffmpeg-static/` a partir de algum ancestral
do diretório de trabalho do servidor, ou existe no `PATH`, ou uma das variáveis
acima o nomeia. Sob `next build`, o caminho que o próprio `ffmpeg-static`
calcula **não** é uma dessas opções.

Isso não foi verificado contra uma implantação, porque não há nenhuma. O que foi
medido é o resolvedor: `tests/v2/ffmpeg-binary-resolution.test.mjs`, 8 testes, 8
passes, 983,4 ms nesta máquina em 2026-09-06 — incluindo um caso que aponta a
busca para um diretório montado como `.next/server/chunks` e observa a subida
até uma instalação real, e outro que confirma que o resolvedor devolve um
binário que esta máquina consegue executar.

## Consequências

**O que melhora.** Uma falha de implantação é respondida como falha de
implantação: 503, `retryable: false`, com o nome do executável que falta e a
variável que o nomearia. Antes era 422 sobre o render, ou 503 "The request could
not be completed" com `retryable: true` — um servidor sem ffmpeg mandando todo
chamador voltar para ser recusado de novo, igual.

**O que piora.** São seis variáveis de ambiente publicadas em vez de duas, com
ordem que quem escreve manifesto de implantação precisa respeitar. E a subida em
ancestrais custa um `statSync` por ancestral na primeira resolução de cada
binário.

**O que fica em aberto.** O `ffprobe` ainda pode devolver o nome nu e, portanto,
ainda pode falhar tarde e como erro de outra pessoa, nos chamadores que não
passam `fallback: null`. Ficou assim porque transformar essa resolução em recusa
é uma mudança de comportamento que este conserto não mediu. E "binário ausente"
não ganhou código de erro próprio: o contrato público recusa acrescentar valor a
um enum já publicado sem um ref novo, o que faria disso um `error-envelope/v5` e
arrastaria toda operação que referencia o v4.
