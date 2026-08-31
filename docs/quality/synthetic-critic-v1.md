# Crítico sintético (F3.009 / FR-106) — evidência v1

> Estado honesto: **especificado, implementado e integrado na branch `claude/f3009-synthetic-critic`, com testes unitários, eval set versionado e integração em PostgreSQL real**. Nada aqui afirma deploy nem aceite. F3.009 permanece **aberta** até integração final, deploy e aceite do proprietário. Nenhuma caixa do TODO foi marcada.

## O que existe

- **Relatório versionado e imutável** `synthetic-critic-report/v1`, content-addressed e localizado por bloco/range: capability, adapter e versão, artifact e checksum avaliados, áudio/alignment/script usados, snapshot do presenter e identidade esperada, evaluators, measurements, issues, decisão, ação recomendada, versão dos thresholds e hash.
- **Toda dimensão responde**: lip-sync, identidade, pronúncia, artefatos visuais, enquadramento, continuidade, olhos, dentes, mãos, integridade temporal e integridade audiovisual — cada uma com `measured`, `not-applicable` ou `unavailable`. Silêncio sobre uma dimensão é recusado na construção **e** por CHECK do PostgreSQL (22 constraints na migration).
- **Fronteira declarada dos evaluators**:
  - `measured` (instrumento leu do artifact): integridade temporal e audiovisual via ffprobe/ffmpeg (duração vs. esperada, codecs, frames, presença de áudio, freeze) e pronúncia via comparação palavra a palavra do alignment com o roteiro aprovado.
  - `controlled` (detector determinístico **nomeado**, substituindo modelo não implantado): lip-sync, identidade e continuidade. **Nunca** reportado como validação visual de produção.
  - `unavailable` (sem modelo): artefatos visuais, enquadramento, olhos, dentes, mãos — com nota escrita explicando.
- **`evidence-unavailable` nunca é aprovação.** Capability que exige uma dimensão e a recebe indisponível falha fechado.
- **Ação vem da causa**, não de score agregado: uma tabela de causas mapeia cada falha para `retry`, `fallback` ou `manual-review`, e a causa fica registrada na evidência da issue.
- **Thresholds versionados por capability** (`synthetic-critic-thresholds/<capability>/v1`), com hard gates: identidade incompatível, palavra crítica omitida, blob corrompido, lip-sync abaixo do limite, frame/duração incompatível, evidência obrigatória ausente e alteração fora dos direitos.
- **Gates integrados**: só relatório aprovado e persistido sela master; reprovado não entra no cache elegível (`CANDIDATE_CRITIC_REJECTED`); retry afeta apenas seu bloco; artifact válido anterior é preservado.

## Provas executadas (2026-08-31, PostgreSQL 16 local)

- `tests/v2/synthetic-critic-report.test.mjs` — 4/4: toda dimensão respondida; dimensão não medida não carrega valor nem confiança e precisa dizer por quê; evaluator precisa estar listado e a evidência referenciada; `evidence-unavailable` não é aprovação; aprovação não carrega issue bloqueante nem ação; rejeição localiza issue; relatório adulterado falha fechado.
- `tests/v2/synthetic-critic-evals.test.mjs` — eval set versionado `synthetic-critic-eval-set/v1` com **14 casos**, mídia sintetizada por ffmpeg (não pelo código sob teste) e vereditos declarados à mão:

| caso | decisão | ação | causa |
|---|---|---|---|
| clean-take | approved | none | — |
| muted-audio | rejected | retry | audio-silent |
| frozen-video | rejected | fallback | video-frozen |
| duration-drift | rejected | retry | duration-drift |
| omitted-word | rejected | retry | word-omitted |
| added-word | needs-review | manual-review | word-added |
| empty-alignment | **evidence-unavailable** | manual-review | required-evidence-missing |
| corrupt-blob | rejected | retry | blob-undecodable |
| identity-mismatch | rejected | fallback | identity-mismatch |
| outside-rights | rejected | manual-review | change-outside-rights |
| silence-window | needs-review | manual-review | audio-silence-window |
| continuity-break | needs-review | manual-review | continuity-break |
| audio-video-offset | rejected | fallback | lip-sync-below-threshold |
| speech-only-clean (tts) | approved | none | — |

- `tests/v2/prisma-synthetic-critic-report.integration.mjs` — PostgreSQL real: gravação idempotente por hash, leitura por bloco e por artifact, hidratação fail-closed cruzando linhas filhas com o blob hasheado.

Banco após a fatia: **198 tabelas, 1010 índices, 780 foreign keys**. Suíte: **1607/1607**.

## Limitações honestas — leia antes de confiar

- **Lip-sync, identidade e continuidade são medidos por detector controlado**, não por modelo perceptual de produção. Isso está no próprio relatório (`kind: 'controlled'` + `scope`) e não deve ser lido como validação visual. Um modelo real substituiria o adapter sem mudar o contrato.
- **Artefatos visuais, enquadramento, olhos, dentes e mãos não são avaliados**: ficam `unavailable` com nota. Uma capability que os exija falha fechado em vez de aprovar.
- `confidence` é `null` em todas as dimensões: nenhum modelo de confiança produziu números, e carimbar 1 ou 0,5 seria inventar. O que qualifica a leitura é o `kind` e o `scope` do evaluator.
- Os limites (34 ms de deriva de duração, 40 ms de offset de lip-sync) são **política declarada**, não medição empírica calibrada.
- O eval set cobre falhas conhecidas e sintéticas; não substitui avaliação humana sobre material real de produção.

## Fronteira do E2E combinado — o que a jornada NÃO atravessa, e por quê

A jornada combinada (`tests/v2/synthetic-production-journey.e2e.mjs`) atravessa plano, geração por blocos, reprovação por evidência mensurável, retry isolado, decisões de cache, consent revogado, isolamento cross-workspace, concorrência, equivalência e divergência de config, e `mustRegenerate` autorizado. Ela **não** atravessa promoção de master, compilação de MP4 e reuso entre projetos — esses estão provados em `tests/v2/synthetic-master-reuse.e2e.mjs`, que roda a promoção real via `/v1` com PostgreSQL real e mede zero chamada de provider.

O motivo é estrutural e vale registrar como decisão, não como omissão:

1. **O leg de avatar não pode rodar contra loopback sem enfraquecer o produto.** O único adapter de avatar registrado é o HeyGen, cuja ingestão passa pelo `SafeProviderResultDownloader`: exige `https:`, porta 443, endereço público (`isPublicWebhookAddress`) e TLS verificado. Um servidor controlado em 127.0.0.1 é rejeitado por construção — que é justamente a proteção contra SSRF funcionando. Fazer o avatar falar com loopback exigiria expor base URL do HeyGen **e** relaxar o https do adapter **e** furar a validação de endereço do downloader. Enfraquecer uma defesa real para um teste passar não é uma troca aceitável; a promoção de master é exercitada com o job aprovado como fixture declarada, exatamente como o E2E de reuso já faz.
2. **Não existe rota `/v1` que compile MP4 a partir de um `SyntheticMasterAsset`.** A única compilação sintética exposta hoje é de áudio (`synthetic-script-plans/{planId}/audio-compilations`). Um MP4 real é verificado com ffprobe nos goldens de render, não a partir do master.
3. **O crítico não tem caminho de escrita por HTTP.** As rotas `synthetic-critic-reports*` são somente leitura; a avaliação é dirigida pelo serviço com os adapters reais (ffprobe e alignment) sobre bytes reais. Isso é medição real, mas não é "via `/v1`".

Fechar os três exige decisão do proprietário sobre superfície de segurança e de API — não cabia resolver dentro de um teste.
