# F2.005 — Busca híbrida v1

## 1. Resultado do slice

Este gate cria o índice unificado usado pelo Diretor para localizar artifacts,
falas, provas, momentos de vídeos longos e segmentos validados. A busca combina:

- filtros estruturados;
- full-text em transcript e OCR;
- intenção e descrição semânticas com `pgvector`;
- situação atual de direitos e consentimento;
- deduplicação por identidade da fonte;
- reranking versionado e explicável.

O índice é virtual. Catalogar uma fonte não copia, recodifica nem materializa
arquivos de mídia.

## 2. Fontes e documento pesquisável

`semantic-search-document/v1` aceita cinco tipos de fonte:

- `artifact`;
- `speech-segment`;
- `evidence-segment`;
- `long-form-moment`;
- `validated-segment`.

Artifact, projeto, locale, duração, transcript, pessoas, intenções, metadados e
direitos já conhecidos são sempre resolvidos pelo servidor. O cliente pode
anexar observações de OCR, descrição, intenção, pessoas e metadados, todas
vinculadas a provider, model, version e confidence.

Cada documento preserva:

- identidade e hash exatos da fonte;
- artifact e SHA-256 de origem;
- kind, duração, locale e pessoas;
- transcript, OCR, intenções, descrição e metadados;
- produtor das observações;
- provider/model/version do embedding;
- hash da entrada e do vetor;
- snapshot de direitos usado na indexação;
- policy, ator, instante e hash canônico do documento.

Um novo documento para a mesma `sourceType:sourceId` desativa o anterior sem
apagá-lo. Um índice parcial único garante apenas uma identidade ativa por
projeto.

## 3. Full-text, vetor e reranking

O PostgreSQL mantém:

- `tsvector` ponderado, com transcript e OCR em peso A, intenção e descrição em
  peso B e metadados em peso C;
- índice GIN para full-text;
- índice trigram para tolerância a pequenas variações;
- vetor com 256 dimensões;
- índice HNSW com distância cosseno.

Em produção, o adapter padrão usa `text-embedding-3-small` quando
`OPENAI_API_KEY` está configurada. O adapter determinístico é marcado como
degradado e só pode ser selecionado explicitamente em banco E2E isolado quando
`NODE_ENV=production`.

Se o provider de embedding estiver indisponível, o documento continua
pesquisável por full-text e filtros, com `embedding.state=unavailable`.

O `hybrid-rerank/v1`:

1. une candidatos full-text, fuzzy, vetoriais e estruturados;
2. exige sinal de relevância quando há texto ou intenção;
3. reavalia filtros e direitos no domínio;
4. deduplica por identidade da fonte;
5. prioriza itens reutilizáveis;
6. ordena por score e identidade estável;
7. aplica o limite solicitado.

O gate de relevância aceita termo efetivamente encontrado, fuzzy forte
(`fullText >= 0,2`), intenção correspondente ou vetor significativo
(`vector >= 0,35`). Similaridade residual do trigram não é suficiente para
retornar um documento.

## 4. Filtros, direitos e explicações

Filtros disponíveis:

- kind;
- uma ou mais pessoas;
- duração mínima e máxima;
- locale;
- pares exatos de metadados;
- direitos aprovados, bloqueados ou ambos.

`rightsUse` é obrigatório. A busca lê o snapshot atual do artifact em cada
consulta e bloqueia:

- snapshot ausente ou desatualizado;
- status ou consentimento incompatível/expirado;
- uso não permitido ou explicitamente proibido;
- qualquer filtro estruturado divergente.

Com `includeBlocked=false`, somente itens reutilizáveis são retornados. Com
`includeBlocked=true`, itens incompatíveis também aparecem para auditoria.
Cada resultado declara:

- `matchedBy`;
- `blockedReasons`;
- `eligibleForReuse`;
- score total e decomposição;
- policy exata do reranking.

## 5. Contratos públicos

### Catalogar documento

- Capability: `apollo.projects.semantic-search.documents.catalog`
- Método: `POST`
- Rota:
  `/v1/projects/{projectId}/semantic-search/documents`
- Scope: `projects:write`
- Idempotência: obrigatória

### Consultar

- Capability: `apollo.projects.semantic-search.query`
- Método: `POST`
- Rota:
  `/v1/projects/{projectId}/semantic-search/query`
- Scope: `projects:read`

### Avaliar retrieval

- Capability: `apollo.projects.semantic-search.evaluations.create`
- Método: `POST`
- Rota:
  `/v1/projects/{projectId}/semantic-search/evaluations`
- Scope: `projects:write`
- Idempotência: obrigatória

As três operações estão publicadas na API HTTP, capability discovery, OpenAPI,
schemas versionados, exemplos e catálogo de ferramentas para agentes. O
`workspaceId` vem exclusivamente da credencial Bearer e campos desconhecidos
são recusados.

## 6. Retrieval evaluation

`retrieval-eval/v1` executa de 1 a 50 casos contra o mesmo application service
da busca pública. Cada caso contém uma consulta e as identidades consideradas
relevantes.

O relatório imutável registra, por caso e em macro:

- precision@k;
- recall@k;
- nDCG@k;
- reciprocal rank;
- hits, quantidade relevante e quantidade retornada.

O relatório preserva query hash, estado semântico, policy de avaliação, policy
de reranking, ator, instante e hash canônico.

## 7. Persistência e concorrência

As tabelas `semantic_search_documents` e `retrieval_evaluations` possuem
constraints para tipos, hashes, policies, dimensão do vetor, estado do
embedding, ranges, atores e ausência de materialização física.

A persistência:

- usa transação serializável;
- revalida projeto, source hash, vínculo do artifact, ator e direitos antes do
  commit;
- promove embedding e vetor atomicamente;
- tenta novamente conflitos serializáveis de forma limitada;
- colapsa chamadas concorrentes com a mesma idempotency key;
- rejeita reutilização da chave com payload diferente.

## 8. Evidência automatizada local

Banco isolado `apollo_video_v2_e2e_speech`:

- 59 migrations aplicadas do zero;
- extensão `vector` e `pg_trgm`;
- 60 tabelas, 298 indexes e 210 foreign keys;
- `T-FR-048`: 9/9 testes de domínio/adapters;
- integração API/PostgreSQL: 1/1;
- regressão integral: 506/506;
- build Next.js 16.2.12: aprovado;
- typecheck, arquitetura e linguagem de domínio: aprovados;
- contratos: 103 capabilities, 172 schemas, 200 exemplos e 85 paths;
- auditorias do app e renderer: zero vulnerabilidades conhecidas.

O E2E comprova:

- catálogo HTTP 201 e replay HTTP 200;
- conflito por payload diferente e source hash desatualizado;
- embedding de 256 dimensões persistido e pesquisado no PostgreSQL;
- full-text, OCR, intenção, descrição e metadados;
- filtros de kind, pessoa, duração, locale, metadata e direitos;
- concorrência com uma única identidade idempotente;
- reindexação com histórico preservado e somente um documento ativo;
- deduplicação da identidade;
- explicações de match e bloqueio;
- exclusão de falso positivo fuzzy residual;
- ocultação e exposição auditável de itens bloqueados;
- precision, recall, nDCG e reciprocal rank persistidos;
- rejeição de campos desconhecidos e acesso sem credencial;
- constraints SQL e zero novos artifacts físicos.

## 9. Evidência de produção

Esta seção só será preenchida após backup, migration, deploy e smoke autenticado
da mesma revisão. Até lá, o F2.005 permanece desmarcado no `TODO.md`.
