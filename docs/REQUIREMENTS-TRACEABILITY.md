# Apollo v2 — Matriz de rastreabilidade

> **Fonte:** PRD v1.2  
> **Objetivo:** garantir que cada requisito tenha fase, spec, dependência, evidência de aceite e teste.

## Legenda

- **F0:** Fundação.
- **F1:** MVP Core.
- **F2:** Lotes/reuso/formatos.
- **F3:** Sintético/transformação.
- **F4:** Multicâmera/long-form avançado.
- **F5:** Localização/áudio.
- **S1:** Diretor/qualidade.
- **S2:** EditPlan/versionamento.
- **S3:** Biblioteca de mídia.
- **S4:** Lotes/compatibilidade.
- **S5:** Multicâmera.
- **S6:** Providers sintéticos.
- **S7:** UX/editor.
- **S8:** Localização/áudio.
- **S9:** API externa/automação.
- **D0:** domínio/banco; **D1:** mídia/storage; **D2:** Director/perception; **D3:** EditPlan/Commands; **D4:** jobs/providers; **D5:** renderer; **D6:** UI; **D7:** rights/policy; **D8:** sync; **D9:** localization/audio.
- **D10:** public API, autenticação externa, eventos e automação.

Cada teste recebe ID `T-<FR>` no test plan da fase.

## F0 — Fundação

| Req | Título | Spec | Dep. | Evidência de aceite | Teste |
|---|---|---|---|---|---|
| FR-001 | Workspace | S7 | D0,D7 | isolamento e settings persistidos | integration/e2e |
| FR-020 | Brand Kit opcional | S7 | D0,D1 | kit vazio e configurado resolvem corretamente | integration |
| FR-022 | Guardrails estruturados | S1 | D0,D7 | policies compiladas e aplicadas | policy |
| FR-023 | Precedência | S1 | D7 | conflitos resolvidos na ordem definida | unit/policy |
| FR-024 | Policy Snapshot | S2 | D0,D3,D7 | versão mantém snapshot imutável | integration |
| FR-031 | Masters imutáveis | S3 | D1 | derivado não sobrescreve master | integration |
| FR-032 | Content addressing e deduplicação | S3 | D1 | upload repetido reutiliza checksum | integration |
| FR-033 | Normalização com lineage | S3 | D1,D4 | derivado aponta para parent/recipe | integration |
| FR-034 | Preservação de timebase | S5 | D1,D8 | PTS/timebase persistem antes do normalize | fixture |
| FR-035 | Direitos | S3 | D0,D7 | unknown/restricted bloqueiam usos proibidos | policy |
| FR-041 | Tipos de ativos | S3 | D0,D1 | schemas aceitam todos os kinds | schema |
| FR-070 | EditPlan versionado | S2 | D0,D3 | schemaVersion e migration obrigatórios | unit/migration |
| FR-071 | Tracks | S2 | D3 | tracks compilam sem acesso ao banco | golden |
| FR-072 | Source ranges | S2 | D1,D3 | source↔timeline preserva frames | property |
| FR-073 | Múltiplas fontes | S2 | D1,D3 | plano referencia N sources | integration |
| FR-074 | Commands/Patches | S2 | D0,D3 | user/IA geram mesma transação | integration |
| FR-075 | Protected elements | S2 | D3,D7 | Director não altera protected | policy |
| FR-076 | Dependency graph | S2 | D0,D3,D4 | invalidation set é determinístico | unit |
| FR-161 | OutputSpec | S2 | D0,D3 | ratio/resolução/safe area separados | schema |
| FR-162 | Plano canônico e variantes | S2 | D3 | story compartilhada, layouts isolados | integration |
| FR-220 | ProjectVersion | S2 | D0,D3 | toda mudança cria versão | integration |
| FR-221 | Fork copy-on-write | S2 | D0,D1,D3 | fork não duplica masters | integration |
| FR-222 | Isolamento | S2 | D0,D3 | fork não altera original/status externo | e2e |
| FR-223 | Diff e restore | S2 | D3 | diff semântico e restore auditável | integration |
| FR-224 | Artifact lineage | S2,S3 | D0,D1,D3 | render rastreia inputs/jobs | integration |
| FR-232 | Durable jobs | S6 | D4 | restart retoma job idempotente | resilience |
| FR-233 | Partial invalidation | S2 | D3,D4 | mudança local enfileira só dependentes | integration |
| FR-234 | Props/manifest | S2 | D3,D5 | manifest reproduz RenderInput | golden |
| FR-236 | Estados | S7 | D0,D4,D6 | transições válidas e visíveis | state/e2e |
| FR-240 | Paridade API-first | S9 | D0,D3,D4,D10 | toda ação da UI, inclusive login/sessão/logout, possui capability e contrato externo sobre o mesmo domínio | contract/e2e |
| FR-241 | Contrato público e descoberta | S9 | D0,D10 | OpenAPI/schemas/versionamento/capabilities publicados | contract/schema |
| FR-242 | Clients, autenticação e escopos | S9 | D0,D7,D10 | sessão humana usa cookie seguro; client revogável usa Bearer e só acessa workspace/scope autorizado; senha nunca vira tool | security/e2e |
| FR-243 | Operações assíncronas | S9 | D4,D10 | job externo acompanha status/result/error/cancel/retry | resilience/contract |
| FR-244 | Webhooks e eventos | S9 | D4,D10 | entrega assinada, deduplicável e recuperável | integration/resilience |
| FR-245 | Idempotência e concorrência externa | S2,S9 | D3,D10 | repetição não duplica e conflito não sobrescreve | property/integration |
| FR-246 | Interface para agentes de IA | S1,S9 | D2,D7,D10 | tools/MCP respeitam schemas, scopes e policies | contract/policy |
| FR-247 | Transferência externa de mídia | S3,S9 | D1,D7,D10 | upload/download resumível sem expor storage interno | security/e2e |
| FR-248 | Preflight e lote externo | S4,S9 | D2,D3,D4,D10 | dry-run prevê impacto/custo e retry é parcial | e2e |
| FR-249 | Governança da API | S7,S9 | D0,D6,D7,D10 | clients/scopes/quotas/webhooks/usage/audit administráveis | security/e2e |

## F1 — MVP Core

| Req | Título | Spec | Dep. | Evidência de aceite | Teste |
|---|---|---|---|---|---|
| FR-002 | Dashboard de projetos | S7 | D0,D4,D6 | cards/progresso refletem jobs reais | e2e |
| FR-003 | Busca e filtros | S7 | D0,D6 | filtros combinados retornam projetos | integration |
| FR-004 | Ações rápidas | S7 | D0,D3,D6 | abrir/revisar/duplicar/arquivar funcionam | e2e |
| FR-010 | Objetivo estratégico | S1 | D0,D2,D6 | rubrica correta entra no DirectorRun | integration |
| FR-011 | Ação desejada | S1 | D0,D2 | CTA/destino persistidos e validados | policy |
| FR-012 | Briefing livre opcional | S1,S7 | D0,D6 | projeto segue com campo vazio | e2e |
| FR-013 | Brief Compiler | S1 | D2,D7 | prompt vira estrutura/conflicts | unit/golden |
| FR-014 | Modo media-only | S1 | D2 | tratamento é inferido sem freeform | e2e |
| FR-021 | Override por projeto | S7 | D0,D7 | inherit/none/custom resolvem por elemento | integration |
| FR-030 | Tipos de entrada | S3 | D1,D6 | vídeo/áudio/imagem entram no ingest | e2e |
| FR-040 | Media Library | S3 | D0,D1,D6 | assets indexados e navegáveis | e2e |
| FR-042 | MediaSegment | S3 | D0,D1 | range reutiliza master | integration |
| FR-047 | Image Library | S3 | D1,D6 | OCR/descrição/busca/reuse | e2e |
| FR-049 | Catalogação automática | S3 | D1,D4 | asset aprovado entra no índice | integration |
| FR-050 | PerceptionTimeline | S1,S3 | D1,D2 | timeline agrega sinais mínimos | golden |
| FR-051 | EditorialBeat | S1 | D2 | beats independem de subtitle chunk | unit |
| FR-052 | Confidence | S1 | D2 | decisões carregam confidence/evidence | contract |
| FR-060 | TreatmentPlan | S1 | D2 | objetivo produz gramática/energy policy | golden |
| FR-061 | StoryPlan | S1 | D2 | atos/blocos/dependências persistidos | golden |
| FR-062 | Alternativas de montagem | S1 | D2 | ao menos candidatos elegíveis são comparados | integration |
| FR-063 | Segurança narrativa | S1 | D2,D7 | qualifier/causalidade não são removidos | policy/golden |
| FR-064 | Ferramentas do Diretor | S1 | D2,D3 | Director só altera via tools | integration |
| FR-065 | Decisions log | S1 | D0,D2 | razão/evidência/custo persistidos | integration |
| FR-066 | Budget | S1 | D2,D4 | limite encerra geração com estado válido | resilience |
| FR-090 | Talking head | S1,S2 | D1,D2,D3,D5 | raw talking head gera final | e2e |
| FR-091 | Visual montage / voiceover | S1,S2 | D1,D2,D3,D5 | áudio+B-roll sem pessoas | e2e |
| FR-160 | Formatos obrigatórios | S2,S7 | D3,D5,D6 | contrato aceita 5 ratios | schema |
| FR-163 | Responsive placement | S2,S7 | D3,D5 | anchors/constraints adaptam canvas | visual golden |
| FR-164 | Reframe | S2,S7 | D2,D3,D5 | face/object permanece visível | visual golden |
| FR-165 | Crítica por formato | S1,S7 | D2,D5 | issue é específico do output | integration |
| FR-170 | Estilos iniciais | S7 | D3,D5 | 5 presets renderizam | visual golden |
| FR-171 | Modos | S7 | D0,D3,D6 | auto/default/manual/none | e2e |
| FR-172 | SubtitleStylePreset | S2,S7 | D3,D5 | schema e responsive overrides | unit/golden |
| FR-173 | Anchor por percepção | S1,S7 | D2,D3 | legenda evita rosto/elemento | visual golden |
| FR-174 | Override por segmento | S2,S7 | D3 | override não muda global | integration |
| FR-175 | Sidecar | S2 | D3,D5 | SRT/VTT seguem alignment | fixture |
| FR-210 | Preview interativo | S7 | D5,D6 | pause/seek frame-accurate | e2e |
| FR-211 | ReviewAnnotation | S7 | D0,D3,D6 | annotation persiste contexto | integration |
| FR-212 | Escopos | S7 | D3,D6 | current/all formats/locales | unit/e2e |
| FR-213 | RenderElementMap | S7 | D3,D5 | hit-test seleciona layer correta | visual/e2e |
| FR-214 | Patch automático | S1,S7 | D2,D3,D6 | annotation vira proposta gated, command e versão imutável | T-FR-214 unit/API/Postgres/render/visual |
| FR-215 | Batch review | S7 | D3,D6 | 2–100 propostas compilam PatchSet único; conflito atômico não muda versão; partial-retry é explícito | T-FR-215 domínio + Postgres serializável/rollback + API HTTP + UI |
| FR-216 | Edição manual | S2,S7 | D3,D6 | timeline deriva do EditPlan corrente; trim/split/move/replace/inspector persistem como Command + snapshot + versão; undo/redo criam versões filhas; API e mouse/teclado usam o mesmo service | T-FR-216 domínio + PostgreSQL serializável/idempotência/conflito + API HTTP + UI mouse/teclado |
| FR-217 | Compare | S2,S7 | D3,D5,D6 | toggle/split/overlay usam snapshots e proxies version-bound; playhead só sincroniza com mapping compartilhado; duração, score, issues e diff semântico são explícitos; accept/reopen persistem Command e restore cria child version sem apagar A/B | T-FR-217 domínio + PostgreSQL serializável/idempotência/conflito + API HTTP nos três modos + Chromium com versões de durações diferentes |
| FR-230 | Proxy first | S1,S7 | D3,D4,D5,D6 | worker persiste proxy H.264 + laudo version-bound; hard bloqueia, warning exige decisão CAS append-only; final lê somente `ready-for-final`; UI/API exibem o mesmo estado e medem upload→proxy real | T-FR-230 domínio + worker + PostgreSQL limpo/49 migrations + API Bearer/idempotência/conflito + Chromium/sessão |
| FR-231 | Final render | S2 | D3,D4,D5 | output aprovado gera artifact | e2e |

## F2 — Lotes, reuso e formatos

| Req | Título | Spec | Dep. | Evidência de aceite | Teste |
|---|---|---|---|---|---|
| FR-043 | SpeechSegment | S3 | D1,D2 | frase/range/alignment pesquisáveis; API pública cataloga e busca segmentos virtuais com metadados/proveniência sem criar mídia | T-FR-043 5/5 + PostgreSQL/API E2E 1/1 + produção `fbbd4c5`, run `speech-catalog-run-0a57512a-e85a-4cd6-9bc4-6f32821f310c` |
| FR-044 | EvidenceSegment | S3 | D1,D7 | claim/qualifier/consent preservados | policy |
| FR-045 | LongFormMoment | S3 | D1,D2 | chapter/moment indexados | integration |
| FR-046 | ValidatedSegment | S3 | D1,D7 | validationScope/protected envelope | integration |
| FR-048 | Busca híbrida | S3 | D1,D2 | filtros+OCR+vector+rerank | retrieval eval |
| FR-053 | Processamento hierárquico | S1,S3 | D1,D2,D4 | long-form não exige visão integral | T-FR-053 + API/PostgreSQL E2E + smoke de produção |
| FR-080 | ProductionBatch | S4 | D0,D1,D4 | lote e items independentes | T-FR-080 + API/PostgreSQL E2E + E2E visual e smoke de produção |
| FR-081 | Script alignment | S4 | D1,D2 | roteiro↔fala↔range com confidence | golden |
| FR-082 | Biblioteca de takes | S3,S4 | D1,D2 | alternates classificados | integration |
| FR-083 | Compatibility graph | S4 | D2,D7 | hard failures e scores explicáveis | unit/golden |
| FR-084 | VariantRecipe | S4 | D0,D2,D3 | H+B+C com lineage | integration |
| FR-085 | Anti-explosão combinatória | S4 | D2,D4 | preflight/top-N/budget | e2e |
| FR-086 | Edição em lote | S4,S7 | D3,D6 | scope/impacto explícitos | e2e |
| FR-087 | Partial retry | S4 | D4 | item falho retenta isolado | resilience |
| FR-120 | Source Deconstruction | S3 | D1,D2 | clean range, report, contexto preservado e comparação source/clean | T-FR-120 domínio/Golden Reel + API/PostgreSQL E2E + UI desktop/mobile + produção `d2bb805` |
| FR-121 | Contaminação | S3 | D1,D2 | cinco tipos localizados por range/região/confidence, impacto de remoção e diagnóstico Director/humano | T-FR-121 + seis fixtures audiovisuais + API/PostgreSQL E2E + UI + produção `e00727f` |
| FR-122 | Limpeza MVP | S3 | D1,D5 | trim/reframe/cover/reject | visual golden |
| FR-124 | Validation envelope | S3 | D1,D7 | copy/take/framing/timing/opening derivados do escopo; proteção automática; saída com aprovação e log preserved/lost; hook exato + corpo/prova/CTA sem excesso | T-FR-124 domínio + API/PostgreSQL E2E + constraints + UI `/v1` |
| FR-130 | Proof need | S1,S3 | D2 | StoryPlan declara claim/tipo/função/momento; busca EvidenceSegments autorizados primeiro; seleciona evidência exata ou registra `proof-unavailable`/`no-proof-needed`; card genérico é impossível | T-FR-130 golden + round-trip canônico + API/PostgreSQL E2E + constraints + UI `/v1` |
| FR-131 | Integrity gate | S1,S3 | D2,D7 | claim/produto/pessoa/período/audience/consent/rights/context comparados contra recipe e EvidenceSegment exatos; prova incompatível, expirada ou descontextualizada bloqueada; attribution/qualifiers idênticos no visual e verbal; nenhuma fabricação | T-FR-131 policy eval 14 casos + round-trip/tamper + API/PostgreSQL E2E + constraints + UI `/v1` |
| FR-132 | Modos de prova | S1,S2 | D2,D3,D5 | cada ProofIntegrity aprovado gera matriz segmento×formato com cutaway/split/card, claim exata, timing/transição/layout seguro, attribution/qualifiers exatos e override hash-scoped; prova/contexto incompatível falha fechado | T-FR-132 domínio + compiler/RenderInput + 15 visual goldens revisados + 3 MP4 Remotion inspecionados; API/PostgreSQL E2E e deploy ainda pendentes |
| FR-133 | Long-form indexing | S3 | D1,D2,D4 | workflow probe→transcript→diarization→chunks→moments com checkpoints, referência tipada ao resultado persistido, parcial pesquisável, budget e retomada sem duplicação | T-FR-133 state machine 6 casos + application/API contract 4 casos + worker orchestration 5 casos + transcript 3 casos + diarização 9 casos focados e 1 integração FFmpeg local + derived stages 7 casos + fencing Prisma controlado 4 casos + E2E API/worker/PostgreSQL de 2h com restart 1 caso. Schema/migration/repositório/API pública e orquestração durável com lease fencing estão implementados localmente. O E2E cria banco limpo com `pgvector`, aplica todas as migrations, parte sem transcript, persiste transcript e diarização controlados, interrompe o primeiro worker em chunks e comprova por `GET /v1` a operação `retrying`, transcript pesquisável e os cinco tiers/status explícitos; depois fecha o Prisma, retoma em uma nova instância e gera 24 chunks e moments pesquisáveis dentro do budget sem duplicar transcript, diarização ou índices. A operação conclui e o postflight confirma zero conexões órfãs. Transcript ausente prepara áudio do artifact imutável, reutiliza somente provider/model/adapter exatos sem novo custo e persiste `V2MediaTranscript`; diarização persiste clusters anônimos; chunks/moments preservam lineage. O daemon supervisionado executa o router integral, propaga shutdown ao provider/FFmpeg, desconecta o Prisma e já possui container de deploy com verificação de restart. Execução E2E com providers reais, deploy e aceite permanecem pendentes; por isso F2.022 continua aberto |
| FR-134 | Contiguous extraction | S1,S3 | D1,D2 | janela autocontida duração-alvo | T-FR-134 domínio da extração 5 casos + domínio da evidência 3 casos + domínio do sidecar de transcript 2 casos + application de extração 3 casos + application do produtor de evidência 3 casos + application do produtor de avaliação 3 casos + analisadores de rights/transcript 4 casos + avaliador determinístico 3 casos + adapter/analisador de áudio 2 casos, sendo 1 FFmpeg real + adapter/analisador visual 2 casos, sendo 1 FFmpeg real + integração/replay no estágio moments 3 casos + adapters Prisma controlados 12 casos + contrato público 2 casos: contrato `contiguous-extraction/v1` seleciona deterministicamente uma única faixa semântica autorizada, pontua autocontenção/densidade/integridade/áudio/visual somente com evidence refs, compila StoryPlan e EditPlan de um clip sem síntese multi-range ou zoom automático e vincula hash à lineage. Cada evidência canônica vincula o index run e moment exatos, faixa, fatos ordenados e provider/model/version/input/output do analisador; o produtor exige uma observação por moment, faz replay antes do analisador e permite runs separados por tipo para não fabricar cobertura ausente. O estágio `moments` persiste atomicamente um sidecar que liga cada moment aos spans exatos, hierarchical run e transcript; hashes de texto/span e o conjunto declarado na aggregation são recalculados dentro da transação fenced. Os analisadores determinísticos de boundary e density derivam começo/fim alinhados, gaps, pontuação terminal, palavras por minuto e cobertura de fala somente desse sidecar; ausência ou adulteração falha fechado. O adapter de evidência hidrata e revalida o sidecar antes de expô-lo aos analisadores. O analisador de rights/consent deriva integridade do snapshot corrente e falha fechado em bloqueio ou cancelamento. O adapter FFmpeg de áudio mede loudness EBU R128, true peak, volume e silêncio em cada faixa recomendada somente após verificar tamanho e SHA-256 dos bytes imutáveis, e revalida o checksum após todas as medições; a localização do storage não participa do hash editorial portátil. O adapter FFmpeg visual mede luminância, saturação, diferença temporal, outliers, repetição, pixels fora do broadcast range, black/freeze e mudanças de cena por faixa, incluindo intervalos de freeze ainda abertos no fim da janela, sob a mesma verificação de bytes imutáveis. O avaliador `apollo/contiguous-evidence-policy/1.0.0` exige exatamente uma evidência de cada uma das cinco dimensões, deriva scores somente dos fatos canônicos e aplica tags de objetivo determinísticas; ausência, silêncio, black frame ou integridade incompleta rejeitam o moment em vez de fabricar aprovação. O estágio executa os cinco produtores e o avaliador após persistir o índice; operação, attempt, lease não expirada, input hash e idempotency do checkpoint são revalidados dentro das transações. Se a lease cair depois do índice ou durante a avaliação, o retry reutiliza o índice e retoma evidências/avaliação sem duplicá-lo. O hash da avaliação também vincula provider/model/version e hashes exatos do input/output; a API expõe essa provenance, mas não aceita candidates nem scores. O produtor de avaliação exige uma decisão avaliada ou rejeitada para cada moment, recusa referências fora da allowlist dimensional e faz replay antes de chamar o provider. O adapter Prisma desse produtor relê source, evidence, rights, ator, operação e checkpoint dentro de transação serializable, invalida somente avaliações ativas substituídas e persiste run/decisions/evaluations atomicamente sob a lease de `moments`. Esses adapters foram comprovados apenas com clients controlados, não em PostgreSQL real. O application service público recebe apenas objetivo/tópico/duração, lê candidates e scores pela porta confiável, persiste uma extração e converge idempotência sem reavaliar. O adapter de extração filtra índice ativo e rights/consent correntes, recalcula `evaluationHash`, persiste JSON canônico e faz FK do resultado para moment, index run e avaliação selecionados. A API local `POST /v1/projects/{projectId}/contiguous-extractions` e `GET /v1/projects/{projectId}/contiguous-extractions/{extractionId}` expõe os mesmos services com auth/scope, idempotência, schemas, exemplos e capability IDs. O roteiro E2E local combinado agora prepara 24 janelas semânticas de 120 s em um master controlado de 7.200 s, exige cinco evidências e uma avaliação por moment, cria/lê/reexecuta a extração via `/v1` e verifica plano single-range e persistência única; ele recusa host não local, exige `application_name`/limites de pool/timeouts, desconecta ambos os clients e consulta `pg_stat_activity` no postflight. Essa extensão compila, mas ainda não foi executada por ausência de PostgreSQL local descartável. O schema anterior foi aplicado do zero em PostgreSQL/pgvector local (110 tabelas/566 índices/435 FKs); as migrations aditivas passam validação estrutural (114/591/455), mas uma nova aplicação do zero está pendente porque este host não possui PostgreSQL/Docker/Podman/WSL local e o incidente bloqueia uso da VPS. O comportamento permanece apenas parcialmente integrado; E2E PostgreSQL/API, golden real de 2h, UI, deploy e aceite estão pendentes |
| FR-136 | Repositório semântico | S3 | D1,D2 | consulta cross-asset reutiliza índice | retrieval eval |
| FR-180 | ColorPipeline | S2,S3 | D1,D5 | technical→match→LUT→output | visual golden |
| FR-181 | Workspace LUT Library | S3,S7 | D0,D1,D6 | upload/select/disable .cube | e2e |
| FR-182 | ColorPlan | S2 | D3,D5 | global/source/segment override | integration |
| FR-235 | Export matrix | S2,S4 | D3,D4,D5 | variants×formats preflight/render | e2e |

Atualização local de FR-134 — a superfície do editor possui 1 contrato estático adicional: busca momentos exclusivamente por `GET /v1/projects/{projectId}/long-form-moments`, envia a `POST /v1/projects/{projectId}/contiguous-extractions` somente objetivo, tópico normalizado, duração, tolerância e FPS com chave de idempotência estável, e apresenta uma faixa, cinco dimensões de evidência, o avaliador, um clip e zoom automático desligado. O fluxo foi inspecionado em desktop e mobile com respostas `/v1` controladas; essa inspeção comprova composição e responsividade da UI, não integração com backend/PostgreSQL. O E2E com PostgreSQL descartável, o deploy e o aceite continuam pendentes; FR-134 permanece parcial e nenhuma caixa de produto foi concluída por esta atualização.

Golden local de FR-134 — `T-FR-134` materializa com FFmpeg um master MP4 real de 7.200 s, distingue por pixels uma janela semântica dourada de 120 s do restante escuro, calcula o SHA-256 dos bytes, escolhe a faixa 59:00–61:00 entre dois moments avaliados e entrega o `EditPlan` V2 ao renderer novo. O teste comprova MP4 de 120 s, 960×540, áudio AAC, uma fonte, um clip, ausência de síntese multi-range e zoom automático desligado; amostras antes/depois do range são escuras e início/meio/fim da saída preservam a faixa dourada. Essa evidência é local e determinística, não substitui o master real da Imersão nem o E2E API/PostgreSQL.

Atualização local de FR-136 — a consulta pública existente aceita `scope: project|workspace`, preserva `project` como padrão e usa o projeto da rota como âncora de autorização. No novo scope de workspace, o adapter consulta somente documentos do mesmo workspace, hidrata o snapshot corrente de rights/consent e elimina candidatos sem permissão para o uso solicitado antes do rerank; `includeBlocked: true` e filtro `rights: blocked` falham fechados nesse scope. A capability usada pelo Diretor recebe intenção, atmosfera, pessoas, fala e visual em canais estruturados: atmosfera e pessoa são restrições exatas; fala precisa corresponder ao transcript; visual precisa corresponder a OCR, descrição ou metadata; esses canais participam da recuperação full-text/vetorial sem aceitar candidates ou scores do chamador. A command capability idempotente `semantic-search.reuse-runs.create` reexecuta a query exata, confere `queryHash` e o `resultSetHash` content-addressed exibido ao Diretor, registra o audit confiável de até 500 candidates (incluindo bloqueios de rights/consent anteriores ao rerank), mede latência e exige que todos os resultados elegíveis sejam particionados entre reutilizados e rejeitados com motivo enumerado; o run e sua decisão são imutáveis no Postgres V2. A capability aditiva `semantic-search.scale-evaluations.create` mantém o contrato `retrieval-evaluation/v1` intacto, fixa escopo e quantidade real de documentos ativos, exige de 3 a 50 julgamentos, mede cada busca com relógio monotônico, agrega precision/recall/nDCG/MRR e latência mínima/p50/p95/máxima/média, rejeita qualquer mudança do corpus durante o run e revalida o tamanho dentro da transação serializável antes de persistir `retrieval-scale-evaluation/v1`. Testes controlados medem snapshots imutáveis com 10, 100 e 1.000 documentos e comprovam qualidade, percentis, hash e fail-closed por drift; testes de application/contrato também comprovam propagação do scope, instante único de avaliação, retorno cross-project no mesmo workspace, default restrito ao projeto, separação entre evidência falada/visual, partição obrigatória, recusa de result set stale e distinção entre rejeição de política e rejeição editorial. O E2E isolado prepara dois projetos do mesmo workspace e exercita consulta, reuse run e scale evaluation pela API/PostgreSQL, incluindo replay, tamanho cross-project e auditoria de um asset bloqueado, mas não foi executado neste host sem PostgreSQL local descartável. Execução PostgreSQL real, série crescente em banco real, deploy e aceite continuam pendentes; F2.024 permanece aberto.

Atualização local de FR-180 — o contrato `color-plan/v1` materializa color space, transfer, primaries, matrix, range e bit depth na entrada, na saída e em cada estágio `technical → match → creative-lut → output`. Todos os quatro estágios precisam estar explícitos; a resolução ordena o pipeline independentemente da ordem de declaração, permite override source/camera/segment somente por substituição, recusa estágio duplicado dentro do mesmo layer, exige continuidade colorimétrica entre estágios, vincula provider/version/parâmetros e seu SHA-256 e só permite LUT em `creative-lut` ativa com artifact ID/hash imutáveis. O resultado `resolved-color-pipeline/v1` possui manifesto e hash canônico. O ingest V2 agora solicita ao `ffprobe` color space, transfer, primaries, range, pixel format e bit depth tanto do master quanto do proxy, deriva HDR SDR/HLG/PQ deterministicamente, identifica a versão e o SHA-256 do executável real e persiste as duas evidências `media-color-probe/v1` de forma imutável na mesma transação que conclui a operação. Metadata incompleta fica explicitamente `unavailable`, sem default silencioso. A capability pública autenticada `GET /v1/artifacts/{artifactId}/color-probe` lê o mesmo registro sob escopo de workspace. As capabilities `POST /v1/projects/{projectId}/color-pipeline-compilations` e `GET /v1/projects/{projectId}/color-pipeline-compilations/{compilationId}` compilam e persistem um pipeline imutável apenas para source artifact/manifest realmente associado ao projeto. O request não aceita `sourceMetadata` nem input de estágio: o application service lê o probe exato do Postgres e encadeia cada input a partir dessa evidência; probe indisponível falha fechado. A tabela V2 projeta o hash do probe, pipeline, compilation e cada transform/provider/version/parametersHash, com idempotência por ator, replay convergente e reidratação que detecta tamper. O adapter `FfmpegColorPipelineProcessor` valida novamente os hashes, exige providers e parâmetros allowlisted, materializa LUT somente por caminho absoluto previamente resolvido, executa exatamente `zscale technical → match → lut3d/none → zscale output`, grava metadata explícita e reprova divergência no probe da saída. O golden real gera três MP4 SDR distintos (`testsrc2`, `smptebars` e rampa limitada), produz três hashes distintos, confirma Rec.709/8-bit e preserva pelo menos 40 níveis na rampa entre preto e branco, cobrindo clipping por inspeção de pixels. Enqueue de proxy e export final agora exige exatamente uma compilação para cada fonte de vídeo, grava `artifactId/manifestId/compilationId/compilationHash/pipelineHash` no contexto imutável e no input hash, e recusa ausência, ambiguidade ou drift. Os workers reidratam e revalidam os hashes antes de chamar o renderer; o renderer pré-processa cada fonte pelo pipeline FFmpeg e só então compõe clips, legendas e áudio. A seleção também entra na recipe de proxy/final e no `RenderInput` final. O golden real multi-source comprovou master + B-roll, preservação do áudio do master, frame visual do B-roll e canvas/fps final. O E2E API/PostgreSQL foi ampliado para rota, replay e registro persistido quando houver PostgreSQL descartável. O ColorPlan editável e seus overrides pertencem a F2.027; ainda faltam executar o E2E PostgreSQL neste host, ligar a seleção editável futura à ProjectVersion, implantar e obter aceite visual do MP4 real de recuperação. F2.025 permanece aberto e nenhuma caixa foi marcada.

Atualização local de FR-181 — o agregado imutável `workspace-lut-version/v1` valida `.cube` 3D de até 8 MiB, tamanho 2–65, domínio finito, quantidade exata de amostras e conteúdo canônico; nomes e `TITLE` Unicode são preservados. A versão vincula workspace, owner, licença e política de uso, tags, compatibilidade de cor, intensidade padrão, hashes do conteúdo/registro e preview PNG. O Postgres V2 possui head lógico ativo/inativo e versões imutáveis, com idempotência por ator, ponteiro de versão corrente, integridade referencial e reidratação que detecta adulteração do registro ou dos bytes do preview. As capabilities públicas autenticadas permitem importar, listar, ler e obter o preview por `/v1/workspaces/{workspaceId}/luts`; o import gera de fato um PNG 512×288 com FFmpeg `lut3d`, persiste os bytes e faz replay sem gerar novamente. A criação de versões sucessoras exige `baseVersion` corrente, recompila o `.cube`, gera preview novo e só avança o ponteiro em transação serializável com sequência contígua; versões históricas possuem leitura e preview próprios. O lifecycle ativo/inativo tem revisão monotônica, comando imutável por ator, idempotência e compare-and-swap; desativar é remoção lógica e não apaga versões/previews antigos. O default do workspace também é um agregado versionado: começa explicitamente sem configuração na revisão zero, aceita somente a versão corrente de uma LUT ativa ou `none`, persiste cada revisão imutável e avança o head por CAS serializável; a API pública lê e altera esse mesmo estado. Testes locais cobrem LUT válido com glyph/nome incomum, linhas/domínio/diretivas inválidos, contrato exato, replay, base stale antes do preview, licença/tags, lifecycle/default stale, default ativo e `none`, persistência controlada, histórico preservado e preview FFmpeg real. O E2E API/PostgreSQL para válido, inválido, novas versões, lifecycle/default, replay, isolamento de workspace e PNG histórico foi codificado, mas não executado porque este host não possui PostgreSQL descartável e a VPS permanece bloqueada pelo incidente operacional. Ainda faltam seleção por projeto e `none` integrado via Command/ProjectVersion ao runtime, materialização do `.cube` no worker, UI comparativa, execução do E2E PostgreSQL, deploy e aceite. F2.026 permanece aberto e nenhuma caixa foi marcada.

## F3 — Sintético e transformação

| Req | Título | Spec | Dep. | Evidência de aceite | Teste |
|---|---|---|---|---|---|
| FR-092 | Synthetic presenter | S6 | D1,D4,D5,D7 | personagem IA+B-roll final | e2e |
| FR-093 | Hybrid | S1,S2,S6 | D1,D2,D3,D5 | real+sintético+prova coexistem | e2e |
| FR-100 | Audio-first | S6 | D1,D3 | áudio governa alignment/timeline | integration |
| FR-101 | Adapters | S6 | D4 | provider mock substituível | contract |
| FR-102 | Geração por blocos | S6 | D2,D4 | retry/reuse por block | integration |
| FR-103 | SyntheticPresenterProfile | S6 | D0,D7 | profiles/version/consent | policy |
| FR-104 | SyntheticMasterAsset | S3,S6 | D1,D4 | bruto+áudio+config salvos | integration |
| FR-105 | Cache | S6 | D1,D4,D7 | hash reutiliza artifact válido | integration |
| FR-106 | Crítico sintético | S1,S6 | D2,D4 | lips/identity/pronunciation gates | eval |
| FR-110 | TransformationBrief | S1,S6 | D2,D4 | intent/preserve/fallback estruturados | contract |
| FR-111 | Modos | S6 | D4 | 6 modos no capability registry | contract |
| FR-112 | Provider Registry | S6 | D4 | routing por capability/custo | integration |
| FR-113 | Jobs duráveis | S6 | D4 | API/MCP resume | resilience |
| FR-114 | Novelty budget | S1 | D2 | excesso bloqueado/penalizado | unit |
| FR-115 | Fallback | S6 | D2,D4 | v2v→composite→cutaway | integration |
| FR-116 | Crítico | S1,S6 | D2,D4 | transform rejeitada com issue | eval |
| FR-123 | Limpeza avançada | S3,S6 | D1,D4 | separation/inpaint como derivado | visual eval |
| FR-218 | Mask future | S6,S7 | D3,D4,D6 | annotation region vira mask input | integration |

## F4 — Multicâmera e long-form avançado

| Req | Título | Spec | Dep. | Evidência de aceite | Teste |
|---|---|---|---|---|---|
| FR-135 | Editorial synthesis | S1,S3 | D1,D2,D3 | multi-range preserva contexto | golden/policy |
| FR-140 | CaptureSession | S5 | D0,D1,D8 | tracks agrupados | integration |
| FR-141 | Session clock | S5 | D8 | mapping canônico | property |
| FR-142 | Estratégias de sync | S5 | D8 | cascade seleciona método | fixture |
| FR-143 | TrackCoverage | S5 | D8 | fontes curtas/gaps representados | property |
| FR-144 | Drift | S5 | D8 | anchors corrigem rate | numeric fixture |
| FR-145 | Piecewise maps | S5 | D8 | stop/rewind/seek mapeados | property |
| FR-146 | Sync audio separado | S5 | D1,D8 | scratch descartável | integration |
| FR-147 | Capture Protocol | S5,S7 | D6,D8 | requisitos exibidos/salvos | e2e |
| FR-148 | Apollo Sync Marker | S5 | D1,D8 | flash+chirp detectados | fixture/e2e |
| FR-149 | SyncDiagnostic | S5,S7 | D6,D8 | confidence/coverage/warnings | e2e |
| FR-150 | Direção multicâmera | S1,S5 | D2,D3,D8 | ângulo por speaker/contexto | golden |
| FR-183 | Multicam match | S2,S5 | D1,D5,D8 | câmeras equilibradas antes da LUT | visual eval |
| FR-184 | Crítico de cor | S1,S2 | D2,D5 | clipping/skin/mismatch localizados | visual eval |

## F5 — Localização e áudio

| Req | Título | Spec | Dep. | Evidência de aceite | Teste |
|---|---|---|---|---|---|
| FR-094 | Music-led montage | S8 | D3,D5,D9 | cuts seguem grid sem deformar fala | audiovisual golden |
| FR-190 | Conteúdo canônico | S8 | D0,D2,D9 | ScriptBlocks sourceLocale | schema |
| FR-191 | LocalizationVariant | S8 | D0,D3,D9 | locale possui assets/plano/status | integration |
| FR-192 | Timings próprios | S8 | D3,D9 | alignment novo recompila timeline | property |
| FR-193 | Modos de áudio | S6,S8 | D4,D7,D9 | TTS/local/upload autorizado | integration |
| FR-194 | LocaleProfile | S8 | D0,D7,D9 | glossary/CTA/font/RTL | integration |
| FR-195 | Assets localizáveis | S3,S8 | D1,D2,D9 | OCR decide share/localize/reject | eval |
| FR-196 | Crítico de localização | S1,S8 | D2,D9 | fidelity/pronunciation/lips/subtitle | eval |
| FR-200 | Sync modes | S8 | D3,D9 | narrative/music/hybrid persistidos | unit |
| FR-201 | AudioDirectionPlan | S8 | D3,D9 | beat/sections/events/mix compilam | golden |
| FR-202 | Sound Library | S3,S8 | D1,D9 | BPM/rights/tags pesquisáveis | integration |
| FR-203 | Sound budget | S1,S8 | D2,D9 | repetição/densidade limitadas | unit |
| FR-204 | Mix/master | S8 | D5,D9 | ducking/loudness/limiter | audio fixture |
| FR-205 | Crítico audiovisual | S1,S8 | D2,D5,D9 | masking/drift/tails/issues | audiovisual eval |

## Verificação

- Todo `FR-*` do PRD deve aparecer exatamente uma vez nesta matriz.
- CI documental deve falhar se um ID estiver ausente ou duplicado.
- Mudança de fase/spec exige atualizar esta matriz no mesmo commit.
