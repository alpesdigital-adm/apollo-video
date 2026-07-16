# ADR-064 — Single-flight durável no challenge de webhook

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Duas ativações simultâneas de um endpoint pendente podiam emitir challenges
distintos e realizar mais de uma chamada HTTPS. A verificação one-shot impedia
dupla ativação, mas não eliminava efeitos externos duplicados nem garantia
convergência previsível para o request perdedor.

O lock não pode depender do processo da aplicação, pois réplicas diferentes
precisam coordenar o mesmo endpoint. Também não é aceitável manter uma transação
de banco aberta durante a chamada HTTPS ou alterar a revisão pública do endpoint
apenas para registrar coordenação interna.

## Decisão

- Cada endpoint pode possuir um único activation lease durável em tabela própria.
- O vencedor persiste um hash SHA-256 de token aleatório, emite o challenge e
  executa o transporte HTTPS; seguidores apenas consultam o estado até convergir.
- O token do lease acompanha a verificação como fencing token. Apenas o lease
  vigente e não expirado pode ativar o endpoint.
- A ativação remove o lease na mesma transação que ativa endpoint e subscriptions.
- Falhas liberam somente o lease do próprio token. Se o processo morrer, a
  expiração permite takeover por outro request.
- Suspensão ou revogação do endpoint também remove qualquer lease existente.
- A espera do seguidor e a duração do lease são limitadas e derivadas do timeout
  do challenge. Nenhuma transação permanece aberta durante o acesso à rede.
- O lease fica separado do endpoint para não alterar `updatedAt`, revisão ou
  representação pública por atividade interna de coordenação.

## Consequências

- Ativações simultâneas produzem exatamente um challenge e um POST HTTPS.
- Líder e seguidores convergem para respostas compatíveis; chamadas posteriores
  retornam replay sem rede.
- Um líder interrompido não bloqueia o endpoint indefinidamente.
- O fencing impede que um líder atrasado consuma o challenge após perder o lease.
- A matriz do ADR-063 passa a ter 21 commands duráveis cobertos, 2 preflights e
  nenhuma pendência.

## Evidências exigidas

- teste de contrato com duas ativações simultâneas e exatamente um transporte;
- integração Prisma cobrindo follower, expiração, takeover e release com fencing;
- integração HTTP concorrente com respostas convergentes;
- retry serializável limitado diante de `P2034` persistente;
- migration validada e regressão completa verde.
