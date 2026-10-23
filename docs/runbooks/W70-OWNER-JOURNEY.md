# W70 — jornada do dono com o master real (condutor `w70-owner-journey`)

Este runbook cobre só a execução da jornada fresca da W70: dois MP4 novos (9:16 e 16:9) de um master real, a correção pedida pelo dono, o download, o decode completo, a inspeção audiovisual e o aceite. O briefing e o roteiro de validação ficam fora do repositório (`w70/briefing-w70.md`); **nenhum conteúdo do vídeo entra no script, nos testes ou aqui** (regra pétrea de `AGENTS.md`: nada é fixo, tudo vem do pedido de cada vídeo). Os exemplos abaixo usam marcadores.

A única hospedagem remota permitida é a DigitalOcean. **É proibido usar a VPS Hostinger** (SSH, API, navegador, banco, storage ou workers) em qualquer etapa; veja `docs/runbooks/OPERATIONS.md`.

## O que o condutor faz

`scripts/validation/w70-owner-journey.mjs` conduz a jornada pela API pública `/v1`, como um usuário ou integrador faria, contra um servidor já em execução. Não decide frase, objetivo, saída nem aprovação: tudo chega por arquivo ou variável e ele aplica exatamente o que o arquivo diz. Em qualquer resposta inesperada, para com mensagem clara (falha fechada). Cada requisição e resposta vai, sem credenciais, para a evidência; o estado vai para `journey-log.jsonl`, e `--resume` pula as fases concluídas.

| Fase | O que acontece | Decisão humana esperada |
|---|---|---|
| `p1-create-project` | `POST /v1/projects` com o texto exato do briefing; registra a leitura do interpretador (diretivas com trecho citado, não suportado, perguntas) | nenhuma |
| `p2-outputs-ingest` | uma saída por proporção; upload real do master (tamanho e SHA-256 conferidos); espera da transcrição (idioma detectado e origem); direitos da fonte; pipeline de cor técnico (identidade); pedidos de `--setup` | `source-rights.json` só se os direitos não vierem aprovados |
| `p3-director-first` | roda o Diretor; se recusar (`editorial-request-blocked`, `director-objective-required`, briefing não lido), registra o motivo e **para** | `revise-editorial-request.json` (e `-2`, `-3`…) |
| `p4-spoken-cuts` | um `remove-spoken-content`, com as frases do arquivo | `remove-spoken-content.json` |
| `p5-director-review` | Diretor de novo, proxy de cada saída, laudo (issues técnicas e do crítico), download do proxy | `proxy-review.json` (e `-2`…) |
| `p6-final-inspection` | final de cada saída, download por download-grant, SHA-256, `ffprobe`, decode completo, `w70-manifest.json` | nenhuma (o dono revisa os arquivos fora do script) |
| `p7-owner-correction` | aplica a correção do dono, novo final das saídas afetadas, `w70-manifest.v2.json` | `owner-correction.json` |
| `p8-owner-acceptance` | grava o aceite no manifesto v2 | `owner-acceptance.json` |

Avisar o dono pelo WhatsApp (passos 6 e 7 do roteiro) é do operador: o condutor registra `owner-review-requested` no log com os caminhos dos arquivos.

## Pré-requisitos no droplet DigitalOcean

1. Droplet criado a partir do snapshot **250999376**, com o repositório na `main` (commit conferido com `git rev-parse HEAD`), `npm ci` feito e `node scripts/generate-prisma-clients.mjs` executado. Confirmar a identidade do alvo antes de qualquer mutação (`docs/runbooks/DIGITALOCEAN-DISPOSABLE-VALIDATION.md`, `AGENTS.md`).
2. PostgreSQL do próprio ambiente, migrado (`npx prisma migrate deploy --schema prisma/v2/schema.prisma`), e `npm run build` concluído.
3. Workspace e credencial de cliente da API (o token aparece uma vez):
   `node scripts/bootstrap-v2-workspace.mjs --workspace-id <id> --workspace-slug <slug> --workspace-name <nome> --client-id <id> --client-name <nome> --environment production`
4. Variáveis do servidor e dos workers (valores por variável de processo, nunca em arquivo versionado):
   - Armazenamento e URLs: `V2_DATABASE_URL`, `APOLLO_API_ENVIRONMENT=production`, `APOLLO_V2_ARTIFACT_ROOT`, `APOLLO_V2_ARTIFACT_STORAGE_DRIVER`, `APOLLO_V2_RENDER_WORK_ROOT`, `APOLLO_MEDIA_UPLOAD_BASE_URL` e `APOLLO_MEDIA_DOWNLOAD_BASE_URL` (a URL pela qual o condutor alcança o servidor, com `/` no fim), `APOLLO_MEDIA_UPLOAD_SIGNING_SECRET` e `APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET` (32 bytes ou mais), `APOLLO_PROTECTED_PAYLOAD_KEY_ID` e `APOLLO_PROTECTED_PAYLOAD_KEY`.
   - Interpretador do briefing (Codex CLI logado com a conta do ChatGPT, sem chave de API): `APOLLO_V2_BRIEF_INTERPRETER_PROVIDER=codex-cli`, `APOLLO_V2_BRIEF_INTERPRETER_MODEL=<modelo>` (sem default), `APOLLO_V2_CODEX_BIN=<caminho do executável>` (versão exata `codex-cli 0.154.0`), `APOLLO_V2_CODEX_HOME=<diretório dedicado ao Apollo>` com só o login (`CODEX_HOME=<dir> codex login --device-auth`; sem `AGENTS.md`, hooks nem configuração). Opcional: `APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS`.
   - Transcrição (Groq): `GROQ_API_KEY`, `GROQ_TRANSCRIBE_MODEL=whisper-large-v3-turbo`, `GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR=4`. O teto de custo da rodada é do operador (US$ 2).
   - Crítico de pixels do MP4, **as 7 variáveis juntas**: `APOLLO_V2_PIXEL_ORACLE_PYTHON`, `APOLLO_V2_PIXEL_ORACLE_PYTHON_SHA256`, `APOLLO_V2_PIXEL_ORACLE_MODULES`, `APOLLO_V2_PIXEL_ORACLE_V9_MODEL_DIR`, `APOLLO_V2_PIXEL_ORACLE_RETAIL_MODEL_DIR`, `APOLLO_V2_PIXEL_ORACLE_BRIDGE`, `APOLLO_V2_PIXEL_ORACLE_BRIDGE_SHA256`. Sem elas todo final de produção é bloqueado (`MP4_CRITIC_NOT_CONFIGURED`), e em produção `APOLLO_V2_MP4_CRITIC_ACK_*` é recusado: não há atalho.
   - Detector de rosto V9 (o reframe do 9:16 acompanha o rosto): `APOLLO_V2_FACE_PROFILE=openvino-face0204-v9-source` no worker de rosto, com o conjunto `APOLLO_V2_FACE_V9_*` (Python, módulos, manifesto do runtime e seu SHA-256, modelo XML/BIN, ponte e SHA-256, ffmpeg/ffprobe e SHA-256, licença do modelo e SHA-256). No Linux ele só inicia com o recibo de paridade da plataforma; sem ele o worker recusa (falha fechada).
   - Binários: `FFMPEG_PATH` e `FFPROBE_PATH` (FFprobe 6 ou mais novo; o 4.0.2 do `ffprobe-static` não responde à sonda do produto).
5. Espaço em disco para o master, os proxies, os finais e a cópia de evidência (o master da W70 tem cerca de 145 MB).

## Subir o servidor e os workers

Cada comando num processo próprio, com o ambiente acima (a ordem não importa; todos esperam o banco):

```
node node_modules/next/dist/bin/next start -p 3000                 # API /v1
./node_modules/.bin/tsx scripts/run-v2-ingest-worker.mjs            # ingest + transcrição
./node_modules/.bin/tsx scripts/run-v2-render-worker.mjs            # proxy, final e Diretor assíncrono
APOLLO_V2_FACE_PROFILE=openvino-face0204-v9-source ./node_modules/.bin/tsx scripts/run-v2-face-producer-worker.mjs
```

Conferir `GET /v1/health` antes de começar. O Diretor roda no servidor (Command `run-director`); proxy e final rodam no worker de render.

## Rodar o condutor

Tudo fora do repositório: o diretório de evidência e o de decisões são absolutos e distintos.

```
export APOLLO_API_BASE_URL=http://127.0.0.1:3000
export APOLLO_API_TOKEN=<token do cliente da API>
./node_modules/.bin/tsx scripts/validation/w70-owner-journey.mjs \
  --briefing /abs/briefing.txt --outputs <proporção>,<proporção> \
  --master /abs/master --master-sha256 <sha256> --master-size <bytes> --rights-confirmed \
  --evidence /abs/evidence --decisions /abs/decisions \
  [--objective <id do catálogo>] [--output-spec /abs/output-spec.json] [--setup /abs/setup.json] \
  [--locale <BCP-47>] [--project-name <nome>] [--resume]
```

- `--briefing`: o texto exato (arquivo). `--objective` é opcional; sem ele o Diretor pede o objetivo (resolva em `revise-editorial-request.json`). Sem `--locale` o Apollo detecta o idioma pela fala; o condutor registra o idioma e a origem.
- `--outputs`: proporções do contrato (`9:16`, `16:9`, `4:5`, `1:1`, `21:9`), cada uma uma vez. Largura, altura, fps e margem segura vêm do preset do produto; `--output-spec` sobrescreve por proporção e é por ali que se pede legenda (`"subtitles": {"mode": "burn-in"}`). **Sem ele nenhuma legenda é desenhada** (o condutor registra a nota `subtitles.mode none`).
- `--setup`: lista de pedidos aplicados depois da ingestão e antes do primeiro Diretor (por exemplo, a configuração de legenda); mesmo formato de `requests` abaixo.
- `--rights-confirmed`: declaração do dono sobre os direitos do master; é obrigatória.
- `--resume`: continua do `journey-log.jsonl`. Sem ele, um log existente é recusado; com ele, mudar briefing, saídas, master, objetivo, idioma ou nome é recusado.
- Códigos de saída: `0` concluído, `1` falha fechada, `2` uso, `3` decisão não chegou a tempo (`--decision-timeout-ms`, padrão 1 h; rode de novo com `--resume`), `4` dono não aceitou.

O condutor espera cada decisão consultando `<decisions>/<nome>.json` a cada `--poll-ms`. Um arquivo ainda sendo escrito (JSON incompleto) é esperado, não rejeitado. O log diz qual arquivo espera e o contexto (`awaiting-decision`). Um segundo pedido da mesma decisão usa `<nome>-2.json`, `-3`… Um arquivo completo e inválido para o formato abaixo para a rodada no prazo, com o motivo.

## Formato dos arquivos de decisão (marcadores, nunca conteúdo do vídeo)

`revise-editorial-request.json` — cada campo presente **substitui** aquela parte do pedido (`briefing: null` remove). Campos aceitos: `briefing`, `directives`, `variantOverrides`, `desiredAction`, `answers`, `objective`; `reason` é obrigatório.

```json
{ "reason": "<por que o pedido muda>", "briefing": "<novo texto do briefing>" }
{ "reason": "<resposta>", "answers": [{ "questionId": "<id da pergunta>", "choiceId": "<id da escolha>" }] }
{ "reason": "<objetivo escolhido>", "objective": "<id do catálogo>" }
```

`remove-spoken-content.json` — as frases e alternativas vêm daqui, sempre. O corte é **um** Command sobre o EditPlan único do projeto (todas as saídas se materializam dele); `variant` nomeia a saída pela qual ele é pedido. Um segundo corte sobre o plano já cortado é recusado pelo produto (`INVALID_COMMAND`).

```json
{ "variant": "<proporção>", "rules": [{ "id": "<id-curto>", "label": "<rótulo>", "alternatives": ["<frase>", "<outra forma da frase>"] }], "reason": "<motivo>" }
{ "skip": true, "reason": "<por que não há corte>" }
```

`proxy-review.json` — uma entrada por saída. Aprovar (com `acknowledgeWarnings: true` quando o laudo pede reconhecimento) ou corrigir com pedidos:

```json
{ "outputs": {
  "<proporção>": { "decision": "approve", "acknowledgeWarnings": true, "note": "<nota da aprovação>" },
  "<proporção>": { "decision": "correct", "reason": "<o que corrigir>", "requests": [
    { "method": "POST", "path": "/v1/projects/{{projectId}}/commands",
      "body": { "type": "<tipo do Command>", "baseVersionId": "{{head.versionId}}", "baseHash": "{{head.baseHash}}" } } ] } } }
```

`owner-correction.json` — o que o dono pediu, as saídas afetadas e a aprovação do novo final delas. `requests`, `runDirector: true` ou os dois.

```json
{ "reason": "<o pedido do dono>", "runDirector": false,
  "requests": [{ "method": "POST", "path": "/v1/projects/{{projectId}}/commands", "body": { "type": "<tipo>", "baseVersionId": "{{head.versionId}}", "baseHash": "{{head.baseHash}}" } }],
  "outputs": { "<proporção>": { "approve": true, "acknowledgeWarnings": true, "note": "<nota>" } } }
```

`owner-acceptance.json`: `{ "accepted": true, "by": "<quem decidiu>", "note": "<nota>" }` (`accepted: false` grava o resultado no manifesto e sai com código 4).

`source-rights.json` (só se os direitos não vierem aprovados): `{ "reason": "<motivo>", "body": { <documento de direitos de PUT /v1/artifacts/{id}/rights> } }`.

**Pedidos (`requests`).** `method` é `POST` ou `PUT`; `path` fica dentro de `/v1/` (o servidor é sempre o do condutor); `body` é objeto; `ifMatch` e `expect` são opcionais. Uma string que é exatamente `{{nome}}` é substituída na hora do pedido: `projectId`, `head.versionId`, `head.baseHash` (a Version atual, relida), `transcript.id`, `sourceArtifact.id`, `variant:<proporção>`, `proxyArtifact:<proporção>`, `review:<proporção>.id|hash|revision`, e `r<N>.data.<caminho>` ou `r<N>.headers.etag` (a N-ésima resposta da mesma lista, a partir de 0). Nome desconhecido para o pedido: nada é enviado.

## Evidência

Em `--evidence` (tudo sem credenciais; trechos de download perdem o `token`):

- `journey-log.jsonl` — uma linha por evento, com o estado ao fim de cada fase; `journey-state.json` — o último estado.
- `requests/<fase>/…json` — requisição e resposta de cada chamada à API; `operations/…json` — cada operação concluída, com o tempo de espera.
- `interpretation/` — a leitura do briefing na criação, a que bloqueou o Diretor e a de cada revisão; `transcription/transcript.json`.
- `director/` — decisões, premissas e laudo de qualidade (`hardChecks`) de cada execução; `reviews/round-N.json` — o laudo do proxy.
- `proxies/`, `outputs/<proporção>/…mp4` — proxies e finais baixados; `inspection/…json` — `ffprobe` completo, decode (`-v error -f null -`, saída 0 e `stderr` vazio) e os checks.
- `decisions-applied/` — cada decisão aplicada, com o SHA-256.
- `w70-manifest.json` (final 1), `w70-manifest.v2.json` (correção e aceite): ids de projeto, versões, DirectorRuns, QualityReports, Commands, operações, revisões, hashes, tempos por fase (e o tempo esperando decisão).

## Ensaio sintético (antes da rodada real)

`tests/v2/w70-owner-journey-rehearsal.mjs` conduz o mesmo script contra um servidor local de verdade, com PostgreSQL descartável, FFmpeg real e um master **gerado** (padrão de teste e tom). Estão substituídos, e o arquivo diz por quê: a fala do Groq (resposta sintética no `fetch` do worker de ingestão), o modelo do interpretador (o stand-in local do repositório), o crítico de pixels (reconhecimento de sandbox, recusado em produção) e as decisões (escritas pelo próprio ensaio). Roda pelo harness supervisionado, com `--build` na primeira vez; o harness segura o lock global de carga.

O teste unitário do condutor (`tests/v2/w70-owner-journey.test.mjs`, parte de `npm test`) cobre argumentos, formato de cada decisão, substituição de pedidos, remoção de credenciais da evidência e as recusas de falha fechada.

## O que o ensaio mostrou do produto (leia antes da rodada real)

Fatos observados no ensaio local (um servidor, PostgreSQL descartável, master sintético de 12 s, duas saídas); cada um tem tratamento no condutor ou é pendência do produto, não do condutor:

- **Comandos de projeto com mais de uma saída.** `run-director`, `remove-spoken-content` e `lut-selection` confirmam o Command e depois pedem o proxy "da" saída; com duas saídas a rota responde `428 PRECONDITION_REQUIRED` (`output-variant-required`) **depois do commit**. O condutor reconhece só essa resposta, prova o commit pela Version de cabeça que mudou, registra `warning` e pede o proxy de cada saída por `proxy-renders` (que nomeia a variante). Qualquer outra resposta, ou cabeça sem mudança, para a jornada.
- **Corte de fala é um Command só.** O EditPlan é único para todas as saídas; um segundo `remove-spoken-content` sobre o plano já cortado é recusado (`INVALID_COMMAND`). Por isso `remove-spoken-content.json` tem um `variant` (a saída pela qual o corte é pedido), não uma lista.
- **Geometria do final.** O final sai com a geometria do preset de formato do produto; largura e altura diferentes no `--output-spec` não mudam o MP4 entregue, e a inspeção do condutor falha por isso (`dimensions-match-output-spec`). Use o preset, ou confira o que o produto entrega antes de pedir outra geometria.
- **LUT.** O render exige uma seleção de LUT explícita na Version. Sem pedido de visual, o condutor grava `mode: none` (origem: "nenhum visual foi pedido"); um pedido de `--setup` para `/lut-selection` o substitui.
- **Direitos.** O upload com `--rights-confirmed` grava direitos sem `editorial-reuse`; o final é recusado (`ASSET_RIGHTS_BLOCKED`) até o dono declarar os direitos: o condutor espera `source-rights.json` e repete o pedido.
- **Projeto concluído não renderiza de novo.** Depois dos finais o projeto fica `completed` e só aceita arquivar. A correção do dono vai para uma **cópia (duplicação copy-on-write)** da Version entregue; o condutor faz isso sozinho na fase 7, recria o pipeline de cor na cópia e, se a duplicação for recusada por falta de direitos nos proxies e finais, espera `derived-rights.json`. **No PostgreSQL local do ensaio a duplicação estourou o limite fixo de 30 s da transação do produto (`500 INTERNAL_ERROR`, três tentativas)**; por isso o ensaio padrão vai até o fim da fase 6 (entrega, download, decode e manifesto) e deixa as fases 7 e 8 aguardando (`W70_REHEARSAL_OWNER_PHASES=1` as tenta). Antes da rodada real, confirmar a duplicação no droplet; se estourar de novo, é defeito do produto a corrigir, não do condutor.
- **Idioma.** A transcrição do ensaio veio sem `language` declarada e o idioma detectado ficou registrado no manifesto; a origem exata (`languageBasis`) não é exposta pela leitura do projeto, então o condutor a registra como inferida da ausência de `--locale` (marcada "inferred").
