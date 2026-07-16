# ADR-061 — Concorrência na declaração de direitos de artifacts

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

`PUT /v1/artifacts/{artifactId}/rights` cria snapshots imutáveis de direitos e consentimento, endereçados pelo hash do draft canônico. Requests idênticos simultâneos ou repetidos após resposta perdida não podem consumir duas sequências, avançar duas vezes a revisão do artifact nem produzir snapshots equivalentes com IDs diferentes.

## Decisão

- Seleção do artifact, validação de evidência, incremento de revisão, criação do snapshot e troca do ponteiro atual ocorrem em transação serializável.
- Conflitos `P2034` são repetidos no máximo três vezes; contenção persistente retorna `PERSISTENCE_CONFLICT`.
- A unicidade `artifactId + snapshotHash` permanece a barreira final contra snapshots equivalentes duplicados.
- Se o snapshot já existe, o command reutiliza seu ID e sequência e o torna atual sem incrementar `rightsRevision`.
- Retry após resposta perdida devolve o snapshot persistido com `replayed=true`.
- Drafts diferentes continuam criando snapshots distintos; a exigência de revisão-base para impedir last-writer-wins pertence à evolução geral de mutações versionadas.

## Consequências

- Chamadas idênticas convergem para uma única identidade jurídica auditável.
- Sequência do snapshot e revisão do artifact permanecem monotônicas sob contenção.
- O comportamento é seguro tanto por retry serializável quanto pela constraint de conteúdo.
- Conflitos intencionais entre drafts diferentes ainda precisam de uma futura precondição explícita.

## Evidências exigidas

- dois PUTs simultâneos devolvem um original e um replay do mesmo snapshot;
- sequência e `rightsRevision` avançam uma vez;
- resposta descartada é recuperada sem nova revisão;
- `P2034` persistente é limitado a três tentativas;
- SQLite repetido e PostgreSQL hospedado confirmam os mesmos invariantes.
