# W67 — pré-registro do crítico independente do MP4 entregue (v1)

Estado: **emenda ao protocolo e pré-registro, em duas etapas, ambas commitadas ANTES do primeiro render do corpus registrado (calibration)** (etapa 1 commit `524755c2`; etapa 2 = o commit que contém este texto e o manifesto). Etapa 1 (este commit): regras, desenho, política, critérios de aceite. Etapa 2 (commit seguinte, também antes de qualquer render do corpus registrado): o manifesto congelado (imagens selecionadas, caixas, janelas, rótulos, hashes de código e da política). Há ensaios de desenho anteriores a esta etapa, e este documento os declara no §9. Este documento emenda `w67-final-pixel-oracle-v1.md` e `w67-corpus-adjudication-sequence-v3.md` sem apagar nenhum dos dois; os bytes, quotas e resultados do caminho CVDF (v2/v3) permanecem como estão (STOP por quotas e direitos). Nada aqui é evidência de qualidade: é o contrato contra o qual o resultado será medido, e o resultado — qualquer que seja — será publicado em `w67-mp4-critic-results-v1.md`.

Manifesto congelado (etapa 2): `docs/quality/w67-mp4-critic-corpus-v1.json`, cujo SHA-256 e `manifestHash` canônico (cobre tudo menos o instante do congelamento) serão registrados no commit da etapa 2. O manifesto contém os IDs e hashes das fontes, as caixas humanas originais, as janelas de crop, os defeitos, os intervalos, os rótulos esperados, a política com todas as tolerâncias e unidades, os pins dos modelos e o SHA-256 de cada arquivo de código que define o oráculo, o crítico, o gerador, o avaliador e o executor. O executor recusa iniciar se o manifesto não se re-deriva byte a byte ou se qualquer desses arquivos mudou.

## 1. Emenda ao protocolo (o que muda e por quê)

| Protocolo v1/v3 | Emenda W67-MP4 v1 | Motivo |
| --- | --- | --- |
| Corpus de aquisição CVDF (selector `w67-v1`, oito imagens, anotação de olhos, adjudicação humana) | Corpus = o split **calibration** da V5 (`openimages-w61-v5-manifest.json`, 60 imagens do Open Images *validation*, direitos por foto já auditados em `openimages-w61-v5-source-audit.json`), selecionado por uma regra fixa (§3) que só lê metadados | a aquisição v2/v3 está em STOP por quota/direitos; o calibration é independente do holdout W62 (que **não foi aberto**) |
| Ground truth: caixas humanas adjudicadas antes do run | Ground truth = a caixa humana original do Open Images (`Source` xclick/activemil), preservada linha a linha com hash. **Adjudicação: `open-images-human-boxes, no project adjudication`** — não há adjudicador de projeto (decisão do proprietário pendente) | não inventar uma adjudicação |
| Olhos | Sem anotação de olhos: **verificações de olhos ficam fora de escopo e não são contadas como amostras**; proteger a caixa inteira do rosto é regra conservadora, não detecção de olhos | o protocolo v1 já dizia que olhos sem anotação são desconhecidos |
| Oráculo de rosto independente do detector do produto | **União** do detector do produto (OMZ face-detection-0204, V9) e de um segundo detector (OMZ face-detection-retail-0004), mais a projeção, por registro de pixels, das detecções do quadro da FONTE; `unknown` explícito quando nenhum modelo nem a projeção dá evidência de rosto no quadro | o produto não pode ser o único oráculo |

Inspeção visual das fotos (a única leitura de pixels da seleção) foi feita pelo agente redator Claude, **uma etapa automatizada — não é adjudicação humana**. **EMENDA (§11): a regra R6 foi escrita DEPOIS de eu ver os títulos e as fotos dos 3 candidatos que passam em R1–R4; é uma exclusão POST HOC**, não uma regra pré-registrada antes de ver os candidatos. Casos ambíguos achados pela regra estão listados em §3.

## 2. Independência: o que foi e o que não foi usado

- **Holdout W62**: nunca aberto, listado ou lido por este trabalho.
- **Detector do produto (V9)**: o recibo `390d3b28d172015f8ed2cb3d416e38625ce4d4efaca8e1eea52d7a8e58aaa817` (`w62-development-v9-v1-42ee2328`) cobre 60 IDs, **todos do split development**; nenhum está no calibration nem no holdout (verificado contra o manifesto V5: 60 em development, 0 em calibration, 0 em holdout; nenhuma menção a "calibration" nos 196 arquivos pequenos da pasta do run).
- **Calibration**: foi avaliado em W61 por YuNet (V5, V6) e por face-detection-retail-0004 (V7) com configurações pré-registradas e **nunca alteradas depois** (V7: recall 37/58 = 63,8%, 4 imagens com caixa inválida, reprovado nos seus próprios gates). O ponto de operação do retail-0004 usado aqui (score 0,50) é o pré-registrado em V7; **nenhum limiar deste protocolo foi escolhido em pixels do calibration**. O calibration, porém, não é virgem para o retail-0004: a taxa dele nessas 60 fotos já era conhecida antes deste corpus, e essa taxa baixa é um fato do qual o resultado depende.
- **Desenho**: política, geometria, gerador e crítico foram projetados e ensaiados em conteúdo sintético e em fotografias do split **development** (§9), antes deste congelamento.

## 3. Seleção do corpus (regra fixa; só metadados)

Regras, aplicadas ao split calibration (60 itens):

- R1 status `eligible`, direitos `original_landing_confirmed`, licença CC BY 2.0 ou 4.0;
- R2 exatamente uma caixa anotada na imagem, rótulo *Human face*, `Source` xclick/activemil, `IsOccluded = IsTruncated = IsGroupOf = IsDepiction = 0`;
- R3 largura e altura do espelho pares, sem orientação EXIF, `Rotation 0.0`;
- R4 as regras de enquadramento (`corpus-geometry.mjs`) conseguem enquadrar o rosto nos DOIS formatos (janela boa, janela perdida, uma faixa de legenda que cubra o rosto, faixa inferior livre);
- R5 ordem crescente de `sha256("w67-mp4-v1|select|<ImageID>")`, primeiros N = 2; nenhum resultado de detector, renderer ou crítico entra;
- R6 exclusão visual, só da foto de origem: o "rosto" anotado é uma representação (retrato impresso ou pintado) ou há outros rostos visíveis sem anotação. **POST HOC (§11):** escrita e aplicada depois de ver os títulos e as fotos dos candidatos; as duas cláusulas foram julgadas depois de olhar.

### Resultado da seleção (etapa 2)

Manifesto congelado: `docs/quality/w67-mp4-critic-corpus-v1.json`, SHA-256 do arquivo `f88584cdd473906544d784b4379bbbc2f04ed52e68a4016915ac2a0b76d90b2f`, `manifestHash` canônico `5fe1eaf409f84055d103a714d0d194927910565ef9e5710c60872c74048d4f0a` (cobre tudo menos o instante do congelamento). O manifesto leva os SHA-256 dos 13 arquivos de código congelados e da política; o executor se recusa a rodar se qualquer um mudar ou se o manifesto não se re-derivar das entradas.

Só **3** imagens do calibration passam R1–R4. A primeira na ordem de R5 (`968a460084c588a1`, título "2$ bill") foi excluída por R6: o "rosto" anotado é o retrato gravado numa cédula de dois dólares (a foto mostra duas cédulas sobre uma mesa), uma representação, mesmo com `IsDepiction = 0` na anotação. **Esta exclusão é POST HOC e foi ela que decidiu o corpus**: com 3 elegíveis e N = 2, excluir a primeira deixou exatamente as outras duas. Eu vi os títulos e abri as três fotos antes de escrever R6 (linha do tempo verdadeira no §11, que corrige a frase anterior desta seção, "só ela"). As outras duas foram vistas na mesma inspeção (um homem de cartola com trompete; um homem deitado numa cama de hospital) e a cláusula "outros rostos visíveis" também foi julgada depois de olhar (na segunda aparece um rosto minúsculo impresso na capa de um livro na borda, que não considerei "claramente visível"). A inspeção é do agente redator (Claude), automatizada, **não é inspeção humana**. O que é verdade e continua valendo: foi feita antes de qualquer render ou detector sobre foto do calibration. A execução de sensibilidade do §11 roda as 10 saídas da foto excluída sob o código congelado, para que a exclusão não fique sem medida.

Candidatos: 60; elegíveis pelas regras R1–R4: 3; elegíveis finais: 2.

Contagem de motivos de exclusão (uma imagem pode ter mais de um):

| motivo | imagens |
| --- | ---: |
| R3:odd-dimension | 23 |
| R2:no-human-face-box | 20 |
| R2:box-flagged-occluded-truncated-group-or-depiction | 15 |
| R2:more-than-one-annotated-box | 10 |
| R4:9 | 6 |
| R4:16 | 5 |
| R6:visual-exclusion | 1 |

Imagens que passam R1–R4 (ordem por chave de ranking `sha256("w67-mp4-v1|select|<ImageID>")`):

| rank | ImageID | estrato | R6 | selecionada |
| ---: | --- | --- | --- | --- |
| 1 | `968a460084c588a1` | lower | R6:visual-exclusion:DEPICTION_NOT_FLAGGED | não |
| 2 | `1580caef8efed517` | small | — | sim |
| 3 | `9295ab265fafd8e5` | small | — | sim |

Exclusões visuais (R6), feitas pelo agente redator Claude (etapa automatizada, **não adjudicação humana**):

- `968a460084c588a1` — The annotated Human face is the engraved portrait on a printed US two-dollar banknote (the photograph shows two banknotes on a table). Open Images has IsDepiction=0 for the box, but the rule R6 excludes depictions. Decided from the source photograph only, before any render or detector run on any calibration photograph.

Fotos selecionadas (proveniência; mídia só no diretório privado):

| ImageID | autor | título | licença | página original | mirror SHA-256 | dimensões | caixa humana (xmin, ymin, xmax, ymax; fonte) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `1580caef8efed517` | Zaneology | Zane Aveton shared an Instagram video with you | https://creativecommons.org/licenses/by/2.0/ | https://www.flickr.com/photos/zaneology/9202606673 | `a1984a325bbc9d3516236bd3a3fc7d82fce55c6d246a2b5f037bcfbb16c1b039` | 1024×1024 | 0.40794224, 0.20036101, 0.51805055, 0.33212996; xclick |
| `9295ab265fafd8e5` | Franco Dal Molin | Valium B | https://creativecommons.org/licenses/by/2.0/ | https://www.flickr.com/photos/orsorama/9176313286 | `b3c62f4f9ccbfea418c3e007fce952339ffe6a44b635b888e5457845508aba6a` | 1024×768 | 0.5875, 0.31875, 0.7015625, 0.46875; xclick |

Saídas (20), enquadramento por construção:

| saída | faixa-alvo da cue | bloqueadores fabricados | caixa humana projetada no clipe A (x0, y0, x1, y1) | fração visível no clipe B | intervalos rotulados |
| --- | --- | --- | --- | ---: | --- |
| 1580caef8efed517-9x16-clean | upper-third | — | 0.368, 0.269, 0.632, 0.446 | 1.00 | — |
| 1580caef8efed517-9x16-caption | upper-third | bottom, lower-third | 0.368, 0.269, 0.632, 0.446 | 1.00 | caption-over-face [8, 28) |
| 1580caef8efed517-9x16-crop | upper-third | — | 0.368, 0.269, 0.632, 0.446 | 0.35 | crop-lost [45, 90) |
| 1580caef8efed517-9x16-cta | upper-third | — | 0.368, 0.269, 0.632, 0.446 | 1.00 | cta-outside-safe-area [31, 44) |
| 1580caef8efed517-9x16-combined | upper-third | bottom, lower-third | 0.368, 0.269, 0.632, 0.446 | 0.35 | caption-over-face [8, 28); crop-lost [45, 90); cta-outside-safe-area [31, 44) |
| 1580caef8efed517-16x9-clean | lower-third | — | 0.426, 0.393, 0.574, 0.707 | 1.00 | — |
| 1580caef8efed517-16x9-caption | lower-third | bottom | 0.426, 0.393, 0.574, 0.707 | 1.00 | caption-over-face [8, 28) |
| 1580caef8efed517-16x9-crop | lower-third | — | 0.426, 0.393, 0.574, 0.707 | 0.35 | crop-lost [45, 90) |
| 1580caef8efed517-16x9-cta | lower-third | — | 0.426, 0.393, 0.574, 0.707 | 1.00 | cta-outside-safe-area [31, 44) |
| 1580caef8efed517-16x9-combined | lower-third | bottom | 0.426, 0.393, 0.574, 0.707 | 0.35 | caption-over-face [8, 28); crop-lost [45, 90); cta-outside-safe-area [31, 44) |
| 9295ab265fafd8e5-9x16-clean | upper-third | — | 0.340, 0.361, 0.660, 0.539 | 1.00 | — |
| 9295ab265fafd8e5-9x16-caption | upper-third | bottom, lower-third | 0.340, 0.361, 0.660, 0.539 | 1.00 | caption-over-face [8, 28) |
| 9295ab265fafd8e5-9x16-crop | upper-third | — | 0.340, 0.361, 0.660, 0.539 | 0.35 | crop-lost [45, 90) |
| 9295ab265fafd8e5-9x16-cta | upper-third | — | 0.340, 0.361, 0.660, 0.539 | 1.00 | cta-outside-safe-area [31, 44) |
| 9295ab265fafd8e5-9x16-combined | upper-third | bottom, lower-third | 0.340, 0.361, 0.660, 0.539 | 0.35 | caption-over-face [8, 28); crop-lost [45, 90); cta-outside-safe-area [31, 44) |
| 9295ab265fafd8e5-16x9-clean | lower-third | — | 0.410, 0.393, 0.590, 0.707 | 1.00 | — |
| 9295ab265fafd8e5-16x9-caption | lower-third | bottom | 0.410, 0.393, 0.590, 0.707 | 1.00 | caption-over-face [8, 28) |
| 9295ab265fafd8e5-16x9-crop | lower-third | — | 0.410, 0.393, 0.590, 0.707 | 0.35 | crop-lost [45, 90) |
| 9295ab265fafd8e5-16x9-cta | lower-third | — | 0.410, 0.393, 0.590, 0.707 | 1.00 | cta-outside-safe-area [31, 44) |
| 9295ab265fafd8e5-16x9-combined | lower-third | bottom | 0.410, 0.393, 0.590, 0.707 | 0.35 | caption-over-face [8, 28); crop-lost [45, 90); cta-outside-safe-area [31, 44) |

## 4. O corpus: 20 saídas, 2 fotos × 2 formatos × 5 variantes

Cada foto vira uma fonte de 3 s a 30 fps (a foto parada, com trilha de áudio senoidal exigida pelo renderer). A linha do tempo é a mesma em todas as saídas: clipe A = quadros 0–44, clipe B = 45–89; legenda "Veja o que muda" nos quadros 8–27; CTA nos quadros 31–43; nada no clipe B. As saídas são renderizadas pelo **renderer real do produto** (`FfmpegEditorialProxyRenderer`, canvas proxy 540×960 e 960×540) a partir de `RenderInput`s e `EditPlan`s controlados.

| variante | defeitos semeados | intervalo (quadros, meio-aberto) |
| --- | --- | --- |
| `clean` | nenhum | — |
| `caption` | legenda sobre rosto protegido | [8, 28) |
| `crop` | crop perdido (sujeito cortado) | [45, 90) |
| `cta` | CTA fora da safe area | [31, 44) |
| `combined` | os três, cada um no seu intervalo | os três acima |

Como cada defeito é semeado, e decidido por quê (geometria própria, sem chamar o solver do produto para decidir onde o defeito vai):

- **legenda sobre rosto**: a evidência de rosto entregue ao planejador relata caixas-fantasma pequenas em cada faixa ANTES da faixa-alvo (na ordem de preferência pública bottom, lower-third, upper-third, top, center) e omite o rosto real; as regras comuns do planejador colocam a cue na faixa-alvo, que é a primeira faixa da ordem cuja altura é coberta em pelo menos 50% pela caixa humana (regra fixa em `corpus-geometry.mjs`). A faixa em que a cue realmente cai é o resultado do planejador e é registrada e comparada com o rótulo;
- **crop perdido**: o clipe B usa a janela boa deslocada, no eixo e sentido de uma ordem fixa, até restar 35% da caixa humana dentro do canvas;
- **CTA fora da safe area**: texto longo cuja segunda linha excede o canvas;
- **controle limpo**: janela boa nos dois clipes, evidência com a caixa humana, CTA curto.

As janelas (crop), as caixas projetadas por construção, as faixas-alvo, os bloqueadores e todos os rótulos estão no manifesto, escritos pelo gerador antes de qualquer render.

## 5. O crítico (o que é medido, e como)

Objeto avaliado: o MP4 entregue, por SHA-256 e tamanho, depois de **decodificação completa** (todos os quadros, hash por quadro, contagem contra o container e contra a lista de PTS, `stderr` do ffmpeg vazio). O `RenderElementMap`, o plano de crop e o plano de posicionamento **não** são verdade; o crítico não os lê.

1. **Tinta** = pixels em que luma(entregue) − luma(controle) excede o limiar e que têm vizinhos também alterados. Controles: o mesmo `RenderInput` sem legenda, sem CTA, sem os dois. A tinta de legenda é entregue vs. "só CTA"; a de CTA, entregue vs. "só legenda".
2. **Rosto**: o oráculo lê o quadro SEM tinta (controle sem os dois). Uma caixa de cada modelo, sem fundi-las; mais a projeção das detecções do quadro da fonte pelo registro.
3. **Registro** do quadro da fonte sobre o quadro de saída: ORB 2000 pontos, razão 0,75, similaridade (escala, rotação, translação) por RANSAC a 3 px — medido nos pixels, nunca aplicando o crop do renderer. Com portões de qualidade (inliers, razão, resíduo, escala, rotação); se reprova, o sujeito é `unknown`.
4. **Verificações por quadro**: legenda × rosto, CTA × rosto, safe area (limites inclusivos do OutputSpec congelado, pixel pelo centro), tinta cortada pela borda do canvas, sujeito visível/cortado (fração da caixa de rosto da fonte projetada que cai dentro do canvas, confirmada pelo oráculo no quadro de saída), densidade.
5. **Veredito por variante**: `blocked` se houver issue `hard`; `warning` se houver issue `warning` ou `unknown` ou cobertura parcial; `passed` caso contrário. Um 9:16 bloqueado não bloqueia o 16:9; o 16:9 só passa pelo seu próprio relatório.
6. **QualityReport selado** (`mp4-quality-report/v1`, hash canônico): variante, ProjectVersion, operação, SHA-256 e tamanho do MP4, hash do RenderInput, IDs de amostra (índice + PTS + SHA-256 do quadro), faixas de quadros e lacunas, recibos dos controles, modelos do oráculo com digests e pontos de operação, hash da política, verificações e unknowns. O resumo (`mp4-evidence-seal/v1`) viaja dentro do `format-quality-report/v3` da variante.

### 5.1 Política e tolerâncias (unidades)

Congeladas no manifesto da etapa 2 (`policy`); o SHA-256 canônico da política vigente nesta etapa é `c7089682fa32b55fd39a16e359e8d92217e8339773995d416627a1cbbaaca687` (se a política mudar antes da etapa 2, o commit da etapa 2 diz o que mudou e por quê, com os ensaios que o motivaram):

| parâmetro | valor | unidade |
| --- | --- | --- |
| limiar de tinta | 40 | níveis de luma Rec.601 (8 bits) |
| vizinhos alterados mínimos (de 4) | 2 | pixels |
| pixels de tinta mínimos para "overlay presente" | 40 | pixels |
| margem de rosto | 0 | pixels |
| tolerância de segmentação na safe area | 2 | pixels (além do limite: `unknown`; além da tolerância: falha) |
| limite de densidade | 0,20 | fração dos pixels do canvas (warning) |
| sujeito perdido / cortado abaixo de | 0,10 / 0,90 | fração visível da caixa projetada |
| confirmação no quadro de saída | IoU ≥ 0,20 | caixa do oráculo × caixa projetada |
| registro: inliers / razão / resíduo mediano | ≥ 25 / ≥ 0,30 / ≤ 2,5 | pontos / razão / pixels de saída |
| registro: escala / rotação | 0,25–6 / ≤ 2 | fator / graus |
| amostragem | todos os quadros até 600; acima, passo 5 + bordas de tinta + cortes + primeiro/último | quadros |

Pontos de operação dos modelos (não ajustados): OMZ face-detection-0204 FP32 (V9, política `w62-v9-visible-intersection-continuous/v1`, SHA-256 `a3c641fd…cad03`), entrada 448×448 BGR, score ≥ 0,50; OMZ face-detection-retail-0004 FP32, entrada 300×300 BGR, score ≥ 0,50 (V7, pré-registro `1c813d9e…614b`). Validação do retail: score em todo slot, image id/label/caixa nos slots selecionados; caixa fora do quadro vira a interseção visível (o avaliador V7 tratava como imagem falha; esta é a escolha de decodificação e está declarada). Digests, licença (Apache-2.0, texto verificado offline, SHA-256 `c71d239d…0ab4`) e commit OMZ `eda1863a6d60b09551df9d039cff2377d6ddd4d6` estão no manifesto.

## 6. Avaliação e aceite (fixados antes do render)

A unidade é **defeito × formato × intervalo**. Para cada saída e classe de defeito, os quadros *marcados* são os cobertos por uma issue `hard` da classe (legenda: `SUBTITLE_FACE_OVERLAP_IN_PIXELS`; crop: `SUBJECT_NOT_VISIBLE_IN_PIXELS` ou `SUBJECT_CLIPPED_IN_PIXELS`; CTA: `INK_OUTSIDE_SAFE_AREA_IN_PIXELS` ou `INK_CLIPPED_BY_CANVAS_IN_PIXELS` de tinta de CTA).

- **detectado**: quadros marcados == intervalo rotulado exatamente (a cue nunca é deslocada de um quadro para fugir de uma colisão; os quadros adjacentes são negativos);
- **falso seguro**: unidade rotulada em que algum quadro do intervalo foi julgado `pass`;
- **falso positivo**: quadro marcado fora do intervalo, classe sem rótulo marcada, ou issue `hard` de código sem classe;
- **unknown**: qualquer verificação que os pixels não estabeleceram.

**Aceite**: zero falso seguro, recall de defeitos 100%, precisão 100%, zero amostras `unknown`, zero falhas de decodificação. Matriz de confusão e denominadores por classe e por formato, todos os resultados, falhas incluídas, serão publicados. Se a união de detectores não alcançar isso, **as verificações relacionadas a rosto FALHAM e esse é o resultado**: sem ajuste de limiar, sem reetiquetagem, sem novo limiar, sem outro oráculo.

Medidas adicionais, **informativas, não de aceite**: recall de cada modelo e da união contra a caixa humana nos quadros em que ela está inteira no canvas; IoU da projeção do registro contra a caixa humana por construção; checagem de sanidade dos rótulos nos pixels entregues (a tinta da legenda toca a caixa humana? o CTA excede a safe area?); densidade e ruído entre codificações (quadros sem overlay).

## 7. Reprovação do protocolo por conflito

Se um rótulo escrito pelo gerador for contradito pelos pixels (por exemplo, a cue cair numa faixa que não cobre o rosto), isso é publicado como **conflito rótulo × pixels**, a unidade não é reetiquetada e a prova daquela unidade é declarada inválida; a correção exige novo protocolo com novo conjunto.

## 8. Execução

Todo FFmpeg e todo OpenVINO rodam somente pelo harness supervisionado (`run-local-pg-s2d.mjs`, lock `workload.lock`, esperando o dono vivo). Imagens, quadros, MP4, contact sheets e relatórios selados ficam em `C:/Users/leand/Documents/Apollo/w61-70-20261008/w67-*` (privado); nada de mídia vai ao git, só scripts, este pré-registro, o manifesto congelado e o resumo dos resultados.

## 9. Ensaios anteriores ao congelamento (declaração)

Tudo o que foi renderizado ou inferido antes desta etapa, em ordem, e o que cada coisa foi:

1. Suíte sintética `tests/v2/mp4-pixel-critic.integration.mjs` (fonte procedural "mandelbrot" com um retângulo magenta como rosto de mentira; **oráculo de teste por chave de cor**, registro = a transformação conhecida da janela de crop; renderer real e FFmpeg real). Corridas pelo harness: `w67-synth-r1-b9c8567b` (6 de 9 passaram) e `w67-synth-r2-c4ce643c` (9 de 9). A primeira revelou duas coisas que mudaram o desenho: (a) a legenda e o CTA estavam no mesmo trecho de tempo do crop perdido e um CTA no topo cobria o rosto cortado no 16:9 (um CTA-sobre-rosto verdadeiro e não rotulado): a linha do tempo passou a pôr legenda e CTA no clipe A, um depois do outro, e nada no clipe B; (b) a expectativa do teste somava duas faixas iguais de dois códigos. Nenhuma foto foi usada.
2. Tentativas do oráculo OpenVINO real sobre fotos do split **development** (só inferência, sem renderer): três falharam antes de inferir por defeitos da ponte (contagem de argumentos, erro de sintaxe num patch, raiz de módulos Python incompleta — OpenVINO e OpenCV/NumPy ficam em duas raízes). Corrigidos; nenhuma medida de detecção foi produzida.
3. Um passe de ensaio de desenho (`w67-dev-rehearsal-86ad1605`): renderizou, pelo renderer real do produto, as 10 saídas da foto de development `58b5c1b5a4add461` (um reflexo num forno, escolhida pela mesma regra R1–R5 aplicada ao split development, que só tem uma elegível); a avaliação abortou na checagem de congelamento de código (eu havia corrigido a raiz de módulos). **Nenhum resultado foi lido.**

4. Ensaio de desenho 3 (`w67-dev-rehearsal3-64f2669b`, split **development**, fotos `58b5c1b5a4add461` e `a0f540fd64c97690`; a segunda foi escolhida à mão por ser um rosto nítido, fora da regra, e o manifesto de ensaio a marca `rehearsal`): fumaça do oráculo, render de 20 saídas (76 s) e avaliação completa (346 s) com exit 0 em todos os passos e pós-voo limpo. Resultado, **uma única corrida (N = 1 por unidade), sem réplica**: 24 unidades rotuladas, 24 detectadas com intervalo exato, 0 falso seguro, 0 marcação em unidade sem rótulo, 0 quadro `unknown`, 0 falha de decodificação; as 4 saídas limpas passaram. O oráculo achou a caixa humana (IoU ≥ 0,3) em 1440 de 1440 quadros com o rosto inteiro nos dois modelos. Na corrida, o excesso do CTA para fora da safe area foi de 31,9 px (9:16) e de 2,5 a 3,5 px (16:9). Esse 16:9 é um excesso pequeno (2,5 a 3,5 px de 1920), e foi o que o gerador construiu; não ajustei nada por isso.
5. **O que mudou por causa dos ensaios:** o desenho do gerador, os rótulos, a política e as tolerâncias **não** mudaram depois do ensaio 3 (os SHA-256 dos 13 arquivos de código e da política do manifesto desta etapa são iguais aos do manifesto de ensaio 3, conferido). As mudanças de código feitas durante os ensaios foram de encanamento (ponte do oráculo: contagem de argumentos e raízes de módulos; falha de lote do oráculo vira `unknown` em vez de derrubar o crítico; decodificação do retail-0004 valida id/rótulo só nos slots selecionados), e o selo do relatório passou a registrar os parâmetros de amostragem realmente usados (para medir saídas longas); todas anteriores ao congelamento desta etapa e nenhuma motivada por uma medida de detecção no calibration. Um item de desenho vindo dos ensaios sintéticos está no item 1 (linha do tempo).

Os ensaios servem para achar defeitos de encanamento e de desenho; o que mudou por causa deles está dito acima. **Nenhuma foto do calibration foi renderizada, e nenhum detector foi executado sobre uma foto do calibration, antes do commit da etapa 2.**

## 10. Limites

- Olhos desconhecidos (sem anotação). Vinte saídas de duas fotografias são **controles mecânicos**, não uma estimativa populacional nem vídeo natural: a fonte é uma foto parada.
- A completude da anotação (nenhum outro rosto na foto) repousa na anotação exaustiva do Open Images *validation*; **não foi adjudicada por humano**.
- A evidência de rosto da legenda-defeito é fabricada para o planejador (caixas-fantasma e rosto omitido); a posição final é o resultado do planejador, comparada ao rótulo.
- Densidade não tem defeito semeado: só falsos positivos são medidos.
- O oráculo roda em runtime Windows (Python 3.14, OpenVINO 2026.4.0, OpenCV 4.13.0, NumPy 2.5.1); não há recibo de paridade Linux.
- Nenhum modelo reprovado, fixture mecânica ou supressão geral de legendas converte este documento em crítico visual validado; aprovação do proprietário e revisão humana permanecem etapas separadas.

## 11. Emenda pós-revisão (linha do tempo verdadeira, R6 post hoc, divulgações, execução de sensibilidade)

Esta emenda foi pedida pela revisão do coordenador (Astra/Opus) e corrige o texto dos §1 e §3 acima, que estava mais limpo do que os fatos. Horários locais (UTC−03:00), lidos do transcrito da sessão (`subagents/agent-a3633a85a0f720cf8.jsonl`) e dos commits:

| horário (19/10/2026) | o que aconteceu |
| --- | --- |
| 19:46 | sondas de geometria dos presets (`probe1`, `probe2`): o planejador de legendas de produção foi chamado sem evidência de rosto |
| 20:03:11 e 20:03:34 | `feas.mjs` e `feas2.mjs`: as regras de enquadramento de `corpus-geometry.mjs` foram executadas sobre as caixas humanas de **todos** os candidatos do calibration (só metadados) e `feas2` **imprimiu os títulos dos três que passam em R1–R4**, entre eles "2$ bill" |
| 20:03:39 e 20:03:40 | abri as fotos dos três candidatos (`968a…`, `1580…`, `9295…`) |
| 20:04–20:05 | passes de ensaio do planejador de produção (`plan1`–`plan3`, `probe2`) sobre geometrias de enquadramento do calibration (metadados, sem detector, sem render) |
| 20:12:24 | a regra R6 foi escrita pela primeira vez em `corpus-generate.mjs`, **depois** de ver títulos e fotos, com a redação "retrato impresso ou pintado" que descreve a cédula |
| 20:44:32 | commit `524755c2` (etapa 1) |
| 21:06:43 | commit `5838b3ae` (etapa 2, manifesto congelado), antes de qualquer render ou detector sobre foto do calibration |

Consequências declaradas:

1. **R6 é uma exclusão post hoc**, não uma regra pré-registrada. A cláusula "retrato impresso" foi redigida olhando a cédula; a cláusula "outros rostos visíveis" foi julgada olhando as fotos. Ela decidiu o corpus (3 passam em R1–R4; excluída a primeira, ficam 2). O que este protocolo pode afirmar é só: nenhum render e nenhum detector tocaram foto do calibration antes do congelamento.
2. **Divulgação (dry-runs com metadados do calibration antes do congelamento):** as regras de enquadramento `corpus-geometry.mjs` e o planejador de legendas de produção foram executados sobre caixas humanas e dimensões de itens do calibration (metadados do manifesto V5), às 20:03–20:05, antes do congelamento. Não houve pixel, detector, render nem crítico sobre essas fotos. As regras R4 (viabilidade do enquadramento) foram escritas conhecendo esses números.
3. **`renderInputHash` do corpus é um substituto.** `corpus-run.mjs:135` calcula o `renderInputHash` do relatório como o hash canônico de `{ output, placementPlanHash, reframePlanHash }` da saída, e não o `renderInputHash` real de um `RenderInput` de produção. O vínculo com o plano continua verificável, mas esse campo nos relatórios do corpus não é o hash de produção.
4. **Execução de sensibilidade pós-hoc (declarada antes de rodar):** as 10 saídas da foto excluída `968a460084c588a1` serão renderizadas e avaliadas sob o código **congelado** (nenhum arquivo congelado foi tocado; os SHA-256 do código do manifesto de sensibilidade são iguais aos do manifesto registrado), no mesmo executor e com os mesmos critérios de aceite do §6. O resultado será publicado seja qual for, no documento de resultados (§8). Ela **não** substitui nem altera o corpus registrado e não entra no aceite dele. O manifesto de sensibilidade (`docs/quality/w67-mp4-critic-sensitivity-968-v1.json`) é gerado pelo mesmo gerador com o id forçado; a frase "design rehearsal on the development split" que ele carrega é a redação genérica do gerador para ids forçados (código congelado, não editado) e não vale para este caso: trata-se de uma execução de sensibilidade sobre o calibration.
