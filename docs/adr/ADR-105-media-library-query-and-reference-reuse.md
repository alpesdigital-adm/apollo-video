# ADR-105 — Media Library paginada e reuso por referência

## Contexto

O Diretor e o editor precisam localizar mídia dentro do workspace, conhecer sua
condição técnica e jurídica e reutilizá-la sem duplicar o master.

## Decisão

A biblioteca usa paginação por cursor ligado à ordenação
`createdAt + artifactId` e ao fingerprint dos filtros. Kind, pessoa, tema e
status de direitos são filtrados server-side. Origem, condição técnica, rights
e previews são campos separados do item canônico.

Inserir no projeto cria uma referência `selected-insert` ao artifact V2; nenhuma
cópia de bytes é autorizada. A elegibilidade é reavaliada dentro da transação
serializável com o locale real do projeto e uso `editorial-reuse`. Assets fora
do workspace, ainda em processamento ou sem rights elegíveis falham de forma
determinística. A API canônica é `/v1`; rotas `/api/assets` e paginação legada
são proibidas.

## Consequências

Listagens permanecem estáveis durante crescimento do catálogo, e rights são
aplicados antes do reuso. Thumbnails e waveforms são derivados descartáveis; o
master continua imutável. `MediaSegment` não é simulado: sua identidade virtual
e seus ranges pertencem a F1.013.

## Evidência

O run remoto `f1012-20260808-r1` nos commits `093272d` e `80fd193` aplicou 151
migrations do zero, aprovou integração Prisma e comprovou a UI/API em Chromium:
filtro por pessoa+rights, bloqueio restrito, attach 201 e replay 200. O banco
preservou uma referência e uma identidade de conteúdo; postflight terminou com
zero sessões/processos do Apollo e a VPS descartável foi destruída. A decisão
está integrada e testada ponta a ponta, mas ainda não implantada/aceita.
