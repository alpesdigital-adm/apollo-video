# Apollo Video — instruções vinculantes para agentes

## Leia antes de qualquer ação

Este arquivo existe para impedir a repetição de um incidente grave de avaliação e arquitetura ocorrido em 18 de julho de 2026. Ele prevalece sobre documentação histórica, comentários antigos, checklists anteriores e qualquer suposição baseada no código existente.

Se uma tarefa conflitar com estas regras, pare e exponha o conflito. Não contorne estas regras com uma flag, adapter temporário, fallback ou promessa de migração posterior.

## O incidente que não pode ser esquecido

O projeto foi reportado como “100% concluído” porque 1.247 de 1.255 caixas do `TODO.md` estavam marcadas. Essa medição estava errada.

O que realmente havia acontecido:

- documentação, tipos, funções puras, fixtures e testes com fakes foram contabilizados como produto entregue;
- várias tarefas descritas como parciais estavam marcadas como concluídas;
- jornadas chamadas de E2E não comprovavam o produto real em produção;
- a GUI nova era apenas uma nova aparência sobre o projeto e o pipeline antigos;
- o projeto de teste ainda acionava rotas `/api/process/*`, `analyzeContent()`, o `narrativeEngine` antigo, `scenesJson/editPlanJson` e SQLite;
- briefing e formato não estavam integrados ao Diretor que efetivamente rodava;
- o primeiro resultado exibiu zoom sem justificativa e legenda sobre o rosto;
- não existia um gate arquitetural que impedisse UI nova de chamar runtime antigo;
- não houve validação do MP4 final antes da alegação de conclusão.

O problema não foi uma regressão causada pela auditoria. O “100%” nunca representou um Apollo novo integrado. A auditoria apenas corrigiu a medição e revelou o estado real.

## Estado auditado

Após a auditoria conservadora de 18 de julho de 2026:

- 84 de 1.258 microtarefas estão comprovadamente concluídas: **6,7% do PRD completo**;
- 1.174 microtarefas estão abertas ou aguardando comprovação integrada;
- o denominador aumentou em três itens quando autenticação humana, isolamento de agentes e hardening de sessão foram decompostos explicitamente; nenhuma tarefa antiga foi apagada para melhorar o percentual;
- a base técnica nova reaproveitável foi estimada em 20–25% do necessário para o primeiro E2E V2;
- faltam aproximadamente 75–80% da jornada executável necessária para esse primeiro teste;
- `TODO.md` é a fonte do status auditado e não pode ser remarcado em massa.

Esses números só podem mudar quando a evidência exigida neste arquivo existir. Nunca arredonde progresso para cima e nunca use quantidade de código ou testes unitários como percentual do produto.

## Decisão irrevogável do proprietário

O Apollo final será **100% arquitetura nova e integralmente conectado**.

O legado não será mantido, modernizado, encapado ou usado como fallback. No estado final não deve existir nenhum código de compatibilidade.

Isso significa excluir fisicamente:

- pipeline, dashboard e editor antigos;
- banco SQLite, schema Prisma antigo e tabelas antigas;
- `Project` antigo e campos `scenesJson`, `editPlanJson`, `briefingJson` antigos;
- rotas `/api/process/*`, `/api/upload`, `/api/projects` e demais rotas do fluxo antigo;
- `analyzeContent()`, `claude.ts` monolítico e `narrativeEngine` antigo;
- tipos universais antigos baseados em `Scene`/`startLeg`;
- flags de compatibilidade, aliases, dual-write, fallback e adapters que leiam estado antigo;
- compositions, props e caminhos preservados apenas para compatibilidade;
- qualquer import do produto novo para um módulo legado.

Não é necessário realizar migração completa do banco ou preservar tabelas. O proprietário autorizou destruir e recriar as tabelas conforme o modelo novo exigir.

Apenas masters brutos selecionados podem ser preservados. Eles devem ser reingeridos pelo fluxo novo e receber novas identidades, rights, lineage e artifacts V2. Arquivo bruto é insumo; não é compatibilidade arquitetural.

## Arquitetura obrigatória

O único fluxo permitido é:

`Editor novo → application services novos → Postgres novo → operações/workers novos → Diretor novo → compiler novo → renderer novo → artifacts/quality reports novos`

Requisitos estruturais:

- Postgres é a única fonte de verdade do produto;
- ProjectVersion e snapshots são imutáveis;
- mudanças manuais e decisões do Diretor usam o mesmo modelo de `Command`;
- UI e API externa chamam os mesmos application services;
- toda capacidade operável possui API externa, capability ID e contract test;
- autenticação também é API-first: sign-in, leitura da sessão e sign-out humanos possuem contratos `/v1` públicos; automações usam credenciais Bearer de `ApiClient`, sem compartilhar senha humana com agentes;
- jobs longos são duráveis, retomáveis, idempotentes e observáveis;
- providers ficam atrás de ports/adapters novos e não aparecem no domínio;
- `TreatmentPlan`, `StoryPlan`, `EditPlan`, `DirectorRun`, `QualityReport` e artifacts são persistidos e realmente usados;
- transcript, OCR e metadata de mídia são dados não confiáveis, nunca instruções do owner;
- o renderer recebe apenas `RenderInput` materializado e não consulta banco/config implícito;
- o editor novo nunca pode chamar uma rota ou ler uma tabela da implementação anterior.

`/v1` pode ser usado como número da primeira versão da **API pública do produto novo**. Isso não autoriza dependência da implementação antiga. Se essa nomenclatura causar ambiguidade técnica, registre a decisão antes de alterá-la.

## Reuso permitido

Não reutilize módulos de runtime do legado.

Um aprendizado algorítmico de FFmpeg, timing, legenda ou render só pode reaparecer se:

1. for reimplementado atrás de um port/adapter novo;
2. usar somente contratos e persistência novos;
3. possuir testes novos contra o comportamento esperado;
4. não importar, chamar ou manter o módulo antigo;
5. o código antigo correspondente for removido antes do aceite.

“Temos uma função pronta no legado” nunca é justificativa para conectá-la ao produto novo.

## Definição estrita de concluído

Uma caixa do `TODO.md` só recebe `[x]` quando o resultado exato pedido estiver efetivamente entregue.

Para documentação ou decisão, o documento pode ser o próprio resultado. Para qualquer comportamento do produto, todos os itens abaixo são obrigatórios:

1. implementação na arquitetura nova;
2. integração com o runtime e a fonte de verdade novos;
3. contrato público quando a capacidade for operável;
4. teste unitário das invariantes relevantes;
5. teste de integração com persistência/adapters reais ou equivalentes controlados;
6. E2E real quando a tarefa prometer UI, worker, provider, timing, render ou jornada;
7. evidência observável pelo usuário quando houver resultado visual;
8. tratamento de erro, retry, cancelamento, lineage e observabilidade proporcionais ao risco;
9. ausência comprovada de dependência legada;
10. atualização simultânea de TODO, PRD, specs e rastreabilidade quando aplicável.

Nunca marque como concluído:

- item explicitamente descrito como parcial;
- interface sem backend novo integrado;
- provider fake como se fosse integração real;
- fixture determinística como se fosse E2E do produto;
- função pura sem chamada no runtime;
- schema sem persistência/migration executada;
- rota sem autenticação, autorização e aplicação real;
- render sem inspeção do MP4;
- teste que apenas reproduz a própria implementação sem validar o resultado requerido.

## Relato de progresso

Todo progresso deve separar claramente cinco estados:

1. especificado;
2. implementado isoladamente;
3. integrado;
4. testado ponta a ponta;
5. implantado e aceito.

Somente o quinto estado conta como produto entregue. Os demais podem ser relatados como trabalho existente, nunca como funcionalidade final.

Ao informar percentual:

- declare o denominador e o critério;
- derive o número das caixas auditadas, não de impressão subjetiva;
- não misture progresso do PRD completo com prontidão do próximo slice;
- inclua pendências que impedem demonstração real;
- vincule cada conclusão à evidência verificável.

## Gates obrigatórios antes de deploy

Não faça deploy do produto novo enquanto qualquer gate falhar:

1. **Gate de arquitetura:** zero imports, rotas, tabelas, flags ou aliases de compatibilidade; teste automático deve impedir reintrodução.
2. **Gate de persistência:** schema/bootstrap Postgres novo testado do zero; nenhum SQLite ou dual-write.
3. **Gate de integração:** editor usa exclusivamente projetos, versões, commands, operations e artifacts novos.
4. **Gate do Diretor:** briefing → percepção → TreatmentPlan → StoryPlan → EditPlan → critic realmente executado e persistido.
5. **Gate de API:** toda operação usada pela UI também está exposta externamente e passa contract/security tests.
6. **Gate de regressão:** suíte unitária, integração, arquitetura e E2E integralmente verde.
7. **Gate visual:** frames e MP4 revisados; legendas, enquadramento, transições e inserts aprovados pelos critérios do teste.
8. **Gate operacional:** mídia persistente, backup de segurança, migrations/bootstrap e health check comprovados.
9. **Gate de rastreabilidade:** commit, testes, artifacts e TODO apontam para a mesma versão.

Commit e push podem ocorrer por slices coerentes. Deploy somente depois dos gates aplicáveis e nunca para “ver se funciona” em produção.

## Projeto real usado como E2E de recuperação

O primeiro E2E deve usar o master bruto já preservado do projeto de boas-vindas da Imersão.

Critérios obrigatórios:

- informar e respeitar briefing e formato antes da direção;
- remover todas as falas sobre data/dia 8, dias de aula e duração de dois dias;
- preservar sentido e continuidade do discurso após os cortes;
- esconder cortes difíceis com decisão editorial justificável, não efeito gratuito;
- não aplicar zoom, pan, tilt ou punch-in sem razão registrada pelo Diretor;
- nunca cobrir rosto ou olhos com legenda;
- usar legendas curtas e posicionadas por safe-area/face detection;
- garantir enquadramento e transições naturais;
- produzir MP4 final assistível;
- executar as alterações pela API nova e registrar Commands/DirectorRun/QualityReport;
- revisar o MP4 antes de declarar o teste concluído.

Timestamps antigos como 36,66–58,24 e 86,58–87,76 podem ajudar a localizar as falas no master, mas não são fonte de verdade. O ingest V2 deve gerar e validar seu próprio alinhamento.

## Segurança para reset e remoção

O proprietário autorizou reset destrutivo, mas isso não autoriza destruição descuidada.

Antes de resetar produção:

- confirmar que os masters necessários existem fora do banco/contêiner descartável;
- criar backup operacional para recuperação de incidente;
- testar schema, migrations/bootstrap e seed V2 em ambiente limpo;
- testar import do master e a jornada de recuperação;
- registrar exatamente quais volumes/tabelas serão substituídos;
- só então remover banco, tabelas e código antigos.

O backup é para segurança operacional, não para manter compatibilidade no produto.

## Procedimento obrigatório ao iniciar uma nova sessão

1. Ler este `AGENTS.md` integralmente.
2. Consultar o Brain MCP para o projeto `apollo-video`.
3. Ler, no mínimo, as memórias 1267, 1268, 1269 e 1270 se ainda existirem.
4. Ler o início do `TODO.md`, inclusive a auditoria e o gate corretivo.
5. Conferir `git status`, commit local, commit remoto e versão implantada antes de afirmar estado.
6. Não assumir que código existente está integrado.
7. Não aumentar progresso nem fazer deploy sem produzir as evidências definidas aqui.

## Memórias persistentes relacionadas

- Brain #1267 — legado excluído do futuro do Apollo;
- Brain #1268 — correção do escopo: novo significa fluxo integral V2;
- Brain #1269 — reset destrutivo e remoção total autorizados;
- Brain #1270 — auditoria honesta do TODO: 83/1.255, 6,6%.

## Regra final

Quando houver conflito entre velocidade e comprovação, escolha comprovação. Quando houver conflito entre reaproveitar legado e reimplementar corretamente, remova o legado. Quando não existir evidência observável, diga que não está concluído.
