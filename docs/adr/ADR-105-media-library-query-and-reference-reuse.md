# ADR-105 — Media Library paginada e reuso por referência

## Contexto

O Diretor precisa localizar mídia dentro do workspace, conhecer sua condição técnica e jurídica e reutilizá-la sem duplicar o master.

## Decisão

A biblioteca usa paginação por cursor ligado à ordenação `createdAt + id`, filtros server-side por kind, pessoa, tema e status de direitos e detalhes separados para origem e previews. Inserir no projeto cria uma referência ao asset; nenhuma cópia de bytes é autorizada. Assets fora do workspace, ainda em processamento ou sem rights elegíveis falham de forma determinística.

## Consequências

Listagens permanecem estáveis durante crescimento do catálogo, e rights são aplicados antes do reuso. Thumbnails e waveforms são derivados descartáveis; o master continua imutável.
