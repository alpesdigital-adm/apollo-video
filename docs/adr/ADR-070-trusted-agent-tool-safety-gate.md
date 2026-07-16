# ADR-070 — Gate confiável para tools de risco

> **Status:** Accepted
>
> **Data:** 16 de julho de 2026

## Contexto

Metadata de custo e confirmação apenas informa risco; ela não impede um agente
de chamar uma tool. Aceitar `approved: true` nos argumentos também seria
inseguro, pois o próprio modelo controla esses dados e poderia se autoaprovar.
O adapter MCP ainda não existe, mas precisa nascer sobre um gate testável e
exaustivo, sem decisões implícitas por nome ou método HTTP.

## Decisão

- Toda capability mutável exposta como tool possui regra explícita no registry
  de segurança, com impacto `bounded`, `broad` ou `destructive` e uma razão.
- Impacto broad/destructive e custo high/variable exigem `human-approval` ou
  `preflight-token`; registry incompleto ou regra sem gate falha no boot/teste.
- O descriptor anuncia a confirmation efetiva e explica o requisito no texto.
- Aprovação e preflight não são propriedades do input controlado pelo modelo.
  O host confiável fornece evidência separada depois de confirmar o usuário ou
  validar criptograficamente um token.
- Evidência é vinculada a kind, capability ID, fingerprint canônico do input,
  emissão e expiração. O gate rejeita ausência, tipo incorreto, capability ou
  fingerprint divergente, emissão futura e expiração.
- Tools sem confirmation passam sem evidência; isso não remove autenticação,
  scopes, policy, preconditions ou validações do endpoint.

## Consequências

- O modelo não consegue fabricar aprovação por prompt injection nos argumentos.
- Nova tool mutável quebra a regressão até receber classificação explícita.
- Alterar o input depois da aprovação invalida a evidência.
- O adapter MCP deverá chamar o gate imediatamente antes da Public API.
- Commit tokens assinados, single-use e vinculados a snapshot/custo serão
  implementados na F0.042 e convertidos em evidência confiável pelo host.

## Evidências exigidas

- cobertura exaustiva de todas as tools mutáveis;
- regra broad/destructive/high/variable sem gate rejeitada;
- ausência, mismatch e expiração rejeitados;
- aprovação válida vinculada ao fingerprint aceita;
- nenhum argumento model-writable de autoaprovação;
- descriptor e jornada HTTP anunciam confirmation efetiva;
- contratos, build, integrações e regressão completa verdes.
