# Validação local do procedimento descartável — 29/09/2026

## Resultado e limite do aceite

Os ajustes operacionais e o runbook foram incorporados à árvore local do projeto.
A base Git local e remota conferida é `2c147de6eb96b85fc432b4c2b6c92249f21919dc`.
Os arquivos novos desta rodada ainda não foram commitados, enviados ou implantados.
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
