# W67 V3 — pré-registro metadata-only de direitos e ground truth humano

Pré-registro documental: 2026-10-12 UTC.

Estado: **proposta documental; STOP de corpus permanece aberto**. A primeira fase é exclusivamente inventário de metadados/direitos/GT já publicado ou preservado. Não é autorização para download de imagens/pesos/CSVs grandes, decode, anotação derivada de detector, render, inferência ou holdout. Nenhum oráculo/algoritmo runtime é implementado. [Protocolo principal W67 V1](./w67-final-pixel-oracle-v1.md) e [aquisição V2 encerrada](./w67-cvdf-acquisition-v2.md) conservam seus resultados e gates.

## Base e limites existentes

Manter o inventário de 27 IDs `w67-local-cache-inventory-v1-r2.json` SHA-256 `4d273863096f75a6aa3c86944657496359b757e7c9d78c5f6c6389f69c935b2d` e eligibility final V2 `w67-official-derivative-eligibility-v2-r2.json` SHA-256 `ddd50b1a597a0ce7c07158a9406977796711d60e37286b9a8e54578c34e7374d`. V2 revalidou evidência local, sem rede/pixels:26 passaram direitos/GT de face; 491b80ed0e159494 teve Author/HTML divergentes, sem equiparação de nomes por inferência. Dois originais presentes no cache não satisfazem corpus; não movê-los entre splits. Nenhum dos 27 IDs possui eyeGT comprovado por esse inventário.

| Split fixo | Single elegíveis V2 | Multiple elegíveis V2 | Quota preservada | Déficit conhecido |
| --- | ---: | ---: | --- | --- |
| Development |7|0|2 single + 2 multiple|2 multiple|
| Evaluation |18|1|2 single + 2 multiple|1 multiple|

Essas contagens precedem os novos campos de GT qualificado; não presumir que os 26 passam olhos/convenção de face/cabeça. Nenhuma seleção de 8 IDs foi congelada em V2, nenhum derivado foi adquirido. V1 original 404/429, V2 falhas/nomes e quotas seguem preservados. Não retomar Flickr 429 nem contornar bloqueio por outro hostname/origem.

## Universo, filtros e splits inalterados

Somente Open Images validation, reusando fontes CSV/classes/hash pinados na V1/V2 local. Excluir todos os180 IDs do manifesto W62 V5, os 8 IDs W67 V1 e qualquer ID adicional já inferido. Para essa exclusão só identidade/manifests, nunca pixels/predições do holdout W62; seus60IDs continuam fechados. Um novo candidato só entra pelo inventário completo antes da seleção e sem resultados de modelo/renderer.

Preservar face humana positiva e Source xclick/activemil, rotação metadata 0; excluir group/depiction/occluded/truncated ou geometria inválida. Rejeitar imagem com alguma anotação facial inválida/excluída; remover a caixa não transforma outro rosto em ausente. Preservar URLs HTTPS, OriginalMD5 válido, OriginalSize1–5000000 e licença metadata CC BY 2.0/4.0; estes campos sozinhos não comprovam direitos nem pixels.

Split continua primeiro byte SHA-256 UTF-8 `w67-v1|split|<id>` : menor que 128 development, demais evaluation. Ranking permanece SHA-256 `w67-v2|<split>|<stratum>|<id>` e ID, como V2; duas single e duas multiple por split. Não relaxar quota, trocar split ou reordenar por resultado. Expansão futura da metadata exige manifesto do universo/fontes/versão antes de seleção; não é substituição silenciosa de um caso depois de aquisição/render.

Open Images descreve caixas humanas e labels humanos explícitos; rótulo ausente não equivale a negativo. A licença das anotações não substitui a licença individual da foto. [Descrição oficial](https://storage.googleapis.com/openimages/web/factsfigures_v7.html), [formato/downloads oficiais](https://storage.googleapis.com/openimages/web/download_v7.html). Isto não fornece por si só landmarks de olhos nem convenção humana detalhada face/cabeça para nossos 27 casos.

## Registro obrigatório de metadata e direitos

Cada candidato terá ID/split/stratum/rank; fonteCSV/class/linhas literais e seus hashes; positivo humano, boxes/flags originais; URLs original/landing/final e licenseURL; autor/nome/perfil/atribuição; hash/timestamp/método da evidência HTML preservada e restrições/deferrals; originalMD5/size/rotation como metadados, sem alegar bytes presentes. Revalidar evidência histórica local ligando a mesma foto/licença/autor à linha preservada; bytes de HTML presentes sem correspondência não bastam. Não alegar consulta atual a partir de um cache antigo.

Nesta escrita, nenhuma requisição nova a landing/image ocorre. Uma fase metadata futura precisa owner/run/deadline próprios, fontes pequenas explicitamente autorizadas e nenhum request a imagem/CSV grande. Ausência, 403/404/429 ou nome/licença conflitante é rights_unconfirmed/STOP; não preencher concessão nem trocar URL para contornar. Registro de status/data/limitação acompanha toda conclusão.

## Flags de GT humano antes de selecionar

| Campo por rosto/candidato | Evidência exigida | Ausência ou ambiguidade |
| --- | --- | --- |
| faceGT | box/máscara humana, origem/ID/linha/hash e vínculo à mesma imagem, coordenadas e convenção explícitas |unknown; detector não preenche|
| faceBoxConvention |face-visível ou cabeça-inteira com definição do anotador/dataset preservada|unknown; label Human face não escolhe convenção por inferência|
| headGT |anotação humana própria quando a avaliação alegar preservação da cabeça; ref/coord/convenção|unknown; face não é cabeça|
| eyeGT/eyeVisibility |coordenadas/região e estado visível/ocluído/fora-quadro explicitamente humanos, lado/identidade do rosto e fonte/hash|unknown; box de face ou máscara conservadora não é detecção de olhos|
| annotationFlags |Source/IsOccluded/IsTruncated/IsGroupOf/IsDepiction e qualquer flag faltante como unknown, com linha original|não converter0/ausência em visibilidade de olho/cabeça|
| adjudication |IDs do(s) anotador(es), protocolo/version/hash e resolução humana da ambiguidade|unknown; não inventar nomes/decisões|
| derivativeCorrespondence |vínculo publicado split/ImageID; geometria/orientação individual medida quando houver bytes autorizados|unverified nesta fase metadata-only|

Olhos/head/face são dimensões separadas. Fonte humana de um campo não autentica os demais. Se coordenadas humanas qualificadas de olhos/convenção faltarem, o gate visual completo **STOP**, sem escopo positivo implícito. Pode continuar inventariando metadata e marcando unknown, mas não congelar corpus qualificado nem admitir controle limpo com dimensão desconhecida. Adjudicação nova exigiria pixels/autorizações e etapa separada; não é executada nesta fase.

## Gate antes de qualquer aquisição ou oráculo

A fase1 fecha somente quando o manifesto de elegibilidade publica todos candidatos, exclusões, direitos individuais confirmados, flagsGT/proveniência, splits/ranks, quotas e hashes, sem IDs/direitos/GT fictícios. Quotas insuficientes, licenças ou GT incompletos são **STOP**, como já ocorre com2 multiple development/1 multiple evaluation e eyeGT não comprovado. Seleção8IDs somente após esses fatos; não diminuir quota nem substituir caso congelado depois de falha.

Depois dessa fase, aquisição/render ainda requer decisão separada e congelamento de identidade dos bytes/uniqueSHA/dimensões/orientação/GT, código/calibração/labels de defeitos e tolerâncias do protocolo principal. O mirror oficial CVDF é derivado, não OriginalMD5/OriginalSize; ETag/MD5/SHA de bytes e correspondência geométrica precisam de prova própria. Mirror,Rotation0 ou EXIF neutro não medem correspondência individual nem conferem direitos. [Downloads oficiais](https://storage.googleapis.com/openimages/web/download_v7.html).

Gates W67 V1 intactos:IoU de detecção W62 não muda; no corpus controlado, zero falso seguro, recall/precisão de defeitos 100% e zero unknown, por defeito×formato×intervalo; qualquer tinta confirmada sobre região protegida reprova. Dois formatos 9:16/16:9, controle limpo e dois outputs defeituosos distintos por formato, legenda-colisão/sujeito-cortado/CTAfora-safe-area, defeitos únicos/combinados e frames adjacentes/boundaries permanecem. PTS um tick é tolerância de associação, não licença para deslocar cue; segmentação/registro/densidade/movimento sem unidades/limiares congelados não passam. Nenhum parâmetro é escolhido após ver pixels.

A seleção evita os180 IDs W62, mas não prova independência de treino nem ausência de near-duplicates; hashes distintos tampouco provam isso. Os 8 controles são regressão delimitada, não qualificação estatística/video natural. W67, W70, modelo facial apto, publicação PG, deploy e aceite permanecem pendentes. Esta fase documental não promove TODO ou status.
