# ADR-106 — Segmentos virtuais sobre masters imutáveis

Um `MediaSegment` é um range semântico e um mapeamento para o tempo do asset pai. Criá-lo nunca recorta nem copia o master. Sobreposição é válida; nesting exige o mesmo asset e limites contidos. Apenas consumers que precisam de bytes físicos recebem uma receita versionada `extract-range/v1`, produzindo derivative com chave própria e lineage para o source.

Implementação vinculante: o registro virtual mantém `physicalObjectKey: null`
por constraint do banco. A duração vem do probe do manifest imutável e é
revalidada na criação serializável. Materialização é content-addressed por
workspace, segmento, consumer e hash do source; replay converge para um único
artifact/manifest. O extractor precisa provar o hash do source antes e depois,
promover os bytes derivados e limpar todo workdir em `finally`.
