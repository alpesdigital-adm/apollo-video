# ADR-106 — Segmentos virtuais sobre masters imutáveis

Um `MediaSegment` é um range semântico e um mapeamento para o tempo do asset pai. Criá-lo nunca recorta nem copia o master. Sobreposição é válida; nesting exige o mesmo asset e limites contidos. Apenas consumers que precisam de bytes físicos recebem uma receita versionada `extract-range/v1`, produzindo derivative com chave própria e lineage para o source.
