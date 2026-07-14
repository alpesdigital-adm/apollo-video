# ADR-015 — Checkpoint do output materializado

> **Status:** Accepted
>
> **Data:** 14 de julho de 2026

## Contexto

O render autorizado reconstrói um artifact cujo manifest e identidade imutável já existem. O rename do arquivo e a conclusão da `PublicOperation` não podem participar da mesma transação. Uma queda pode ocorrer depois do commit físico, antes do checkpoint ou depois do checkpoint, antes de `succeeded`.

Criar outro artifact após o render duplicaria a identidade alvo e quebraria o vínculo da autorização com artifact/manifest. Tratar um arquivo existente como conflito impediria recuperação segura.

## Decisão

- O artifact/manifest da autorização continua sendo o target canônico da reconstrução.
- A materialização efetiva é registrada no contexto tipado `artifact_render_operations`, não como um segundo artifact.
- O checkpoint contém storage key interna, input hash já vinculado, SHA-256, byte size, probe técnico, codec/container, attempt, commit time e record time.
- O checkpoint só é gravado por uma operação `running/persisting` com owner, attempt e lease válidos.
- Hash, tamanho, container e probe precisam corresponder ao artifact/manifest alvo; divergência falha fechada.
- `succeeded` exige checkpoint completo.
- A output key é determinística a partir da autorização e do input hash. O renderer pode inspecionar um output final já existente, recalcular sua identidade e recuperá-lo sem codificar novamente.
- Output recuperado repete materialização, rights revalidation e gate de lease.
- Replay do checkpoint ignora stage ID e horário reobservado, mas exige igualdade de todos os campos que identificam bytes e render técnico.
- Storage key e receipt técnico permanecem internos; a resposta pública referencia somente artifact e manifest.

## Recuperação

```text
sem arquivo → stage → revalidate/lease gate → commit → checkpoint → succeeded
                                      │          │            │
queda antes do commit ────────────────┘          │            │
queda após commit → inspect/recover ─────────────┘            │
queda após checkpoint → inspect + replay checkpoint ──────────┘
```

## Consequências

- Uma queda após rename não obriga nova codificação nem deixa a operação irrecuperável.
- Um arquivo estranho na key determinística não é adotado: hash/probe/target precisam coincidir.
- O artifact pode existir no catálogo mesmo quando seus bytes precisam ser reconstruídos; disponibilidade física continuará sendo verificada pelo storage adapter.
- Object storage remoto deverá implementar a mesma semântica de inspect, commit imutável e checkpoint, sem mudar o contrato público.
