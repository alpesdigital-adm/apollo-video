# Biblioteca de mídia — W41–W50

Execução autorizada em 04/10/2026 sobre `83eb8fc65075e4f744fd2fd9e6415df073fad392`. Luna leu arquitetura, contratos e pendências; Sol implementa, orquestra, revisa e testa em checkouts separados. Integração Git e arquivos compartilhados são serializados. O estado atual está em `project-status.json`; este relatório não concede implantação ou aceite.

## Escopo e evidência exigida

| Waves | Comportamento | Prova |
| --- | --- | --- |
| W41–W43 | Paginação mista, filtros reais, isolamento, cancelamento de leituras e retry | Oráculo PG com empate e mais de 24 registros; API e Chromium; revogação real; falhas de transporte identificadas |
| W44 | Detalhes, thumbnail e waveform autenticados | FFmpeg/Sharp reais, pixels e sinal medidos, lineage e direitos atuais antes da leitura |
| W45–W46 | Segmentos virtuais e seleção por referência | Ranges sobrepostos/aninhados, duração medida, zero cópia, Command/ProjectVersion/CAS e replay persistidos |
| W47 | Derivada física de vídeo por consumidor | Job durável, lease, cancelamento ativo, deadline, concorrência, FFmpeg/MP4 e publicação protegida |
| W48 | Imagem, OCR e derivadas | Upload real, Sharp/Postgres/storage; Tesseract eng/por no CI; faces/objetos explicitamente indisponíveis |
| W49 | Catalogação após promoção aprovada | Worker de exportação/FFmpeg reais, direitos/consentimento explícitos, lineage, replay concorrente e busca |
| W50 | Jornada consolidada própria | Next em modo produção, sessão humana, uploads vídeo/áudio/imagem, navegador desktop/mobile, hashes e cleanup |

Os IDs exatos das caixas estão nos pacotes e no registro de status. São subescopos cumulativos de F1.012–F1.015 / FR-040/042/047/049. O TODO continua sem remarcação automática.

## Limites da comprovação

Os arquivos são mídia controlada, produzida por FFmpeg/Sharp. O transporte de transcrição do vídeo é controlado e separado da ingestão real: não comprova provider live ou qualidade da transcrição. Na exportação W49, direção, revisão de proxy e colorimetria são seeds upstream controlados; a API, worker, render, aprovação de saída e catálogo são exercitados com persistência e bytes reais. Materialização física W47 cobre vídeo; áudio usa somente referência virtual. Faces e objetos não possuem provider nesta entrega. Implantação DigitalOcean e aceite do proprietário continuam pendentes.

## JEV no desenvolvimento

A API foi avaliada como apoio à triagem estruturada, seguindo a [documentação oficial](https://docs.typesafe.ai/introduction/quickstart). A credencial referenciada no Brain permaneceu no arquivo local ignorado do projeto Yegr Agents; nenhum segredo foi copiado para Apollo.

Uma chamada com descrição sanitizada das lacunas respondeu HTTP 200 em 398 ms: `jev-latest` resolveu para `jev-1.13.0`, com 554 tokens de entrada e 108 de saída. A escolha do principal risco teve confiança 0,29; a preferência por prova com worker/PG/FFmpeg teve confiança 1. O resultado ajudou a priorizar a investigação, mas não substitui leitura do código, revisão, testes ou decisão de integração. Não foi adicionado ao runtime do produto.

## Registro de validação

Provas independentes locais concluídas: publicação protegida/cancelamento/lease
com PostgreSQL, pixels/waveform e hash do executável FFmpeg, referência tipada
com CAS/replay e auditoria de sessão humana. A suíte completa passou 2.622/2.622
sem skips; um novo teste de contrato segmentado passou depois desse run.

W49 `w49-output-catalog-proof-36b0ddb8` passou a API e o worker reais, decode
integral do MP4, catálogo convergente e busca autenticada em Chromium. Captura
e frame revisados. Postflight: zero backends, cluster parado, porta 55574 livre,
postmaster encerrado e nenhum processo próprio vivo. O MP4 controlado tem
SHA-256 `05d14f8a16b0f5c2a6ec07f067ad22bd5fabf33ec99463a31d64613781251d4b`.

W50 `w50-library-controlled-proof-e181b3fa` passou no código `e8b4e306`:
uploads HTTP vídeo/áudio/imagem, ingestão e recorte real, listagem mista,
conjunção de filtros, direitos bloqueados, previews medidos e inspecionados,
criação/attach de segmento em Chromium com Command/Version, retry e respostas
atrasadas após 401. Revogação no PG impediu leitura por preview e por artifact
direto; sessão revogada limpou todos os dados. Quatro screenshots e o MP4 da
derivada foram preservados. Browser/app terminal, zero backends, cluster parado
e porta 55574 livre. OCR local ficou explicitamente indisponível; CI exige OCR
real eng/por. O erro jurídico canônico é HTTP 422, não falha de autenticação.

CI e artifacts precisam comprovar o commit final antes de merge. A primeira
configuração do workflow usou um contexto `runner` indisponível no env de job,
corrigido para caminhos isolados por run. O CI também encontrou um CR isolado
num teste trazido da frente paralela; o arquivo foi normalizado, sem relaxar o
gate de whitespace. Estes erros de workflow/formatação não são falhas de mídia.

Falhas encontradas e corrigidas durante a construção: testes antigos com variável em zona temporal morta e expectativa textual de rights; identidade de artifact ignorada após deduplicação; constraint que impedia dois consumidores de compartilhar os mesmos bytes; ausência de fence na publicação após cancelamento ativo; Command de attach sem impacto explícito; ator humano gravado contra o contrato de auditoria externa. Erros de invocação/preflight dos supervisores foram registrados separadamente de falhas do produto. Os testes de shell locais exigem Git Bash no PATH, pois o bash padrão da máquina aponta para WSL indisponível. O cleanup de Chromium no Windows consulta identidade/estado do processo no SO; warnings de close não são tratados como prova de encerramento. Todos os clusters locais pertencem ao próprio run; nenhuma infraestrutura de produção foi utilizada.

## Integração final

PR #74 integrado em main pelo merge `0ac380d7df20634be4024dac9157f6c61e2771f3`. A revisão `a769296e` passou a jornada local final `w50-governance-paced-final-64eb497d`, com 13 casos de navegador e cleanup terminal/zero backends. Os hashes das quatro capturas foram conferidos e o preview real revisado. CI do PR: biblioteca [37297009503](https://github.com/alpesdigital-adm/apollo-video/actions/runs/37297009503) e regressão central [37297009518](https://github.com/alpesdigital-adm/apollo-video/actions/runs/37297009518), ambos verdes. O readback do CI e dos artifacts de main após o commit documental é registrado no PR, evitando alegar prova antecipada da versão final.

O CI encontrou uma corrida no próprio teste de reclaim: o heartbeat ativo podia renovar a lease que o teste acabara de expirar. Uma barreira explícita preserva a concorrência real dos dois claims; uma asserção separada prova que owner/attempt corretos não renovam lease expirada, e outra que o owner antigo não renova a substituta. PG real e FFmpeg passaram. A jornada ampliada também ultrapassou uma janela real de governança durante a rajada artificial de leituras; os casos independentes agora aguardam 61 segundos antes das verificações de autorização, sem alterar limites ou guards do produto. O 403 de preview é transporte controlado e prova limpeza da UI; revogações de rights e sessão continuam exercitadas no PG real.

O registro classifica W41–W50 como validadas no subescopo técnico controlado e integradas em main. Produção e aceite continuam pendentes; TODO permanece 380/1.259.

A regressão central também revelou P2034 na criação de ProviderJob durante uma jornada sintética. O retry curto existente se esgotou; não foi tratado como motivo para apenas repetir CI. Uma prova com PostgreSQL real produziu quatro conflitos consecutivos e confirmou a quinta tentativa com um único job/transição/replay. O retry mantém Serializable e revalidação de autoridade/ator, com até oito tentativas, backoff total máximo de 1.575 ms e orçamento de cinco segundos para admitir uma nova tentativa. Unitários verificam também que acordar após esse orçamento impede outra transação. O log não identifica o ator concorrente do CI.

A jornada HTTP sintética que expôs o conflito passou localmente em `0b33ce97`, run `provider-create-http-recovery-2b02e9ae`: Next/worker/PG/FFmpeg e bytes reais, transporte ElevenLabs em loopback controlado, zero chamadas pagas. Postflight: zero backends, cluster parado, porta 55574 livre e postmaster encerrado. Luna revisou o retry sem achados bloqueantes.

O CI de qualidade cancelado em 37251445384 atingiu o limite de 35 minutos após `ENOTEMPTY` no after-hook do deploy simulado. Um publisher em voo podia gravar enquanto o diretório era removido; o timer permanecia vivo. A correção `a6a44e43` dá ao world um cleanup único: parar timer, drenar o tick único, preservar erros e só então remover arquivos. Seis cenários de deploy simulado e duas regressões determinísticas passaram localmente; processo encerrou normalmente. Não houve mudança de limiares ou aumento do timeout de CI.
