# W62 V8 — pré-registro de desenvolvimento Intel face-detection-0204

Pré-registro documental: 2026-10-12 UTC.

Estado: **proposta documental, nenhuma aquisição ou inferência V8 executada; candidato não apto**. A série de arquivos mantém o prefixo histórico W61; a hipótese é da detecção facial W62. V5/V7 e seus FAILs permanecem intactos. Este protocolo é registrado após resultados anteriores já conhecidos e antes de qualquer resultado do candidato 0204; não é avaliação cega nova dos mesmos conjuntos.

## Hipótese única e procedência

Testar futuramente uma configuração FP32 do Intel Open Model Zoo `face-detection-0204`, commit `eda1863a6d60b09551df9d039cff2377d6ddd4d6`. O [README pinado](https://github.com/openvinotoolkit/open_model_zoo/blob/eda1863a6d60b09551df9d039cff2377d6ddd4d6/models/intel/face-detection-0204/README.md) descreve MobileNetV2/SSD, entrada BGR 448×448 e label facial 0; é uma hipótese diferente do retail0004, não evidência de rejeição de animais. Não há lista completa de imagens de treino publicada nesse material, portanto independência absoluta de Open Images não está comprovada.

A AP WIDER publicada, 92,89%, considera faces maiores que 64×64 pixels. AP não é nosso recall/IoU; **não filtrar GT por 64 pixels**, não excluir faces pequenas nem mudar quotas, score ou gate para reproduzir a métrica do publisher. Uma falha nessa população é resultado válido. [Descrição oficial](https://github.com/openvinotoolkit/open_model_zoo/blob/eda1863a6d60b09551df9d039cff2377d6ddd4d6/models/intel/face-detection-0204/README.md).

A [declaração pinada](https://github.com/openvinotoolkit/open_model_zoo/blob/eda1863a6d60b09551df9d039cff2377d6ddd4d6/models/intel/face-detection-0204/model.yml) fornece os dois arquivos FP32 oficiais abaixo. Sua licença aponta ao LICENSE do OMZ; a [especificação do campo license](https://github.com/openvinotoolkit/open_model_zoo/blob/eda1863a6d60b09551df9d039cff2377d6ddd4d6/CONTRIBUTING.md) o define como licença do modelo. Preservar [Apache-2.0 e notices nesse commit](https://github.com/openvinotoolkit/open_model_zoo/blob/eda1863a6d60b09551df9d039cff2377d6ddd4d6/LICENSE), sem confundir isso com licença das imagens. LICENSE já preservado na série V7: SHA-256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`; revalidar seus bytes antes de futura aquisição.

| Arquivo FP32 | Bytes exigidos | SHA-384 do publisher |
| --- | ---: | --- |
| face-detection-0204.xml |185457|`14cdec35ec8303c0dd1dd7ed248e084c3618a6812c30e0241b9326f6d94c079079de40869879f0de9a3386c234f497fb`|
| face-detection-0204.bin |7269196|`b27cfb3acded0881843c317c9cf04d8789abfe51b19a85d0adde89f3a021a44a2cb4a180a381a52290a2dd9ceff45e5f`|

URLs exclusivamente declaradas, **não acessadas nesta etapa**:

- `https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/face-detection-0204/FP32/face-detection-0204.xml`
- `https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/face-detection-0204/FP32/face-detection-0204.bin`

Os hashes acima são pins prévios oficiais, não SHA calculado do binário depois para validar a si próprio. SHA-256 local dos pesos/declaration/README V8 ainda não existe neste protocolo e não deve ser inventado. Aquisição futura, separadamente autorizada e supervisionada, deve confrontar tamanho/SHA-384, preservar docs/licença/URL/data e registrar SHA-256 local; divergência fecha o gate, sem FP16/INT8/modelo alternativo.

## Conjuntos e configuração congelados

Herdar os 180 IDs exatos do manifesto V5 SHA-256 `74cc75cf7a188bca692f51c22cbde1ecd8754bd2ef059a613672bef0acfd9927` e source audit detector-free `e5056b33e4960404f2e19f000185378bae8760dabd083e8e7b3b8b97e5e7b49b`:60 development,60 calibration e60 holdout, mesmos JPEGs CVDF licenciados/hashes e linhas GT humanas. O split continua primeiro byte SHA-256 UTF-8 `w61-v1|validation|<image-id>` menor que 128 para development, demais calibration; test oficial é holdout. Quotas por set:10 multiple,10 lower,10 small,10 other-single,20 negativos humanos explícitos. O ranking executado V5 `w61-v3|<set>|<stratum>|<image-id>` é histórico preservado, não nova seleção V8. [V5](./w61-visual-preflight-v5.md), [V7](./w61-visual-preflight-v7-openvino-retail0004.md).

**V8 autoriza como proposta apenas development 60 numa passagem de acurácia futura**, após revisão e freeze do evaluator/runtime. Os calibration 60 ficam com IDs/bytes/labels inalterados, sem nova inferência por este documento; holdout 60 permanece fechado, sem decode/pixels/predições. Não substituir, relabelar ou reordenar falhas, consultar holdout para decidir modelo ou executar segundo preset. Uma etapa calibration ou avaliação independente exige direção/pré-registro separado; um PASS development não abre holdout automaticamente.

Configuração futura: mesmo runtime privado Python 3.14/OpenVINO 2026.4.0 FP32/CPU de V7, pin oficial do wheel `eab8a6c71210b2596765e3c9ffbdbe05c1d3b279793806e55162befa898a548f`, no máximo 2 threads e uma infer request. Revalidar suporte CPU AVX2, Python, wheel/native DLL, numpy/OpenCV e licença; congelar hashes reais do ambiente/script antes de inferir. Nenhuma instalação global, GPU/OpenCL, chamada paga ou modelo remoto.

Decode BGR dos JPEGs V5 já auditados, Rotation0/EXIF neutro; resize direto bilinear de BGRuint8 a448×448, depois cast explícito float32 e transpose para NCHW [1,3,448,448], sem letterbox/crop/flip/multiscale/augmentação ou ajustes extras de mean/scale fora do IR. O check detector-free futuro exige elemento de entrada float32/shape exatos antes da inferência. Exigir output [1,1,200,7] e percorrer os200registros: image_id=-1 é padding e não vira detection; ignorar esse registro sem inferir que todos os seguintes são padding nem adicionar break não comprovado. Nos registros efetivos não-padding, exigir image_id0, face label0 e confidence finita no intervalo[0,1], antes do threshold fixo score≥0,50. Para a caixa selecionada, exigir XYXY finito, normalizado[0,1], x_min<x_max/y_min<y_max. ID/label/score inválido ou bounds selecionados inválidos é falha da imagem, nunca ausência facial nem repair por clipping/normalização. Postprocess/NMS interno é o IR pinado; nenhum NMS externo ou sweep. NMS 0,30 dos YuNet anteriores permanece no histórico, não é um tuning novo de 0204. Reverter resize à geometria normalizada source e comparar uma vez com GT original, sem filtro por tamanho 64.

## Métricas e STOP

Preservar score 0,50 e matching um-para-um IoU ≥0,50; IoU 0,30 serve só diagnóstico histórico de faces pequenas. Reportar denominadores completos, misses inclusive GT de imagens falhas, falsos positivos, completude e recall por stratum, precisão, IoU mediana/p95, bins de confiança e Wilson 95%. Falha de negativo não conta como animal corretamente rejeitado. Os cinco animais já conhecidos em V7 são apenas subconjunto pós-hoc dos 40 negativos fixos, não novo benchmark; não selecionar novos negativos depois do resultado.

Targets inalterados: completude ≥90% por set; recall geral ≥95%; recall ≥90% em cada stratum positivo com pelo menos 10 faces; FP por imagem negativa explícita ≤10%. Targets holdout ≥30 faces/≥10 negativos permanecem, mas não são avaliados nem satisfeitos por V8 development. O desenvolvimento já inspecionado mede hipótese diagnóstica, não qualificação independente.

Limites de recursos V1/V7: 3 warmups + 30 medidas, mediana ≤150 ms/p95 ≤500 ms, janela benchmark 30 s, incremento RSS ≤512 MiB e total RSS reportado. Congelar o ID development de benchmark e todas as chamadas repetidas de timing antes do run; não usar saídas repetidas para selecionar uma predição favorável. Futuro run tem owner/PID, total ≤15 min, timeout por imagem ≤30 s, um worker CPU e cleanup/estado terminal explícitos; orçamento é teto, não aumento do gate 30 s do benchmark. Preservar relatório parcial e FAIL em timeout/loading/integridade/shape/GT/rights/budget.

**STOP** em pin/manifest/licença/GT incompatível, orçamento excedido ou gate falho. Não ajustar threshold, filtroGT64, quotas, resolução ou score sob V8 para obter PASS. Qualquer configuração posterior precisa nova hipótese/versionamento e conjunto independente apropriado. Nenhum candidato está apto; faceSafety continua unknown, sem autoridade de export, olhos, vídeo, W67/W70, deploy ou aceite. Nenhum algoritmo runtime é criado por este documento.
