# ADR-034 — Secret provider configurado e entrypoint do worker de webhook

> **Status:** Accepted
>
> **Data:** 15 de julho de 2026

## Contexto

O dispatcher assinado já dependia de uma porta de secret provider, mas somente testes forneciam sua implementação. Sem adapter e entrypoint concretos, a entrega fim a fim não podia ser iniciada em um ambiente implantado. Colocar o segredo no banco, em respostas administrativas ou em logs violaria a separação definida para webhook signing secrets.

## Decisão

- O primeiro adapter concreto recebe um catálogo JSON pela variável protegida `APOLLO_V2_WEBHOOK_SIGNING_SECRETS_JSON`.
- Cada entrada vincula exatamente `workspaceId`, `endpointId`, `keyRef` opaco, `version` e `secretBase64url`. Não existe fallback por endpoint, versão anterior ou referência semelhante.
- A configuração aceita entre 1 e 1.000 entradas e no máximo 256 KiB. Campos desconhecidos, identidades duplicadas, UUIDs inválidos, referências com credencial embutida e secrets fora de 32–512 bytes falham no boot com `PERSISTENCE_NOT_CONFIGURED`.
- Mensagens de erro nunca incluem o JSON, a referência solicitada ou os bytes do secret.
- O adapter mantém somente a representação codificada após validação. Cada `open` decodifica uma cópia nova; o buffer temporário interno é zerado antes do retorno.
- A porta passa a declarar que o array retornado é descartável. O dispatcher copia os bytes e zera imediatamente o array recebido; sua cópia de assinatura continua sendo zerada no `finally` após transporte ou falha.
- Fingerprint SHA-256 persistido continua sendo verificado pelo dispatcher antes de qualquer chamada de rede. Configuração trocada sem atualização coordenada do registro falha fechada.
- `scripts/run-v2-webhook-worker.mjs` é o entrypoint operacional. Ele cria provider, discovery e runner, usa lease owner único, suporta encerramento por `SIGINT`/`SIGTERM` e expõe shard, scan e polling somente por configuração limitada.
- A API pública nunca lê nem devolve o catálogo. Administração e rotação futuras operarão referências/versionamento, não material secreto.
- Providers externos dinâmicos poderão implementar a mesma porta sem alterar dispatcher, scheduler ou contrato público.

## Consequências

- O worker pode executar deliveries reais sem persistir material secreto no Apollo.
- Configuração ausente ou ambígua impede o processo de iniciar, em vez de produzir assinatura com chave incorreta.
- Rotação inicial exige disponibilizar a nova versão no catálogo e reiniciar os workers antes de ativá-la no banco; automação de rotação e reload dinâmico permanecem futuras.
- A variável protegida deve ser fornecida pelo secret manager da plataforma e nunca versionada em arquivo `.env` do repositório.

## Evidências exigidas

- contrato prova binding exato, cópias independentes e indisponibilidade para qualquer identidade divergente;
- configurações vazias, malformadas, com campo extra, secret curto ou duplicata falham sem disclosure;
- dispatcher zera o array entregue pelo provider e sua cópia local;
- integração Prisma executa dispatch assinado usando o adapter concreto;
- typecheck, worker syntax, regressão global e auditorias permanecem verdes.
