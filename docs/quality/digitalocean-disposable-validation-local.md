# Validação local do procedimento descartável — 29/09/2026

Este é o registro da etapa local anterior à publicação no PR #63. Os resultados
abaixo não são uma declaração sobre o CI posterior; ver a seção de publicação.

## Resultado e limite do aceite

Os ajustes operacionais e o runbook foram incorporados à árvore local do projeto.
A base Git local e remota conferida é `2c147de6eb96b85fc432b4c2b6c92249f21919dc`.
Na coleta local, os arquivos novos ainda não tinham sido commitados ou enviados.
Não confundir essa base com uma revisão publicada contendo os novos scripts.

Estado: **implementado e integrado entre componentes em testes locais controlados**.
Não há homologação Linux, Docker ou DigitalOcean desta versão. Não é aceite de
produto nem aumento de progresso do PRD/TODO. O procedimento operacional está em
`docs/runbooks/DIGITALOCEAN-DISPOSABLE-VALIDATION.md` e é referenciado por
`docs/runbooks/OPERATIONS.md` e pela especificação 11 de segurança do host.

## Ajustes verificados localmente

- Gate Python trata falhas de descoberta/importação, exceções de threads,
  exceções não tratáveis e threads remanescentes como falha; um `OK` isolado do
  unittest deixou de ser suficiente.
- Smoke Linux mede execução dos casos exigidos, não apenas o nome da plataforma;
  Windows não pode produzir aprovação Linux. O sinal só é enviado após o handler
  estar instalado, e a leitura do smoke tem prazo.
- Contrato explícito de mounts e logs entre host, runner e batch, com regressões.
- Contrato produtor/consumidor usa registros emitidos pelo guard, com relógio,
  métricas e transporte controlados: identidades, terminalidade, contagem e
  arquivos de evidência precisam concordar. Isso não é prova de API real.
- Preflight/postflight registram janelas monotônicas de pelo menos 60 segundos;
  o consumidor rejeita amostras repetidas, fora de ordem, lacunas e cobertura
  incompleta. Contar doze linhas não prova duas janelas.
- Root preexistente é preservada; cleanup/evidência só operam na root criada pelo
  run. O lock Linux recusa symlink, arquivo não regular, owner não-root e modos
  permissivos; confere identidade do inode e fecha descritores nos erros.
- PostgreSQL só admite retry dos estados transitórios explicitamente reconhecidos
  por `pg_isready`; deadline, cancelamento e falhas estruturais não viram retry.
- Empacotador e extrator limitam payload a 512 MiB regulares e 100.000 membros;
  comandos Git possuem prazo e cleanup de processo. Não há override de limites.
- Deleção exige identidade exata e evidência terminal; marcações de prework não
  substituem a prova. Intents persistentes e readback evitam repetir DELETE
  ambíguo. Testes do transporte são controlados, não exclusões reais.
- CLI Node foi nomeado `run-disposable-validation-tests.mjs` para não entrar
  acidentalmente na descoberta de `node --test`.

## Execuções observadas

Ambiente: Windows, Python 3.14.7, terminal Git Bash. Docker CLI ausente e WSL
sem distribuições instaladas na consulta desta rodada.

| Verificação | Resultado real | Escopo |
|---|---|---|
| `npm run test:ops:disposable` | 107 casos: **103 aprovados, 4 pulados**, zero falhas/erros | Local controlado |
| Hooks do gate operacional | `threadErrors=0`, `uncaughtErrors=0`, `lingeringThreads=0` | Processo de testes |
| `npm run test` | **2.551 aprovados**, zero falhas, cancelamentos ou skips | Suíte principal existente |
| `npm run lint` | Exit 0 | Fronteiras arquiteturais |
| `npm run infra:validate` | Exit 0 | Contratos locais de infraestrutura |
| `npm run lint:code` | Exit 0, sem warnings | ESLint |
| `npm run typecheck` | Exit 0 | `next typegen` e TypeScript na árvore local |
| `bash -n scripts/ops/digitalocean-bootstrap/batch.sh` | Exit 0 | Sintaxe, não execução Docker |
| `git diff --check` | Exit 0 | Diff rastreado |
| Comando Linux obrigatório no Windows | Exit 1 esperado, sem executar testes | Recusa correta de plataforma |
| `remote_guard.py --check` com template de IDs pendentes | Exit 1 esperado | Template não passa como alvo real |

Os quatro skips são os três casos de pipe/sinal/deadline Linux e um teste de
symlink sem privilégio disponível no Windows. Eles **não** foram contabilizados
como aprovados. A etapa Linux está adicionada ao workflow, mas ainda não existe
run de CI desta alteração. Não houve novo build Docker/Next nem E2E remoto nesta
rodada; typecheck não constitui prova de isolamento de leitura de arquivos de ambiente.

A revisão independente de Luna encontrou problemas antes das correções e não
foi tratada como aprovação. A revalidação completa confirmou os ajustes anteriores
e reteve a pendência do lock. Essa pendência foi corrigida e recebeu revalidação
independente localizada sem bloqueantes. Astra releu a integração do fixture de
ownership e executou novamente o gate completo. O mock de UID root do fixture
Linux não é uma comprovação de execução privilegiada real.

### Tentativa auxiliar não creditada

Uma coleta adicional usando `subprocess` diretamente pelo kernel de ferramentas
atingiu o limite de 100 segundos e retornou 124. Não foi contabilizada como sucesso.
A inspeção posterior não encontrou processos correspondentes ao gate/bundle; o
comando canônico no terminal foi reexecutado e passou. Os ambientes diferiam,
inclusive nas variáveis MSYS; a causa dessa tentativa não foi estabelecida.
Não inferir daí aprovação de todos os shells/contextos de execução do Windows.

## Como repetir a verificação local

No terminal do projeto, usar `npm run test:ops:disposable`. Nesta sessão Windows,
foi necessário definir explicitamente `TMPDIR` para o diretório scratch do Hermes,
pois o terminal reportou o diretório temporário do sistema apesar do contexto
inicial. Não supor o valor: conferir e apontar para scratch antes dos testes.
No runner Linux, usar `npm run test:ops:disposable:linux`; recusa ou skip obrigatório
bloqueia o avanço, sem alterar limites ou forçar plataforma fictícia.

A evidência persistente local foi arquivada fora do repositório no pacote
`apollo-ops-procedure-20260929`, incluindo resultados finais, hashes, revisões e
registro da tentativa auxiliar descartada. Não usar logs temporários como única
fonte para a rodada seguinte.

## Pendências antes de repetir na DigitalOcean

1. Publicar/revisar a alteração com autorização e obter CI Linux real verde.
2. Confirmar alvo, inventário, preço, orçamento e autorização vigentes.
3. Preparar e comprovar coordenação exclusiva, SSH e contingência independente.
   Não existe provisionador/agendador/coordenador completo implementado neste conjunto.
4. Executar preflight, jornada, postflight, inspeção e exclusão verificadas no
   descartável autorizado. Nenhum recurso foi criado por estes ajustes locais.
5. Só então avaliar a homologação operacional; isso ainda não equivale a aceite
   editorial, providers live ou produção do Apollo.

`TODO.md`, `AGENTS.md`, `package-lock.json` e `config/host-safety-policy.json`
permaneceram idênticos ao HEAD conferido. W29 não foi retomada. Nenhum token,
config operacional real ou arquivo de credenciais integra esta documentação.

## Publicação e primeira execução Linux — PR #63

Após autorização para prosseguir, a implementação local foi publicada no commit
`5b25800ce2b2d5ae003c2a54fa5af8be994059c1`, na branch
`chore/disposable-validation-ops`. A primeira execução Linux, CI `36645462027`,
**reprovou** a etapa operacional: 107 testes, 9 falhas, zero erros e dois skips
exclusivos do Windows. Os três smokes Linux realmente executaram e passaram;
isso não tornou a suíte completa verde. Nenhuma falha foi creditada como sucesso.

Uma prova adicional usou um clone limpo do commit publicado e encontrou um
bloqueio que as fixtures pequenas não cobriam: o empacotador confundia os
diretórios `credentials` de duas rotas TypeScript `/v1` com material secreto.
O pacote não foi publicado após a falha. Uma correção não pode liberar arquivos
de credenciais genericamente nem enfraquecer o bloqueio de `.env` e chaves.

As nove falhas Linux e o bloqueio do pacote foram preservados em
`apollo-ops-pr63/initial-validation-failures.json`, fora do repositório. Os
checks do PR #63 e seus recibos posteriores são a referência para a revisão
efetivamente validada; o verde local registrado acima não substitui esses gates.
Não houve provisionamento, SSH, exclusão DigitalOcean ou deploy nesta publicação.

### Correção candidata e regressões

- O produtor reconhece apenas os dois caminhos exatos de `route.ts` como código
  da API e rejeita outros arquivos no mesmo subtree, inclusive material secreto.
  Os negativos também cobrem `credentials.json` e `secrets.json` fora das rotas.
- A fixture de cleanup cria o diretório do run com `0700`, como exige o runtime;
  o negativo POSIX exige rejeição de diretório `0755` sem DELETE nem intent.
  O teste de symlink exige rejeição no estágio de manifesto e zero chamadas API.
  Nenhuma proteção de `watchdog.py` foi removida para acomodar as fixtures.
- O CI passa a empacotar seu checkout real limpo e ler o pacote com
  `remote_guard.safe_extract()`. Confere commit, Git shallow/clean, presença das
  rotas, hash, bytes e contagem; o tar permanece fora da árvore e é removido ao
  encerrar a etapa. O recibo de saída não inclui o caminho privado do executor.

Astra reexecutou a suíte local: **111 testes, zero falhas/erros e seis skips**
(três smokes Linux, dois de permissões POSIX e um de symlink indisponível no
Windows), sem exceções de threads. A prova local do produtor corrigido e do
extrator usou o payload antigo `5b25800c`: 3.046 membros e 53.002.240 bytes.
Isso não substitui a prova do novo commit no CI. A revisão independente não
encontrou bloqueantes; sugeriu limitar e isolar ainda mais os subprocessos Git
do helper de readback, hoje restrito à prova local/CI e à saída do produtor.

Arquitetura e infraestrutura passaram. Uma cadeia local atingiu 150 segundos
durante ESLint; o processo remanescente foi identificado, encerrado e sua
ausência conferida antes da repetição. Essa tentativa não foi creditada.
ESLint executado separadamente com prazo maior retornou zero. A nova execução
Linux e o recibo do checkout revisado devem ser conferidos nos checks do PR #63.
