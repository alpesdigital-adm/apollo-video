# W61–W70 — Percepção visual real e exportação segura em 9:16 e 16:9

**Plano de execução, 08/10/2026.** Base local e `origin/main`: `252f6bd851b03d3c2728a4820f17b8df71d71bb0`. Os runs CI `37459288317`, `37459288374` e `37459288474` estavam `SUCCESS` nessa base. As dez waves estão planejadas e não iniciadas. W51–W60 têm 38 IDs validados tecnicamente no respectivo recorte, entre 72 IDs técnicos de projeto; 840 IDs individuais ainda não têm comprovação. Não há implantação atual do novo produto comprovada por esta base. O registro canônico continua em `docs/quality/project-status.json` e o TODO não muda por associação ao plano.

## Objetivo e fronteira

Entregar percepção visual produzida a partir de bytes de mídia, persistida com cobertura temporal, proveniência e erro medidos, e usá-la para proteger rosto/olhos, textos e elementos do quadro em dois renders independentes: 9:16 e 16:9. Cada formato terá reframe, placement, crítica e export próprios. Um `bottom` com `faceProtection: true` não comprova que nenhuma legenda cobriu um rosto. Se a percepção necessária estiver ausente, falhar ou for incerta, a decisão vira revisão ou bloqueio explícito; não se inventa `coverage=complete`.

O master bruto da Imersão permanece imutável. O final W60 de SHA-256 `7f6f27805429418d56a98f9bec665da4aefc01763bd778fc1d019a75ceb3c876` é prova histórica, não output destas waves. Os novos 9:16 e 16:9 terão Artifact, manifest, RenderInput e hashes próprios. A revisão do proprietário sobre aquele final não aprova automaticamente os novos arquivos nem o produto global.

Fora do recorte: reconhecer pessoas, inferir gesto/olhar/emoção, gerar mídia, F3/provider live, deploy DigitalOcean e aceite global. Uma tentativa Bailian com 404 não torna Bailian obrigatório nem justifica trocar para um provider pago. A preferência é um detector local CPU, mas a biblioteca/modelo só serão escolhidos após prova de licença, origem dos pesos, hashes, capacidade e custo operacional; sem nomear um pacote por suposição.

## Baseline verificado e lacuna

`run-project-director.ts` constrói a percepção principalmente de palavras do transcript, atribui `visualCoverage=partial`, `faceCoverage=absent` e produz cues `bottom`. Seu hard check `subtitlesFaceSafe` considera `bottom` mais a flag `faceProtection`; falta confrontar pixels/rostos reais. O fluxo W60 avisou `FACE_PERCEPTION_UNAVAILABLE_SAFE_FALLBACK` e passou por revisão visual do arquivo então produzido, mas não instituiu um detector de faces.

`perception-timelines.ts` e a rota pública `/v1/projects/{projectId}/perception` já oferecem timeline, provenance, `GET` por range, `PUT` com CAS/idempotência e isolamento; `PUT` admite observações fornecidas por caller. Tais observações são **manuais/controladas**, jamais evidência de um detector verificado. O Diretor e o reframe precisam resolver snapshot produzido pelo servidor, vinculado a artifact/hash, ProjectVersion e mapa temporal, com rights revalidados. `plan-project-reframe.ts` hoje aceita `observationSet` da chamada; o domínio já possui planejamento de ROI, mas a origem confiável da observação não está amarrada ao consumo do produto.

`subtitle-anchor-plan.ts` já conhece faces, OCR, insert, CTA e logo, faixas elegíveis, estabilidade e bloqueio de face sem localização; são contratos/fixtures úteis. `format-quality-critic.ts` já localiza issues por variante, frame e element IDs. Timeline de entrada e `RenderElementMap` não são crítica independente do MP4: a prova de saída precisa amostrar frames **do arquivo final** com oráculo independente e comparar a geometria realmente renderizada. OCR Tesseract/Sharp já funciona em imagens, inclusive texto pequeno/multilíngue no recorte anterior, mas não constitui automaticamente OCR temporizado, detecção de rosto ou rastreamento de vídeo.

## IDs do TODO selecionados

Os IDs são os hashes literais obtidos de `parseTodo(TODO.md)` na base acima. Um mesmo ID pode participar de mais de uma wave sem criar outra caixa; os quatro de J.001 também já foram selecionados em W60. Uma wave entregue não promove o ID inteiro se seu critério literal for mais amplo que o resultado observado.

| Seção | IDs selecionados | Alcance deste pacote |
| --- | --- | --- |
| F1.014 | `9a30a9b79c59-1` | Caixas reais de faces; objects somente com fonte verificada, senão unavailable; não fecha a caixa ampla |
| F1.016 | `26845752a027-1`, `95648df1db63-1`, `ae8074fdef11-1`, `85514de89d9b-1`, `b543c60be203-1` | Timeline temporal, provenance/API/cobertura e goldens; não declarar nove kinds completos sem prova |
| F1.018 | `76e7e1f536dd-1`, `6a723f9a056c-1`, `99221a4bc2bd-1`, `b73740a47fce-1` | Confiança, bandas, UI e calibração nos tipos realmente avaliados |
| F1.019 | `8662d19a6473-1`, `f3338d39d1ad-1`, `d5d3f39c6aad-1` | Consumo de percepção no TreatmentPlan, limites e decisões auditadas |
| F1.030 | `247f7694a332-1`, `3c5a68e99d79-1`, `a4aa3d1b7ac4-1` | Placement e constraints nos dois formatos; a matriz de cinco canvases permanece fora |
| F1.031 | `eba5d6a20bbd-1`, `0293bff3321f-1`, `4d9bedfd87ea-1`, `da5a414c29b3-1`, `72babc1df6c4-1` | Reframe por ROI, suavização, override, issue e fixtures |
| F1.032 | `68bbd7860ffc-1`, `3f670a796ca3-1`, `65ee578c6695-1`, `fa2bbfa8f082-1` | Crítica específica e eval visual 9:16/16:9 |
| F1.036 | `e388518a7504-1`, `09dcdf656d1d-1`, `19f872a9d137-1`, `d7f581a07db8-1` | Anchor por percepção e bloqueio sem região segura |
| F1.037 | `3bf6a6b94291-1`, `523a307339cd-1`, `5f9c1e599441-1`, `afac8c37ae94-1` | Override de legenda e invalidação por variante/range |
| F1.038 | `92ef89b25708-1`, `60ac0370b814-1`, `dce77836c7bd-1`, `3372d6445ac4-1` | Sidecars derivados das cues efetivamente renderizadas |
| J.001 | `41f80ebe5d2a-1`, `57ac9c7f3197-1`, `186dd251b68f-1`, `9eeab33b085e-1` | Reuso dos quatro IDs W60 para extensão visual em dois outputs; zero itens novos |

**Inventário:** 41 IDs únicos em 11 seções; W61–W70 contêm associações repetidas F1.016/F1.018/J.001, sem contagem dupla. O planejamento não altera os 1.259 IDs nem qualquer checkbox.

## Regras de execução e prova comuns

- O único caminho de produto é Editor V2 → application services V2 → PostgreSQL V2 → operações/workers → Diretor → compiler → renderer → Artifact/QualityReport. ProjectVersion/snapshots permanecem imutáveis; correções usam Commands com base version e conflito explícito.
- Cada capacidade operável precisa `/v1`, capability ID e contract test; sessão humana/API client, workspace e rights são verificados no servidor. Observação `PUT` de cliente é `manual/controlled`, identificada como tal, nunca elevada a observação de detector.
- Produto consome somente snapshot de percepção `server-owned`, content-addressed, ligado a bytes SHA, asset/version, tempo canônico e modelo/versão. Mídia, OCR e transcript são dados não confiáveis, nunca instrução do owner.
- Workers têm lease, idempotência, retry/cancel, timeout, backpressure, cleanup e logs sem segredos. Falha de detector não pode virar sucesso nem passar a face-safe por flag; ausência e cobertura parcial permanecem observáveis.
- Antes do primeiro run, congelar corpus de desenvolvimento e holdout independente, rubrica/limiares propostos de IoU, recall/false negatives em rosto baixo/oclusão, erro de calibração, latência e CPU/RAM em máquina de referência. Os valores serão critérios de aceite definidos **antes** da medição, não resultados inventados aqui. Registrar licença, fonte dos pesos, checksum, build/binário e disponibilidade offline.
- Prova por wave: SHA do código, modelo e source/output; manifest do run, IDs/ranges, banco e artifact reais quando prometidos; asserts positivos e negativos; full decode, ffprobe, frames e revisão visual quando há output; postflight com zero processos/backends do run. CI em `main`, deploy e aceite são estados separados.
- Atualizar status por ID e rastreabilidade apenas ao executar; não usar `TODO.md` como contador automático. Suites nomeadas abaixo são **a construir ou ampliar**; nenhuma referência a elas é alegação de execução.

### Matriz de cobertura a materializar

| Kind / dado | Baseline na base | Evidência mínima para consumo automático |
| --- | --- | --- |
| `transcript-word` | Real no W60, com tempo da fala | Alinhamento original, mapa source→timeline e SHA do transcript |
| `speaker` | Depende do transcript/diarização disponível | IDs temporais observados; desconhecido se diarização não existir |
| `silence` | Dados de áudio existentes em pipeline | Intervalos verificáveis no áudio e remapeamento após Commands |
| `face` | Ausente no DirectorRun W60 | Caixas/intervalos de detector verificado e cobertura por frame amostrado |
| `object` | Indisponível no ramo de imagem quando provider não configurado | Detector ou anotação manual rotulada; não preencher por inferência |
| `shot` | Não alimenta o Diretor como timeline visual completa | Boundaries medidos e confrontados com rótulos independentes |
| `motion` | Reframe aceita observações, mas não as produz de mídia confiável | Movimento/ROI com tempo, magnitude, método e erro medidos |
| `ocr` | Tesseract real para imagem estática | Regiões de frames de vídeo, tempos, texto e confidence com avaliação |
| `image-insert` | Estrutura de inserts/planos existente | Intervalos e geometria do insert realmente compilado/renderizado |

Um kind ausente não se torna `complete` porque outro kind possui cobertura. A timeline conserva intervalos observados, intervalos ainda não avaliados e período total da versão. A distinção entre `absent` (sem observação verificada) e `partial` (somente parte examinada) deve ser revalidada no banco e na resposta pública. `inventedValues: 0` é invariant medido, não campo ornamental.

### Rubrica do corpus congelado antes da W62

1. Selecionar masters e frames com direitos de uso para validação local, separando desenvolvimento, calibração e holdout; registrar SHA e quem anotou cada caixa/frame.
2. Estratificar por 9:16/16:9, rosto alto/baixo, pessoa única/duas pessoas, oclusão, motion blur, iluminação, cor de pele e telas/inserts. Registrar casos sem rosto para false positives.
3. Definir regra de anotação de rosto/olhos e de região ocupada, adjudicar divergências humanas e fixar o método de amostragem de frames antes de rodar o detector.
4. Fixar limiares propostos por estrato para IoU, recall e false negatives de rosto, erro de calibração e false-safe da legenda; publicar as regras de aprovação/review/block antes da medição.
5. Fixar máquina de referência e teto proposto de p95 de latência, CPU, RAM e throughput em material de duração curta e no master real; observar timeouts, fila e cancelamento.
6. Registrar `modelId`, licença, URL/fonte, checksum de weights, formato de inferência, versões de runtime e política de atualização. Mudança de weights invalida calibração e exige novo corpus/run.
7. Nunca calibrar e aferir no mesmo split. Publicar resultados por estrato, inclusive falhas, e manter o holdout sem seleção manual de “bons exemplos” após ver saída.
8. Se não existir modelo local apto/licenciado dentro dos limites, parar W62 em gate explícito. Uma alternativa paga requer nova decisão de orçamento; não é fallback silencioso.

### Handoff observável entre waves

| Wave que entrega | Consumidor | Artefato/contrato e condição para avançar |
| --- | --- | --- |
| W61 | W62–W67 | Envelope server-owned, proveniência/hash, política `unknown` e corpus/limiares congelados |
| W62 | W64–W66 | Face/ROI temporal avaliado em holdout, cobertura explícita e IDs de evidência |
| W63 | W64–W65 | OCR/shot/motion no mesmo timebase, com gaps e erro declarados |
| W64 | W65–W68 | Snapshot consumido pelo Diretor, decisões/critic e bandas versionadas |
| W65 | W67–W68 | Anchor/placement por OutputSpec com blocker e range auditável |
| W66 | W67–W68 | Crop/keyframes/overrides por variante ligados à ProjectVersion |
| W67 | W68–W70 | QualityReport por MP4/hash com amostras de pixels independentes |
| W68 | W69–W70 | Commands de revisão e invalidation/recompile seletivos |
| W69 | W70 | SRT/VTT com cues e hash do arquivo final de cada variant |
| W70 | Registro final | Dois MP4 novos, revisão integral por artifact e falhas preservadas |

Nenhum handoff aceita apenas um tipo ou função pura. Quando a entrega inclui browser, worker ou MP4, o consumer recebe resultado observável do caminho V2 executado e um postflight limpo.

## W61 — contrato de observação verificável e fail-closed (8–12 h)

**IDs:** F1.016 `95648df1db63-1`, `ae8074fdef11-1`, `85514de89d9b-1`; F1.018 `76e7e1f536dd-1`. **Depende de:** contrato V2/PG já existente; precede W62–W67.

Corrigir primeiro o hard check do Diretor: `bottom + faceProtection` é intenção de layout, não prova de segurança. Sem cobertura de faces verificada, expor `unknown/review` e impedir aprovação automática de face-safe; manter a explicação de falta de percepção para a UI/API. Definir envelope imutável de observação com source artifact SHA, ProjectVersion, source/timeline timebase e transformações de corte, producer/model/weights hash/license/version, confidence, geometry/range, coverage e reason codes. `PUT /v1/.../perception` conserva origem manual quando for caller-supplied; worker próprio sela observações de detector em rota/application service autorizados, com CAS/idempotência e audit.

Congelar corpora e critérios quantitativos propostos antes dos runs. Fazer preflight de modelo local CPU: licença comercial compatível, provenance dos pesos, checksum, método de obtenção reproduzível, limites de RAM/CPU/latência, offline e falha segura se ausente. Antes de obter os pesos, verificar licença, origem, digest esperado e limites propostos. Após a obtenção autorizada durante a execução, confirmar o digest e medir desempenho em spike isolado; só liberar W62 se os critérios forem atendidos. **Provas:** contrato/API/PG de workspace, rights, replay, stale base, hash adulterado, clock/corte, producer falso e falha do modelo; regressão do antigo `subtitlesFaceSafe=true` indevido e `unknown` propagado. **Saída:** spec/version e pacote de evidência com corpus congelado e preflight, sem declarar detecção pronta.

## W62 — faces e regiões detectadas nos bytes (8–12 h)

**IDs:** F1.016 `26845752a027-1`, `95648df1db63-1`; F1.018 `b73740a47fce-1`; F1.014 `9a30a9b79c59-1` somente no subescopo faces/boxes. **Depende de:** W61 e preflight do modelo local.

Implementar adapter/worker novo que decodifica frames por tempo de fonte, detecta caixas de rosto e regiões de interesse, faz tracking conservador entre amostras e grava observações seladas. Registrar intervalos não vistos como `absent`/`partial`, não interpolar rosto através de cortes ou oclusão sem evidência. Não inferir identidade, emoção ou olhar. Expor comparação source→timeline com offsets dos Commands e preservar direitos sobre o master.

**Provas:** corpus independente congelado com uma/duas pessoas, rosto inferior, oclusão, plano aberto, tela sem pessoas e inserts; comparar caixas com anotação humana, reportar IoU, misses/false positives, calibration error, latência/CPU e cobertura por estrato frente aos limiares pré-registrados. PG/worker reais para retry, cancel, perda do modelo, direitos revogados e nenhum objeto publicado em falha. Se threshold falhar, estado `review/block` e wave parcial; não selecionar só frames favoráveis.

## W63 — OCR, shots e motion na mesma timeline (8–12 h)

**IDs:** F1.016 `26845752a027-1`, `b543c60be203-1`, `85514de89d9b-1`; W57/F1.014 apenas como base de OCR de imagem, não conclusão de vídeo. **Depende de:** W61; pode desenvolver OCR/shot em paralelo à W62, integração serial.

Ampliar o OCR Tesseract/Sharp para amostras de vídeo com regiões e intervalo, detectar cortes/shot boundaries e movimento mensurável de câmera/objeto com source time. Fundir words/speakers/silence, faces, OCR, shots, motion e inserts em timeline canônica ordenada. `object` fica ausente quando não existir detector verificado; o pedido literal de nove kinds F1.016 não fecha por preencher um objeto fictício. Ranges não vistos e diferenças de fps/PTS são preservados.

**Provas:** goldens independentes de talking head, áudio sem face e imagens inseridas, além de texto pequeno/multilíngue, hard cut, crossfade, motion e tempo após cortes. Comparar OCR e boundaries contra labels externos, testando duplicatas, gaps, reorder, fonte adversarial e replay PG. `GET /v1/.../perception` deve retornar range/kind/coverage/provenance com isolamento e sem inventar `complete`.

## W64 — Diretor usa percepção persistida com confiança (6–10 h)

**IDs:** F1.019 `8662d19a6473-1`, `f3338d39d1ad-1`, `d5d3f39c6aad-1`; F1.018 `76e7e1f536dd-1`, `6a723f9a056c-1`. **Depende de:** W61–W63.

No claim do Diretor, resolver o snapshot do servidor ligado à ProjectVersion/Artifact e revalidar workspace, rights, hash e time mapping. Usar regiões e coverage reais no TreatmentPlan, Story/EditPlan, decisions log e critic; a rubrica distingue evidência alta, parcial e ausente. Bandas auto-apply/review/block específicas para crop, legendas e inserts ficam versionadas; rights exige certeza integral. `observationSet` passado pelo caller não substitui detector verificado em plano automático.

**Provas:** PG/API/worker com versão stale, rights revogado, percepção ausente/parcial, confiança baixa e replay. O oráculo confere snapshots/Commands/DirectorRun/QualityReport persistidos e decisões com evidence IDs; sem observação, o plano marca review/block em vez de reaproveitar a flag antiga.

## W65 — anchor e placement por variante (6–10 h)

**IDs:** todos F1.036 (`e388518a7504-1`, `09dcdf656d1d-1`, `19f872a9d137-1`, `d7f581a07db8-1`); três primeiros F1.030 (`247f7694a332-1`, `3c5a68e99d79-1`, `a4aa3d1b7ac4-1`). **Depende de:** W62–W64.

Alimentar o solver existente com boxes de face/OCR/inserts verificados e placement resolvido de CTA/logo, em tempo e canvas da variante. Testar cinco faixas, margem/estabilidade temporal, colisão e bounds de 9:16/16:9 sem compartilhar coordenadas absolutas. Se o rosto não foi medido ou não cabe legenda segura, bloquear a cue/variante ou exigir revisão explícita; nunca “bottom por padrão” como aprovação.

**Provas:** oráculo de boxes e pixels finalizados para rosto inferior, fullscreen, múltiplos overlays, safe area estreita e ausência de detector; `IMPOSSIBLE_CONSTRAINTS`/`NO_SAFE_SUBTITLE_REGION` com range, cue e variant. Goldens de dois canvases são parte deste recorte; o ID F1.030 de 20 placements nos cinco formatos permanece fora.

## W66 — reframe com trajetória e override por formato (6–10 h)

**IDs:** todos F1.031 (`eba5d6a20bbd-1`, `0293bff3321f-1`, `4d9bedfd87ea-1`, `da5a414c29b3-1`, `72babc1df6c4-1`). **Depende de:** W62–W64; integra com W65.

Resolver ROI face/object/screen do snapshot do servidor, produzir keyframes 9:16 e 16:9 separados e suavizar velocidade/aceleração sem cortar sujeito. Overrides manuais viram Commands por variant/range, com base version e precedence clara; nunca alteram observação bruta. Se dois sujeitos não couberem ou a evidência for incerta, gerar issue localizado e manter a variante bloqueada/revisável.

**Provas:** fixtures uma/duas pessoas, tela e objeto móvel; comparação frame-a-frame com GT de visibilidade, limite de velocidade e safe margin; API/PG de override, stale/replay, rights e reconstrução determinística do RenderInput.

## W67 — crítica independente do arquivo de cada formato (6–10 h)

**IDs:** todos F1.032 (`68bbd7860ffc-1`, `3f670a796ca3-1`, `65ee578c6695-1`, `fa2bbfa8f082-1`). **Depende de:** W65–W66.

Além do plano e `RenderElementMap`, amostrar frames **do MP4 efetivamente renderizado** e aplicar oráculo independente sobre rosto/olhos, clipping, safe area, legenda, CTA e densidade. O ground truth de rosto/olhos usa holdout com caixas adjudicadas antes do run, independente do detector, calibrador e Diretor usados no produto; não repetir o mesmo detector como único oráculo. Selar sample IDs, output hash, percepção/calibration version e frame range no QualityReport. Uma falha vertical reprova apenas 9:16; 16:9 só passa por sua própria prova. Critic bloqueado impede promoção/export da variante, mantendo StoryPlan canônico intacto.

**Provas:** dois outputs controlados com defeitos semeados independentemente (legenda sobre rosto, crop perdido, CTA fora de safe area) e um sem defeito; comparar reports com labels antes do run, verificar precisão/recall definidos em W61, captura visual, full decode e ausência de artifact promovido na variante bloqueada.

## W68 — issues até override e recompilação na UI (6–10 h)

**IDs:** todos F1.037 (`3bf6a6b94291-1`, `523a307339cd-1`, `5f9c1e599441-1`, `afac8c37ae94-1`); F1.018 `99221a4bc2bd-1`. **Depende de:** W65–W67.

Na UI V2, abrir issue por frame/range/elemento e mostrar chips de `review/block` sem esconder evidence/provenance. Aplicar position/style/text/visibility de uma cue por Command, variant e range; proteger override, permitir reset para nível herdado e invalidar só o necessário. Recompilar proxy/final da variante e repetir critic com pixels novos; a outra variante e a ProjectVersion anterior continuam imutáveis.

**Provas:** browser real + API/PG/worker em 9:16 e 16:9, incluindo sessão expirada, acesso cruzado, stale base, replay, cancelamento e reset. Capturas antes/depois com cue e hash; zero aceitação implícita por clicar “resolver”.

## W69 — sidecars do alignment final (4–6 h)

**IDs:** todos F1.038 (`92ef89b25708-1`, `60ac0370b814-1`, `dce77836c7bd-1`, `3372d6445ac4-1`). **Depende de:** W68 e output final por variante.

Derivar SRT/VTT exclusivamente das `RenderedCue` efetivamente usadas no arquivo de cada formato após cortes, override e recompile. Preservar Unicode NFC/UTF-8, quebras, pontuação, última cue e timestamps monotônicos sem overlap inválido. Sidecar referencia hash do MP4/RenderInput e variant; não exportar sidecar de versão stale ou render reprovado.

**Provas:** round-trip parser independente com `Ação`/`Última cue.`, duração/cue boundaries comparados a frames finais, teste de override e saída `none`; API/storage reais para autorização, hash, download, replay e mismatch.

## W70 — master real, dois MP4 e revisão de falhas (8–12 h)

**IDs compartilhados com W60:** J.001 `41f80ebe5d2a-1`, `57ac9c7f3197-1`, `186dd251b68f-1`, `9eeab33b085e-1`. **Depende de:** W61–W69 completos em seus subescopos aplicáveis.

Reexecutar a jornada V2 do master original preservado com Commands de corte, percepção visual verificável, Diretor, proxy, annotation/override e final **separado** em 9:16 e 16:9. Validar continuidade da fala, datas/duração removidas, enquadramento, safe area e legenda diante de rosto/olhos em ambos. Testar detector indisponível, oclusão, duas faces, OCR sobreposto, rights revogados, version stale, retry/cancel e uma variante reprovada sem contaminar a outra. Não reaproveitar aprovação ou hash do W60 como se fossem dois novos renders. W70 adiciona evidência do subescopo visual aos mesmos IDs J.001, preserva o status técnico do recorte W60 e não encerra integralmente a seção J.001.

**Prova final:** manifests e SHA-256 de source, pesos, timeline, cada RenderInput, cada MP4, sidecar e QualityReport; ffprobe/full decode dos dois arquivos; sheets de frames da timeline inteira e cortes, amostras independentes do critic, audição/revisão humana integral de ambos e registro do proprietário para **cada novo artifact**. Se qualquer caso crítico ficar `unknown`, review/block permanece e o pacote é parcial. A confirmação de dois arquivos não equivale ao aceite global do produto nem a deploy.

## Sequência, estimativa e handoff

| Frente | Ondas | Pode avançar em paralelo após W61 | Integração serial |
| --- | --- | --- | --- |
| Percepção e eval | W62–W63 | detector, OCR/shot/motion e corpus | timeline selada, calibração, W64 |
| Layout e render | W65–W67 | fixtures de anchor, ROI, critic | observações verificadas, outputs e critic final |
| Experiência e export | W68–W69 | UI/sidecar em contratos existentes | Commands, recompilação e W70 |

Estimativa indicativa: **66–104 h** de desenvolvimento (W61–W70 conforme cada título), fora CI, revisão externa e disponibilidade do master. Um único owner integra schema, contracts, capability registry/composition root, CI, status e Git; worktrees, banco, portas e processos de prova têm ownership isolado e cleanup terminal. Antes de executar cada wave, ler AGENTS.md, TODO e registro, confirmar SHA/CI, reavaliar prova existente e registrar a lacuna exata. Nenhum TODO ou estado `validado` é inferido deste plano.
