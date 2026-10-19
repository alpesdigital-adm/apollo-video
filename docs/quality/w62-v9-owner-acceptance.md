# W62 — aceite do proprietário do detector V9 (OMZ face-detection-0204)

Este documento é endereçado por conteúdo: o envelope de rostos v2 grava o SHA-256 destes bytes
(`FACE_V9_OWNER_ACCEPTANCE_SHA256` em `src/v2/domain/face-evidence-policy.ts`). Qualquer edição
muda o hash e invalida os envelopes que o citam; correções entram como novo documento versionado.

## Decisão

Data: 17/10/2026. Autor: Leandro, proprietário, no chat do Claude Code. Palavras dele:

> "Posso aceitar os 74% da V9. Um detalhe: não precisamos detectar todos os rostos da cena, apenas
> os que estão no primeiro plano na cena, e em especial o orador."

Antes, no mesmo contexto, ele endossou inverter a lógica para "área livre": o produto pergunta se a
área da legenda está livre, em vez de provar que todos os rostos foram achados.

## Escopo aceito

- Detector: Open Model Zoo `face-detection-0204`, IR FP32, executado em CPU pelo OpenVINO, com a
  política de saída `w62-v9-visible-intersection-continuous/v1`.
- Aceite com escopo: rostos em primeiro plano e o orador. Rostos de fundo estão fora do escopo.
- Uso aceito: evidência de rosto por janela de tempo, relevância de primeiro plano, candidato a
  orador e liberação da área de legenda em três estados (livre certificada, ocupada, desconhecida).

## O que este aceite NÃO é

- Não é qualificação estatística nem confirmação independente selada. O corpus de desenvolvimento é
  adaptativo; holdout e calibration permanecem selados e não foram abertos.
- Não concede `faceSafety`: o envelope mantém `faceSafety = "unknown"`. "Livre certificada" vale
  somente contra o escopo acima e contra a cobertura amostrada registrada; não afirma ausência de rosto.
- Não cobre identidade, emoção, olhar nem fala. O candidato a orador é proeminência visual, não
  detecção audiovisual de quem fala.
- Não cobre rostos de fundo, que o detector perde com frequência em cenas de várias pessoas
  (13 das 17 perdas do desenvolvimento ocorreram no estrato `multiple`).

## Evidência citada

- Execução V9 de desenvolvimento `w62-development-v9-v1-42ee2328`, `owner-receipt.json` com SHA-256
  `390d3b28d172015f8ed2cb3d416e38625ce4d4efaca8e1eea52d7a8e58aaa817`: 50 de 67 rostos (74,6%),
  10 falsos positivos, mediana de IoU 0,808, mediana de inferência 17,4 ms, p95 24,3 ms.
- Corpus de desenvolvimento: visão `7f2e232a0e063589dcc6eef487dd2d684dfc1ba063d55ef1fbc66cfc5697e8a6`,
  60 imagens e 67 rostos de referência.
- Análise pós-hoc de primeiro plano e de liberação de área, sobre os tensores brutos da V9
  (reproduzem o recibo em 60 de 60 imagens): `tables.md`
  `e5ed533dfcab5ae26d119bed4dbfacc865ee2bf3c7fba893a6d958f238499613`, `results.json`
  `4c7f07ffd3ff3feb22220adabaff2873fb5c54f47de5733ec8cd2110d598d2d3`, `analysis.py`
  `2166235aba507d1f845ab69e957e380a7ec6e43ae1580735eb58b2c75e9780b3`. É evidência de
  desenvolvimento com intervalos largos, não qualificação.
- Proveniência do modelo: Open Model Zoo, commit `eda1863a6d60b09551df9d039cff2377d6ddd4d6`, arquivos
  `face-detection-0204.xml` (SHA-256 `33394c03…7ee3`) e `face-detection-0204.bin` (SHA-256 `0bbc0e08…4102`),
  licença com SHA-256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`.

## Limites declarados

1. Os 74,6% foram medidos em imagens JPEG paradas; o produto decodifica quadros de vídeo. A taxa em
   vídeo não está medida. A medição real (talking head, agregação temporal) virá da jornada W70
   com o master do proprietário, reproduzível a partir da evidência persistida.
2. O aceite foi dado sobre o runtime Windows do recibo (OpenVINO 2026.4.0, OpenCV 4.13.0, NumPy 2.5.1,
   Python 3.14). O runtime de produção em Linux precisa de rodas fixadas por hash.

## Bloqueio de implantação

Antes de qualquer implantação, é obrigatória uma execução supervisionada de paridade: as 60 imagens de
desenvolvimento no runtime Linux de produção, comparadas byte a byte com os tensores da V9, sem ajuste
de nenhum parâmetro. Sem esse recibo, o detector não é habilitado em ambiente algum.
