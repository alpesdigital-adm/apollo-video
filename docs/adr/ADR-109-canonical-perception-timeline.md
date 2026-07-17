# ADR-109 — Tempo canônico para percepção multimodal

Todas as observações usam milissegundos no tempo do asset/projeto e carregam source, model, version e confidence. A API consulta intervalos para Diretor, legendas, reframe e editor. Coverage é explícita como completa, parcial ou ausente; ausência nunca é preenchida por inferência silenciosa. Fixtures golden representam talking head, áudio sem imagem e imagem inserida.
