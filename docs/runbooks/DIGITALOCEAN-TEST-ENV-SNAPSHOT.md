# Ambiente de teste Apollo na DigitalOcean — snapshot reutilizável

Decisão do proprietário em 22/10/2026: o ambiente completo de teste (PostgreSQL, MinIO, Chromium, ffmpeg, runtime
OpenVINO) fica gravado como snapshot, para regressões e para a W70 reinstanciarem sem remontar. O teto de custo
combinado antes foi levantado só para esta onda.

**A DigitalOcean é o único provedor remoto. A VPS Hostinger (`srv1512423.hstgr.cloud` / `187.77.245.144`) é PROIBIDA:
nem SSH, nem API, nem leitura.** O token da DigitalOcean vive só no Brain (memória #3800); nunca em arquivo, log,
prompt, repositório ou snapshot.

## O snapshot

- Nome: `apollo-test-env-20261022-536b6fa` — id **250999376**, região **`ric1`** (Richmond), 21,87 GB, `min_disk_size` 80 GB.
  Só reinstancia em tamanhos com disco **≥ 80 GB** (o disco do droplet de origem). Snapshots só existem na região onde foram
  gravados.
- Gravado em 22/10/2026 17:42 UTC, com o droplet desligado, a partir de `apollo-test-env-20261022b` (id 611644052,
  `g5-4vcpu-16gb-80gb`, AMD EPYC 9555P, CPU dedicada) depois de a validação do CI passar inteira (ver "Desempenho e validação").
- Repositório em `/opt/apollo/apollo-video` no commit `536b6fada3500d9f45c4ad135da1cf0d2dda0ec4` (origin/main de 22/10/2026), com
  `npm ci`, clientes Prisma, `npm run remotion:build`, `npm run build` e o addon pidfd já construídos.
- Ubuntu 24.04, Node 22 (v22.23.4, npm 10.9.9), Docker (`docker.io` + compose v2), usuário sem privilégio `apollo` (roda o
  repositório, como o runner do CI; o build do addon pidfd recusa uid 0).
- PostgreSQL 16 + pgvector 0.8.5 no container `apollo-postgres` (imagem `pgvector/pgvector:0.8.5-pg16-trixie`,
  `127.0.0.1:5432`, `restart: unless-stopped`, usuário/senha/banco de TESTE `apollo`/`apollo-ci`/`apollo_v2`, que são
  as mesmas credenciais do CI e não são segredo). O cluster está vazio (só `apollo_v2`, sem tabelas). Os binários PostgreSQL 16
  do sistema estão em `/usr/lib/postgresql/16/bin` com o serviço do sistema desabilitado.
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
- `/opt/apollo/provision.sh` e `/opt/apollo/validate.sh` (cópias de `scripts/ops/digitalocean-test-env/`; a cópia do `validate.sh` no snapshot é anterior à correção do resumo de steal e do tempo de render: recopie do repositório).
- `unattended-upgrades` e os timers do apt estão desligados: nenhum pacote muda sozinho.

Não contém: segredos de provedor, bancos de teste, logs ou evidências de execuções, nem mídia de cliente. As chaves de host SSH
do droplet de origem vão junto no snapshot (os droplets criados dele compartilham o fingerprint
`SHA256:OCUi9NPdDc352D7v5sQYywYeVep0R++No/VKDJvkkDU`); a chave pública `apollo-do-test-env` também fica em `authorized_keys`.

## Desempenho e validação (por que dedicada)

O primeiro ambiente, `s-8vcpu-16gb-intel` em nyc3 (CPU compartilhada "DO-Premium-Intel" 2,0 GHz), **não** passou o CI: a jornada 7
do Wave 23 runtime-safety falhou em 7 de 7 execuções e o teste unitário `perception-ci-supervisor.test.mjs:713` falhou 2 de 2
com os 8 vCPU soltos. O `steal` medido com `vmstat 2` durante o runtime-safety foi de 3,6–4,4% em média (máximo 12–18%) e o
render de proxy passou de 40 s (jornada 4: 46–50 s; jornada 7: 40,5 s, que é o timeout do teste). O ffmpeg usado era o
`ffmpeg-static` (187 amostras de processos), então a causa não foi o ffmpeg do apt.

No `g5-4vcpu-16gb-80gb` em ric1 (4 vCPU dedicados, AMD EPYC 9555P, `steal` 0%), com os mesmos comandos e variáveis do CI e o
repositório em `536b6fad`:

| Passo (comando) | Resultado |
| --- | --- |
| Unitários: `node scripts/validation/perception-consumer-cgroup.mjs unit` | 3969 testes, 3963 pass, 0 fail, 6 skip, 170 s |
| Deploy contra Docker de gravação: `npm run test:e2e:deploy-fake-docker` | 6/6 |
| Segurança do host no /proc: `npm run test:e2e:host-safety-linux` | 3/3 |
| Confiabilidade do editor: `npm run test:e2e:editor-reliability` | 1/1, 37 s |
| Runtime safety (driver local): `npm run test:e2e:runtime-safety-workers`, 3 execuções | 8/8 nas três, 141 s cada |

Na dedicada o render de proxy das jornadas 4 e 7 leva ~10 s (contra 40–50 s na compartilhada); a suíte inteira, 141 s contra
514 s. Nenhum timeout nem limiar foi alterado. **Para validar de novo use `validate.sh`**, que roda os mesmos comandos do CI com o
mesmo ambiente (sem as variáveis do crítico de pixels, ffmpeg do `ffmpeg-static`, ffprobe do apt, `taskset -c 0-3`), grava
`vmstat 2` (coluna `st` = steal), os ffmpeg executados e o tempo de render por jornada em `/opt/apollo/logs/<caso>-<rótulo>/`:

```bash
/opt/apollo/validate.sh <unit|deploy-fake-docker|host-safety|runtime-safety|editor> [rótulo]    # como o usuário apollo
```

Não use `npm test` puro: ele falha cinco testes do pidfd (só existem sob o consumer do CI, que define
`APOLLO_PERCEPTION_CONSUMER_RUN_ID`) e, se `FFMPEG_PATH` apontar para o ffmpeg do apt, dois testes de reconstrução de final.

`tests/v2/mvp-core-full-journey.e2e.mjs` não foi executado neste ambiente: não roda no CI, o teste estava desatualizado em
relação à API (`format` em `POST /v1/projects` gera 422) e exige `.apollo/test-inputs/imersao-master.mp4`, que não está aqui.

## Instanciar a partir do snapshot

1. Confirme o IP público atual de quem vai conectar (`curl -s https://api.ipify.org`).
2. Crie a chave SSH (se ainda não existir) e registre a pública na DigitalOcean (`POST /v2/account/keys`).
3. Crie a tag (`POST /v2/tags`, `apollo-w70-env`) e o firewall com **22/tcp somente do IP acima (`/32`)**, saída livre, aplicado
   pela tag. Já existem: tag `apollo-w70-env`, firewall `apollo-w70-env-fw` (`860d2be6-4f47-4755-877d-82ce0851bf06`) e chave 60288938;
   atualize o IP do firewall se mudou.
4. Crie o droplet com `POST /v2/droplets`: `region: ric1`, `size: g5-4vcpu-16gb-80gb` (ou outro com disco ≥ 80 GB e CPU
   dedicada), `image: 250999376`, **sem `vpc_uuid`** (cai na `default-ric1`; confira por `GET /v2/vpcs/<id>/members` que só o novo
   droplet é membro), `monitoring: true`, `ssh_keys: [60288938]`, `tags: ["apollo-w70-env"]`. Confira por `GET /v2/droplets/<id>`
   (status `active`; id/nome/região/size/imagem/tag/VPC iguais ao pedido) antes de usar o IP. Os tamanhos `g5-*` só existem em
   `mem1`, `mkc1` e `ric1`; `gd-4vcpu-16gb-intel`, `g-4vcpu-16gb-intel` (nyc3) e `g5-4vcpu-16gb-80gb` (atl1) foram recusados com
   422 nesta conta em 22/10. O helper local lê o token do Brain dentro do processo:
   `MSYS_NO_PATHCONV=1 node do-api.mjs <MÉTODO> <caminho> [corpo.json]`.
5. Entre por SSH (`ssh -i <chave> root@<ip>`) e confirme `docker ps` (postgres e minio `healthy`), `node -v` (v22) e
   `. /opt/apollo/env/test-env.sh`. Se o commit mudar (próxima seção), regenere o arquivo de ambiente: `/opt/apollo/provision.sh envfile`
   (os hashes das pontes dependem do commit).

Para montar do zero em uma máquina limpa (Ubuntu 24.04), copie `provision.sh` e os cinco arquivos de modelo para
`/opt/apollo/incoming/models/` e rode `./provision.sh` como root; foi assim que o ambiente de ric1 foi feito, sem nenhum passo
manual (≈ 7 minutos em 4 vCPU dedicados).

## Atualizar o repositório para outro commit

Como `apollo`, em `/opt/apollo/apollo-video`:

```bash
git fetch origin && git checkout --detach <commit>
npm ci && npm ci --prefix remotion
npm run remotion:build && npm run build
```

`npm ci` roda o postinstall que gera os clientes Prisma (não existe `prisma generate` na raiz, o schema fica em `prisma/v2`).
Se o `package-lock.json` não mudou, `node_modules` serve. Depois, como root, `/opt/apollo/provision.sh envfile` para recalcular os
hashes das pontes. Se o commit mudou o addon pidfd (`scripts/validation/perception-pidfd.*`), reconstrua-o com `provision.sh deps`.

## Segredos só no processo

Chaves de provedor (Groq etc.) entram por variável de ambiente do comando, nunca em arquivo do droplet:

```bash
GROQ_API_KEY="$(…)" npm run test:e2e:…
```

Antes de gravar um snapshot novo: apague bancos de teste, `/opt/apollo/logs`, `/opt/apollo/runner-temp/*` (exceto o diretório do
addon pidfd e `github_env`), `~/.npm/_npx`, e faça `history -c` + truncar `~/.bash_history` (root e `apollo`). Varra por padrões de
token (`dop_v1_[a-f0-9]{64}`, `gsk_…`, `sk-…{32,}`) em `/root`, `/opt` e `/etc/environment`: deve devolver 0 arquivos. A
varredura solta (`sk-` etc.) pega só texto de terceiros (`task-`, `mask-`, caches do Playwright), que não é segredo.

## W70 (`tests/v2/recovery-master-live.e2e.mjs`)

Exige `APOLLO_RECOVERY_MASTER_LIVE=1`, banco isolado, `GROQ_API_KEY` por processo, `GROQ_TRANSCRIBE_MODEL=whisper-large-v3-turbo`,
`GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR=4`, `APOLLO_RECOVERY_COST_CAP_USD` (≤ 2), `APOLLO_RECOVERY_MASTER_PATH` (o master
do proprietário, que NÃO está no snapshot: copie por `scp` e apague depois) e `APOLLO_RECOVERY_EVIDENCE_ROOT`. Para o crítico
de pixels do final, carregue as sete variáveis `APOLLO_V2_PIXEL_ORACLE_*` (já em `test-env.sh`). Rode tudo em `nohup`/`tmux` e acompanhe
por polling; uma sessão SSH que cai mata o processo em primeiro plano.

## Paridade V9 no Linux

`createFaceWindowWorker` ainda recusa `linux` (`PERSISTENCE_NOT_CONFIGURED`: o registro de produtores não tem recibo de paridade).
O proprietário aceitou a paridade em 22/10/2026 com base na medição abaixo; o recibo no repositório é de outra frente. Medição
(60 imagens de desenvolvimento, PNG idênticos, oráculo de pixels com os mesmos modelos pinados): detecções com score ≥ 0,5 idênticas
em todas as comparações (V9 61/61, retail 52/52); delta máximo de caixa/score 3,6e-7 (Linux/Intel) e 8,9e-7 (Linux/AMD EPYC, a
máquina deste snapshot) contra o Windows (Python 3.14). Os tensores brutos não são idênticos byte a byte (V9 1/60 em ambos os
Linux; retail 53/60), e dependem da CPU. Python no Linux: 3.12.3 (o aceito é 3.14); OpenVINO 2026.4.0, OpenCV 4.13.0 e NumPy 2.5.1
iguais. Entradas, saídas, hashes e versões: fora do repositório, em `Documents/Apollo/w61-70-20261008/do-test-env/v9-linux-parity-20261022/`.

## Destruir o droplet preservando o snapshot

```bash
MSYS_NO_PATHCONV=1 node do-api.mjs DELETE /v2/droplets/<droplet-id>
```

Só o droplet (confira antes por `GET` nome, tag e IP). O snapshot, a chave SSH, a tag e o firewall são recursos separados e ficam;
apague o firewall e a chave quando não houver mais droplet. Nunca toque nos snapshots `196315426` e `240076873` nem na chave
`58272886`. Custo de referência: `g5-4vcpu-16gb-80gb` = US$ 0,18762 por hora enquanto o droplet existir (mesmo desligado);
o snapshot cobra por GB armazenado (21,87 GB).
