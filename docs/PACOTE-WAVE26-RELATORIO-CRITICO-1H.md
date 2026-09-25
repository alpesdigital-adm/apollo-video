# Wave 26: abrir relatório crítico pelo link do gate (pacote de até 1 hora)

## Resultado limitado

Adicionar leitura pública por ID de um `transformation-critic-report` já persistido. O gate passa a oferecer link direto somente a quem recebe a capability exata `apollo.projects.transformation-critic-reports.get`. A rota `GET /v1/projects/{projectId}/transformation-critic-reports/{reportId}` exige autenticação e `projects:read`, consulta pelas três identidades (workspace, projeto, relatório) e devolve `data.report` com campos públicos explícitos. Nenhuma transformação ou avaliação nova é disparada pela leitura.

Este pacote não cria schema de banco, migration, provider, job, render, comparação, exportação ou mudança no cálculo do gate. Não altera o comportamento de leitura em lista já publicado em `transformation-quality`. O relatório crítico de transformação é distinto do crítico sintético.

## Mapa de alterações

- `src/v2/application/transformation-quality.ts`: query com escopo e consulta ao port existente `readCriticReport`.
- `src/app/v1/projects/[projectId]/transformation-critic-reports/[reportId]/route.ts`: GET público, query string vazia, erro padrão.
- `src/v2/public-api/{capability-registry,schema-registry,schema-examples,transformation-quality-contract}.ts`: capability, schema fechado, exemplo e projeção explícita.
- `src/v2/ui/synthetic-phase-gate-addresses.ts`: endereço condicionado à capability exata.
- `tests/v2/{transformation-critic-report-read,synthetic-phase-gate-addresses}.test.mjs` e helper da jornada Wave 24: isolamento, contrato e clique real.
- `docs/REQUIREMENTS-TRACEABILITY.md`: vínculo com FR-116; documentação pública gerada em `generated/public-api/` pelo script existente.

## Prova falsificável

O teste unitário deve observar a chave completa enviada ao repositório, aceitar o relatório correto, negar outro projeto, workspace ou falta de escopo, e provar que propriedades internas extras do objeto persistido e de seus filhos não vazam. A jornada browser deve clicar no link real de uma referência persistida, ler `id`, `reportHash`, `decision` e projeto coerentes, voltar ao painel, e exigir 401/`AUTH_INVALID` anônimo, 422/`ASSET_NOT_FOUND` para outro projeto existente e 422/`INVALID_ARGUMENT` para query desconhecida, conforme o catálogo público atual. O relatório continua sujeito ao hash validado pelo repositório real. Teste de fonte ou mock de transporte isolado não substitui essa prova de browser/PG.

Comandos de verificação: `node --test tests/v2/transformation-critic-report-read.test.mjs tests/v2/synthetic-phase-gate-addresses.test.mjs`; `npm run api:v1:validate`; `npm run api:v1:docs:build`; `npm run typecheck`; `npm run lint`; `npm run test:e2e:synthetic-wave24-journey` na configuração supervisionada e isolada do CI. Não improvisar credenciais, não usar Hostinger, não executar carga em produção DigitalOcean.

## Limite e estado

Janela de uma hora: 25/09/2026 19:52–20:52 UTC. Reservar a parte final para revisão, CI do commit exato e cleanup. Se fila ou infraestrutura externa consumir o prazo, parar com checkpoint verificável e pendências abertas; tempo decorrido não equivale a aprovação. No momento de escrita, a implementação local e os testes unitários focados estão presentes; CI, jornada browser, merge, deploy e aceite ainda não foram comprovados neste pacote. Não marcar TODO como concluído por este recorte.
