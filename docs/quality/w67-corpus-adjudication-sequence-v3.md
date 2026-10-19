# W67 V3 — sequência de aquisição e adjudicação do corpus

Proposta de implementação, 2026-10-12. Complementa o pré-registro
`w67-cvdf-acquisition-v3.md` (SHA-256
`a1ab79137589035e042c25f750c1e0bd30952828d6e7f8c01f28d3409cde3699`),
sem alterar seus bytes, splits, ranking, quotas, critérios ou resultados anteriores.
Não autoriza aquisição, inferência, render ou abertura do holdout.

## Sequência explícita

A qualificação de regiões protegidas exige adjudicação dos pixels. Por isso,
um lote de aquisição não é o corpus qualificado e não pode receber esse nome.
As etapas ficam separadas:

1. Congelar universo, exclusões, fontes humanas e critérios de metadata.
2. Congelar um lote provisório na ordem de rank já definida, com dois single e
   dois multiple em cada split. Esse lote ainda não comprova direitos atuais,
   visibilidade, correspondência geométrica ou completude das anotações.
3. Revalidar individualmente foto, autor, licença e atribuição. Ausência,
   contradição ou bloqueio de acesso interrompe a aquisição; não substituir
   silenciosamente o ID nem procurar outro host para contornar a recusa.
4. Após autorização específica de execução, adquirir somente os bytes do lote
   congelado, com proveniência, limites e encerramento verificáveis. Não executar
   detector ou renderer nesta etapa.
5. Adjudicar regiões e correspondência segundo a rubrica congelada abaixo,
   antes de consultar qualquer predição ou output defeituoso/limpo.
6. Admitir o mesmo lote como corpus somente se todas as quotas e dimensões
   obrigatórias passarem. Um candidato desconhecido ou reprovado mantém STOP.
   Qualquer tentativa futura terá novo protocolo e preservará este resultado.

Essa distinção resolve a dependência entre acesso aos pixels e adjudicação;
não aceita metadata como substituto de adjudicação nem reduz o gate original.

## Base autenticada disponível

O preparo `w67-id-extraction-v1-d4bbde1b` produziu a allowlist de 922 IDs,
SHA-256 `7ec2470d254de05b19f597a227258c8d4249d7f928de68243cc9da60c78b2510`.
O manifesto de dois arquivos tem SHA-256
`7dd141a466c6b324852c621a0e2de795c583ace593f6655967d21db6adc1a35e`.
Os 180 IDs W62 V5 e oito IDs W67 V1 foram excluídos por identidade, sem
materializar os campos GT/predições de calibration ou holdout. A allowlist não
é uma seleção final nem comprova licença individual atual.

A leitura independente posterior dos CSVs pinados encontrou 365 candidatos
com todas as faces anotadas associadas geometricamente a exatamente dois
HumanEye GT limpos e univocamente contidos, label humano positivo de olho e
ausência de label negativo contraditório: 177 single e 15 multiple em
development; 147 single e 26 multiple em evaluation. Isso é uma constatação
de metadata, sem inspeção de pixels. Contenção geométrica não demonstra que
os olhos estão visíveis, que todas as pessoas foram anotadas ou que a região
Human face corresponde à cabeça inteira. A lista de seleção permanece pendente.

## Rubrica a congelar antes dos pixels

- Preservar cada linha humana original, classe, Source, Confidence, flags,
  coordenadas normalizadas, ordinal físico, hash literal e vínculo ao CSV.
  Registrar xclick e activemil conforme a origem publicada, sem chamar ambos
  de anotação manual própria.
- Manter face, cabeça e cada olho como regiões e fatos separados. Ausência de
  Human head não vira cabeça derivada por expansão de Human face. Uma máscara
  geométrica conservadora tem procedência algorítmica e não é novo GT humano.
- Adjudicar o conjunto completo da imagem: pessoas/rostos adicionais, regiões
  truncadas, oclusão, depiction, olhos ausentes ou associação ambígua. Nunca
  remover uma caixa problemática e declarar o restante completo.
- Registrar convenção de face e cabeça, visibilidade e lado/identidade de cada
  olho, incerteza e divergência. Não preencher esses campos a partir de scores,
  caixas ou landmarks do modelo candidato.
- Registrar identidade real do adjudicador, data, ferramenta, versão da rubrica
  e hash dos bytes efetivamente vistos. Não atribuir uma decisão humana a uma
  inspeção automática. Divergências permanecem desconhecidas até resolução
  humana registrada.
- Fixar orientação, dimensões e correspondência das anotações com os bytes
  adquiridos. OriginalMD5/OriginalSize não autenticam o derivado CVDF; identidade
  por ImageID e ausência de EXIF não provam correspondência individual.
- Congelar máscaras finais, coordenadas, convenção e hashes antes de observar
  outputs do modelo ou renderer. Tolerâncias/defeitos do protocolo W67 V1
  permanecem intactos; nenhum parâmetro será escolhido para fazer um output
  já observado passar.

## Limites

O lote provisório, sua revisão de direitos e a adjudicação ainda não foram
executados. Continuam pendentes a seleção explícita, os bytes autorizados,
os fatos visuais humanos e o corpus qualificado. Os oito controles não
comprovam independência de treino, ausência de near-duplicates, comportamento
em vídeo natural, aptidão W62, publicação W69, entrega W70 ou aceite do owner.
Nenhuma caixa TODO ou estado de produto é promovido por este documento.
