# Evidência do gate MVP Core v1

## Contrato do gate

O gate `mvp-core/v1` exige AC-001 a AC-016, todos cobertos e aprovados
exclusivamente por evidência produzida pelo servidor. O relatório canônico exige:

- `approved=true`;
- `covered=16`, `passed=16` e `total=16`;
- todos os checks com `passed=true` e ao menos uma referência íntegra;
- `serverEvidenceOnly=true`;
- fingerprint e record hash SHA-256 persistidos;
- projetos primário, companion e duplicado distintos, no mesmo workspace;
- versões e hashes exatos informados pelo cliente externo.

A avaliação é operável por
`POST /v1/projects/{projectId}/mvp-core-gates` e consultável por
`GET /v1/projects/{projectId}/mvp-core-gates`. Ambas as rotas usam autenticação,
scopes, idempotência, precondição de versão e persistência PostgreSQL V2.

## Jornada E2E integral

A prova principal é
`tests/v2/mvp-core-full-journey.e2e.mjs`. Ela inicia o build de produção, usa um
cliente externo da API pública e um PostgreSQL isolado criado com as 54
migrations V2. A jornada:

1. cria workspace, cliente de API e projetos 9:16/16:9;
2. persiste master, transcript alinhado, direitos e assets;
3. remove pela API as falas “31 de janeiro”, “1 de fevereiro” e “dois dias”;
4. executa Director V2, seleção/rejeição de insert e edição manual;
5. prova split, trim, troca de B-roll, inspector e undo;
6. renderiza proxies reais com FFmpeg;
7. reconhece warnings e aprova o proxy;
8. força uma falha transitória real do executor, prova retry durável e fencing;
9. exporta finais H.264/AAC 9:16 e 16:9;
10. cria annotation e aplica patch em nova versão;
11. duplica o projeto por copy-on-write, sem copiar masters;
12. chama o gate pela API e exige 16/16.

Execução local aprovada em 2026-07-27:

- teste: `T-FR-222`;
- gate: `mvp-core-gate-f0e53b61-104a-492f-bdbe-7ce9a2c69623`;
- record hash:
  `dc23d7ba37a90d1e89d8d14f328bfaaba2dc4f99777b2b094d4a7458bbbc6bea`;
- report fingerprint:
  `123213174851c1bea773e9b351029ef73a3138cff3259960e3b4fad06a1c8511`;
- resultado: 16 critérios cobertos, 16 aprovados e zero evidência manual
  substituindo check automático.

## Mídia real e inspeção manual

| Saída | Especificação | Duração | Bytes | SHA-256 | True peak |
| --- | --- | ---: | ---: | --- | ---: |
| Primária | 1080×1920, 30 fps, H.264/AAC | 79,534s | 43.625.829 | `8d13f4495793f8fd619c21b94674c15088847c19d16805e9a7bdf7be693bc84b` | −1,5 dBTP |
| Companion | 1920×1080, 30 fps, H.264/AAC | 4,500s | 145.688 | `fa9f88e7d7fa7313c64044c2f14b5db8735f52854061b465ab26db5019c93966` | −2,0 dBTP |

O EditPlan final primário retém os ranges de fonte `0–1087`,
`1744–2597`, `2633–2723` e `2723–3079` frames. O terceiro range troca apenas
o vídeo pelo B-roll selecionado e mantém o áudio do master. As exclusões
auditadas são:

- 36,26–58,12s para “31 de janeiro” e “1 de fevereiro”;
- 86,58–87,76s para “dois dias”.

As legendas finais não contêm essas expressões. O plano possui três straight
cuts com fade de áudio de 24ms, `automaticZoom=false`, abertura protegida por
120 frames, foreground estático e safe regions distintas para rosto e legenda.

Foram inspecionados quadros na abertura, antes/depois dos dois cortes, entrada e
saída do B-roll e encerramento. A inspeção confirmou:

- nenhum punch-in ou zoom gratuito;
- rosto e olhos livres;
- legendas na faixa inferior segura;
- enquadramento estável;
- B-roll visível com áudio original preservado;
- composição person-free válida no companion 16:9;
- ausência de clipping depois do limiter de true peak.

Os arquivos e contact sheets locais ficam em
`.apollo/review/mvp-core-f1-051/` e são evidência de revisão, não artefatos
versionados do produto.

## Regressão do mesmo estado-fonte

- `npm test`: 480/480;
- `npm run typecheck`: aprovado;
- `npm run build`: aprovado;
- `npm run lint`: arquitetura V2-only/PostgreSQL/API-first aprovada;
- `npm run domain-language:validate`: aprovado;
- `npm run db:v2:validate`: 51 tabelas, 224 índices e 163 foreign keys;
- `npm run api:v1:validate`: 91 capabilities, 152 schemas, 179 examples e
  77 paths;
- integração PostgreSQL de asset selection: aprovada;
- integração PostgreSQL de duplicação copy-on-write: aprovada;
- integração PostgreSQL do gate MVP Core: aprovada;
- integração PostgreSQL de export final, retry, download e reconstrução:
  aprovada;
- integração FFmpeg multi-source, FPS fracionário e true peak: aprovada.

## Condição para contabilização

Esta evidência local torna o F1.051 candidato a deploy, mas não altera o
percentual oficial. As 17 caixas de F1.051 permanecem abertas até que o mesmo
commit seja migrado, implantado e revalidado em produção. Depois da prova de
produção, este documento deve registrar commit, versão implantada, health,
contratos públicos, migration state e gate 16/16 antes de atualizar o
`TODO.md`.
