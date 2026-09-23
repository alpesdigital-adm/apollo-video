# Pacote Wave 24 — gate sintético integrado e evidência verificável

## Objetivo

Preparar o próximo pacote vertical do Apollo em quatro slices sequenciais: restaurar a confiabilidade do CI, ligar o
critic ao runtime, coletar evidências autoritativas e provar produção, reuso, fallback, render e revisão pela UI.

O pacote aproveita a implementação parcial existente, sem recriar domínio, persistência, adapters, compiler ou contratos
corretos. Cada slice confirma o código e fecha somente a lacuna demonstrada por teste falsificável.

## Estado-base confirmado em 22/09/2026

- `main` local e `origin/main`: `3c9a2dd79b6bda7c4257c9aa5a8c3197140b20ce`.
- Não há pull request aberto. `output/` já estava untracked e deve ser preservado.
- Worktrees antigos não pertencem a este pacote e não devem ser alterados.
- O [CI `35484066162`](https://github.com/alpesdigital-adm/apollo-video/actions/runs/35484066162)
  falhou no job `Quality and security`, step `Run public API integration tests`;
  o job `Isolated Compose infrastructure` passou.
- A falha está em `tests/v2/public-project-api.integration.mjs:2044`: duas criações concorrentes
  com a mesma idempotency key e payloads diferentes deveriam produzir
  `IDEMPOTENCY_PAYLOAD_MISMATCH`, mas uma delas produziu
  `PERSISTENCE_CONFLICT`.
- Em `src/v2/infrastructure/prisma/webhook-endpoint-creation-repository.ts`, o
  caminho `P2034` faz três tentativas imediatas e, ao esgotá-las, não reconcilia
  o vencedor já confirmado. O caminho `P2002` já lê e valida fingerprint,
  resposta, auditoria, endpoint e secret. Isso orienta a investigação, mas não
  prova sozinho a causa completa da disputa.
- `runSyntheticPhaseGateService` e a persistência PostgreSQL do gate existem.
  Porém,
  `src/v2/infrastructure/prisma/synthetic-phase-gate-repository.ts:184` devolve
  deliberadamente `evidence: []`; a integração PostgreSQL comprova um gate
  verdadeiro e reprovado, sem evidência coletada.
- Não existem capability e rota públicas do gate F3. Os gates encontrados mais
  adiante no registry pertencem a outra fase.
- `evaluateSyntheticCriticService` existe, mas hoje só é consumido diretamente
  por testes. As rotas atuais leem relatórios; o runtime não cria o critic como
  consequência da produção.
- O registry já expõe `synthetic-production-runs` e
  `src/v2/application/synthetic-production.ts` já compila e persiste
  `EditPlan` e snapshot. A lacuna é ligar essa saída ao render e à evidência da
  jornada, não reimplementar o compiler.
- `tests/v2/provider-live-contract.e2e.mjs` exercita providers e grava evidência
  externa, mas não alimenta o gate. Os testes de reuso atuais partem de avatar
  aprovado semeado: provam o comportamento de reuso, não a cadeia desde uma
  geração live.
- Nenhuma versão implantada ou infraestrutura DigitalOcean foi verificada para
  este pacote. O estado acima é local/CI, não estado de produção.

## Regras de execução

1. Iniciar a implementação a partir do SHA acima, depois de confirmar novamente
   `git status`, `HEAD` e `origin/main`, em uma branch nova como
   `codex/wave24-synthetic-gate`.
2. Não carregar alterações de `output/` nem reaproveitar worktree antigo.
3. Concluir os slices na ordem W24.0 → W24.1 → W24.2 → W24.3. Não esconder a
   falha de CI com rerun nem avançar usando teste vermelho como baseline.
4. Preservar arquitetura V2-only, isolamento de tenant, audit context,
   idempotência, rights, consent, lineage e ausência de dados de provider no
   domínio público.
5. Não marcar caixa do `TODO.md` por implementação parcial, fixture, provider
   fake, gate rejeitado ou MP4 não revisado.
6. Este documento não autoriza merge, deploy, gasto em provider, nem acesso ou
   provisionamento de infraestrutura remota. GitHub/CI de desenvolvimento faz
   parte da validação; qualquer runtime remoto do Apollo deve ser DigitalOcean
   previamente confirmado e cumprir integralmente o `AGENTS.md`.
7. Relatar separadamente: especificado, implementado isoladamente, integrado,
   testado ponta a ponta e implantado/aceito; somente o quinto é produto entregue.
8. Na execução futura: Astra orquestra e entrega; Luna lê/audita; Sol escreve;
   Astra revisa, testa e valida antes de qualquer entrega.

Leitura obrigatória antes de implementar: `AGENTS.md`, Brain #1267–#1270, `TODO.md` F3.019,
`docs/PRD-APOLLO-V2.md`, `docs/specs/06-synthetic-providers.md` e `docs/REQUIREMENTS-TRACEABILITY.md`.

## W24.0 — estabilizar a concorrência de criação de webhook

Reprodução determinística em PostgreSQL e correção limitada à criação de
endpoint para que uma disputa serializável reconcilie o vencedor antes de
classificar o resultado, sem relaxar fingerprint, tenant, auditoria, endpoint,
secret ou resposta idempotente.

- Tornar o cenário concorrente de
  `tests/v2/public-project-api.integration.mjs` determinístico o bastante para
  atravessar a disputa que hoje termina em `P2034`.
- Ajustar
  `src/v2/infrastructure/prisma/webhook-endpoint-creation-repository.ts` para
  que o esgotamento da disputa consulte e valide o estado confirmado. A
  reconciliação deve aplicar as mesmas invariantes fortes já exigidas no
  caminho de conflito único; retry cego adicional não é aceite.
- Manter o erro `PERSISTENCE_CONFLICT` para estado ausente, inconclusivo ou
  estruturalmente divergente. Não converter todo `P2034` em mismatch.

### Critérios falsificáveis

- Mesma chave + payloads diferentes em concorrência: exatamente um `201` e um
  `409`; o `409` contém `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Mesma chave + mesmo payload e recuperação após resposta perdida continuam
  convergindo para a resposta original, sem novo efeito.
- Há exatamente um idempotency record, um endpoint, um secret/payload protegido
  e um command de auditoria coerente com o payload vencedor.
- Adulterar fingerprint, audit context, endpoint ou secret continua falhando
  fechado; outro workspace não consegue observar ou reutilizar o resultado.
- `npm run test:integration:api`, `npm run typecheck`, `npm run lint` e os jobs
  equivalentes do CI passam no mesmo commit.

## W24.1 — conectar o critic sintético ao runtime

Todo resultado sintético candidato a master, cache ou produção passa pelo
critic real do Apollo após a ingestão dos artifacts e antes de aprovação ou
reuso. O relatório imutável e localizado é criado pelo runtime, não por chamada
direta de teste.

- Identificar o ponto canônico já existente entre conclusão/ingestão do
  provider job e promoção do master; nesse ponto invocar
  `evaluateSyntheticCriticService` e persistir via
  `PrismaSyntheticCriticReportRepository`.
- Reusar os evaluators implementados em `src/v2/infrastructure/media/` e as
  policies versionadas. Dimensão requerida `unavailable` permanece bloqueante;
  detector controlado continua explicitamente identificado como controlado.
- Fazer promoção, cache e compile consumirem o mesmo relatório persistido, sem
  aceitar aprovação escrita pelo caller ou estado derivado apenas de fixture.
- Preservar leitura pública existente em
  `synthetic-critic-reports` e `synthetic-blocks/.../critic-evidence`.

### Critérios falsificáveis

- Uma jornada PostgreSQL com artifact audiovisual real dispara o critic pelo
  runtime e grava um único relatório com hashes, bloco/range, versão, issues,
  ação e provenance dos evaluators.
- Relatório aprovado habilita o próximo estado apenas quando todas as dimensões
  requeridas têm evidência suficiente; `unavailable`, hash adulterado ou critic
  rejeitado bloqueiam promoção/reuso/compile conforme a policy.
- Retry técnico idêntico converge para o mesmo efeito; retry criativo preserva
  lineage e cria identidade distinta quando a entrada realmente muda.
- `npm run test:integration:synthetic-critic-report` e as regressões focadas do
  runtime passam em PostgreSQL descartável e encerram com zero conexão órfã.

## W24.2 — coletar evidência autoritativa e publicar o gate F3

`readEvidence` projeta recursos reais do servidor e o gate pode ser executado e
consultado pela API pública. O resultado pode ser aprovado, reprovado ou
incompleto; o serviço nunca fabrica aprovação para satisfazer o pacote.

- Substituir `evidence: []` por projeções PostgreSQL tipadas e hash-verificadas
  de provider jobs/results, audio alignment, masters e speech catalog, cache
  decisions, critics de transformação/fallback, production runs e evidência de
  render.
- Mapear separadamente os oito checks de `F3-GATE-001` a `F3-GATE-004`. Em
  especial, distinguir ElevenLabs live com alignment, HeyGen live com áudio
  gerado e HeyGen live com áudio pronto. Provenance armazenada no master ajuda
  a correlação, mas nome/version do adapter não prova que a chamada live ocorreu.
- Para reuso, exigir master bruto aprovado e catalogado, consumo por outro
  projeto/vídeo e zero submit/generation no intervalo observado.
- Para transformação, correlacionar rejeição do resultado original, descida da
  ladder e aprovação do fallback. Para swap, provar que trocar adapter mantém
  os contratos de domínio, `EditPlan` e renderer livres de tipos do provider.
- Para F3-GATE-004, exigir build attestation confiável ligada ao SHA e ao grafo
  de contratos testado; nome de adapter ou metadata declarada não basta.
- Expor run/list autenticados em `/v1`, com schemas, capability registry,
  OpenAPI, contract tests, escopos, idempotência e isolamento de workspace. O
  request informa identidade da versão; não envia a evidência avaliada.
- Atualizar `docs/quality/synthetic-phase-gate-v1.md` para refletir o estado
  comprovado do service/repository/API, sem declarar execução live inexistente.

### Critérios falsificáveis

- Cada referência do relatório resolve para recurso server-owned do workspace,
  com tipo, ID e SHA-256 coerentes; referência ausente, cruzada ou adulterada
  deixa o check descoberto/reprovado.
- Fixture, fake e smoke que apenas grava arquivo externo nunca satisfazem check
  live. Sem as três execuções live de F3-GATE-001, o gate persiste honestamente
  com `approved=false`; a UI deriva “incompleto” de `missing` e da cobertura de
  checks/evidência requerida (`missingChecks`/`missingEvidenceTypes`), sem novo
  enum e preservando `approved`, `covered`, `passed`, `failed` e `missing`.
- Uma fonte controlada marcada pode exercitar o collector positivo no CI apenas
  para checks não-live; ela nunca promove checks live.
- Replay idêntico retorna o registro original; mesma chave com versão/payload
  diferente retorna `IDEMPOTENCY_PAYLOAD_MISMATCH`; concorrência não duplica
  gate nem evidence rows.
- `npm run test:integration:synthetic-phase-gate-pg`,
  `npm run api:v1:validate` e contract/security tests passam.

## W24.3 — provar produção, reuso, fallback, render e revisão

Uma jornada controlada atravessa os services V2 já existentes, compila o
`EditPlan`, materializa um MP4 e exibe o relatório do gate na UI. Uma execução
live separada fornece a prova de provider exigida por F3 quando houver
autorização de gasto e ambiente adequado.

- Evoluir as jornadas existentes para cobrir texto → áudio/alignment → avatar,
  áudio pronto → avatar, promoção/catalogação do master bruto e produção
  sintética com B-roll, legendas e overlays.
- Ligar o `EditPlan` já persistido por `synthetic-production-runs` ao caminho
  canônico de renderer/operation/artifact/QualityReport, sem criar compiler ou
  renderer paralelo.
- Produzir um segundo vídeo/projeto reutilizando o master aprovado e comprovar
  zero nova geração; exercer também transformação rejeitada com fallback
  aprovado e o swap de adapter já coberto estruturalmente.
- Exibir no editor o último gate e seus quatro critérios, checks, referências,
  hashes e o contrato atual. “Incompleto” deriva de `missing` e da cobertura
  (`missingChecks`/`missingEvidenceTypes`), não de novo estado persistido. Incluir loading, vazio, erro e retry, sem segredo,
  payload bruto ou URL permanente.
- Fazer o teste live alimentar as mesmas tabelas e o mesmo collector. O arquivo
  de evidência externo de `provider-live-contract.e2e.mjs`, isoladamente, não
  fecha o gate.

### Critérios falsificáveis

- A jornada controlada usa PostgreSQL, API, runtime, storage e renderer reais;
  gera MP4 decodificável, `RenderInput` materializado, artifact e QualityReport
  correlacionados. O MP4 e frames definidos no teste são inspecionados.
- O segundo vídeo resolve o master catalogado e não cria provider job, reserva
  de custo ou chamada de geração para o trecho reutilizado.
- O fallback aprovado é diferente do resultado rejeitado e mantém intent,
  range, lineage e causa registrada. Trocar adapter não acrescenta enum/campo
  específico de provider ao domínio, `EditPlan` ou renderer.
- Boundaries de provider são testados sem enfraquecer HTTPS, SSRF, ingestão ou
  validação de mídia; rights/consent revogados ou stale bloqueiam uso.
- Restart entre submit e ingestão preserva idempotência e reconcilia por
  `providerJobRef`; submit ambíguo bloqueia nova submissão até conciliação, sem
  prometer retomada ou cobrança única quando o provider não oferece prova. O cleanup prova zero processo, browser, túnel ou conexão órfã do run.
- A UI e a API exibem o mesmo gate; “incompleto”, derivado de `missing` e
  `missingChecks`/`missingEvidenceTypes`, nunca equivale a aprovação.
- `npm run test:e2e:synthetic-production-journey`,
  `npm run test:e2e:synthetic-master-reuse`, testes de render e browser focados
  passam com cleanup completo.

### Resultado controlado W24.3

O run `w24-3-full-journey-c2645167-551e8a1f`, no SHA
`c26451670c6a1c9cec36aa97d085b70edbc07359`, passou 1/1 em 183 s. A jornada
atravessou PostgreSQL, API, workers, storage, compiler, Remotion e UI e reteve
os MP4s A/B, relatórios terminais, gate e frames. A terminou no SHA-256
`ebdb51f115709248f421038ba32983d2da33ac994b672ad3f567d9adb882e03e` e B em
`93c99df84c89813914e5fd97a6297b4d58f74881b4ca83e408d5db3e078d39cb`.
Decode integral e ffprobe passaram; os frames revisados mostram `Olá` em 0,25 s,
`mundo` em 1,25 s, disclosure no topo, B-roll em 0,75 s e overlay em 1,75 s.
Isso prova decodificação e frames definidos, não visualização humana completa
dos dois MP4s.

O projeto B consumiu o master completo aprovado de A com composição distinta e
zero jobs, reservas ou submits de provider em B. Fallback, decisão humana,
checkpoint, quality report, manifest e attestation ficaram ligados à cadeia
persistida. API e browser apresentaram o mesmo gate: 3/4 critérios, 5/8 checks,
`approved=false` e três checks live ausentes. O supervisor observou 68 processos
do run, terminou com zero vivos e zero backends, parou o cluster, liberou a
porta 55571, removeu o scratch e registrou zero erro de cleanup. O checkpoint
local não incluiu CI W24.3; consultar os checks do PR para o commit atual.
Provider live, merge, deploy, aceite e fechamento do TODO permanecem abertos.

## Evidência e encerramento do pacote

| Nível | O que comprova | Limite |
| --- | --- | --- |
| Técnico controlado local/CI | PostgreSQL, API, workers, adapter controlado, renderer, MP4 e UI integrados | Não prova provider live |
| Provider live | Chamadas autorizadas, artifacts ingeridos, alignment, jobs, custos, critic e hashes persistidos | Único nível apto aos checks live de F3-GATE-001 |
| Implantado e aceito | DigitalOcean identificado, gates do `AGENTS.md`, evidência visual e aceite do proprietário | Fora da autorização deste documento |

Ao concluir a implementação, registrar no PR os comandos e runs exatos, IDs e
hashes dos recursos, contagens antes/depois, MP4/frames revisados, resultado de
cada check e cleanup. Se provider live não for autorizado ou estiver
indisponível, entregar W24 tecnicamente integrado com `approved=false` e
`missing` explícito, sem marcar F3 concluída nem transformar ausência em sucesso.

Gate final da branch: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run lint:code`, `npm run domain-language:validate`,
`npm run db:v2:validate`, `npm run api:v1:validate`,
`npm run api:parity:validate` e `npm run build`, além dos dois jobs do CI.
Pós-merge só existe se o merge for autorizado; então confirmar o novo `main` e
seu CI, sem inferir deploy ou aceite.
