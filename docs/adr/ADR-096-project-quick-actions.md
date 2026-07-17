# ADR-096 — Ações rápidas de projeto com rollback seguro

## Status

Aceito em 2026-07-17.

## Decisão

Abrir e revisar são navegações de leitura. Renomear, duplicar, arquivar e restaurar são comandos. O serviço de aplicação recebe identidade, workspace e permissões explícitas; nenhum identificador informado pelo cliente amplia o workspace autenticado.

Arquivar exige confirmação e guarda o estado anterior para restauração. A duplicação é copy-on-write: cria uma identidade nova, mas compartilha referências imutáveis de versões, snapshots e fontes; jobs e arquivos renderizados não são copiados fisicamente.

A interface só aplica atualização otimista quando conserva o snapshot anterior completo. Em falha, restaura exatamente a coleção anterior. A duplicação não é otimista, pois seu identificador é atribuído pelo servidor.

## Consequências

- ações frequentes ficam disponíveis sem abrir o editor;
- falhas de rede não deixam cards em estados fictícios;
- arquivamento é reversível e não equivale a exclusão;
- duplicar um projeto não multiplica arquivos brutos nem perde linhagem.
