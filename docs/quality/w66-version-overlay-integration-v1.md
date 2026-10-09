# W66 — integração proposta do crop manual por variante

Status: desenho, sem implementação de persistência ou aceite visual. A operação automática de reframe continua em `review-required`; crop manual é preferência editorial, não evidência de rosto seguro.

## Identidade e hash

`variant-reframe-overrides/v1` já valida o Command de cada override, formato, source artifact/SHA, FPS, mapa de origem e ranges. Seu `variantId` atual é, na verdade, um **formato de saída** (`OutputAspectRatio`); a identidade de uma variante renderizável é distinta. Antes de persistir, versionar o set como `variant-reframe-overrides/v2`: cada override terá `variantId` real e `outputFormat` separados. O contexto autenticado da operação/snapshot resolve e vincula ambos; o caller não declara proveniência ou observação facial. Duas variantes reais com o mesmo formato devem continuar independentes, inclusive em Command, herança, invalidação e RenderInput. O parser v1 permanece apenas para leitura histórica, sem alimentar o runtime novo.

Proposta de persistência: estado imutável `V2VariantReframeState`, discriminado em `active-set` ou `invalidated`. O set ativo contém o documento e `contentHash`; a invalidação contém o hash do set anterior, mapa antigo/novo e razão revisável. A versão contém `overlayStateHash` e `reframeStateId`; seu `baseHash` novo é hash versionado do hash base calculado pelo Command mais esse estado. O corpo do estado não contém `baseHash`, evitando ciclo de hashes. O estado guarda `resultVersionId` pré-alocado como valor escopado **sem FK reversa**; Version usa FK composta `(id, reframeStateId)` → State `(resultVersionId, id)`, além do escopo workspace/project. Isso permite inserir State e depois Version na mesma transação, sem Version nula nem UPDATE posterior. É preciso confirmar no Prisma a relação composta e criar a migration SQL correspondente, com teste de bootstrap PostgreSQL real. A integridade da associação é garantida pelo FK da Version; um State órfão eventualmente inserido isoladamente não pode ser lido/publicado como versão, e o repositório só grava ambos dentro da transação. Version histórica continua legível com seu contrato antigo; a fórmula nova deve ser explicitamente versionada. A alternativa de FKs nas duas direções exige deferral testado e aumenta o custo operacional sem melhorar a leitura canônica.

O fingerprint de idempotência vincula baseVersionId/baseHash, ator autenticado, ação, variante/formato e payload antes de gerar IDs ou consultar o relógio. IDs prealocados de Command, versão e estado podem entrar no corpo persistido sem entrar nesse fingerprint. Replay compara fingerprint, ator e conteúdo já persistido; não reavalia crop nem troca a versão.

## Política de transição

Um helper puro recebe o estado da **versão pai exata**, EditPlan e source map do pai e do filho, Command e resultVersionId. Retorna `none`, `inherited-set`, `new-set` ou `invalidated` com hashes canônicos. A herança usa uma **projeção geométrica versionada**, não igualdade integral do EditPlan. Para o proxy FFmpeg atual, a projeção `variant-reframe-geometry/v1` deve conter:

- `fps`, `durationFrames`, `outputFormat` e a identidade da variante real resolvida do detail/snapshot;
- um único track `base-video` com sua identidade e **ordem** de clips, pois o renderer concatena nessa ordem; para cada clip: `id`, `sourceArtifactId`, SHA-256 e manifest de fonte resolvidos, `sourceInFrame`, `sourceOutFrame`, `timelineInFrame`, `timelineOutFrame` e `rate`;
- largura, altura, FPS e orientação **observados** do vídeo de cada fonte, mais os campos de composição recebidos pelo renderer atual (`foregroundScale`, `verticalPosition`, incluindo a distinção entre ausente e presente);
- a presença e conteúdo de `clip.crop` histórico. No caminho novo, crop global deve ser rejeitado em vez de competir com o overlay por variante.

Essa lista decorre de `src/v2/application/run-project-proxy-render-worker.ts` (seleção do primeiro track `base-video`, extração de clips/composition/transitions e input do renderer), `src/v2/application/ports/editorial-proxy-renderer.ts` (`EditorialCutClip` e os dois campos de `composition`) e `src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts` (seek por `sourceInFrame`/FPS, trim, rate, concat na ordem dos clips, crop e composição). Hoje `transitions` afeta os fades **de áudio** nesse renderer, não o crop visual; a ordem e os spans dos clips já capturam a mudança visual de seam. `audioSource*`, câmera para ColorPlan, texto/cues, estilo, CTA, LUT e cor não entram na projeção geométrica. Campos `layout` ou `background` do EditPlan não são consumidos como controles de geometria por esse port atual e não serão incluídos por suposição. Se qualquer compiler, snapshot ou renderer posterior transformar vídeo usando outro campo, a projeção v1 não pode autorizar herança nesse caminho: documentar o campo, versionar a projeção e invalidar ou bloquear antes de persistir. Orientação/FPS/dimensões ausentes ou contraditórios também bloqueiam herança; não inferir orientação zero nem FPS da timeline. O `sourceMapHash` v1 atual ordena clips por ID e, sozinho, não detecta mudança de ordem: não serve como essa projeção. O helper conserva o `commandId` original em cada override herdado. Crop novo substitui apenas range exato da mesma variante real e clip; sobreposição parcial é conflito explícito. Alteração de fonte/tempo/geometria produz estado `invalidated` e issue de revisão persistida, nunca desaparecimento silencioso.

Um helper Prisma recebe `Prisma.TransactionClient`, lê o pai e estado com escopo e lock/CAS, compara hashes, grava o filho e verifica o `overlayStateHash` e `baseHash` declarados. Todo writer de ProjectVersion com pai que possua estado ativo deve fornecer uma transição; omissão falha a transação. O render lê somente estado da versão exata, verifica FK/hash, variante→formato, EditPlan/source map e rights atuais, e inclui o hash no RenderInput/recipe/manifest. Estado invalidado não gera crop seguro; mantém issue/review. Sem busca por ancestral.

## Matriz de writers

Há 15 chamadas de `createProjectVersion` em `src/v2/application` e 16 repositórios com `v2ProjectVersion.create`. `createProjectVersion` apenas valida/congela; não há helper único de baseHash, herança ou commit. A política abaixo é determinada por comparação dos mapas, não pelo nome do Command.

| Producer | Repositório de gravação | Política quando o pai tem overlay |
| --- | --- | --- |
| `create-project.ts` | `project-creation-repository.ts` | Versão raiz sem herança. |
| `run-media-ingest-worker.ts` | `project-media-repository.ts` | Plano inicial: sem herança; versões derivadas revalidam mapa. |
| `duplicate-project.ts` | `project-duplication-repository.ts` | Novo projeto não herda identidade; invalidação explícita se o clone solicitar o estado. |
| `manual-edit.ts` | `manual-edit-repository.ts` | Crop cria/substitui set; select/inspect/undo/redo/restore preservam só sob mapa igual, senão invalidam. |
| `apply-editorial-cut-command.ts` | `editorial-command-repository.ts` | Cortes normalmente mudam mapa; comparar e invalidar se mudou. |
| `run-project-director.ts` | `director-run-repository.ts` | Comparar mapa dirigido ao pai; invalidar se alterado. |
| `multicam-direction.ts` | `multicam-direction-command-repository.ts` | Comparar fontes e mapa; invalidar se alterados. |
| `replace-source-transcript.ts` | `source-transcript-replacement-repository.ts` | Preservar só se source map e EditPlan estrutural iguais. |
| `review-patch.ts` | `review-patch-repository.ts` | Preservar só se mapa igual; edição temporal invalida. |
| `review-patch-batch.ts` | `review-patch-batch-repository.ts` | Mesma política do patch, de forma atômica. |
| `project-policy-overrides.ts` | `project-policy-overrides-repository.ts` | Preservar sob mapa igual. |
| `project-lut-selections.ts` | `project-lut-selection-repository.ts` | LUT não prova mudança de geometria; comparar mapa, preservar só se igual. |
| `project-color-plans.ts` | `project-color-plan-repository.ts` | Preservar sob mapa igual. |
| `project-subtitle-configurations.ts` | `project-subtitle-configuration-repository.ts` | Preservar sob mapa igual; necessário para W68. |
| `subtitle-segment-overrides.ts` | `subtitle-segment-override-repository.ts` | Preservar sob mapa igual; necessário para W68. |

O 16º repositório com inserção direta, `media-library-repository.ts`, não usa `createProjectVersion` na aplicação: seleção/anexo de asset deve comparar o mapa e preservar ou invalidar explicitamente. Nenhum writer pode herdar por `project.format` quando a operação real tem variante/formato próprios. Os leitores/hidratações de ProjectVersion nesses repositórios também precisam entender o campo versionado; os contratos públicos devem preservar schemas históricos e declarar a nova forma antes do baseline.

## Provas mínimas antes de afirmar integração

- Command de crop por variante: commit atômico de snapshot/set/Version/outbox, baseHash e fingerprint; replay exato e conflito de ator/payload.
- Command seguinte de legenda ou cor com projeção geométrica idêntica herda crop e preserva provenance Command original; crop de outra variante não muda mesmo se ambas tiverem `outputFormat` igual. Source FPS 30→24 ou source SHA/frame map diferente gera issue persistida e não aplica o crop.
- Writer posterior sem política recebe rejeição transacional, nunca uma versão que omite overlay silenciosamente.
- Rights revogados, set/hash adulterado, version/variant/formato divergentes, range sobreposto e rollback no meio do commit falham fechados.
- PG real confirma a FK composta e a ordem atômica escolhida (ou deferral, somente se essa alternativa for adotada), concorrência CAS e replay. Renderer real demonstra crop só na variante/range solicitados e mede pixels; inspeção final de MP4 e critic facial continuam gates separados.
