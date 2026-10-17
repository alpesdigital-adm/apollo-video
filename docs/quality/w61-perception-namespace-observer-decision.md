# W61 — observador descartável de percepção no Linux

Estado: **draft isolado, não executado nem ativado**. Nenhuma aprovação facial,
editorial, de produto ou de deploy resulta desta mudança de infraestrutura.

## Motivo e autoridade

`/proc/PID/environ` combina DAC e verificação ptrace. Um filho nondumpable pode
manter os quatro UIDs do runner enquanto o arquivo `environ` fica root/0400.
Idade do processo, UID coincidente ou recebimento de SIGTERM não comprovam
ownership/terminalidade e não autorizam ignorar uma negação sobre processo vivo.
Não se atribui a negação histórica sobre PID 4073 a zombie sem evidência.

O observador privilegiado só existe no run Linux descartável. Não muda sysctl,
Yama, dumpability de outro processo, sudoers ou capabilities globais do Node.
Produto, testes, browser e clientes PostgreSQL usam UID/GID normais e CapInh,
CapPrm, CapEff, CapBnd e CapAmb zero, com NoNewPrivs=1.

## Fronteiras e ordem

1. Launcher Node normal envia configuração delimitada por pipe privado ao
   Python isolado `-I -S`; ambientes LD_*/PYTHON* nunca chegam ao código root.
2. Guardian host cria o filho unshare conhecido; não inventaria o host nem lê
   ambientes do host. Confere identidade/ancestry/namespaces do init e lê apenas
   o arquivo `children` desse init antes do gate: exatamente um bootstrap,
   host PID/starttime/PPID/NSpid/inode de namespace iguais à identidade local.
   Guardian passa ao UID/GID do runner com grupos vazios e apenas CAP_KILL,
   NoNewPrivs e keepcaps desligado. A retenção temporária serve exclusivamente
   à sua transição de UID; nunca ocorre no bootstrap ou produto.
3. PID1 monta `/proc` de seu PID namespace com propagação privada antes do
   bootstrap. Não inventaria/contem nada se essa montagem não foi comprovada.
4. Bootstrap Python confiável perde grupos, GID/UID e todos os capsets/bounding/
   ambient antes do exec. Não usa keepcaps no produto. Aguarda gate privado.
5. PID1 reduz a CAP_SYS_PTRACE, CAP_DAC_READ_SEARCH e CAP_KILL + NoNewPrivs.
   PR_GET_PDEATHSIG deve continuar SIGKILL após a redução; não se reinstala um
   binding perdido de pai invisível e nenhum FD hostproc fica retido no init.
   O filho unshare arma PR_SET_PDEATHSIG e confere o guardian mintado antes do
   exec; `--kill-child=SIGKILL` deve preservar o binding medido no init. Guardian
   reinstala/readback seu próprio PDEATHSIG após a mudança de credenciais.
   O owner normal abre/revalida os pidfds de guardian e bootstrap gated e envia
   o ACK privado. Só então a cadeia libera o exec Node.
6. Node owner usa socketpair herdado. O PID/starttime é mintado pelo fork real;
   hello não escolhe owner. Cada fragmento recvmsg exige SCM_CREDENTIALS e nova
   confirmação de PID/starttime/UID/GID. FDs recebidos, frame truncado, bytes
   excessivos, sequência/run incorretos ou deadline encerram o gate.

RPC admite somente hello, snapshot paginado, identidade, fatos de marcador e
finish. Nunca admite paths, exec ou sinais. Retorna identidades/credenciais,
inode UID/mode diagnóstico e runMarked/knownMarker; nenhum byte de environ.
O supervisor continua o algoritmo PID/starttime, ancestries por identidade,
pidfd, rechecks e preservação parcial de owned após uma outra leitura falhar.
O ABI privilegiado não cria Buffers falsos e não cai para o backend normal.

## Recibos, prazo e contenção

Sudo usa stdio padrão, sem `-C`: FD1 do guardian é framing exclusivo, duplicado
internamente. Unshare/bootstrap/produto usam FD1 apontado para stderr e fecham
todas as cópias de receipt/release antes do exec Node. Stdout do produto não
pode produzir uma attestation root.

O recibo externo é separado do recibo da suíte e preserva inner FAIL. PASS
requer Node esperado fechado, init com namespace vazio após reaps, identidades
de init/unshare/guardian/sudo terminais, closes observados, código fonte/SHA e
postflight PostgreSQL com zero outros backends. Zombie é explicitamente Z;
PID reutilizado não é chamado ausente e nunca recebe sinal de outra identidade.

Cada chamada reserva 480s dentro do deadline agregado do job: suíte/cleanup
interno, contenção do namespace/guardian e postflight/recibo externo. Os dois
guardians param execução antes do limite para reservar 25s globais de cleanup.
Timeout, owner/IPC/launcher morto ou dado inconclusivo nunca viram PASS.
Não há kill(pid), process.exit/unref ou destruição de pipe para esconder vivos.

O owner Node usa um addon Linux CI-only Node-API 8, compilado pelo UID normal
fora da árvore rastreada. O C expõe somente open(pidfd flags=0), TERM/KILL e
close por handles opacos type-tagged; FD_CLOEXEC é conferido, close/finalizer
são idempotentes e não aceitam descritor numérico. O wrapper abre antes de
revalidar PID/starttime e mantém o handle até finally. Falha ou timeout da
releitura fecha o handle dentro do wrapper. Nenhum Python de sinal/atestação
é lançado pelo owner, nenhum fallback kill(pid) e nenhum compilador é acionado
pelo runtime. Node 22 Quality e Node 24 Perception permanecem distintos.
Proveniência registra SHA de source, addon, headers, compiler e Node + versões,
commit e UID/GID; inputs são relidos antes de carregar o addon explicitamente.
O cache é local ao owner e pressupõe inputs imutáveis após esse primeiro load:
nenhum writer de produto altera source, compiler, Node, headers ou diretório de
build do run. A proveniência mantém os bytes atestados; o cache não oferece
revalidação contínua de alterações posteriores. Esse limite é de infraestrutura
confiável do CI, não de autoria editorial de material não confiável.

O prerequisite de compilação é um comando fixo/trusted foreground do step CI,
executado pelo UID normal com timeout TERM 55s + KILL 5s e limite do step 2min.
Registra exit/status e proveniência em falha e retém pasta/logs quando
inconclusivo; não chama timeout de terminalidade, não apaga evidência de um
possível sobrevivente e não promove addon de compiler falhado. Esse limite do
bootstrap CI ainda exige revisão antes de executar; não substitui o protocolo
de identidades/close/PG0 obrigatório do runtime namespace.

No negativo guardian parado e contido, o externo usa identidades do READY se
FINAL não existe: guardian/unshare/init/Node/sudo são revalidados sem sinais a
PIDs reutilizados. A ausência de init-final/inner/Node close/nsEmpty permanece
ausência, nunca é preenchida como sucesso; o run principal continua FAIL.

## Gates ainda pendentes

- Revisão estática e execução real da fronteira UID/caps/parent-death/FD1.
- Parser de pipe root preserva frames coalescidos minted→ready→final, consome
  o buffer antes de esperar e recusa EOF truncado, extra e sequência inválida.
  Essas alterações e a substituição dos helpers por pidfd nativo ainda exigem
  revisão, compilação e testes reais; não são provas de terminalidade Linux.
- Gate Linux composto real: UID/GID/capsets/NoNewPrivs do Node e do filho
  PR_SET_DUMPABLE=0, EACCES normal, marcador privilegiado da identidade exata,
  zero bytes do sentinel no ABI/recibos, setsid/reparenting/reap.
- Negativos reais: sender substituído em fragmento, run/seq/frame inválidos,
  IPC morto/truncado, Node PID2 owner autenticado morto, deadline, init stuck e guardian SIGSTOP seguido
  de pidfd SIGKILL pelo owner normal, com terminalidade e PostgreSQL zero.
  Os sete fault modes estão escritos somente para o composto; cada negativo
  exige seu efeito observado (T, SIGKILL no wait, EOF/truncado/tamanho ou deadline
  real) e os cinco processos terminais + PG0. Guardian perdido não fabrica
  close/nsEmpty/inner; um rótulo configurado nunca substitui a observação.
- Morte do outer launcher host permanece um gate Linux não executado. O caso
  `node-owner-death` comprova exclusivamente a morte do Node PID2 autenticado
  pelo IPC, não a morte do outer/driver. O novo driver normal pai está escrito:
  minta o launcher direto e seu token de nascimento sem yield, captura stat
  síncrono e revalida antes do ACK do bootstrap. No READY já validado abre seus
  próprios cinco tokens e cruza PID/starttime/UID/PPID/NSpid/inode do anchor
  normal com a atestação Warden. Mata o launcher host real antes do ACK de
  produto e exige close real, cinco identidades terminais e PG0. Ausência de
  FINAL/inner/Node close/nsEmpty continua ausência. O composto agora exige
  oito negativos, mas `infrastructureAcceptance: pending` permanece: código
  preparado não comprova a cascata kernel nem o gate Linux.
- Negativos nativos preparados: forgery/closed/double-close/recycle, deadline
  de recheck, sinal fora de TERM/KILL, self-stop/KILL com close e terminalidade
  observados, pidfd não herdado após exec e ausência de addon fechando o gate.
- Wiring obrigatório do composto e de oito chamadas externas, além da suíte
  npm test literal executada como UID normal. Face mantém exatamente três
  asserções offline; suites PG/HTTP faciais e holdout/modelo não são inferidos.

Pré-requisitos: Linux com PID/mount namespaces e procfs, sudo/unshare/Python3
confiáveis, libc prctl/capset/mount, pidfd_open/pidfd_send_signal, as capabilities
necessárias permitidas pelo runner e LSM, ambiente PostgreSQL CI dedicado.
Ausência ou negação fecha o gate; não habilita mudança de segurança do host.

Referências primárias: [procfs](https://docs.kernel.org/filesystems/proc.html),
[NoNewPrivs](https://docs.kernel.org/userspace-api/no_new_privs.html),
[unshare](https://github.com/util-linux/util-linux/blob/master/sys-utils/unshare.c),
[SCM_CREDENTIALS](https://github.com/mkerrisk/man-pages/blob/master/man7/unix.7).
Parent-death: [man-pages PR_SET_PDEATHSIG](https://github.com/mkerrisk/man-pages/blob/master/man2/prctl.2),
[unshare v2.39.3](https://github.com/util-linux/util-linux/blob/v2.39.3/sys-utils/unshare.c),
[kernel cred.c](https://github.com/torvalds/linux/blob/v6.8/kernel/cred.c).
Node-API: [ABI stability](https://nodejs.org/api/n-api.html#implications-of-abi-stability)
e [object type tagging](https://nodejs.org/api/n-api.html#object-type-tagging).

## Owner de build, registro e limpeza — diff isolado para revisão

O shell de build somente resolve caminhos e faz exec do owner Node normal.
Esse owner registra runID/PID/starttime/UID/inode namespace e raiz 0700 antes do
filho. O bootstrap Node fixo recusa EOF, ACK inválido e prazo total de 5s;
captura de nascimento e recheck precedem ACK. Uma única cadeia GNU timeout
TERM 55s + KILL 5s contém cc --version e a compilação fixa. Provenance v2 e
admissão aberta só existem com exit 0, evento close e terminalidade observada
de todas as identidades capturadas. Falha retém raiz/logs; exportar a localização
da raiz para cleanup não publica um addon válido.

Toda entrada no addon, inclusive cache, registra self real por criação exclusiva
sob mkdir-lock bounded. O registro verifica run/commit/raiz/input hashes e a
allowlist explícita de fontes novas; nenhum require nativo precede admissão.
Registro de self não é evento close. npm test literal (via npm-cli fixo), oito
suites e composto passam por owner normal de comando fixo, token de nascimento,
inventário metadata bounded e recibo separado de child close/árvore. Um novo
PID vivo não atribuível fecha gate; UID sozinho não autoriza adoção/sinal.

Cleanup é outro entrypoint normal e não carrega addon. Fecha admissão, confere
creator/consumers/inputs/recibos e revalida identidades conhecidas; não sinaliza
nem adota PID novo. PID local de namespace nunca é consultado como host:
inode/runID ancorados em READY medido + FINAL real com namespaceEmpty fecham
essas inscrições. Caminho/owner/arquivo desconhecido ou prova inconclusiva
retém raiz e FAIL. Arquiva bytes/hashes/registro/recibos antes de remover somente
a raiz exata autenticada. Workflow sempre chama cleanup e publica arquivo
separado para Quality Node22 e Perception Node24, sem mudar prazos dos jobs.

Limite identificado e patch focal preparado: o antigo PID2 do READY era Python
depois de drop_product, ainda nondumpable antes de execve(Node). Agora PID1
mede o Python dropped e reduz caps; guardian reduz/readback e libera somente
o exec do bootstrap Node fixo. Esse Node usa apenas stdlib até G, mede seu
próprio UID/GID/caps/grupos/NNP/inode e envia readiness por FD próprio. Init e
guardian revalidam o MESMO PID/starttime; o READY externo só vem depois disso.
Gate/ready/RPC têm FDs próprios e receipt/release não chegam ao Node. G fecha
gate/ready e chama main inner por import fixo no MESMO PID, sem spawn/exec
de produto substituto. Inode observado do Node normal cruza atestação Warden
antes de G. EACCES/mismatch/EOF/deadline continuam FAIL; não foi usado
PR_SET_DUMPABLE nem alteração de privilégio. A execução Linux dessa transição
e da ausência de vazamento de FDs permanece gate, não prova já obtida.

Testes preparados cobrem admissão fechada antes de require, inscrição exclusiva
real sem carregar bytes nativos, lock/deadline, EOF/ACK/deadline do bootstrap,
compiler fail/timeout recusados na publicação, close/terminalidade, namespace
binding errado/ausente, desconhecido e ausência de FINAL. Esses vetores puros
não substituem execução real de compiler falhado/timeout, cleanup com
sobrevivente, oito negativos do composto e cascata outer-host-death. Nenhuma
compilação/teste/run foi executada pelo autor deste diff.
