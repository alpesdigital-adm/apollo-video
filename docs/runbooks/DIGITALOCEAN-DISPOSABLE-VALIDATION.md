# Validação descartável na DigitalOcean — procedimento para próximas rodadas

## Escopo, autoridade e estado

Correção local de observabilidade em 30/09/2026 ainda sem gate verde: o guard
registra callsites e amostras falhas em `monitor-diagnostics.jsonl`, e o controller
tenta coletar a evidência filtrada antes de rejeitar postflight. Isso não explica
o timeout real de `next-build` nem confirma hipótese sobre Docker/cgroup.
O owner já autorizou retomada condicionada a monitor corrigido/validado e cinco
minutos de estabilidade: o preflight do guard foi ampliado para 300 s com ticks
de 10 s; postflight permanece 60 s. Não iniciar rodada até testes locais e CI
Linux passarem e a identidade de novo alvo descartável ser confirmada. A suíte
local desta edição ainda falhou: ver relatório privado de Sol em scratch.

Este runbook descreve uma validação isolada, não um deploy em produção.
Aplicam-se `AGENTS.md` (inclusive exclusividade e segurança de E2E remoto),
`docs/specs/11-host-safety-and-serial-operations.md` e os gates do produto.
A DigitalOcean é o único provedor remoto permitido; a VPS anterior é proibida.
A validação não altera critérios de aceite nem autoriza acesso por si só.
Usar a autorização explícita já vigente, se ainda válida e escopada para a
rodada/alvos; seus tetos são quatro horas e US$ 1. Não renová-la nem ampliá-la
por inferência. Se vencida ou fora do escopo, parar e pedir nova decisão.
Em 30/09/2026 o owner autorizou também NYC3, com os mesmos limites e isolamento:
somente `nyc3` + `s-8vcpu-16gb-intel` ou o par original `nyc1` +
`s-8vcpu-16gb-amd`. Não há fallback automático nem permissão para pares cruzados.
NYC1 foi recusada no preflight real por indisponibilidade dos planos 8/16;
NYC3/Intel foi informada disponível a US$ 0,16667/h nessa consulta, mas requer
preflight atual antes de qualquer mutação. A VPC default NYC3 já existe: Astra
deve confirmar membros vazios antes de usá-la; não criar nem remover VPC.
Snapshot preservado, nenhuma produção/DNS/provider pago; execução real só Astra.
Código local e testes controlados não homologam operação remota.
Atualização de 30/09/2026: CI Linux `36717184411` verde após merge PR #65.
Houve uma primeira criação real às 13:20:29; o controller bloqueou no gate
`droplet_identity` às 13:20:30, antes de SSH, upload ou app. O payload do primeiro
POST/GET não foi preservado; não é possível identificar qual campo estava ausente
ou incorreto. GET posterior completo mostrou droplet active com ID 604968051,
nome/tag, região NYC3, plano Intel, VPC e imagem esperados, e `created_at`
13:20:37 (depois do bloqueio). Não usar esse GET para reconstituir o primeiro.
Astra fez inspeção SSH pinned somente leitura por 120 s/13 amostras, confirmou
ausência de app/Docker/PG/root e processo SSH terminal/fechado, depois conferiu
404 por API de droplet/firewall/tag. Snapshot foi preservado. Nenhum recurso
permanece em execução; isto não foi homologação nem aceite do produto.
O readback corrigido espera apenas GET por até 600 s: ID/nome do POST e GET são
obrigatórios imediatamente; divergência conhecida bloqueia; campos de provisão
ausentes em `new` podem completar, mas `active` exige identidade completa/exata
antes de aceitar IP e abrir SSH. IP ausente pode aguardar; timeout ou estado
inesperado bloqueia, sem segundo POST ou DELETE de erro. Diagnóstico local usa
somente nomes de checks/estado/presença, não valores nem payload HTTP. Novo
CI Linux e nova rodada real continuam pendentes para esta correção.
`ip_address` público `''` é ausência provisória (apenas GET até o deadline),
mas IP não vazio inválido/privado/IPv6 ou múltiplos públicos bloqueiam.
O `created_at` válido do POST não exige igualdade byte a byte com o do GET;
o timestamp final válido do GET ancora manifesto e cleanup. Divergência conhecida
de ID/nome/config ainda bloqueia. Em `new`, campo `region`/`image` inteiro
ausente/None pode completar; objeto presente sem `slug`, com `slug: null` ou
`slug: ''` continua fail-closed por falta de contrato de resposta comprovado
para tratá-lo como provisório. Essa classificação não identifica o campo real
da falha inicial, cujo POST/GET não foi preservado.
O registro local abaixo refere-se à rodada anterior à criação acima: Windows
real, WSL sem distribuições e Docker CLI ausente. Naquela rodada não houve uso
de provedor real nem de VM. O CI #36717184411 pertence à revisão PR #65,
não comprova esta correção. Não há processo remoto homologado nem aceite de
produto W27/W28, F3 ou W29.
Não transformar README de scratch anterior em fonte de verdade atual.
A evidência local e suas limitações estão registradas em
`docs/quality/digitalocean-disposable-validation-local.md`; ela não libera a VM.

## Contratos locais que devem estar verdes antes de qualquer recurso remoto

- Python 3.12+ (biblioteca padrão), Git, Bash e Node/npm são pré-requisitos.
- `npm run test:ops:disposable` executa o gate local em Windows ou Linux.
- `npm run test:ops:disposable:linux` exige Linux e falha em outra plataforma.
- O wrapper Node é `scripts/ops/run-disposable-validation-tests.mjs`;
  conferir seu destino no `package.json` antes de executar.
- A suíte Linux cobre smoke de pipe, sinais e deadline sem Docker, VM ou API.
- A etapa do CI em `.github/workflows/ci.yml` não prova execução até haver run verde.
- Corrigir contrato produtor/consumidor e gate de testes antes da rodada remota;
  não usar documentação ou fixtures isoladas como aprovação desse contrato.
- `remote_guard.py --check <config.json>` está implementado e testado no
  Windows; valida somente config local, sem rede. Não é prova Linux/remota.
- Execução efetiva de `remote_guard.py` é somente Linux no droplet autorizado.
- `watchdog.py --manifest <manifest.json> --mode check` é apenas validação local.
- `--mode inspect` usa GET da API; `--mode delete` é destrutivo e condicionado.
- Nenhum destes scripts cria droplet, firewall, tag, snapshot, SSH ou agenda cleanup.
- Não existe coordenador SSH/provisionador/agendador de ponta a ponta implementado.
- Não chamar o conjunto de “um comando” ou “cleanup garantido”.

## Identidades, caminhos e evidência privada

Escolher `run_id` ASCII `[a-z0-9]`, com hífens internos opcionais,
1 a 29 caracteres, início e fim alfanuméricos; sem conversão implícita.
`owner_id`: 1 a 64 caracteres ASCII `[A-Za-z0-9_-]`.
Manter ambos idênticos no planejamento, config, manifesto e provas.
`root` remoto exato: `/opt/apollo-validation/<run_id>`.
Ferramentas remotas derivam seus caminhos de `remote_guard.py`; não apontar
um script solto de origem desconhecida, nem substituir por arquivo de scratch.
A configuração do guard contém exclusivamente `run_id`, `owner_id`, `root`,
`expected_droplet_id`, `expected_commit`, `source_sha256` e
`duration_seconds` (inteiro de 300 a 10800).
O manifesto do watchdog contém identidade real de droplet, firewall, tag,
VPC e snapshot, região, plano, commit, horários, flags e caminhos exigidos.
`manifest.example.json` é só esquema ilustrativo: IDs e datas são fictícios.
Não copiar seus valores como alvos reais nem tratar `delete_authorized=false`
como autorização para a rodada seguinte.
Usar `evidence_root` privado, absoluto, nativo do SO do operador, fora do repo.
Não normalizar caminho para encaixar um manifesto que falha na validação.
Conferir ACL efetiva no Windows operacionalmente: o helper não prova
criptograficamente a privacidade das ACLs nesse sistema.
Arquivar `postflight.json` em `<evidence_root>/<run_id>/postflight.json`,
`samples.jsonl` e `monitor-diagnostics.jsonl` no mesmo diretório.
`prework_file` é campo obrigatório inerte
do schema do manifesto: não exige criar nem guardar `prework.json`, e não
substitui evidência terminal.
Lock local: `<evidence_root>/apollo-validation-owner.lock`; nunca removê-lo.
Não arquivar `pg.env`, `runner.env`, tokens, URLs com senha ou stdout bruto.
Não usar arquivos de credencial, argumentos de processo, shell history,
.env ou este documento para transportar `DIGITALOCEAN_ACCESS_TOKEN`.
Injetá-lo somente pelo Brain/cofre no processo autorizado que chama a API;
não registrar nem reproduzir seu valor, inclusive nos exemplos abaixo.

## Checklist sequencial; desconhecido significa parar

### 1. Autorização e inventário (sem mutação)

1. Verificar a autorização explícita vigente, escrita e escopada para esta
   rodada: alvo, região, plano/CPU/RAM, preço, até quatro horas/US$ 1,
   acesso e deleção final. Se qualquer escopo não cobrir a ação, parar.
2. Confirmar orçamento, persistência, backup/restore, rede e isolamento de
   produção; snapshot a preservar exige identidade e destino confirmados.
3. Conferir inventário pela API oficial: zero recursos Apollo de teste
   inesperados; recurso desconhecido ou compartilhado bloqueia a criação.
4. Confirmar por API o plano nominal de 8 vCPUs/16 GiB e seu preço real;
   `MemTotal` Linux pode ser menor: guard aceita no mínimo 15 GiB utilizáveis.
5. Confirmar snapshot, VPC, região e IP somente depois da resposta atual da API.
   Nunca inferir a identidade de droplet de ID/IP/registro histórico.
6. Nomear um único owner e uma operação remota mutável por vez, com uma só
   conexão operacional; incidente ou pausa impede iniciar a rodada.
7. Se autorização, inventário, preço ou identidade forem inconclusivos,
   registrar bloqueio e não provisionar, testar nem “experimentar” produção.

### 2. Fonte reprodutível e testes locais

8. Executar `npm run test:ops:disposable` localmente; falha ou skip do gate
   necessário bloqueia a sequência. Executar o comando Linux no runner Linux.
9. Guardar o link/ID e resultado real do CI Linux depois da execução;
   um step configurado, mas não executado, não é prova de Linux.
10. Revisar `scripts/ops/digitalocean-bootstrap/{remote_guard.py,prepare_bundle.py,batch.sh,Dockerfile.runner}`,
    `scripts/ops/digitalocean-cleanup/watchdog.py`, o gate e o commit pretendido.
11. Preparar cópia da fonte somente a partir de HEAD aprovado, tracked limpo:
    `python scripts/ops/digitalocean-bootstrap/prepare_bundle.py --source <REPO_ABSOLUTO> --output <TAR_ABSOLUTO_FORA_DO_REPO> --expected-commit <SHA40_APROVADO>`.
12. Conferir o JSON de saída: commit, SHA-256, bytes e caminho do tar.
    Não confundir `2c147de6` (base local no início desta rodada) com a versão
    ainda não commitada dos novos scripts. Não criar commit automático para
    satisfazer o check: publicar/revisar somente com autorização do owner.
13. O pacote é clone Git shallow sem remote, somente arquivos rastreados,
    sem untracked, `.env`, `node_modules` ou `output`; modos executáveis preservados.
    O empacotador verifica HEAD, tracked limpo e objeto empty-tree do Git.
    Rejeição exige rever a origem; não mover o tar para dentro do repo.
    Limites embutidos, sem override: 512 MiB de bytes regulares descompactados,
    100.000 membros do tar (incluindo Git), 120 s por comando Git e 300 s
    para o conjunto Git. Antes da rodada confirmar Git já disponível no
    host Linux; se faltar, parar, sem instalação ad hoc que drible o preflight.
14. Preparar em área privada apenas o template de config e manifesto, com
    run/owner, SHA40, SHA-256, paths e campos ainda desconhecidos explicitamente
    pendentes. Antes de criar droplet, nenhum `--check` de config/manifesto deve
    passar: `expected_droplet_id`, `droplet_id`, `firewall_id`, `created_at`,
    `owner_pid` e `owner_deadline_utc` precisam vir de observação real.
    Nunca usar IDs/PIDs/datas sintéticos para “passar o gate”.

### 3. Contingência antes da criação

15. Planejar e revisar com o owner a contingência independente de SSH/guard,
    com template de manifesto privado e caminhos exatos; não inventar alvos.
16. Nesta fase não executar `watchdog.py --mode check` com manifesto falso:
    o manifesto real ainda depende da criação e do owner record. Os testes
    unitários exercitam `--mode check` apenas com fixtures controladas.
17. Sondar API oficial por inventário/GET, VPC, preço/plano e snapshot
    autorizado antes da criação; `inspect` do helper só após alvos existentes.
18. Antes de criar, registrar como obter prova terminal independente,
    como isolar incidente e quem autoriza contenção se SSH falhar.
    Se não houver contingência executável de modo independente, parar.
19. Erro de trabalho não prova erro de cleanup: `work_outcome=failed` mantém
    `exit_code`, erro e fases falhas, mas somente `cleanup_outcome=verified`
    com prova terminal íntegra pode liberar deleção do descartável. PG nunca
    despachado requer `not_dispatched_verified` após término do guard e root
    próprio, runner igualmente não despachado, e `backend_proof` =
    `not_applicable_no_pg_created` com `orphan_backends="N/A"`; não equivale a
    zero observado. Criação/start tentados e ambíguos, postflight inconclusivo
    ou falha pré-root/identidade bloqueiam delete. Não existe bypass de prework;
    descrever contenção excepcional ao owner com prova própria. Nunca forjar
    zero, mudar flags ou excluir intents para liberar deleção.

### 4. Provisionamento isolado (somente após gates anteriores)

20. Adquirir o lease local com `watchdog.claim_lock` antes da primeira
    mutação pela API e mantê-lo durante toda a operação do owner. Não há
    controlador de provisionamento/SSH/agendamento implementado: esta
    coordenação é manual, serial e sujeita a cleanup em `finally`.
21. O owner usa exclusivamente a API oficial e um droplet novo descartável,
    separado de produção; registrar IDs reais de droplet/firewall, região,
    plano, criação, tag, VPC e snapshot preservado após readback. Sem readback,
    não usar os IDs devolvidos pela criação para seguir adiante.
22. Confirmar readback de identidade e custo/teto; completar a config privada
    com `expected_droplet_id` real e executar
    `python scripts/ops/digitalocean-bootstrap/remote_guard.py --check <CONFIG_JSON>`
    antes de qualquer SSH. Falha bloqueia acesso; check é local e sem rede.
    Não apagar VPC, snapshot, outros droplets nem serviços compartilhados.
    Se usar SSH/SFTP, manter uma única conexão/transporte operacional,
    sem owner paralelo ou segundo canal; nenhum coordenador automático existe.
23. Sem coordenador implementado, o operador deve organizar manualmente
    estado, timeout, `finally`, PID, deadline e fechamento de conexão.
    Não iniciar SSH, túnel, browser, worker ou guard fire-and-forget.
24. Conferir fingerprint/chave autorizada e identidade do droplet por API
    e metadata no próprio guard; falha ou divergência bloqueia o run.

### 5. Guard, upload e batch no droplet

25. Transferir ferramentas do commit aprovado e config sem segredo;
    verificar conteúdo, modos executáveis e identidade antes de executar.
26. Iniciar `python3 <CAMINHO_REMOTO_DO_GUARD>/remote_guard.py <CONFIG_JSON_REMOTO>`
    na única sessão SSH sob o mesmo lease; manter stdin aberto até o final.
    Redirecionar stdin a `/dev/null` ou fechá-lo indica perda do owner, não
    “fim do upload”. Capturar PID, deadline UTC Z e owner record da mesma sessão
    antes de atribuir estes valores ao manifesto local. Só após observar o
    owner record atual, completar PID/deadline do manifesto com valores reais,
    preencher `created_at` do readback e `not_before` conforme autorização
    (entre criação e deadline observado),
    mantendo `owner_released=false` e `run_terminal_verified=false`,
    executar `python scripts/ops/digitalocean-cleanup/watchdog.py --manifest <MANIFEST_JSON> --mode check`
    localmente e bloquear se falhar. Esse check não faz API e não autoriza delete.
27. Guard Linux valida metadata/recursos, faz preflight de 60 s, instala
    componentes sob limites e somente então emite `upload_ready`.
    Não transferir fonte antes desse evento; ausência/timeout bloqueia.
28. Após `upload_ready`, pelo SFTP do mesmo transporte enviar `source.tar`
    e `upload.complete` contendo exclusivamente o SHA-256 esperado.
    O marker não substitui o hash do tar, HEAD nem a verificação do guard.
29. Monitorar amostras a cada 10 s durante toda a operação e postflight de
    60 s. CPU host busy >=50% por 30 s ou >=70% em amostra, load1/CPUs
    >=0,75, steal >=10%, MemAvailable <2 GiB, OOM, conexões PG >50%,
    latência/erro de app ou métrica inconclusiva fecham admissão.
30. Limite agregado do slice: 2 CPUs e 12 GiB; Docker e containerd têm
    quota de 25% cada dentro do slice, runner 1,5 CPU, PG 0,5 CPU.
    Não alegar readback de quota de container se só houve verificação systemd.
31. O batch no runner instala dependências, valida contratos/build e executa
    a jornada sintética Wave 24; fase falha interrompe, não prova sucesso.
    O teste é isolado e não muda aceite de outras waves nem gates de produção.
32. Desvio, timeout ou desconexão: parar novas admissões, preservar estado,
    encerrar só processos do run com identidade verificada; não reiniciar host,
    Docker, PostgreSQL global ou mandar segundo comando em paralelo.

### 6. Terminalidade, cópia filtrada e deleção opt-in

33. Aguardar o supervisor terminar na sessão original; capturar exit code,
    PID e deadline, eventos, estados de runner/PG e backends do próprio run.
34. Confirmar containers criados terminais (stopped), runner antes de PG,
    zero backends do `application_name` observado enquanto PG acessível e
    ausência de filho/reconexão. Para PG/runner nunca criados, exigir prova
    explícita de não-despacho do comando e reconciliação após término do guard,
    com backend `not_applicable_no_pg_created`, nunca zero inventado.
    Falta de confirmação após timeout/SSH perdido não autoriza retry, outro
    canal mutável, ação sobre host inteiro ou cleanup remoto inferido.
35. Exigir `postflight.json` com run, owner, droplet ID, commit, PID e deadline
    UTC Z idênticos ao manifesto; `terminal_evidence` registra root próprio,
    identidade, despacho e estado terminal de runner/PG, e prova de backend
    distinta para PG criado (`observed_zero` e contagem inteira 0) ou não
    criado (`not_applicable_no_pg_created` e `"N/A"`). `cleanup_ok=true`,
    `cleanup_outcome=verified` e `cleanup_errors=[]` significam somente
    cleanup comprovado. `work_outcome`, `work_errors`, `exit_code` e `phases`
    preservam o resultado do trabalho: sucesso exige fases e saída zero;
    falha editorial/teste não vira sucesso só porque o ambiente foi limpo.
36. Exigir `samples >= 12`, `windows` no postflight e `samples.jsonl` ao lado,
    com contagem exata e >=6 amostras preflight e >=6 postflight sem `reason`.
    Cada janela monotônica `started`/`finished` dura >=60 s reais, não se
    sobrepõe; cada amostra tem `monotonic_at` float finito, estritamente
    crescente globalmente e, nas fases pre/post, dentro da janela respectiva.
    Início→primeira, amostras adjacentes da mesma janela e última→fim têm
    lacuna <=11 s. `at` segue UTC numérico válido, mas não mede cadência;
    12 linhas no mesmo instante nunca constituem duas janelas. Falha bloqueia.
37. Copiar somente evidência revisada, com filtragem de segredos e destino
    privado; jamais arquivar `state/pg.env` ou `state/runner.env`.
38. Encerrar SFTP e SSH, atestar liberação do owner e terminalidade antes
    de colocar `owner_released=true` e `run_terminal_verified=true` no manifesto.
    EOF de stdin não é prova de término; timeout/perda real de SSH sem postflight
    observável e incidente ativo mantêm flags bloqueantes. Uma sessão original
    ainda viva pode entregar postflight de trabalho falho após cleanup; não
    abrir sessão ou owner paralelo para fabricar readback.
39. Após soltar o lease operacional, `watchdog.py --manifest <MANIFEST_JSON> --mode inspect`
    confere por GET identidade de droplet, firewall, tag e snapshot.
    Divergência, recurso compartilhado, falta de snapshot ou API incerta bloqueiam.
40. Apenas com autorização explícita de delete já válida e escopada (não
    exigir repetição arbitrária), `not_before` atingido,
    prova terminal íntegra e lock exclusivo: `watchdog.py --manifest <MANIFEST_JSON> --mode delete`.
    O helper registra intent persistente antes de cada DELETE; mesmo após
    timeout não repetir DELETE apagando intent. Consultar GET e reconciliar.
41. Exigir GET 404 do ID do droplet, firewall e tag e inventário zero para
    o run; preservar snapshot e verificar sua presença antes/depois.
    Registrar custo real medido, não tratar estimativa como valor pago.
42. Arquivar manifest, postflight, samples, inventário/API filtrados,
    aprovação, resultados local/Linux e custo em local privado controlado.
    Manter lockfile; não remover para contornar exclusividade.
43. Se qualquer etapa for inconclusiva, estado = bloqueado: nenhum retry,
    restart, novo E2E ou alegação de cleanup completo. Escalar ao owner.

## Falha → mecanismo → comando/teste de regressão

| Falha evitada | Mecanismo esperado | Comando ou teste local |
|---|---|---|
| Origem suja ou secreta no tar | `prepare_bundle.py` recusa tracked sujo/especial e filtra payload | `npm run test:ops:disposable` (`tests/ops/test_prepare_bundle.py`) |
| Identidade/config divergente | config estrito + metadata do guard | `remote_guard.py --check <CONFIG_JSON>`; `tests/ops/test_remote_guard.py` |
| Falha de pipe/sinal/deadline | monitor e cleanup `finally`, smoke Linux | `npm run test:ops:disposable:linux` (`tests/ops/test_bootstrap_linux.py`) |
| Diretórios/logs montados incorretamente no runner | batch exige source/state/evidence/logs graváveis e log do smoke; argumentos limitam os bind mounts | `tests/ops/test_remote_guard.py` (`test_batch_requires_writable_mounted_dirs_and_records_smoke_log`, `test_runner_arguments_mount_only_owned_paths_and_logs`) |
| Monitor ausente ou janela incompleta | amostras pre/post + gate fail-closed | `tests/ops/test_remote_guard.py`; `tests/ops/test_disposable_contract.py` |
| Produtor declara zero não comprovado | watchdog exige terminalidade, ambos os arquivos | `tests/ops/test_disposable_contract.py`; `tests/ops/test_watchdog.py` |
| DELETE ambíguo ou alvo compartilhado | intent durável, GET/identidade/lock | `tests/ops/test_watchdog.py` |
| Suíte falsa ou skip silencioso | gate do processo, discovery e Linux obrigatório | `tests/ops/test_disposable_test_gate.py`; comando Linux no CI |

## Matriz de comprovação (não converter em percentual)

| Estado | Esta rodada | Evidência que ainda falta |
|---|---|---|
| Especificado | Procedimento e limites descritos | Revisão do owner e alvo fresco para cada rodada |
| Implementado isoladamente | Scripts locais existentes, validação local controlada | CI Linux e rodada remota ainda pendentes |
| Integrado | Contrato produtor/consumidor testado localmente com relógio/host controlados; não demonstrado em VM | CI Linux executado e ambiente isolado real |
| Testado ponta a ponta | Sem VM DigitalOcean real nesta rodada | Run isolado, prova terminal, inspeção e limpeza verificadas |
| Implantado e aceito | Não | Gates, evidência publicada por Astra e aceite explícito do owner |

A evidência local não substitui Linux; Linux sem Docker não substitui VM;
VM sintética não substitui deploy ou aceite do Apollo em produção.
Para repetir, partir deste runbook e dos arquivos do repositório após gates,
com IDs e inventário atuais, sob autorização válida; nunca de anotações de scratch.
