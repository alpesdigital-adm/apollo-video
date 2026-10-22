# ADR-160 — Nada é fixo: a política editorial vem do pedido de cada vídeo, e o silêncio do pedido tem uma regra nomeada

- **Estado:** aceito para implementação (fatias F0–F8; esta ADR acompanha F0–F2)
- **Data:** 2026-10-22
- **Contexto:** regra pétrea do dono, `AGENTS.md` ("Regra pétrea: nada é fixo, tudo vem do pedido de cada vídeo")
- **Relacionado:** [ADR-005](ADR-005-editplan-v2.md), [ADR-111](ADR-111-decision-specific-confidence.md), [ADR-155](ADR-155-one-renderable-plan-and-cut-only-materialization.md), `docs/specs/01-director-and-quality.md` §7.4, `docs/PRD-APOLLO-V2.md` FR-023

## Decisão do dono (22/10/2026), literal

- "nada é fixo, tudo deve vir do pedido de cada vídeo. isso deve ser uma regra pétrea do apollo."
- Briefing: "Pede um briefing, pode dar indicações do que é esperado no briefing para um video melhor.. mas aceita também briefing simples, como 'apenas corte os silencios' (e isso é um exemplo, não vá me trazer isso com default nem como recomendação)."
- Para interpretar o briefing, a IA é a **OpenAI**.
- Quando o briefing não fala de um assunto: **"Não inventa."** Nada que não foi pedido nem observado na fonte; cada escolha registra origem e motivo.
- Ordem: tudo antes da W70 (o teste final prova a regra).
- O conteúdo do teste pontual (as falas, datas e tempos do master da Imersão) só pode existir em `tests/`.

## Contexto

O inventário de 22/10/2026 encontrou, no produto, decisões editoriais que não vinham de nenhum pedido: zoom proibido por tipo literal (`automaticZoom: false`, `effectTracks: never[]`); abertura de 4 s protegida e exigida até no render; legenda de 32 caracteres no Diretor e 42 no corte; preset `clean-color` ignorando o override `subtitleStyle`; papéis narrativos atribuídos pela posição do clipe (`hook` no primeiro, `cta` no último); CTA visual sempre nos 3 s finais; layout `landscape-inset` com fundo desfocado sempre; locale `pt-BR` por omissão; e, na UI, objetivo, persona, oferta, tom e "Composição principal" pré-preenchidos.

Pior: a razão `decision-motion-none` do Diretor dizia "The owner requested a direct, natural tone" sem ler o briefing. O sistema atribuía ao dono uma intenção que o dono nunca escreveu. O briefing livre só era lido por uma regex de rótulos ("Público:", "Tom:"), e um briefing simples em prosa era **ignorado em silêncio**.

## Decisão

1. **O pedido é um valor.** `editorial-request/v1` reúne o briefing livre, campos estruturados opcionais, as remoções de fala pedidas (`requestedRemovals`, referências aos Commands `remove-spoken-content`), exceções por variante e a interpretação do briefing. Tem `requestHash`. Campo ausente é ausente.
2. **A IA propõe, a resolução decide.** `brief-interpretation/v1` (OpenAI, atrás da porta `BriefInterpreterModel`) devolve diretivas num vocabulário fechado ligado às capacidades reais do Apollo; cada diretiva cita o trecho do briefing; o que não é executável vai para `unsupported[]`, o que é ambíguo para `questions[]`. Briefing com texto e interpretação indisponível falha fechado.
3. **A política é derivada.** `resolveEditorialPolicies(request, mediaContext, outputSpec)` é pura e versionada (`editorial-policy-resolution/v1`). Cada política é `{ value, origin, rule, reason, evidenceRefs }`, com `origin` em `request-field | request-briefing | media-context | output-spec | workspace-policy | silence-rule`. O Diretor não contém valor editorial; consome a resolução.
4. **O silêncio tem uma regra: `minimal-intervention`.** Quando o pedido nada diz, não se inventa: nenhum movimento, abertura, reordenação, papel narrativo, overlay ou B-roll que o pedido não tenha pedido e a fonte não tenha mostrado. A resolução registra `silence-rule` / `minimal-intervention` e o motivo. Valores herdados das ondas anteriores que ainda não foram derivados do pedido são registrados com a regra `carried-planner-value`, sem atribuição ao dono, e entram numa baseline que só encolhe.
5. **A razão nasce da origem.** O texto de cada decisão do Diretor é gerado da origem da política que a sustenta; o texto fixo de `decision-motion-none` foi removido.
6. **Os gates verificam o pedido, não valores.** `director-quality-report/v5` tem `hardChecks` como lista `{ id, kind: 'request' | 'invariant', passed, policyRef, evidence }`. A admissão para o final exige v5, crítico `apollo-director-critic/v4` ou posterior, todas as checks aprovadas, `requestHash` igual ao do Brief Snapshot atual e `policyResolutionHash` igual ao snapshot selado no DirectorRun. v3 e v4 continuam legíveis e nunca são admitidos: exigem novo DirectorRun; aprovação antiga nunca é herdada em silêncio.
7. **Contrato público aditivo.** Os schemas públicos são imutáveis por ref: `director-quality-report` v5 entra como ref nova (`director-quality-report-read/v4`) e as anteriores ficam. As colunas Prisma são aditivas e anuláveis (`V2DirectorRun.policySnapshotId`, `V2DirectorRun.requestHash`); linhas antigas ficam nulas e não são admitidas no final.
8. **Guarda estrutural.** `tests/v2/editorial-literals.test.mjs` varre `src/` atrás de literais editoriais proibidos fora do módulo de resolução, contra uma baseline explícita de violações conhecidas. O teste falha se aparecer violação nova **e** se uma entrada da baseline deixar de existir (obriga a removê-la). Cada fatia remove as suas; ao final a baseline é vazia.

## Consequências

- Duas execuções do Diretor sobre a mesma mídia com pedidos diferentes produzem resoluções, e portanto planos, diferentes; um pedido silencioso produz resolução com origem e razão em todas as políticas.
- Um pedido que o Apollo não executa (por exemplo, movimento de câmera enquanto o renderer não executa efeitos) bloqueia o plano em vez de ser ignorado.
- Todo DirectorRun anterior a esta decisão perde a admissão ao final export até um novo run. É o custo explícito de não herdar aprovação antiga.
- O uso do OpenAI depende de chave válida (a chave local falhava com 401 `invalid_organization` desde 06/10/2026; chave nova pendente do dono). Até lá o interpretador é testado com modelo injetado e o caminho real fica atrás de opt-in. O nome do modelo vem de variável de ambiente sem default: é configuração de infraestrutura, não decisão editorial.

## Fatias

F0 documentos; F1 varredura de literais e domínio puro; F2 o Diretor grava a resolução, report v5, crítico v4, admissão e migração; F3 idioma e legenda; F4 movimento e abertura; F5 estrutura, CTA, layout e rubrica; F6 interpretador OpenAI e `revise-editorial-request`; F7 UI de criação de projeto; F8 Lotes. A ordem e o critério de cada uma estão em `docs/specs/01-director-and-quality.md` §7.4.
