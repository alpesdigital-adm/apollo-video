# Ambiente de teste Apollo na DigitalOcean — snapshot reutilizável

Decisão do proprietário em 22/10/2026: o ambiente completo de teste (PostgreSQL, MinIO, Chromium, ffmpeg, runtime
OpenVINO) fica gravado como snapshot, para regressões e para a W70 reinstanciarem sem remontar. O teto de custo
combinado antes foi levantado só para esta onda.

**A DigitalOcean é o único provedor remoto. A VPS Hostinger (`srv1512423.hstgr.cloud` / `187.77.245.144`) é PROIBIDA:
nem SSH, nem API, nem leitura.** O token da DigitalOcean vive só no Brain (memória #3800); nunca em arquivo, log,
prompt, repositório ou snapshot.

## Estado em 22/10/2026: snapshot NÃO gravado

O ambiente foi montado e validado nos itens de versão, no crítico de pixels e na maior parte dos E2E, mas a regra do
proprietário é gravar o snapshot só com o ambiente validado, e dois passos do CI falham de forma reproduzível neste hardware
(ver "Achados"). Em vez de afrouxar timeout algum, o snapshot não foi gravado e o droplet ficou ligado para decisão. Quando
a decisão for tomada (aceitar o ambiente como está, ou subir para um tamanho mais rápido e repetir), este documento passa a
dizer o nome e o id do snapshot; até lá, as seções abaixo descrevem o que o droplet contém e o que o snapshot conterá.

## O que o snapshot contém

- Nome previsto: `apollo-w70-env-20261022-b87e39f` (região `nyc3`). Id e tamanho: a registrar quando for gravado.
- Repositório em `/opt/apollo/apollo-video` no commit `b87e39f7239c514e5f99bd1c8b9f2c009b3a653f` (origin/main de 22/10/2026), com `npm ci`,
  clientes Prisma, `npm run remotion:build`, `npm run build` e o addon pidfd já construídos.
- Ubuntu 24.04, Node 22 (v22.23.4, npm 10.9.9), Docker (`docker.io` + compose v2), usuário sem privilégio `apollo` (roda o
  repositório, como o runner do CI; o build do addon pidfd recusa uid 0).
- PostgreSQL 16 + pgvector 0.8.5 no container `apollo-postgres` (imagem `pgvector/pgvector:0.8.5-pg16-trixie`,
  `127.0.0.1:5432`, `restart: unless-stopped`, usuário/senha/banco de TESTE `apollo`/`apollo-ci`/`apollo_v2`, que são
  as mesmas credenciais do CI e não são segredo). O cluster está vazio. Os binários PostgreSQL 16 do sistema estão em
  `/usr/lib/postgresql/16/bin` com o serviço do sistema desabilitado.
- MinIO construído da fonte pinada (`infra/object-storage`) no container `apollo-minio-minio-1`
  (`127.0.0.1:59000/59001`, credenciais de teste do CI, `restart: unless-stopped`). Arquivo `/opt/apollo/env/minio.env`.
- ffmpeg 6.1.1 e ffprobe do apt (libass, `fonts-liberation`); `ffmpeg-static` do npm continua sendo o ffmpeg dos testes.
- Chromium do Playwright em `/opt/apollo/ms-playwright` (link `/usr/local/bin/playwright-chromium`).
- Python 3.12: `venv-ops` (paramiko/cryptography do `requirements.txt` das operações) e `venv-oracle`; o diretório
  privado de pacotes `/opt/apollo/oracle-pydeps` tem `openvino==2026.4.0`, `opencv-python-headless` 4.13.0 e
  `numpy` 2.5.1 (sem bytecode).
- Modelos OMZ em `/opt/apollo/models` (somente leitura; SHA-256 conferidos contra os pins do código): `face-detection-0204`
  (V9), `face-detection-retail-0004` e a `LICENSE` Apache-2.0.
- `/opt/apollo/env/test-env.sh` (sem segredos; formato em `scripts/ops/digitalocean-test-env/test-env.example.sh`) e o
  manifesto do runtime de rosto `/opt/apollo/env/face-runtime-manifest.json`.
- `unattended-upgrades` e os timers do apt estão desligados: nenhum pacote muda sozinho.

Não contém: segredos de provedor, bancos de teste, evidências de execuções, nem mídia de cliente.

## Instanciar a partir do snapshot

1. Confirme o IP público atual de quem vai conectar (`curl -s https://api.ipify.org`).
2. Crie a chave SSH (se ainda não existir) e registre a pública na DigitalOcean (`POST /v2/account/keys`).
3. Crie o firewall com **22/tcp somente do IP acima (`/32`)**, saída livre, aplicado pela tag `apollo-w70-env`
   (a tag precisa existir antes: `POST /v2/tags`).
4. Crie o droplet com `POST /v2/droplets`: `region: nyc3`, `size: s-8vcpu-16gb-intel`, `image: <id do snapshot>`,
   `vpc_uuid` da `default-nyc3`, `monitoring: true`, `ssh_keys: [<id>]`, `tags: ["apollo-w70-env"]`. Confira por
   `GET /v2/droplets/<id>` (status `active`; id/nome/região/size/imagem/tag/VPC iguais ao pedido) antes de usar o IP.
   O helper local lê o token do Brain dentro do processo: `MSYS_NO_PATHCONV=1 node do-api.mjs <MÉTODO> <caminho> [corpo.json]`.
5. Entre por SSH (`ssh -i <chave> root@<ip>`; registre o fingerprint do host na primeira conexão) e confirme:
   `docker ps` (postgres e minio `healthy`), `node -v` (v22), `psql` via `docker exec` e `. /opt/apollo/env/test-env.sh`.
   Se o IP do droplet novo ou o commit mudaram, regenere o arquivo de ambiente: `/opt/apollo/provision.sh envfile`
   (os hashes das pontes dependem do commit).

## Atualizar o repositório para outro commit

Como `apollo`, em `/opt/apollo/apollo-video`:

```bash
git fetch origin && git checkout --detach <commit>
npm ci && npm ci --prefix remotion
npm run remotion:build && npm run build
```

`npm ci` roda o postinstall que gera os clientes Prisma (leva vários minutos; não existe `prisma generate` na raiz, o
schema fica em `prisma/v2`). Se o `package-lock.json` não mudou, `node_modules` serve. Depois, como root,
`/opt/apollo/provision.sh envfile` para recalcular os hashes das pontes. Se o commit mudou o addon pidfd
(`scripts/validation/perception-pidfd.*`), reconstrua-o com `deps` do `provision.sh`.

## Segredos só no processo

Chaves de provedor (Groq etc.) entram por variável de ambiente do comando, nunca em arquivo do droplet:

```bash
GROQ_API_KEY="$(…)" npm run test:e2e:…
```

Antes de gravar um snapshot novo, procure vestígios: `grep -rIl -E 'dop_v1_|gsk_|brain-|sk-' /root /opt /etc/environment`
deve devolver 0 arquivos, e `history -c` + truncar `~/.bash_history` (root e `apollo`).

## Rodar os testes

Sempre como `apollo`, com o ambiente carregado. Para o passo de testes unitários do CI, **sem** as variáveis do crítico
de pixels (o CI não as define):

```bash
. /opt/apollo/env/test-env.sh
for v in $(compgen -e | grep -E '^APOLLO_V2_(PIXEL_ORACLE|FACE_V9)_'); do unset "$v"; done
taskset -c 0-3 node scripts/validation/perception-consumer-cgroup.mjs unit
```

`npm test` puro falha cinco testes do pidfd, que só existem sob o consumer do CI (`APOLLO_PERCEPTION_CONSUMER_RUN_ID`).
`taskset -c 0-3` reproduz os 4 vCPU do runner: com os 8 vCPU soltos o teste
`Linux owned cleanup proves close and terminal identities…` falhou 2 de 2 vezes (ver "Achados").

E2E (bancos descartáveis criados e migrados como no CI; um banco por jornada):

```bash
docker exec -e PGPASSWORD=apollo-ci apollo-postgres psql -U apollo -d postgres -c 'create database apollo_v2_e2e_capture'
V2_DATABASE_URL='postgresql://apollo:apollo-ci@127.0.0.1:5432/apollo_v2_e2e_capture?schema=public' npm run db:v2:migrate:deploy
APOLLO_EDITOR_RELIABILITY_E2E=1 APOLLO_EDITOR_RELIABILITY_EVIDENCE_DIR=$RUNNER_TEMP/editor-reliability \
  V2_DATABASE_URL='postgresql://apollo:apollo-ci@127.0.0.1:5432/apollo_v2_e2e_capture?schema=public' npm run test:e2e:editor-reliability
```

Os demais (Wave 23, runtime safety) usam as variáveis do passo correspondente do `.github/workflows/ci.yml`. Rode tudo em
`nohup`/`tmux` e acompanhe por polling; uma sessão SSH que cai mata o processo em primeiro plano.

### W70 (`tests/v2/recovery-master-live.e2e.mjs`)

Exige `APOLLO_RECOVERY_MASTER_LIVE=1`, banco isolado, `GROQ_API_KEY` por processo, `GROQ_TRANSCRIBE_MODEL=whisper-large-v3-turbo`,
`GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR=4`, `APOLLO_RECOVERY_COST_CAP_USD` (≤ 2), `APOLLO_RECOVERY_MASTER_PATH` (o master
do proprietário, que NÃO está no snapshot: copie por `scp` e apague depois) e `APOLLO_RECOVERY_EVIDENCE_ROOT`. Para o crítico
de pixels do final, carregue as sete variáveis `APOLLO_V2_PIXEL_ORACLE_*` (já em `test-env.sh`).

## Achados desta montagem (não corrigidos de propósito)

Medidos no droplet `apollo-w70-env-20261022` (`s-8vcpu-16gb-intel`, CPU "DO-Premium-Intel" 2,0 GHz, compartilhada), commit `b87e39f7`:

- **Testes unitários e de contrato** (passo do CI `perception-consumer-cgroup.mjs unit`, 3939 testes): com os 8 vCPU soltos,
  3932 pass / 1 fail / 6 skip, 2 de 2 execuções, sempre o mesmo teste (`perception-ci-supervisor.test.mjs:713`, "Spawned root
  identity was not observed completely": um filho de 250 ms não é observado porque o baseline de processos demora ~550 ms sob a
  concorrência de 7 arquivos de teste). Isolado, o teste passa 5 de 5. Com `taskset -c 0-3` (4 vCPU, como o runner): 3933 pass /
  0 fail / 6 skip em 559 s (N=1).
- **Wave 23, runtime safety no driver local** (`npm run test:e2e:runtime-safety-workers`): a jornada 7 ("um monitor que para de
  escrever fecha a admissão") falhou 4 de 4 (3 com `taskset -c 0-3`, 1 solta): o worker só relê o gate depois do render, e o render
  de proxy leva mais de 40 s aqui; o teste espera 40 s. A jornada 2 falhou 1 de 4 (`settled outside the shutdown contract`).
  A suíte inteira levou ~9 min, contra ~3 min no runner do CI (comentário do `ci.yml`). Hipótese: o droplet é ~2,5x mais lento
  que o runner e os timeouts do teste foram calibrados para o runner. Não foi confirmada em hardware mais rápido e **nenhum timeout
  foi alterado**.
- Passam: deploy contra Docker de gravação (6/6), coletor de segurança do host no /proc real (3/3), jornada de confiabilidade do
  editor com o Chromium (1/1), teste puro da ponte V9 (6/6), integração do crítico MP4 com oráculo simulado e ffmpeg real (11/11).
- `tests/v2/mvp-core-full-journey.e2e.mjs` está **desatualizado em relação à API**: envia `format` em `POST /v1/projects` e a rota
  (`src/app/v1/projects/route.ts`) rejeita campo não suportado (422). Também exige `.apollo/test-inputs/imersao-master.mp4`,
  que não existe na máquina do proprietário; para chegar ao POST usei um arquivo sintético (apagado/descartável). Não roda no CI.
- **Paridade V9 no Linux (medição, não aceite).** `createFaceWindowWorker` continua recusando `linux`
  (`PERSISTENCE_NOT_CONFIGURED`: o registro de produtores não tem recibo de paridade) e isso não foi tocado. O oráculo de pixels (mesmos
  arquivos de modelo, pinados por SHA-256) roda no Linux. Comparação com o Windows (Python 3.14) sobre as mesmas 60 imagens de
  desenvolvimento (PNG idênticos): detecções com score >= 0,5 idênticas (V9 61/61, retail 52/52), delta máximo de caixa/score 3,6e-7,
  mas os tensores brutos só são idênticos byte a byte em 1/60 (V9) e 53/60 (retail). Python no Linux: 3.12.3 (o aceito é 3.14);
  OpenVINO 2026.4.0, OpenCV 4.13.0, NumPy 2.5.1 iguais. A decisão sobre paridade continua sendo do proprietário.
- O `npm test` puro não é o passo do CI: falha 5 testes do pidfd (sem `APOLLO_PERCEPTION_CONSUMER_RUN_ID`) e, se `FFMPEG_PATH`
  apontar para o ffmpeg do apt, 2 testes de reconstrução de final ("FFmpeg binary differs from the approved final render"): o ffmpeg dos
  testes é o `ffmpeg-static` pinado; só o `ffprobe` é o da distribuição.

## Destruir o droplet preservando o snapshot

```bash
MSYS_NO_PATHCONV=1 node do-api.mjs DELETE /v2/droplets/<droplet-id>
```

Só o droplet. O snapshot, a chave SSH, a tag e o firewall são recursos separados e ficam; apague o
firewall e a chave quando não houver mais droplet. Nunca toque nos snapshots `196315426` e `240076873` nem na chave
`58272886`. Custo de referência: `s-8vcpu-16gb-intel` = US$ 0,16667 por hora ligado, mesmo desligado enquanto o droplet
existir; o snapshot cobra por GB armazenado.
