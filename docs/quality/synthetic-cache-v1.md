# Cache sintético (F3.008 / FR-105) — evidência v1

> Estado honesto: **especificado, implementado e integrado na branch `claude/f3008-synthetic-cache`, com testes unitários e de integração em PostgreSQL real**. Nada aqui afirma deploy nem aceite. F3.008 permanece **aberta** até integração final, deploy e aceite do proprietário. Nenhuma caixa do TODO foi marcada.

## O que existe

- **Uma única identidade canônica** (`src/v2/domain/synthetic-cache-identity.ts`, ADR-146) para TTS e avatar. A chave de TTS é **byte-idêntica** à `synthetic-block-cache-key/v1` já persistida — congelada por sentinela (`1d49a2d3…`) e comparada contra a implementação anterior —, então nenhuma geração já paga foi orfanada. A de avatar (`1f23325a…`) acrescenta checksum do áudio condutor, referência do avatar, versão do presenter, model, formato, hash de config de render, direção e background.
- **Gate Zero**: existiam três respostas para "isto é o mesmo trabalho?". O `cacheKey` inventado por `splitSyntheticBlocks` (que nenhuma linha persistida jamais usou) foi **removido**, e `synthetic-block-generation.ts` passou a reexportar a identidade canônica.
- **Sentinela de forma**: projeto, versão de projeto, bloco, posição, sequência, ocorrência, plano, consent, custo, moeda, timeout, retry, tentativa, deadline, timestamps, workspace, actor e idempotency key **não podem** entrar no endereço. Consent é elegibilidade, não identidade: caso contrário renovar consent fabricaria regeneração paga e revogar deixaria endereço reutilizável.
- **Ordem vinculante de elegibilidade**: request/workspace → snapshot do presenter → head (vontade atual do ator) → rights e consent → identidade canônica → candidato → critic → blob/checksum → output constraints → `mustRegenerate` → hit. Custo só é reservado depois que um miss sobrevive a essa ordem.
- **Ledger durável** (`synthetic_cache_decisions`): outcome, reason code canônico, motivo textual, candidato, versão de política, hash do critic, economia estimada, custo evitado e hash da decisão. O assunto é guardado como hash domain-separated — nunca o texto, a evidência de consent ou segredo de provider (sentinela de campos proibidos garante).
- **Custo evitado é evidência**: lido da estimativa do provider job que efetivamente pagou pelo candidato, percorrendo a cadeia de generation de origem. Sem essa evidência o reuso **falha fechado** em vez de alegar economia. Somatórios são reportados por moeda, porque somar minor units entre moedas inventaria câmbio.
- **Reclamação durável de submissão** (`synthetic_cache_submission_claims`): a submissão toma um claim no endereço de cache antes de comprometer custo e o libera quando a linha pendente fica visível.

## Provas executadas (2026-08-31, PostgreSQL 16 local)

- `tests/v2/synthetic-cache-identity.test.mjs` — 4/4: sentinelas congeladas e compatibilidade com as chaves persistidas; cada fator audível e visual movendo o endereço; a sentinela de campos proibidos sobre o corpo canônico serializado; identidades malformadas falhando fechado.
- `tests/v2/synthetic-cache-decision.test.mjs` + `tests/v2/prisma-synthetic-cache-decision.integration.mjs` — invariantes do aggregate e, em PostgreSQL real, gravação idempotente por hash da decisão (**replay não duplica economia**), sumário por outcome, isolamento cross-workspace e hidratação fail-closed.
- `tests/v2/prisma-synthetic-cache-invalidation.integration.mjs` — cada modo de invalidação medido em ledger, jobs e chamadas HTTP controladas:

| caso | ledger | jobs | chamadas |
|---|---|---|---|
| bytes mudaram | 1 `miss` / `CACHE_MISS_NO_CANDIDATE` | +1 | +1 |
| direitos restringidos | 1 `miss` / `CANDIDATE_RIGHTS_BLOCKED` | +1 | +1 |
| **blocos reordenados** | **0 linhas** | **+0** | **+0** |
| blob corrompido | 1 `miss` / `CANDIDATE_CHECKSUM_DRIFT` | +1 | +1 |
| output divergente | 1 `miss` / `CANDIDATE_OUTPUT_MISMATCH` | +1 | +1 |
| force malformado (4 variantes) | **0 linhas** | **+0** | **+0** |
| force autorizado | 1 `forced-regenerate` / `MUST_REGENERATE` | +1 | +1 |
| **duas requisições concorrentes** | `blocked` + `miss` | **+1** | **+1** |

  Em todos os casos o artifact e sua linha no ledger de resultados **sobrevivem**: nada é apagado para invalidar cache.

- **Concorrência era um defeito real, medido e corrigido**: duas passadas concorrentes na mesma cache key enfileiravam e pagavam **as duas** (`['enqueued','enqueued']`), porque a checagem de gêmea era ler-depois-escrever. Com o claim durável, exatamente um job e uma chamada acontecem; a corrida foi repetida 3× para confirmar que o resultado é o desenho, não um entrelaçamento de sorte.
- Defeito colateral encontrado e corrigido: um artifact corrompido derrubava a passada inteira de `ensure`; agora degrada para miss **apenas daquele bloco**.

Banco após as migrations desta fatia: **194 tabelas, 996 índices, 769 foreign keys**. Suíte: **1583/1583**.

## Limitações honestas

- **Não existe gate de escopo dedicado para `mustRegenerate`.** Exigir um scope novo em capability já publicada é mudança quebradora e o validador de contrato corretamente recusou. Hoje a autorização é uma ordem motivada obrigatória na fronteira de aplicação — quem força aparece no ledger com o motivo verbatim e o client autorizador. Um gate de escopo real exige bump de versão da capability.
- `CANDIDATE_CRITIC_REJECTED` existe e é emitido quando o job pagador não é verificavelmente aprovado, mas o critic perceptual por dimensão só chega na F3.009; até lá a verificação é estrutural.
- O cache de avatar tem identidade definida e testada, porém o caminho de geração de avatar por bloco ainda não a consome — quem a consome hoje é o caminho de TTS. Isso é modelagem pronta, não fluxo em produção.
- A economia é estimativa do provider registrada no job, não fatura reconciliada.
