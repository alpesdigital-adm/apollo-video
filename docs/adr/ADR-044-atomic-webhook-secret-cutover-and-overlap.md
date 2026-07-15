# ADR-044 — Corte HMAC atômico e overlap limitado

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

Depois que o receptor instala a candidata preparada, o Apollo precisa trocar a versão usada por novas deliveries sem invalidar um worker que resolveu o target antigo instantes antes do corte. Manter todas as chaves aposentadas abríveis seria um bypass permanente; assinar simultaneamente com duas chaves criaria um protocolo ambíguo e ampliaria a superfície de ataque.

## Decisão

- A ativação é explícita em `POST /v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/activate`.
- O body contém somente a `baseRevision` registrada no preparo. Endpoint, rotação, workspace, lifecycle, prazo e chave anterior são revalidados na transação.
- O command é naturalmente idempotente: uma rotação já ativada devolve seu resultado com `replayed: true`, desde que a revisão original seja a mesma.
- Na mesma transação serializável, a chave anterior recebe `status=retired`, `retiredAt` e `usableUntil`; a candidata e seu payload passam ao secret store como única versão ativa; o envelope intermediário é apagado; a rotação recebe `activatedAt` e `overlapUntil`; o endpoint avança de revisão.
- `overlapUntil = activatedAt + overlapSeconds` e o limite é exclusivo.
- A resolução de novas deliveries consulta somente `status=active`, portanto passa a escolher a candidata após o commit.
- O provider abre uma versão aposentada somente quando ela corresponde exatamente a workspace, endpoint, keyRef e version solicitados e `now < usableUntil`.
- Uma chave aposentada vencida ou revogada retorna indisponível com fallback proibido. Configuração legada não pode estender a janela definida no banco.
- Não há dual-signature. O receptor aceita atual e candidata antes do corte; após o corte, mantém a anterior apenas pelo overlap combinado.

## Consequências

- A corrida `getDispatchTarget(old) → cutover → open(old)` permanece válida somente durante a janela explícita.
- Um attempt iniciado depois do corte resolve a candidata, mesmo que sua delivery tenha sido criada antes.
- No instante `usableUntil`, a chave anterior já está bloqueada.
- O payload aposentado pode permanecer cifrado para auditoria/reprocessamento controlado, mas o provider não o abre após o prazo.
- Cancelar preparação, consultar rotações e executar higiene física de payloads são responsabilidades separadas.

## Evidências exigidas

- corte, retirement, criação do payload ativo, limpeza do estágio e revisão do endpoint são atômicos;
- exatamente uma chave fica ativa antes e depois do corte;
- candidata é abrível após o corte e a anterior somente antes do limite exclusivo;
- provider legado não contorna chave expirada;
- replay não repete efeito, envelope ou plaintext e revisão diferente falha fechado;
- OpenAPI, schema, exemplos, migração, integração Prisma e jornada HTTP descrevem o mesmo contrato.
