# Apollo Video v2 — Documentação de produto e engenharia

## Documento mestre

- [PRD Apollo Video v2](./PRD-APOLLO-V2.md)
- [Matriz de rastreabilidade](./REQUIREMENTS-TRACEABILITY.md)
- [Backlog executável em microtarefas](../TODO.md)

## Especificações derivadas

As specs estão em estado **implementation-grade draft**: já definem contratos, invariantes, estados, regras de decisão, falhas/fallbacks, observabilidade e cenários de aceite. As specs 01–08 estão na versão 2.0; a spec 09 foi criada na versão 1.0. Questões marcadas para ADR ou calibração continuam explícitas e devem ser fechadas antes da implementação do módulo correspondente.

1. [Agente Diretor e qualidade](./specs/01-director-and-quality.md)
2. [EditPlan, Commands e versionamento](./specs/02-editplan-commands-versioning.md)
3. [Ontologia da biblioteca de mídia](./specs/03-media-library-ontology.md)
4. [Produção em lote, variações e compatibilidade](./specs/04-batch-variants-compatibility.md)
5. [Sincronização multicâmera, tela e react](./specs/05-multicam-sync.md)
6. [Providers sintéticos e transformação generativa](./specs/06-synthetic-providers.md)
7. [UX do editor, timeline e revisão](./specs/07-editor-review-ux.md)
8. [Localização multi-idioma e direção de áudio](./specs/08-localization-and-audio.md)
9. [API externa, automação e agentes](./specs/09-external-api-and-automation.md)

## Referências visuais aprovadas

- [Editor e revisão](./assets/apollo-v2-editor-reference.png)
- [Dashboard do workspace](./assets/apollo-v2-workspace-reference.png)

## Ordem recomendada de leitura

1. PRD, seções 1–6: visão, problema e princípios.
2. PRD, seção 15: roadmap incremental.
3. Spec 01: comportamento do Diretor e qualidade.
4. Spec 02: contrato central da timeline e versões.
5. Spec 03: mídia e reuso.
6. Demais specs conforme a fase.
7. Matriz de rastreabilidade antes de montar backlog/test plan.

## Regra de manutenção

Mudança de requisito deve atualizar no mesmo commit:

- PRD;
- spec derivada afetada;
- matriz de rastreabilidade;
- critérios de aceite ou test plan correspondente.
