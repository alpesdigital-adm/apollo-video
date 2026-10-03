# Wave 29 — comparação autenticada de LUTs no `/brand`

**Implementada e validada tecnicamente em ambiente local controlado em 2026-10-03.** Alvo: F2.026 / FR-181, somente a caixa aberta “Criar UI de comparação e remoção segura sem quebrar versões antigas” (ID `d5c7c7de03a2-1`). Base: `main` em `edfef392a68847cce6d89c9676e49ff07f3c54ec`. Implantação atual na DigitalOcean e aceite do proprietário continuam pendentes. `TODO.md`: **380/1.259**, sem checkbox alterada.

## Escopo e limite

Com sessão humana real, provar A/B de duas LUTs `.cube` distintas aplicadas à mesma carta pelo gerador FFmpeg existente. A comparação apenas muda previews; não cria Commands, ProjectVersions, seleções ou revisões. Testar `none`, retirada da LUT referenciada por um projeto, reativação e restauração do padrão versionado sem reescrever histórico. Não há DELETE, API paralela, provider live, migration ou alteração do runtime do produto. PNGs são o resultado deste escopo; W29 não produz MP4 novo.

Pacote estimado em **até 3h de desenvolvimento**, com CI e revisão independente separados. Coordenação autorizada: Astra orquestra; Luna lê e revisa; Sol escreve; Astra revisa, integra, testa, valida e entrega.

## Implementação

- `tests/v2/public-project-api.integration.mjs` preserva todas as asserções anteriores de uma LUT; chama a prova W29 no final do baseline, antes da expiração/revogação terminal. O encerramento do Next aguarda estado terminal, com TERM/KILL limitados; cleanup falho reprova o teste e preserva erro primário.
- `tests/v2/helpers/workspace-lut-browser-proof.mjs` usa Postgres, API, FFmpeg e Chromium reais. Exige Chrome disponível, diretório fora do repositório, sessão válida, previews completos com src esperado, SHA dos bytes realmente recebidos pelo browser e nomes/versões corretos. Registra PNGs, capturas e manifesto sanitizado; cleanup possui limites e verifica o processo próprio terminal.
- `.github/workflows/ci.yml` executa a prova na suite pública já existente. Usa `application_name` específico e pool/timeouts limitados. Postflight exige zero backends e manifesto aprovado; valida SHA/run ID, hashes dos dois PNGs e existência das três capturas. Publica artifact sanitizado `w29-lut-<sha>-<run-id>-<attempt>`, incluindo postflight, mesmo em falha. Ausência de evidência reprova o job.

A sessão é `formUiSession`, obtida pelo `POST /v1/session` real do harness e confirmada por `GET /v1/session` imediatamente antes do browser. A outra sessão é encerrada pelo baseline; as tentativas inválidas posteriores ativam throttle. Um novo login tardio responderia 429, portanto não se limpa throttle nem se fabrica cookie. O contexto anônimo é separado e deve redirecionar `/brand` para `/login` sem biblioteca.

## Prova local observada

Run final: **`w29-api-final-70779de3`**, em `C:/Users/leand/Documents/Apollo/wave29-20261003/`. Bootstrap/migrations executados do zero em PostgreSQL descartável. Suite pública + segurança da sessão + OIDC HTTP: **4/4 testes, zero skips**, 24,33 s no runner Node; jornada pública 23,91 s.

- A: `public-api-lut-cinema`, versão 2, nome **Coração 🎞️ v2**; SHA PNG `d32da5f1287ab6a716294382216fd79d2a1a0eee2db4896c7db81636beb995a9`.
- B: `public-api-lut-contrast-w29`, versão 1; SHA PNG `74d09dd7b5895dd59f8256e8b44c9c0831deff8dd5acaf0b90aefa83aebd1c7e`.
- Ambos 512×288; **147.328 pixels diferentes**. Oracle independente da LUT inversa: **100% dos canais** satisfazem A+B=255 com tolerância de 2.
- A/B e B/A: zero requests mutáveis e contagens PostgreSQL idênticas para versões LUT/default/status, seleções, ProjectVersions e todos os Commands do projeto e workspace. Mobile 390×844: zero overflow horizontal.
- UI impede retirar o padrão. Após `none`, retirar a LUT original referenciada remove-a dos dois seletores e preserva integralmente as linhas v1/v2, previews e hashes, seleção e snapshot de ProjectVersion. Reativar preserva identidade/conteúdo. Restaurar padrão e recarregar confirma a versão 2 pela UI, API e PostgreSQL. Somente default/status aumentam duas revisões/linhas cada; nenhum DELETE.
- Regressões anteriores de 401, 404 cross-workspace, CAS obsoleto 409, import/replay, `.cube` inválido e histórico permanecem executadas; não há allowlist 403/404 ou relaxamento do baseline.
- Astra inspecionou dois PNGs e três capturas desktop/mobile: carta/inversa correspondem aos rótulos e seletores; nomes Unicode legíveis; previews sem recorte/overlay dos controles; mobile empilha ambas as referências. Essa revisão é técnica do desenvolvedor, sem substituir aceite do proprietário.
- Postflight: **18 identidades próprias encerradas**, zero backends, browser terminal, cluster parado, porta 55571 livre, scratch removido e zero erros. Manifesto do browser, supervisor `result.json` e `visual-review.json` ficam fora do build.

O guard de artifact foi exercitado separadamente com metadados de fixture explícitos: evidência válida passa; bytes PNG adulterados, captura vazia e browser não terminal falham. Isso testa a rejeição do guard, não é execução de CI hospedado.

## Correções e verificações

O CI da base, `37150091510`, falhou somente na declaração documental de suites não executadas. RED local reproduzido; sete entradas `KNOWN_UNRUN_SUITES.citedBy` passaram a citar o painel/auditoria gerados. Guard completo: 4/4, sem enfraquecer assertions nem declarar execução dessas suites.

A primeira jornada W29 passou (25,72 s) e encerrou processos/banco, mas a inspeção visual revelou um literal já corrompido na fixture v2. Check independente reproduziu RED; a fixture passou a usar `Coração 🎞️ v2`, e a nova prova exige esse Unicode. O run final acima passou após a correção. Não foi necessário corrigir código de produção.

Verificações locais: **2.603/2.603 unitários/contratos, zero skips**; 22/22 focados de LUT; 4/4 guard CI; typecheck, ESLint, arquitetura, linguagem de domínio, API pública (374 capabilities), DB V2 (293 tabelas), paridade UI/API, build e status consistentes. A primeira invocação unitária local usou Bash/WSL sem distro; selecionar Git Bash no PATH resolveu o ambiente, e os seis guards correspondentes e a suite inteira passaram. O primeiro build encontrou dependências Remotion locais ausentes; `npm ci --prefix remotion` corrigiu o ambiente e o build completo passou. Nenhum desses ajustes mudou dependências rastreadas.

## CI, rastreabilidade e entrega

O workflow exige o commit efetivo no manifesto. A conclusão hospedada deve ser conferida no run desse SHA e no artifact W29, com os dois jobs verdes e inspeção das capturas; a prova local acima não é apresentada como CI hospedado. A base anterior falhou e não é usada como aceite. O relatório privado `C:/Users/leand/Documents/Apollo/wave29-20261003/delivery.json` consolida o SHA/run/artifact quando a execução hospedada terminar.

`TODO.md`, PRD FR-181, Spec 07, traceability e `docs/quality/project-status.json` registram a validação técnica controlada. `docs/PROJECT-STATUS.md` é gerado por `npm run project:status -- --write` e verificado por `npm run project:status:check`. W29 e F2.026-open passam a **validado tecnicamente**, com implantação e aceite separados. F2.026 continua com a mesma caixa aberta; os demais gates, incluindo F3 live, não mudam.
