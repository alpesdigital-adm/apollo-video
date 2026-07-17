# ADR-107 — Catálogo de imagens observado e rastreável

A análise separa atributos observados de tags inferidas. Dimensões, orientação, cores, faces, objetos e regiões OCR mantêm confidence e versão do modelo; a descrição só menciona elementos recebidos do analisador. Thumbnail e preview são derivatives, nunca alterações do original. A busca devolve o mesmo asset para B-roll, insert ou card e preserva a finalidade solicitada.
