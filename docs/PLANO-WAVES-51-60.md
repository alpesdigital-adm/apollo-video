# Próximas dez waves — reconciliação de lacunas, W51–W60

**Registro histórico do planejamento de 05/10/2026.** Base de leitura: `main`/`origin/main` `701dd99c68e330701578073af1e963780c14720d`. Este plano não inicia a execução de código dos pacotes nem autoriza provider pago, operação na DigitalOcean, deploy ou aceite do proprietário. O registro canônico é `docs/quality/project-status.json`, com painel gerado em `docs/PROJECT-STATUS.md`. As notas do `TODO.md` e dos pacotes [W31–W40](PLANO-WAVES-31-40.md) e [W41–W50](PLANO-WAVES-41-50.md) são histórico; confrontá-las com o registro, manifests, artifacts e SHA atuais antes de afirmar lacuna ou conclusão. Em especial, W35/W36 já têm prova posterior de pipeline/eventos reais; W51–W60 não repetem uma suíte apenas porque o texto histórico ainda diz “parcial”.

**Atualização de execução, 06/10/2026.** O proprietário autorizou construir, integrar e validar estes dez recortes. A [matriz por 38 IDs](quality/w51-60-integration.md) registra 34 IDs W51–W59 com provas técnicas controladas candidatas à reconciliação e quatro W60 ainda provisórios: o run real `w60-reconstruction-final-precision-32548397` passou pela cadeia e reconstrução byte-idêntica após o fix `ecca96af`; falta a audição integral. As estimativas e verbos prospectivos abaixo permanecem como plano histórico; o status atual por ID depende do registro canônico, merge e CI no SHA de `main`. Nenhuma prova técnica remarca automaticamente o TODO, comprova implantação DigitalOcean ou constitui aceite do proprietário. W60 cobre os quatro IDs selecionados, sem declarar J.001 abrangente completo ou percepção de faces disponível.

| Wave | Recorte | Depende de | Desenvolvimento indicativo |
| --- | --- | --- | --- |
| [W51](#w51) | Upload, grants e histórico F0.041 | Base V2 e provas F0.041 existentes | 3–5 h |
| [W52](#w52) | Sessão e troca de workspace F0.031 | Contratos de sessão V2 | 3–5 h |
| [W53](#w53) | Dashboard com eventos de worker F1.001 | W35/W36 integradas; W52 para sessão | 3–5 h |
| [W54](#w54) | Filtros e lifecycle F1.002/F1.003 | W53; provas W31–W40 | 3–5 h |
| [W55](#w55) | Biblioteca UI, leitura e rights F1.012 | W52; provas W41–W50 | 3–5 h |
| [W56](#w56) | Ranges e derivadas áudio/vídeo F1.013 | W55; pipeline W45–W47 | 6–8 h |
| [W57](#w57) | Imagem, OCR, thumbnail e tags F1.014 | W55; prova W48 | 4–6 h |
| [W58](#w58) | Catálogo aprovado, rights e lineage F1.015 | W55–W57 conforme tipo; prova W49 | 4–6 h |
| [W59](#w59) | Operação durável/outbox F0.037/F0.038 | W53 e operações V2 existentes | 4–6 h |
| [W60](#w60) | Jornada do master da Imersão J.001 | W51–W59 aplicáveis; master, percepção e providers disponíveis | 6–8 h |

Total indicativo: **39–59 h de desenvolvimento**, excluindo CI e revisão externa. Dependência bloqueada ou requisito maior que o recorte vira pendência explícita, não aumento silencioso de escopo. O mesmo ID pode aparecer em trabalho anterior e nesta fila: é a **mesma caixa**, cuja situação individual precisa de prova completa. Planejamento e classificação de wave não remarcariam o TODO. Os 38 IDs selecionados não representam toda a revisão pendente das 875 tarefas de grupos parciais ou dos 234 aceites históricos com referências a reconciliar.

Na futura execução, Luna lê e audita; Sol escreve, orquestra, integra, valida e testa. Leituras e implementação independente podem avançar nas frentes upload/sessão (W51–W52), dashboard/operações (W53–W54/W59) e biblioteca (W55–W58), respeitando os gates da tabela. Checkouts, bancos, portas, processos e ownership devem ser distintos; schema, contracts, composition root, CI, registro de status e Git remoto são integrados em série por um único owner. W60 é a convergência das dependências aplicáveis.

## Protocolo comum de execução futura

Antes de cada wave, inventariar **cada ID** no TODO e no painel, ler seu critério literal, o código/contrato vigente e a prova mais recente. Reusar prova válida quando ela vincula SHA, run, manifest, artifact e resultado ao comportamento exato; não repetir teste por rotina nem tratar nome de suíte ou referência documental como execução. Resolver só o gap demonstrado, com oráculo independente e caminhos de sucesso, erro, autenticação/isolamento, retry/cancelamento e lineage conforme o risco. O registro por ID deve dizer claramente: implementado, integrado, E2E controlado ou live, implantado e aceito; ausência de provider, ambiente ou artifact fica como `unavailable`/bloqueio, nunca sucesso por fake, seed, skip ou fallback legado.

Manifest sanitizado mínimo por prova nova: SHA do código e do artifact/CI, run ID, casos/asserts e origem dos dados (`seed PG controlado`, bytes/worker reais, HTTP/browser reais ou provider live), IDs de projeto/workspace/Command/Operation/Version/Artifact/manifest e hashes quando relevantes, roles/scopes sem cookies ou Bearer brutos, direitos/consentimento, resultado visual ou mídia inspecionada quando houver, erros/retry/cancel e postflight de processos e conexões do run. O teste deve distinguir transporte controlado de autorização real. Para testes locais, usar PostgreSQL/storage/processos isolados com owner, prazo, cleanup terminal e zero backends; um processo órfão fecha o gate. Sem infraestrutura ou provider necessário, fechar relatório **parcial**, preservando a caixa aberta.

Ao executar uma wave, atualizar `docs/quality/project-status.json` com `todoItems` exatos, escopo, evidências e bloqueios; gerar `docs/PROJECT-STATUS.md` com `npm run project:status -- --write` e passar `npm run project:status:check`. Só alterar TODO/PRD/spec/rastreabilidade quando a evidência exigir, mantendo construção, integração, validação, implantação e aceite distintos. DigitalOcean é assunto futuro e condicionado a ambiente/droplet identificados, orçamento, persistência, backup/restore, DNS/rede, exclusividade, preflight/monitor/postflight e todos os gates de `AGENTS.md`; produção não recebe build nem E2E de desenvolvimento.

<a id="w51"></a>
## W51 — upload, grants e histórico

**F0.041 · IDs:** `7f16cb076f65-1`, `df3dbec4de35-1`, `d8fe6d431e60-1`, `1d40492407b0-1`. **Dependência:** API/storage V2 e provas F0.041 atuais. **Estimativa:** 3–5 h.

Reconciliar por ID o begin-upload, sessão signed single/multipart, retomada/completion/verificação e o E2E de arquivo grande, interrupção, checksum errado, expiração e download revogado. A nota do TODO já aponta 256 MiB/4 parts determinísticos e port local/S3 controlado; identificar se falta a jornada conjunta PostgreSQL + storage S3 compatível + HTTP/browser, ou somente vínculo de artifacts. Não transformar um teste de signer/driver em comprovação de grant revogado no stream. Se houver gap real, exercer transferência, receipts, expiry, SHA/tamanho/MIME, rejeição antes do ingest e leitura full/range após revogação, inclusive retry idempotente, com bytes reais controlados e histórico persistido. Fonte: `src/v2/application/begin-media-upload.ts`, `manage-media-upload.ts`, `manage-media-download-grant.ts`, `src/v2/infrastructure/media-upload-verifier.ts`, `tests/v2/media-download-grant.test.mjs`, `docs/adr/ADR-075-durable-media-upload-intent.md` até ADR-078. Entrega da wave: tabela de quatro IDs com prova reaproveitada, prova nova e bloqueio remanescente; nenhum grant ou segredo bruto no manifest.

<a id="w52"></a>
## W52 — sessão e troca de workspace

**F0.031 · IDs:** `933b64ede8c5-1`, `3bc3f43c2f08-1`, `757a4004294a-1`. **Dependência:** contratos `/v1/session` e shell V2. **Estimativa:** 3–5 h.

Reconciliar evidências de shell, invalidação de cache/subscription e E2E de sessão expirada, acesso negado e troca. Os runs históricos de IdP mock, rotação e PostgreSQL não provam IdP real, recuperação ou implantação; separar o critério de cada caixa da pendência externa. Se o código atual mostrar lacuna executável, corrigir o menor fluxo: sessão humana com membership, troca que revoga a identidade anterior, zero dados/subscriptions do workspace antigo, 401/403/404 reais e navegação SSR segura. Provar no browser e API com duas identidades/workspaces e readback PG, sem expor cookie; Bearer de agente tem contrato e escopo separados. Fonte: `src/v2/application/authenticate-ui-session.ts`, `manage-ui-session-security.ts`, `src/v2/infrastructure/security/ui-session.ts`, `tests/v2/prisma-ui-session-security.integration.mjs`, `docs/adr/ADR-142-human-identity-session-and-recovery.md`. Registrar IdP/recuperação live como bloqueio próprio se indisponíveis, sem repetir mock como se fosse live.

<a id="w53"></a>
## W53 — cards e eventos de worker

**F1.001 · IDs:** `bff460a9298a-1`, `0944e64350b1-1`, `d1048dd7b809-1`, `ba0e03c8f7d9-1`. **Dependência:** prova integrada W35/W36 e sessão W52 para qualquer browser novo. **Estimativa:** 3–5 h.

Primeiro ligar o resultado posterior W35/W36/PR #76 e os manifests W29–W40 ao critério dos quatro IDs. Os eventos de operação, progresso e annotation já passaram por outbox, HTTP e observer real no recorte controlado; não reconstruir feed nem rerodar a jornada completa sem gap novo. Inspecionar o que falta para os cards: referência visual, estados produzidos por operações reais versus seed, ação recomendada de cada estado e porcentagem somente com `completed/total` medidos. Se faltar prova, criar caso focado de worker/PG → evento → GET → card no browser, com operação falha/retry/cancel e workspace isolado, conferindo screenshot e `aria-valuenow`; marcar seeds e transporte injetado separadamente. Fonte: `src/app/ProjectsPageClient.tsx`, `src/v2/application/read-public-event-feed.ts`, `src/v2/infrastructure/prisma/public-event-outbox.ts`, `tests/v2/public-event-feed.integration.mjs`, `tests/v2/public-project-api.integration.mjs`, `docs/PACOTE-WAVE36-EVENTOS-DASHBOARD.md`. Resultado: matriz estado/ação/progresso/evento por ID, sem promessa de push instantâneo.

<a id="w54"></a>
## W54 — filtros e lifecycle

**F1.002/F1.003 · IDs:** `0b96ddcb537a-1`, `7e132977731d-1`, `1349e49bda43-1`, `56a977e125cd-1`. **Dependência:** W53 e provas W31–W40. **Estimativa:** 3–5 h.

Verificar provas atuais dos oito filtros, paginação/cursor e das ações abrir, revisar, duplicar, renomear, arquivar e restaurar. Checar especialmente a lacuna documentada em W40: `?mode=review` era destino de URL, sem modo efetivo no editor; corrigir somente se o critério da ação “revisar” exigir comportamento distinto. Nos casos sem evidência suficiente, exercitar estado/revisão reais via API/PG/browser, cursor preso a filtros/workspace, falha recuperável 401/403/404/409, duplicate copy-on-write com hashes/lineage e idempotência, sem substituir transições por seed silencioso. Fonte: `src/v2/ui/project-dashboard-filters.ts`, `src/v2/application/project-quick-actions.ts`, `src/v2/application/duplicate-project.ts`, `tests/v2/project-dashboard.test.mjs`, `tests/v2/public-project-api.integration.mjs`, `docs/PACOTE-WAVE40-JORNADA-CONSOLIDADA-DASHBOARD.md`. Registrar quais ações cumprem a caixa integralmente e quais só têm subescopo comprovado.

<a id="w55"></a>
## W55 — biblioteca na UI, leitura e rights

**F1.012 · IDs:** `5fed046a5719-1`, `fdd725d7664f-1`, `db882ddc544b-1`, `ac7e0a1c125b-1`. **Dependência:** W52 e evidências W41–W50. **Estimativa:** 3–5 h.

Auditar paginação mista de assets/segments, detalhes/previews, filtros kind/pessoa/tema/rights, navegação/reuso por referência e bloqueio de asset restrito. W50 já provou muitos caminhos com bytes controlados; conferir quais manifests e capturas se ligam a cada ID antes de construir algo. Para lacuna real, seguir um item da ingestão/catálogo até listagem, detalhe, preview e referência via UI/HTTP/PG, comparar bytes/hash e estados indisponível/falha; revogar rights e sessão e exigir bloqueio também no endpoint direto. Distinguir o 422 jurídico canônico de 401/403 de identidade, sem chamar 403 injetado de autorização real. Fonte: `src/components/MediaLibraryWorkspace.tsx`, `src/v2/application/media-library.ts`, `src/v2/infrastructure/prisma/media-library-repository.ts`, `tests/v2/prisma-media-library.integration.mjs`, `docs/quality/media-library-w41-50.md`. Evidência final deve nomear itens e previews inspecionados, checks de rights e lacunas por ID.

<a id="w56"></a>
## W56 — ranges e derivadas áudio e vídeo

**F1.013 · IDs:** `4b34d180f96e-1`, `685f984e3c9d-1`, `75a8db3a5d75-1`, `82ccf53db39a-1`. **Dependência:** W55, range virtual W45 e worker físico W47. **Estimativa:** 6–8 h.

Reusar as provas de range semântico, sobreposição/nesting/borda, master sem corte físico e derivative de vídeo só por demanda. O relatório W41–W50 diz expressamente que **áudio materializado ainda não foi coberto**. Confirmar se o consumer de áudio está no contrato pedido; se sim, implementar pelo port/worker V2 existente, sem reaproveitar runtime legado nem extrair bytes na criação virtual. Testar áudio e vídeo reais controlados com duração/source time, idempotência de demanda concorrente, cancelamento ativo, retry/reclaim/lease e lineage de artifact/manifest; inspecionar o MP4 e escutar/medir o áudio, com SHA de entrada/saída e zero novo objeto no caminho virtual. Fonte: `src/v2/domain/media-segment.ts`, `src/v2/application/request-media-segment-derivative.ts`, `run-media-segment-derivative-worker.ts`, `src/v2/infrastructure/media/ffmpeg-media-segment-extractor.ts`, `tests/v2/media-segment-materialization.integration.mjs`. Se áudio depender de contrato/provider ausente, declarar o ID parcial e o bloqueio preciso.

<a id="w57"></a>
## W57 — imagem, OCR, thumbnail e provenance

**F1.014 · IDs:** `92393ad62131-1`, `184065af0667-1`, `22ad5715eb6c-1`. **Dependência:** W55 e prova W48. **Estimativa:** 4–6 h.

Validar o que o CI/manifest W48 já demonstra para descrição observada, tags com origem/modelo/versão/confidence, thumbnail/derivadas imutáveis e eval sem texto, texto pequeno e PT/EN. O OCR local indisponível no W50 não apaga automaticamente a prova de CI; exigir vínculo ao SHA e às imagens/saídas precisas. Se faltar caso, rodar pipeline V2 com imagens reais controladas, ler OCR persistido, comparar pixels/hashes/dimensões e demonstrar ausência de palavras inventadas; conferir falha e rights no consumo. Fonte: `src/v2/domain/image-library.ts`, `src/v2/application/analyze-image-artifact.ts`, `src/v2/infrastructure/media/sharp-image-analysis-processor.ts`, `tests/v2/image-analysis-tesseract.integration.mjs`, `tests/v2/prisma-image-library-proof.integration.mjs`, `docs/PACOTE-WAVE48-IMAGENS-OCR-DERIVATIVES.md`. Faces/objects sem provider ficam `unavailable`: não há ID de faces/objects neste pacote e sua ausência não vira prova de detecção.

<a id="w58"></a>
## W58 — catálogo aprovado, rights e lineage

**F1.015 · IDs:** `d579da1d7f50-1`, `0780b4a83bea-1`, `1d6d2df95dcf-1`, `ca7b74c93a9c-1`. **Dependência:** W55–W57 para os tipos em exame e prova W49. **Estimativa:** 4–6 h.

Reconciliar W49/CI com cada critério: catalogação depois da promoção, snapshot de rights/consent, parent/provider/model e exclusão de temporários, falhas e rejeitados. O teste fake citado no TODO para replay não basta; W49 relata worker/exportação/FFmpeg reais, então conferir se a prova posterior cobre concorrência e unicidade no PG. Se faltar, rodar apenas cenário focado de promoção aprovada e replay/reprocessamento real, com artifact/manifest, contagem antes/depois, GET da biblioteca, hash e lineage; provocar rejeição/rights inválidos/outro workspace e confirmar zero entradas. Fonte: `src/v2/application/catalog-approved-output.ts`, `src/v2/domain/automatic-catalog.ts`, `src/v2/infrastructure/prisma/automatic-catalog-repository.ts`, `tests/v2/automatic-catalog.test.mjs`, `docs/PACOTE-WAVE49-CATALOGACAO-APROVADA.md`. Aceite e implantação permanecem campos separados dos quatro IDs.

<a id="w59"></a>
## W59 — operação durável e outbox

**F0.037/F0.038 · IDs:** `af2c94e4eac8-1`, `7fa10cdf98e4-1`, `fadcc2d775a2-1`, `80557a535c10-1`. **Dependência:** operações V2 atuais e W53 quando evento for observado no dashboard. **Estimativa:** 4–6 h.

Auditar o recorte real existente de PublicOperation, worker do Diretor e outbox: status sem perder retry/cancelabilidade, restart/stale result, transição + evento no mesmo commit, assinatura inválida/timeout/replay. O TODO descreve Diretor local e writers parciais; não extrapolar para **todos** os providers, sync e batches. Provar em PG/HTTP e worker real uma transição selecionada com evento real, reinício/reclaim, retry limitado, cancelamento cooperativo e fencing de resultado stale; verificar idempotência da outbox, nenhuma publicação fantasma, payload sem dados internos e estado terminal após erro. Webhook deve usar endpoint/assinatura reais do harness, com testes de contrato; fake e seed são rotulados e não fecham caminho live/provider. Fonte: `src/v2/application/run-project-director-operation-worker.ts`, `src/v2/infrastructure/prisma/public-event-outbox.ts`, `tests/v2/prisma-public-operation.integration.mjs`, `tests/v2/public-operation-worker.test.mjs`, `docs/adr/ADR-022-transactional-public-event-outbox.md`. Registrar limite de cobertura por worker/evento e bloqueios individuais, sem proclamar F0.037/F0.038 completos.

<a id="w60"></a>
## W60 — jornada real do master da Imersão

**J.001 / seção `H-019d6f44afde` · IDs:** `41f80ebe5d2a-1`, `57ac9c7f3197-1`, `186dd251b68f-1`, `9eeab33b085e-1`. **Dependência:** W51–W59 aplicáveis, master bruto preservado, percepção/transcrição e providers necessários disponíveis. **Estimativa:** 6–8 h de desenvolvimento indicativo; execução, revisão editorial e CI podem exigir mais tempo e são gates próprios.

Executar **somente se** insumos e dependências reais estiverem acessíveis em ambiente local ou descartável isolado, com rights e custo confirmados. Caso contrário, deixar W60 bloqueada; não usar fake, proxy antigo ou fallback para fabricar J.001. Criar media-only com objetivo, briefing e formato antes da direção; ingerir/normalizar/transcrever/perceber o master e validar alinhamento próprio, sem tomar timestamps antigos como verdade. Pela API V2, persistir Command, TreatmentPlan, StoryPlan, EditPlan, DirectorRun, critic/QualityReport e proxy; aplicar correções por annotation/Command e exportar final reconstruível. Verificar por transcrição e audição que saíram todas as falas de “31 de janeiro”, “1 de fevereiro” e “dois dias/dois dias de aula”, preservando sentido e continuidade. Exigir decisão editorial para esconder cortes difíceis; zero zoom/pan/tilt/punch-in sem motivo registrado, legendas curtas fora de rosto/olhos, enquadramento/transições naturais. Inspecionar **o MP4 final inteiro** e frames críticos, com ffprobe/decode, SHA, manifest, lineage e erro/retry/cancelamento do run; só então atribuir prova individual aos quatro IDs. Fonte: `AGENTS.md` (“Projeto real usado como E2E de recuperação”), `docs/specs/01-director-and-quality.md`, `src/v2/application/run-project-director.ts`, `src/v2/application/recovery-project-acceptance.ts`, `tests/v2/recovery-project-acceptance.test.mjs`, `docs/adr/ADR-141-mandatory-journeys-and-release-gate.md`. Não confundir E2E controlado local, implantação e aceite do proprietário.
