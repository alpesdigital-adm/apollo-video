# Apollo Video v2 — Product Requirements Document

> **Status:** Draft consolidado para implementação  
> **Versão:** 1.2  
> **Data:** 12 de julho de 2026  
> **Responsável pelo produto:** Leandro / Alpes Digital  
> **Produto:** Apollo Video  
> **Natureza do documento:** PRD mestre, cobrindo visão final e entregas incrementais

### Alterações da versão 1.2

- API externa como contrato obrigatório e paritário para todas as capacidades operáveis.
- Autenticação por clientes de API, escopos, idempotência, concorrência e auditoria.
- Jobs assíncronos, webhooks/eventos e transferência segura de mídia.
- Contratos legíveis por máquinas e adapter MCP para agentes de IA e outras ferramentas.
- Spec 09 para API externa e automação.

### Alterações da versão 1.1

- Rubricas editoriais específicas por objetivo estratégico.
- Gramática editorial e regras de ritmo, B-roll e movimento.
- Sistema de aprendizado de preferências do workspace.
- Non-goals e limites explícitos do produto.
- Suíte de specs funcionais/técnicas derivadas.
- Matriz de rastreabilidade requisito → fase → dependência → aceite → teste.

---

## 1. Resumo executivo

Apollo Video v2 será uma plataforma de direção e edição de vídeos com IA capaz de receber materiais em diferentes estados de preparação — roteiro, áudio, vídeo bruto, múltiplas câmeras, lotes de takes, lives longas, vídeos publicados, depoimentos, imagens ou mídia sintética — e produzir automaticamente vídeos finalizados, revisáveis e reutilizáveis.

O produto não será apenas um gerador de cenas nem um editor tradicional com recursos de IA adicionados. Seu núcleo será um **Agente Diretor multimodal** que:

1. percebe e cataloga o material;
2. entende objetivo, mensagem, contexto e restrições;
3. define tratamento editorial e estratégia narrativa;
4. escolhe, cria ou transforma fontes;
5. compila um plano de edição determinístico;
6. renderiza um proxy;
7. assiste e critica o próprio resultado;
8. executa correções localizadas;
9. permite edição manual e comentários visuais;
10. gera outputs em múltiplos formatos, variantes e idiomas.

O Apollo v2 deverá atender dois grandes grupos de produção:

- **Distribuição de conteúdo:** descoberta, elevação de consciência e aquecimento.
- **Conversão:** captação de leads, venda, WhatsApp, agendamento e download de materiais.

O sistema será **IA-first, mas não IA-only**. O Diretor entrega uma primeira montagem completa, enquanto o usuário mantém controle manual sobre timeline, cenas, fontes, layouts, textos, legendas, formatos, cores, áudio e decisões específicas.

O Apollo atual não está em produção. Portanto, o v2 será reconstruído com um núcleo limpo no mesmo repositório, sem obrigação de manter a v1 operacional. Serão reaproveitados seletivamente componentes e aprendizados comprovados, especialmente Remotion, FFmpeg, timing, legendas, hardening de render e primitivas visuais.

---

## 2. Referências visuais aprovadas

As duas telas abaixo são referências obrigatórias de direção visual, densidade, hierarquia e experiência do produto final.

### 2.1 Editor e revisão

![Referência do editor Apollo v2](./assets/apollo-v2-editor-reference.png)

### 2.2 Workspace e projetos

![Referência do workspace Apollo v2](./assets/apollo-v2-workspace-reference.png)

### 2.3 Princípios visuais

- Interface desktop profissional e densa, sem aparência de landing page.
- Tema escuro grafite, superfícies em carvão, texto branco/cinza e destaque âmbar/dourado.
- Hierarquia clara entre workspace, mídia, preview, Diretor, timeline e revisão.
- Progressos, jobs, qualidade e falhas devem ser visíveis.
- A interface deve transmitir controle e confiabilidade, não “mágica opaca”.
- Ações de IA e ações manuais devem coexistir no mesmo fluxo.
- O produto deve parecer uma ferramenta de produção profissional, não um chatbot com preview.

---

## 3. Problema

Produzir vídeos de alta qualidade para anúncios e distribuição de conteúdo exige decisões que hoje dependem de um editor humano experiente:

- encontrar o melhor hook;
- cortar retakes, pausas e redundâncias;
- reorganizar a narrativa sem distorcer o sentido;
- combinar hooks, corpos e CTAs compatíveis;
- decidir quando manter o apresentador e quando usar B-roll;
- escolher provas, depoimentos e trechos de materiais antigos;
- criar quebras de padrão sem exagero;
- posicionar legendas, inserts e layouts sem cobrir elementos importantes;
- adaptar composição a formatos diferentes;
- avaliar materiais gerados por IA antes de usá-los;
- sincronizar câmeras, telas e áudios diferentes;
- preservar identidade, marca, direitos e integridade de claims;
- revisar o vídeo renderizado e corrigir problemas localizados.

O Apollo v1 automatiza parte da transcrição, análise, cenas, legendas e render, mas foi construído ao redor de um único vídeo bruto e de um pipeline linear. A visão v2 requer um domínio centrado em **workspaces, mídia reutilizável, segmentos semânticos, versões, receitas, jobs e planos editoriais**.

---

## 4. Visão do produto

### 4.1 Declaração de visão

> Transformar materiais audiovisuais brutos, fragmentados, antigos, longos ou sintéticos em produções editadas com intenção, qualidade e rastreabilidade, reduzindo o trabalho operacional sem retirar o controle editorial do usuário.

### 4.2 Resultado esperado

O usuário deverá conseguir:

- enviar apenas um vídeo bruto e receber um vídeo pronto;
- enviar roteiro + arquivos de hooks/corpos/CTAs e receber variações compatíveis;
- selecionar um vídeo já validado e reaproveitar somente seu hook;
- minerar depoimentos e provas para inserir em novas produções;
- extrair um conteúdo de dois minutos de uma live de duas horas;
- gerar apresentador sintético a partir de roteiro ou áudio;
- produzir apenas áudio + B-roll, sem pessoas;
- produzir personagem de IA + B-roll, sem pessoas reais;
- transformar cenas com IA conforme o plano do Diretor;
- trabalhar com múltiplas câmeras e captura de tela sincronizadas;
- exportar em múltiplas proporções e idiomas;
- revisar, anotar e editar manualmente;
- duplicar um projeto concluído e criar variações pontuais;
- reaproveitar qualquer mídia catalogada sem regeneração desnecessária.

---

## 5. Princípios de produto

### P-01 — A IA decide, o código garante

IA interpreta intenção, semântica, compatibilidade e qualidade. Código determinístico controla frames, ranges, timebases, limites, colisões, invalidação, persistência e render.

### P-02 — Áudio e vídeo são ativos, não arquivos descartáveis

Masters são imutáveis, derivados mantêm lineage e segmentos apontam para ranges. Nenhuma edição destrói a fonte original.

### P-03 — Estilo é consequência do tratamento

O usuário pode definir preferências, mas o Diretor deve inferir tratamento editorial, gramática visual, ritmo e densidade. Presets não substituem direção.

### P-04 — Gerar é mais caro que reutilizar

Antes de gerar imagem, vídeo, voz ou avatar, o Diretor consulta a biblioteca. Conteúdo aprovado e validado tem prioridade quando semanticamente adequado.

### P-05 — Não usar também é uma decisão válida

O Diretor pode decidir não inserir B-roll, transformação, música, prova ou branding quando isso não melhora o vídeo.

### P-06 — Qualidade exige ciclo fechado

Planejar e renderizar não basta. O sistema deve executar proxy → crítica → patch → nova avaliação antes do render final.

### P-07 — Toda decisão deve ser rastreável e reversível

Projetos, assets, segmentos, gerações, avaliações e renders possuem origem, versão, autor e dependências.

### P-08 — Automação não elimina edição manual

Usuário e Diretor operam sobre o mesmo modelo de Commands/Patches. Não haverá estado manual paralelo.

### P-09 — Segurança e integridade não são prompts frágeis

Consentimento, direitos, claims, guardrails e restrições são dados estruturados e gates determinísticos.

### P-10 — Arquitetura ampla, entrega incremental

Contratos devem prever a visão final, mas cada ciclo libera uma fatia vertical utilizável.

### P-11 — Toda capacidade operável é API-first

Tudo que o usuário pode criar, consultar, alterar, revisar, aprovar, renderizar, exportar ou administrar pela interface deve possuir contrato externo estável. Web App, agentes de IA e ferramentas de terceiros usam o mesmo domínio, Commands, políticas e estados; a API não expõe banco, storage interno nem atalhos capazes de contornar direitos, guardrails ou validações.

Autenticação não é exceção. Sign-in, leitura da sessão corrente e sign-out do usuário humano devem existir como endpoints versionados, documentados e testados; a tela de login é apenas um cliente desses endpoints. Clientes de automação não reutilizam senha nem cookie humano: recebem identidade `ApiClient`, credencial Bearer revogável e escopos próprios. Endpoints de sessão humana não são publicados como tools de agentes, para que senha não atravesse contexto de modelo.

---

## 6. Usuários e papéis

### 6.1 Operador/editor

- Cria projetos e lotes.
- Envia materiais.
- Revisa a montagem.
- Faz ajustes manuais e anotações.
- Aprova outputs.

### 6.2 Diretor/estrategista

- Define objetivo, oferta e briefing.
- Configura restrições de narrativa e marca.
- Avalia variações e qualidade.
- Duplica projetos e cria testes.

### 6.3 Administrador do workspace

- Configura Brand Kit e Guardrails.
- Gerencia perfis de apresentadores, vozes e consentimentos.
- Gerencia bibliotecas, direitos e providers.
- Define budgets e políticas.

### 6.4 Revisor

- Assiste ao preview.
- Cria anotações por frame, região ou cena.
- Compara versões.
- Aprova ou rejeita correções.

### 6.5 Integrador, agente externo ou ferramenta de automação

- Opera projetos, mídia, biblioteca, revisão, lotes, renders e configurações autorizadas por API.
- Descobre capabilities e schemas de forma legível por máquina.
- Acompanha operações longas por jobs, eventos e webhooks.
- Usa credenciais e escopos próprios, sem personificar usuário ou receber acesso implícito.
- Está sujeito aos mesmos guardrails, rights, budgets, protected elements e audit log da interface.

---

## 7. Escopo funcional

## 7.1 Workspace e dashboard

### FR-001 — Workspace

O sistema deve suportar workspaces isolados, cada um com projetos, bibliotecas, configurações, Brand Kit, Guardrails, perfis sintéticos e permissões.

### FR-002 — Dashboard de projetos

O dashboard deve exibir:

- projetos em produção;
- aguardando revisão;
- concluídos;
- falhas;
- arquivados;
- lotes e progresso agregado;
- formatos e idiomas;
- qualidade estimada;
- comentários pendentes;
- atividade recente;
- uso de armazenamento e fila.

### FR-003 — Busca e filtros

Busca por nome, campanha, objetivo, tags, pessoa, material, idioma, status e data.

### FR-004 — Ações rápidas

- Abrir.
- Revisar.
- Duplicar como variação.
- Arquivar.
- Excluir respeitando lineage e referências.
- Reprocessar etapa.

---

## 7.2 Criação de projeto e briefing

### FR-010 — Objetivo estratégico

O projeto deve aceitar uma seleção estruturada:

**Distribuição**

- descoberta;
- elevação de consciência;
- aquecimento.

**Conversão**

- captação de leads;
- venda;
- WhatsApp;
- agendamento;
- download de material.

### FR-011 — Ação desejada

Projetos de conversão devem poder registrar ação, destino, oferta e contexto.

### FR-012 — Briefing livre opcional

O usuário pode escrever um prompt livre com tom, duração, fontes obrigatórias, fontes proibidas, restrições, quantidade de variações, formatos e instruções editoriais.

O campo não é obrigatório.

### FR-013 — Brief Compiler

O texto livre deve ser compilado para uma interpretação estruturada contendo:

- intenção;
- duração;
- audiência;
- tom;
- ritmo;
- mustUse;
- mustAvoid;
- protectedRanges;
- permissões de reordenação;
- permissões de mídia sintética;
- formatos;
- quantidade de variações;
- assumptions;
- conflicts;
- confidence.

### FR-014 — Modo media-only

Na ausência de briefing livre, o Diretor deve continuar usando objetivo estruturado, perfil do workspace e inferência do material.

## 7.2.1 Rubricas por objetivo estratégico

O objetivo não é apenas metadata. Ele altera planejamento, escolha de cenas, crítico e definição de sucesso.

### Distribuição — descoberta

**Intenção:** interromper padrão e conquistar atenção de público ainda não familiarizado.

- Hook deve ser compreensível sem contexto prévio.
- Aparência deve ser nativa, evitando introdução institucional precoce.
- Uma ideia principal por vídeo.
- Curiosidade não pode depender de promessa enganosa.
- CTA, quando existir, deve ser leve e subordinado ao conteúdo.
- Crítico prioriza first-frame clarity, retenção inicial, novidade e naturalidade.

### Distribuição — elevação de consciência

**Intenção:** mudar a forma como o público interpreta um problema, mecanismo ou oportunidade.

- StoryPlan deve registrar crença inicial e crença desejada.
- Corpo deve apresentar mecanismo, contraste ou explicação causal.
- Provas servem para sustentar a nova interpretação, não apenas decorar.
- B-roll deve tornar ideias abstratas concretas.
- Crítico prioriza progressão lógica, clareza do mecanismo e mudança de crença.

### Distribuição — aquecimento

**Intenção:** aumentar familiaridade, confiança, identificação e autoridade.

- Pode preservar mais personalidade, contexto e bastidores.
- Depoimentos, histórias e provas de processo têm prioridade.
- Ritmo pode ser menos agressivo no corpo.
- Branding pode aparecer de forma contextual.
- Crítico prioriza autoridade, autenticidade, continuidade e valor percebido.

### Conversão — captação de leads

**Intenção:** levar a uma ação de cadastro.

- Promessa, mecanismo e próximo passo devem estar claros.
- O material/benefício oferecido deve corresponder ao CTA.
- Remover distrações na aproximação do CTA.
- Crítico prioriza clareza de troca, fricção percebida e correspondência anúncio-destino.

### Conversão — venda

**Intenção:** produzir decisão de compra.

- Estrutura preferencial: hook → problema/desejo → mecanismo → prova → objeção → oferta → CTA.
- Claims, condições e preços devem ter fonte explícita.
- Provas devem ser compatíveis com oferta, público e contexto.
- Urgência só pode ser usada quando sustentada.
- Crítico prioriza entendimento da oferta, credibilidade, objeções e clareza de compra.

### Conversão — WhatsApp

- A ação deve ser verbal e visualmente inequívoca.
- Não confundir mensagem, formulário ou link genérico.
- CTA deve explicar por que chamar e o que acontece depois.
- Handle e destino devem vir do projeto/workspace, nunca ser inventados.

### Conversão — agendamento

- Comunicar tipo de conversa, benefício e próximo passo.
- Evitar ambiguidade entre “falar”, “agendar” e “comprar”.
- Crítico verifica correspondência com agenda e elegibilidade quando houver.

### Conversão — download

- Nome, formato e benefício do material devem estar claros.
- Visual do material pode ser usado como prova concreta.
- CTA deve corresponder ao destino e não prometer conteúdo ausente.

### Regras comuns

- Um vídeo de distribuição não será reprovado por ausência de CTA forte.
- Um vídeo de conversão não será aprovado apenas por retenção ou estética.
- A rubrica aplicada deve ser salva no QualityReport.
- Projetos podem ter objetivo primário e secundário, mas um deles deve governar desempates.

---

## 7.3 Brand Kit, identidade e Guardrails

### FR-020 — Brand Kit opcional

O workspace pode armazenar:

- cores;
- logos e variantes;
- nome do profissional;
- nome da empresa;
- Instagram;
- YouTube;
- vinheta de abertura;
- vinheta de encerramento;
- transições;
- fontes;
- watermarks;
- templates de lower third e CTA.

### FR-021 — Override por projeto

Cada projeto terá `inherit`, `none` ou `custom`, além de overrides por elemento.

### FR-022 — Guardrails estruturados

O workspace deve permitir:

- mustDo;
- mustNotDo;
- prohibitedClaims;
- prohibitedTopics;
- requiredDisclaimers;
- syntheticMediaRules;
- evidenceRules;
- instruções adicionais livres.

### FR-023 — Precedência

Segurança do produto → direitos/consentimento → Guardrails do workspace → restrições do projeto → briefing → defaults → inferência.

### FR-024 — Policy Snapshot

Cada versão de projeto registra snapshot da política e do Brand Kit resolvidos.

---

## 7.4 Ingestão e fontes

### FR-030 — Tipos de entrada

O sistema deve aceitar:

- vídeo único;
- vários vídeos;
- áudio;
- roteiro/documento;
- lote de hooks/corpos/CTAs;
- múltiplas câmeras;
- captura de tela;
- react;
- vídeo publicado/validado;
- depoimento/prova;
- live/vídeo longo;
- imagem;
- assets de marca;
- mídia gerada externamente.

### FR-031 — Masters imutáveis

Toda fonte original deve ser armazenada sem sobrescrita.

### FR-032 — Content addressing e deduplicação

Checksums devem evitar duplicação física do mesmo ativo.

### FR-033 — Normalização com lineage

Normalização, proxy, áudio extraído, thumbnails e derivados devem apontar para o master.

### FR-034 — Preservação de timebase

PTS, timecode, frame rate, VFR e metadata original devem ser preservados antes de normalização, especialmente em sessões multicâmera.

### FR-035 — Direitos

Cada ativo deve registrar origem, autorização, escopo de uso, restrições e expiração opcional.

---

## 7.5 Biblioteca unificada de mídia

### FR-040 — Media Library

Biblioteca global por workspace, pesquisável e reutilizável.

### FR-041 — Tipos de ativos

- VideoAsset.
- AudioAsset.
- ImageAsset.
- DocumentAsset.
- SyntheticMasterAsset.
- GeneratedTransformationAsset.

### FR-042 — MediaSegment

Segmentos semânticos apontam para ranges dentro de masters, evitando milhares de arquivos recortados.

### FR-043 — SpeechSegment

Frases/reflexões completas com:

- exactText;
- normalizedText;
- word timings;
- source range;
- edit handles;
- standaloneScore;
- contextDependency;
- ator;
- roupa;
- fundo;
- emoção;
- expressão;
- enquadramento;
- cores;
- tópicos;
- função narrativa;
- qualidade;
- direitos;
- embedding.

### FR-044 — EvidenceSegment

Depoimentos e provas devem registrar:

- speaker;
- claim;
- resultado;
- contexto;
- qualifiers;
- oferta e objeções compatíveis;
- consentStatus;
- força e credibilidade;
- range original e handles.

### FR-045 — LongFormMoment

Momentos extraídos de vídeos longos com capítulo, assunto, resumo, citações, hookPotential, standaloneScore e embedding.

### FR-046 — ValidatedSegment

Hooks ou trechos publicados podem registrar validationScope:

- copy;
- spoken-take;
- opening-edit.

### FR-047 — Image Library

Imagens devem registrar:

- OCR com regiões e confiança;
- descrição curta e longa;
- objetos e entidades;
- pessoas autorizadas;
- atmosfera, emoção e estilo;
- cores predominantes;
- focal point;
- negative space;
- safe crops;
- função narrativa;
- qualidade;
- direitos;
- embedding;
- lineage de crops, outpainting e transformações.

### FR-048 — Busca híbrida

Filtros duros → busca textual/OCR → busca vetorial → reranking editorial → crítica visual.

### FR-049 — Catalogação automática

Toda mídia gerada ou aprovada deve poder entrar automaticamente na biblioteca.

---

## 7.6 Percepção multimodal

### FR-050 — PerceptionTimeline

Deve consolidar por timeline:

- transcrição word-level;
- falantes;
- blocos narrativos;
- frases fortes;
- áudio e energia;
- silêncios e retakes;
- shot boundaries;
- rosto, mãos, gesto e olhar;
- objetos e tela;
- movimento;
- ocupação e safe zones;
- qualidade técnica;
- timecode e disponibilidade de fontes.

### FR-051 — EditorialBeat

Unidade editorial independente de legenda. Pode abranger parte de uma legenda ou várias legendas.

### FR-052 — Confidence

Toda inferência relevante deve possuir confiança e evidências.

### FR-053 — Processamento hierárquico

Vídeos longos devem ser analisados em níveis: transcript → capítulos → momentos → candidatos → análise visual detalhada.

---

## 7.7 Agente Diretor

### FR-060 — TreatmentPlan

O Diretor deve criar plano contendo:

- narrativeMode;
- hookStrategy;
- energyCurve;
- visualGrammar;
- subtitlePolicy;
- brollPolicy;
- presenterPolicy;
- reorderPolicy;
- noveltyPolicy;
- colorPlan;
- audioDirection placeholder;
- confidence e assumptions.

### FR-061 — StoryPlan

Plano semântico independente de formato e idioma, incluindo tese, atos, blocos, dependências, provas, objeções e CTA.

### FR-062 — Alternativas de montagem

O Diretor pode avaliar montagem cronológica, cold open e reorganizada.

### FR-063 — Segurança narrativa

Reordenação não pode:

- fabricar afirmações;
- remover qualifiers relevantes;
- mudar causalidade;
- associar prova a oferta incompatível;
- mudar o sentido de depoimentos.

### FR-064 — Ferramentas do Diretor

O Diretor opera por tools/commands estruturados, não por acesso direto ao banco ou renderer.

### FR-065 — Decisions log

Cada decisão deve registrar motivo, evidência, confiança, versão e impacto.

### FR-066 — Budget

DirectorRun deve respeitar limites de custo, tempo, gerações, transformações e iterações.

## 7.7.1 Gramática editorial

As regras abaixo são defaults orientadores. O TreatmentPlan pode modificá-las, mas deve registrar a razão.

### Entrada e saída de B-roll

- O B-roll deve entrar em boundary semântico, gesto, pausa, palavra-chave ou mudança de energia.
- A entrada não deve cortar palavra, respiração expressiva ou reação relevante.
- A saída deve ocorrer quando a função do insert foi cumprida, não apenas quando termina o arquivo.
- Inserts devem possuir handles para transição e fallback.
- B-roll não pode permanecer depois de perder relação com a fala.
- Prova/documento deve ficar tempo suficiente para identificação; detalhe pode exigir zoom dirigido.
- O apresentador deve retornar em momentos de confiança, transição, oferta ou CTA quando o tratamento exigir presença.

### Movimento de câmera simulado

- `punch-in`: ênfase curta em palavra/claim/virada.
- `zoom-in`: aumento progressivo de tensão ou foco.
- `zoom-out`: alívio, conclusão ou abertura de contexto.
- `pan/tilt`: revelar informação espacial existente; nunca mover sem alvo.
- `parallax`: dar vida a still sem simular ação inexistente.
- Movimento deve respeitar face, texto, crop e formato.
- Nunca acumular movimento de base, transformação, legenda e transição em competição.

### Curva por ato

- Hook: alta densidade, mudanças rápidas e promessa clara.
- Corpo: ritmo adaptado à complexidade, alternando foco e respiro.
- Prova/virada: reforço visual e redução de ambiguidade.
- CTA: composição simplificada, hierarquia de ação e menor distração.

### Pattern-break budget

- O Diretor deve definir quantidade-alvo, intensidade e espaçamento mínimo.
- Repetir o mesmo recurso reduz seu valor e deve gerar penalidade.
- Quebra de padrão deve servir a compreensão, emoção ou retenção.
- Transformações generativas são recursos raros, não decoração padrão.

### Continuidade

- Cortes devem preservar direção de olhar, posição, energia e lógica espacial quando relevante.
- Mudanças bruscas de roupa/fundo/cor devem ser assumidas como recurso ou escondidas.
- Prova e depoimento precisam de setup mínimo para serem compreendidos.
- B-roll, cards ou tela podem esconder junções entre fontes, mas não mascarar distorção narrativa.

### Densidade adaptativa

- Não haverá cota universal fixa de ImageInsert ou movimento.
- O Diretor estima densidade a partir de objetivo, duração, energia, abstração e diversidade da fonte.
- Hard limits continuam existindo para legibilidade, colisão, repetição e custo.
- QualityReport deve explicar monotonia ou excesso com ranges concretos.

---

## 7.8 EditPlan v2 e timeline

### FR-070 — EditPlan versionado

Contrato central compilável e migrável.

### FR-071 — Tracks

O plano deve suportar:

- baseVideoTracks;
- alternateCameraTracks;
- overlayTracks;
- subtitleTracks;
- audioTracks;
- effectTracks;
- annotation references;
- output variants.

### FR-072 — Source ranges

Cada segmento deve mapear sourceStart/sourceEnd para timelineStart/timelineEnd em frames.

### FR-073 — Múltiplas fontes

Uma timeline pode montar segmentos de qualquer SourceAsset autorizado.

### FR-074 — Commands/Patches

Ações humanas e de IA devem usar o mesmo modelo de operações validadas.

### FR-075 — Protected elements

Usuário pode bloquear cena, range, asset, texto ou decisão para impedir alteração automática.

### FR-076 — Dependency graph

Alterações invalidam apenas derivados afetados.

Exemplos:

- legenda → render;
- LUT → derivado de cor + render;
- fala sintética → áudio + avatar do bloco + render;
- CTA existente → receita + render;
- novo formato → layout + render.

---

## 7.9 Produção em lote e variações

### FR-080 — ProductionBatch

Unidade raiz para lotes de fontes, roteiro, takes, receitas e outputs.

### FR-081 — Script alignment

Alinhar roteiro planejado com transcrição real e ranges dos takes.

### FR-082 — Biblioteca de takes

Classificar takes como hook, body, CTA, proof ou outros papéis.

### FR-083 — Compatibility graph

Compatibilidade deve considerar:

- promessa;
- ângulo;
- mecanismo;
- audiência;
- consciência;
- contexto;
- pronomes e conectores;
- tom;
- oferta;
- ação desejada;
- continuidade visual e sonora.

### FR-084 — VariantRecipe

Receita rastreável, por exemplo H4+B2+C1, com score, razões e lineage.

### FR-085 — Anti-explosão combinatória

Antes de executar, mostrar quantidade de receitas, outputs, custo estimado, reutilização e regras de seleção.

### FR-086 — Edição em lote

Aplicar alterações em múltiplas receitas/outputs com escopo explícito.

### FR-087 — Partial retry

Falha em um item não reinicia o lote.

---

## 7.10 Modos de produção

### FR-090 — Talking head

Pessoa real como fonte principal, com B-roll, inserts, legendas e layouts.

### FR-091 — Visual montage / voiceover

Áudio + B-roll sem apresentador. Deve permitir proibir qualquer pessoa real ou sintética na imagem.

### FR-092 — Synthetic presenter

Personagem IA + B-roll, sem pessoas reais quando configurado.

### FR-093 — Hybrid

Combinar pessoas reais, sintéticas, tela, provas, biblioteca e long-form.

### FR-094 — Music-led montage

Previsto no contrato, implementado posteriormente.

---

## 7.11 Synthetic Presenter

### FR-100 — Audio-first

Áudio é timeline-mestre. Entrada por texto/TTS ou áudio enviado.

### FR-101 — Adapters

VoiceProvider e AvatarProvider. Primeiros: ElevenLabs e HeyGen.

### FR-102 — Geração por blocos

Gerar hook, corpo, prova e CTA separadamente para retry e reutilização.

### FR-103 — SyntheticPresenterProfile

Avatar, voz, idioma, direção, dicionário de pronúncia, consentimento, usos permitidos e versão.

### FR-104 — SyntheticMasterAsset

Salvar sempre:

- output original do provider;
- normalizado;
- áudio separado;
- script;
- alinhamento;
- job/config;
- checksums;
- custo;
- consent snapshot.

### FR-105 — Cache

Hash de script + áudio + perfil + provider + config evita regeneração.

### FR-106 — Crítico sintético

Lip-sync, identidade, olhos, dentes, mãos, pronúncia, omissões, continuidade e artefatos.

---

## 7.12 Transformação generativa de cenas

### FR-110 — TransformationBrief

Deve conter source range, editorialIntent, mode, prompt, preserve rules, target, intensidade, duração e safe zones.

### FR-111 — Modos

- generated cutaway;
- background replacement;
- actor composite;
- video-to-video;
- camera motion;
- restyle.

### FR-112 — Provider Registry

Escolher adapter por capabilities, custo, qualidade e disponibilidade. Transporte pode ser API ou MCP.

### FR-113 — Jobs duráveis

MCP/API não são fonte de estado. Guardar providerJobId, status, retries e output.

### FR-114 — Novelty budget

Limitar quantidade, intensidade e proximidade de transformações.

### FR-115 — Fallback

Full v2v → actor composite → cutaway → still/parallax → nenhuma transformação.

### FR-116 — Crítico

Semântica, identidade, lip-sync, temporal consistency, anatomia, transições e safe areas.

---

## 7.13 Reaproveitamento de vídeos publicados

### FR-120 — Source Deconstruction

Extrair trecho essencial de material publicado/validado.

### FR-121 — Contaminação

Detectar legenda queimada, música mixada, watermark, overlays, transições e compressão.

### FR-122 — Limpeza MVP

Trim semântico, crop/reframe, cobertura simples e rejeição quando não houver qualidade.

### FR-123 — Limpeza avançada

Separação voz/música, inpainting, remoção de legenda e restauração em fase posterior.

### FR-124 — Validation envelope

O reuso de material historicamente validado deve representar separadamente
`copy`, `take`, `framing`, `timing` e `opening`. O conjunto protegido é derivado
do `validationScope` persistido, nunca declarado livremente pelo solicitante.

Mudar opcionalmente um aspecto protegido deve ser bloqueado de forma automática.
Quando a nova composição exigir a mudança, o sistema deve abrir uma decisão
humana explícita: rejeitar preserva a validação; aprovar registra que a
validação histórica foi perdida e quais aspectos saíram do envelope.

Para reutilizar um hook com corpo/prova/CTA novos, a composição deve referenciar
somente o range validado do hook e os ranges primários necessários da recipe
alvo. O hook, cold open e qualquer excesso da recipe alvo devem ser excluídos.
Plano, composição e decisions log são imutáveis, versionados, idempotentes,
vinculados aos hashes exatos das fontes e operáveis pela API pública.

---

## 7.14 Depoimentos, provas e long-form

### FR-130 — Proof need

O StoryPlan deve declarar a necessidade de prova sobre uma afirmação real de
um bloco narrativo, antes de escolher apresentação ou gerar qualquer asset. A
declaração contém:

- `storyBlockId`, `claimId` e texto exato da afirmação;
- classificação do claim (`outcome`, `quantified`, `mechanism` ou `low-risk`);
- tipo de prova derivado (`testimonial`, `data`, `demonstration` ou `none`);
- função editorial derivada: construir confiança, sustentar número, demonstrar
  mecanismo ou registrar que prova não é necessária;
- posição narrativa e temporal exata, vinculada ao StoryPlan e EditPlan da
  mesma `VariantRecipe`;
- auditoria da busca, resolução e evidência selecionada, quando existir.

Antes de qualquer fallback, o Diretor consulta `EvidenceSegments` compatíveis
no workspace/projeto, aplicando claim, categoria, contexto, oferta, objeção,
integridade, rights, consent e expiração. Somente um segmento autorizado e do
tipo requerido pode ser selecionado.

Se não houver evidência adequada, a saída obrigatória é
`proof-unavailable`. O Diretor não pode preencher a lacuna com estatística,
depoimento, inferência, texto ilustrativo ou card genérico fabricado. Claims de
baixo risco podem receber `no-proof-needed`, decisão distinta de ausência de
evidência.

As declarações fazem parte de um StoryPlan direcionado, são imutáveis,
versionadas e vinculadas aos hashes exatos da recipe e do StoryPlan base.
Criação, leitura e listagem devem existir na API externa; a interface consome
as mesmas rotas. A criação é idempotente, revalida recipe, evidência, rights e
consent no commit e não materializa mídia nem inicia provider/render.

Critérios de aceite:

- golden stories cobrem depoimento, dado, demonstração e nenhuma prova;
- o momento aponta para o bloco de prova existente ou para a fronteira exata
  depois do claim;
- candidato incompatível ou não autorizado nunca é selecionado;
- ausência fica explícita e pesquisável;
- `genericCardGenerated=false` e `genericCardCount=0` são invariantes de
  domínio e banco;
- replay converge; payload diferente com a mesma chave falha;
- API, PostgreSQL, interface e regressão provam o mesmo estado.

### FR-131 — Integrity gate

Toda prova selecionada por um `ProofNeed` deve passar por um gate imutável,
fail-closed e vinculado à `VariantRecipe` exata antes de ficar elegível para
montagem. O gate não escolhe um modo visual e não materializa mídia; ele decide
se o uso editorial proposto preserva a verdade, a autorização e o contexto da
evidência.

Para cada item, o gate compara:

- texto e identidade do claim da recipe com o claim do `EvidenceSegment`;
- produto/oferta da recipe com as ofertas compatíveis da evidência;
- pessoa ou sujeito declarados na recipe com o sujeito catalogado;
- período estruturado na recipe com um qualifier temporal explícito;
- todos os audience tags da recipe com os públicos autorizados da evidência;
- exigência de consentimento com o snapshot atualmente vigente;
- rights, expiração e identidade do snapshot atual;
- range de contexto e evidências adjacentes exigidos com o trecho que será
  efetivamente incluído na montagem.

Pessoa e período não podem ser inferidos de copy livre. A recipe deve
publicá-los em claims estruturados `integrity.person` e `integrity.period`.
Ausência desses campos bloqueia o uso e produz uma ação para completar o
contexto estruturado. Normalização pode remover diferenças superficiais de
caixa, acento e espaço, mas não pode aproximar semanticamente pessoas, períodos,
produtos ou claims distintos.

O resultado por item é `approved`, `blocked` ou `not-applicable`:

- `approved` exige oito comparações aprovadas, evidência selecionada,
  autorização atual e contexto integral;
- `blocked` impede montagem e contém issue hard, reason codes e ações
  permitidas;
- `not-applicable` existe somente para `no-proof-needed` e não autoriza inserir
  uma prova por conveniência.

Uma aprovação produz um presentation contract obrigatório. `attribution` e
todos os `qualifiers` do `EvidenceSegment` devem aparecer com conteúdo idêntico
nos modos visual e verbal; a etapa posterior pode escolher layout, duração e
modo de prova, mas não pode omitir nem reescrever esses campos. Range de
contexto e evidências adjacentes também seguem como precondições da montagem.

Issues bloqueantes só podem recomendar:

- completar o contexto estruturado da recipe;
- escolher outra evidência existente e compatível;
- restaurar o contexto original obrigatório;
- renovar rights ou consentimento.

O sistema nunca pode sugerir gerar, inventar, estimar ou reformular evidência
para contornar o gate. `fabricationSuggested=false` é invariante de domínio,
persistência, schema público e banco.

Cada execução deve persistir o `ProofNeed` hash, recipe hash, node/context
hashes, evidence hash, comparações, presentation contract, issue, ator,
timestamp, fingerprint e idempotency key. A transação serializável revalida
ator, recipe, ProofNeed, nodes, evidências e rights atuais antes do commit.
Mudança de qualquer identidade relevante falha por conflito ou produz nova
avaliação; uma aprovação antiga não libera montagem futura após expiração.

Criação, leitura e listagem devem existir na API externa. A UI usa apenas essas
rotas e mostra aprovação/bloqueio, as oito dimensões, atribuição, qualifiers e
ações corretivas. O gate é bounded, não inicia provider, render ou
materialização.

Critérios de aceite:

- policy eval inclui casos aprovados e falsos positivos/negativos críticos para
  claim, produto, pessoa, período, audience, consent, rights e contexto;
- prova incompatível, expirada ou descontextualizada nunca fica elegível;
- visual e verbal preservam attribution e qualifiers byte a byte;
- `proof-unavailable` bloqueia e `no-proof-needed` fica não aplicável;
- replay converge e payload diferente com a mesma chave falha;
- constraints rejeitam fabricação, aprovação incoerente e contagens
  adulteradas;
- API, PostgreSQL, UI e E2E observam o mesmo registro canônico;
- a contagem de artifacts permanece inalterada.

### FR-132 — Modos de prova

O MVP deve transformar somente avaliações `approved` de um
`ProofIntegrityRun` atual em uma matriz imutável `segmento × formato`. Cada
plano escolhe um dos três modos executáveis:

- `cutaway`: a evidência visual ocupa o canvas e substitui temporariamente o
  presenter;
- `split-screen`: presenter e evidência permanecem simultaneamente visíveis;
- `proof-card`: a prova é apresentada em layout tipográfico/estático com
  identificação e qualifiers.

Montage, prova conduzida apenas por áudio e proof-first/cold open continuam
como extensões futuras. Eles não podem ser aliases silenciosos dos três modos
do MVP.

Entradas obrigatórias:

- ID e hash exatos do `ProofIntegrityRun`, que precisa estar
  `readyForAssembly=true`;
- `ProofNeedRun` e item correspondentes;
- `EvidenceSegment` e artifact de origem atuais;
- tipo real da mídia: `video`, `image`, `audio` ou `document`;
- um a cinco formatos entre `9:16`, `16:9`, `4:5`, `1:1` e `21:9`;
- ritmo `fast` ou `measured`;
- overrides manuais opcionais, sempre vinculados a
  `proofNeedItemId + format + expectedEvaluationHash`.

Política automática inicial:

| Condição | Modo |
| --- | --- |
| mídia não visual | `proof-card` |
| contexto visual obrigatório | `split-screen` |
| mídia visual + ritmo rápido | `cutaway` |
| vídeo medido em 16:9/21:9 | `split-screen` |
| imagem medida | `proof-card` |
| demais vídeos medidos | `cutaway` |

`cutaway` e `split-screen` exigem vídeo ou imagem. `proof-card` não pode
substituir evidência marcada como `contextRequired`, pois isso removeria a
mídia/contexto que fundamentaram a aprovação. Override manual pode mudar a
preferência editorial, nunca relaxar essas invariantes.

Cada `ProofModePlan` deve persistir:

- evaluation, ProofNeed item, EvidenceSegment e artifact/hash exatos;
- texto exato da claim do ProofNeed, sem gerar copy genérica no proof-card;
- formato, ritmo, modo, origem automática/manual e reason codes;
- frame/milissegundo de entrada derivados do ProofNeed;
- context range integral e duração mínima/alvo/máxima;
- transições explícitas de entrada/saída e duração em frames;
- regiões em pixels para evidência, presenter, attribution e qualifiers;
- canvas, safe area, contraste mínimo, fonte mínima e limites de texto;
- o mesmo `ProofIntegrityPresentation` aprovado, sem reescrever attribution ou
  qualifiers;
- contrato do renderer `proof-presentation/v1`, sem materializar nova mídia
  durante o planejamento.

Layouts são determinísticos por modo e formato. Attribution e qualifiers ficam
sempre dentro da safe area, não se sobrepõem e permanecem visual e verbalmente
idênticos. Split-screen nunca sobrepõe presenter e evidência.

Criação, leitura e listagem devem existir na API externa. A UI consome somente
essas rotas, mostra preview proporcional ao canvas e permite override por
segmento/formato gerando um novo run imutável. Criação é bounded, idempotente,
serializável, não chama provider e não cria artifact.

Critérios de aceite:

- os 15 pares `cinco formatos × três modos` possuem visual golden e regiões
  válidas;
- seleção automática cobre mídia, formato, ritmo e contexto;
- override afeta somente o segmento/formato escolhido e rejeita evaluation
  stale;
- prova bloqueada, expirou ou perdeu rights não recebe plano;
- constraints rejeitam identificação ausente, modo/mídia incompatíveis e
  proof-card que remova contexto obrigatório;
- replay converge e payload diferente com a mesma chave falha;
- API, PostgreSQL e UI observam o mesmo run canônico;
- a contagem de media artifacts permanece inalterada;
- renderer deve comprovar visualmente as quinze combinações formato/modo e
  produzir MP4 real de cutaway, split-screen e proof-card antes de marcar o
  requisito como entregue.

### FR-133 — Long-form indexing

Lives e vídeos longos devem ser indexados por um workflow durável, retomável e
observável. O workflow possui exatamente cinco etapas ordenadas:

1. `probe`, para identidade técnica, duração e timebase;
2. `transcript`, para texto e alinhamento temporal;
3. `diarization`, para intervalos de speakers sem inventar identidades;
4. `chunks`, para partições virtuais sobrepostas e evidence spans;
5. `moments`, para capítulos, momentos, scores e índice pesquisável.

Cada etapa possui provider/model/version, dependências, input/output hash,
idempotency key estável, tentativa, orçamento, concorrência, custo, tempo,
contagem de resultados e checkpoint antes de liberar a etapa seguinte. Probe e
transcript já materializados pelo ingest podem ser reutilizados após conferência
dos hashes; reuso não cobra custo nem finge nova execução.

O workflow deve:

- executar em background por operação pública cancelável e retomável;
- persistir cada checkpoint antes de publicar o resultado;
- retomar do primeiro estágio incompleto depois de restart, sem duplicar
  segments, chunks ou moments;
- publicar transcript, chunks e moments incrementalmente com `status` e
  `searchable` explícitos;
- limitar custo, elapsed e concorrência tanto no run quanto em cada etapa;
- manter master imutável e materializar somente entidades virtuais/indexes;
- preservar source artifact, manifest, transcript, rights, consent, producer,
  hashes e time ranges em todo resultado;
- invalidar apenas a etapa cuja versão/input mudou e seus dependentes;
- expor create/list/read/retry/cancel e resultados parciais pela API `/v1`,
  usando os mesmos application services da UI;
- falhar fechado quando faltar diarização necessária, rights, consent,
  alinhamento, budget ou provider configurado.

Critérios de aceite:

- fixture de duas horas conclui dentro dos budgets publicados;
- uma interrupção após `chunks` retoma em `moments` com as mesmas identidades;
- polling durante o processamento encontra resultados parciais pesquisáveis;
- payload idempotente converge e payload divergente falha;
- PostgreSQL prova constraints, concorrência, restart e ausência de duplicatas;
- API, worker e UI observam o mesmo run;
- nenhum MP4 ou cópia do master é criado pela indexação.

### FR-134 — Contiguous extraction

Encontrar janela autocontida de duração-alvo.

### FR-135 — Editorial synthesis

Montar vários ranges preservando contexto e lineage.

### FR-136 — Repositório semântico

Busca cross-library por assunto, história, prova, objeção, frase, pessoa e função.

---

## 7.15 Multicâmera, tela e react

### FR-140 — CaptureSession

Agrupar tracks do mesmo evento.

### FR-141 — Session clock

Mapear cada fonte para relógio canônico.

### FR-142 — Estratégias de sync

Timecode → shared audio → fingerprint → transcript/visual/lip → Apollo Marker → manual anchors.

### FR-143 — TrackCoverage

Fontes podem começar depois, terminar antes, possuir gaps e múltiplos clips.

### FR-144 — Drift

Corrigir clock drift apenas em intervalos comuns; nunca esticar para igualar duração.

### FR-145 — Piecewise maps

Suportar stop/resume, VFR, pause/rewind de react e mapping não linear.

### FR-146 — Sync audio separado

Scratch audio pode servir para sync e ser descartado no mix final.

### FR-147 — Capture Protocol

Exibir pré-requisitos por cenário antes da gravação.

### FR-148 — Apollo Sync Marker

Flash/código visual + chirp sonoro, início e fim, repetido após restart.

### FR-149 — SyncDiagnostic

Método, confiança, offset, drift, coverage, warnings e necessidade de anchors.

### FR-150 — Direção multicâmera

Escolher ângulo por falante, expressão, tela relevante, reação, formato e ritmo.

---

## 7.16 Formatos e layout responsivo

### FR-160 — Formatos obrigatórios

- 9:16;
- 16:9;
- 4:5;
- 1:1;
- 21:9.

### FR-161 — OutputSpec

Aspect ratio separado de resolução, fps, codec, bitrate, safe area e delivery profile.

### FR-162 — Plano canônico e variantes

StoryPlan/EditorialTimeline compartilhados; FormatVariantPlan por output.

### FR-163 — Responsive placement

Coordenadas normalizadas, anchors, constraints, avoid zones e regras por formato.

### FR-164 — Reframe

Face/object tracking, contain/blur, layout alternativo, background extension/outpainting ou mídia específica.

### FR-165 — Crítica por formato

Cada output é validado individualmente.

---

## 7.17 Legendas

### FR-170 — Estilos iniciais

- kinetic;
- karaoke-box;
- karaoke-pill;
- caps-stroke;
- clean-color.

### FR-171 — Modos

Workspace default, Director auto, manual ou none.

### FR-172 — SubtitleStylePreset

Tipografia, casing, grouping, cadence, highlight, container, stroke, shadow, animação, placement e responsive overrides.

### FR-173 — Anchor por percepção

Evitar rosto, mãos, telas, CTAs e elementos relevantes.

### FR-174 — Override por segmento

Um estilo principal e exceções controladas para hook/CTA/depoimento.

### FR-175 — Sidecar

Prever export opcional SRT/VTT, além de legenda queimada.

---

## 7.18 Cor e LUTs

### FR-180 — ColorPipeline

Detectar metadata/HDR → normalizar/tone-map → correção técnica → match → LUT criativa → output transform.

### FR-181 — Workspace LUT Library

Arquivos .cube, nome, tags, intensidade, espaços de cor, compatibilidade, preview, licença e política de uso.

### FR-182 — ColorPlan

Plano global com correções por fonte e overrides por segmento.

### FR-183 — Multicam match

Igualar exposição, white balance, contraste, saturação e pele antes da LUT.

### FR-184 — Crítico de cor

Skin tones, clipping, blacks, saturation, mismatch, brand color drift e HDR/SDR.

---

## 7.19 Localização multi-idioma

### FR-190 — Conteúdo canônico

ScriptBlocks semânticos com sourceLocale.

### FR-191 — LocalizationVariant

Script localizado, áudio, alinhamento, legendas, lip-sync/avatar, EditPlan e outputs por locale.

### FR-192 — Timings próprios

Não reutilizar timestamps do idioma original.

### FR-193 — Modos de áudio

TTS/voice clone autorizado, voz local ou áudio traduzido enviado.

### FR-194 — LocaleProfile

Glossário, termos, pronúncia, tom, CTA, handles, disclosures, unidades, moeda, fontes, RTL e line breaking.

### FR-195 — Assets localizáveis

Detectar texto em cards, UI, documentos e B-roll; compartilhar somente assets adequados.

### FR-196 — Crítico de localização

Fidelidade, claims, naturalidade, pronúncia, lip-sync, legenda, CTA e disclosure.

---

## 7.20 Áudio, música e SFX — previsto para futuro

### FR-200 — Sync modes

- narrative-led;
- music-led;
- hybrid.

### FR-201 — AudioDirectionPlan

Beat grid, downbeats, bars, sections, energy curve, cue points, ducking e events.

### FR-202 — Sound Library

BPM, intensidade, atmosfera, attack, tail, loudness, função, direitos e embeddings.

### FR-203 — Sound budget

Evitar SFX repetitivos e excessivos.

### FR-204 — Mix/master

Ducking, fades, loudness target, limiter e proteção de fala.

### FR-205 — Crítico audiovisual

Masking, drift, repetition, clipping, tails, energia e CTA musical.

---

## 7.21 Revisão, anotações e edição manual

### FR-210 — Preview interativo

Pause, seek frame-accurate, seleção de cena e inspeção de tracks.

### FR-211 — ReviewAnnotation

Frame, range opcional, bbox normalizada, escopo, formato, scene/segment/layer, screenshot/crop, instrução, status e autor.

### FR-212 — Escopos

Point, region, scene, time-range ou project; current-format ou all-formats.

### FR-213 — RenderElementMap

Hit-test por frame para identificar legenda, B-roll, CTA, presenter, background e transformação.

### FR-214 — Patch automático

Diretor recebe anotação + imagem + contexto + plano e gera operação validada.

### FR-215 — Batch review

O operador pode selecionar de duas a cem annotations abertas da mesma `ProjectVersion` e compilar suas propostas prontas em um único `PatchSet`. Operações idênticas são deduplicadas; operações divergentes sobre o mesmo target produzem `conflictIds` simétricos e um resultado por annotation.

O modo padrão é `all-or-nothing`: qualquer conflito impede o patch e marca todos os itens como `rolled-back`, sem criar Command, snapshot ou versão. `partial-retry` só existe por escolha explícita e inclui apenas annotations sem conflito, preservando as demais abertas e `retryable`.

A confirmação cria um único Command `apply-review-patch-batch`, um snapshot de EditPlan e uma ProjectVersion filha dentro de transação serializável. O payload v2 inclui `command-impact/v1` frame-first para todas as operações incluídas, preserva ranges disjuntos canônicos quando o mapping intermediário não muda e registra relações stale apenas para outputs concluídos das variants abrangidas. A API, a UI e agentes usam o mesmo application service; o proxy da versão resultante é uma operação durável associada ao lote. Idempotência, optimistic concurrency, fencing dos outputs-base, protected/policy/budget gates herdados das propostas e rollback total em falha intermediária são obrigatórios.

### FR-216 — Edição manual

Trim, split, reorder, fontes, câmeras, layouts, crop, posição, tamanho, texto, legenda, cor, LUT, áudio e formato.

A timeline manual não mantém um estado paralelo ao Diretor. A leitura parte do `EditPlan v2` compilado da `ProjectVersion` corrente e expõe `versionId`, `baseHash`, `revision`, clips, tracks e pontos de snap. Seleção permanece responsiva no cliente; todo gesto que muda conteúdo é enviado pela API como Command `manual-edit`, com `scope` explícito de projeto, variante e target.

O MVP deve materializar `trim`, `split`, `move/reorder`, `replace`, `crop` normalizado por clip/formato e alterações pelo inspector. Crop é persistido no `EditPlan`, visível na timeline e realmente consumido pelos renders proxy/final; não é alias textual de layout nem estado local. O inspector possui campos tipados para layout, texto, preset de legenda, cor/LUT, movimento e ganho de áudio. Campos ainda não consumidos por um renderer posterior continuam dentro do EditPlan e de sua lineage, nunca em estado local não auditável. Snapping usa tolerância inicial de 120 ms e o servidor recalcula ranges e continuidade em frames.

Cada mutação exige `baseVersionId`, `baseHash`, `expectedRevision` e `Idempotency-Key`. O commit serializável cria exatamente um `V2EditCommand`, um snapshot de EditPlan, uma ProjectVersion filha e um evento de outbox. A mudança de `currentVersionId` usa compare-and-swap; base stale produz `VERSION_CONFLICT` e nenhuma escrita parcial.

Undo e redo também são Commands `manual-edit`. Undo restaura o snapshot compilado do pai direto em uma nova versão filha; redo restaura uma versão indicada e pertencente ao mesmo projeto, igualmente em uma nova versão. Nenhuma operação apaga versões, snapshots, Commands ou lineage. A resposta retorna comparação antes/depois e enfileira o proxy correspondente à nova versão.

A superfície pública mínima é:

- `GET /v1/projects/{projectId}/timeline`, para timeline, snap points e histórico imutável;
- `POST /v1/projects/{projectId}/manual-edits`, para apply, undo e redo;
- os mesmos application services para UI, agentes e integrações externas.

Os fluxos principais devem funcionar por mouse e teclado: clique seleciona, drag reordena, `S` divide no playhead, `Delete` apara até o playhead, `Ctrl/Cmd+Z` desfaz e `Ctrl/Cmd+Shift+Z` refaz. O E2E precisa provar resposta visual, Command persistida, versão filha, optimistic concurrency, replay idempotente e novo proxy.

### FR-217 — Compare

O editor deve comparar duas `ProjectVersion` imutáveis do mesmo projeto sem reconstruir estado por heurística e sem alterar nenhuma delas. A comparação parte dos respectivos snapshots de `EditPlan v2`, calcula duração em tempo editorial, identidade de mapping de sincronização, score, issues e diff semântico limitado. A experiência principal não apresenta JSON bruto.

Modos visuais obrigatórios:

- **toggle:** alterna A/B preservando a posição de revisão;
- **split:** apresenta os dois proxies lado a lado;
- **overlay:** sobrepõe os proxies com opacidade controlável.

O playhead só pode ser compartilhado quando ambas as versões declaram o mesmo mapping de sincronização. Na ausência ou divergência do mapping, os players permanecem independentes e a UI deve dizer isso explicitamente; o sistema não pode fingir alinhamento porque as durações são semelhantes. Versões de durações diferentes continuam comparáveis e exibem o delta exato em milissegundos.

O painel deve mostrar:

- IDs e sequências das versões;
- duração antes/depois e delta;
- score antes/depois e delta;
- issues novas e resolvidas;
- mudanças semânticas de timeline, source, inspector visual, composição, legendas e duração;
- disponibilidade de proxy de cada lado.

As ações são explícitas e API-first:

- `accept` registra um Command `compare-action` na versão corrente e mantém o projeto em revisão;
- `reopen` registra um Command `compare-action` e move o projeto para revisão editorial;
- `restore` copia o snapshot escolhido para um novo `EditPlan` e uma nova `ProjectVersion` filha, registra `restoresVersionId` e enfileira um proxy.

Aceitar ou reabrir exige que o lado “depois” ainda seja a versão corrente. Todas as ações exigem `baseVersionId`, `baseHash`, `expectedRevision` e `Idempotency-Key`; concorrência stale falha com `VERSION_CONFLICT`. Restore nunca reativa ou sobrescreve a linha histórica: A, B e a nova versão restaurada permanecem consultáveis.

Contrato público:

- `GET /v1/projects/{projectId}/version-comparisons?beforeVersionId=&afterVersionId=&mode=`;
- `POST /v1/projects/{projectId}/version-comparisons`.

Critérios de aceite:

1. toggle, split e overlay usam proxies ligados às versões declaradas;
2. mapping igual compartilha playhead; mapping ausente/divergente não compartilha;
3. delta de duração de versões desiguais é exato;
4. diff semântico e issues/scores aparecem antes da decisão;
5. accept/reopen são Commands auditáveis;
6. restore cria uma versão filha e não apaga nenhuma versão;
7. UI e API chamam os mesmos application services;
8. E2E cobre PostgreSQL, API HTTP e navegador real com versões de durações diferentes.

### FR-218 — Mask future

Região anotada poderá servir como máscara para inpainting/transformação.

## 7.21.1 Aprendizado de preferências

O sistema deve aprender com correções sem transformar qualquer edição pontual em regra global.

### Tipos de feedback

- **Project override:** vale apenas para a versão/projeto.
- **Workspace preference:** padrão recorrente e contextual.
- **Workspace guardrail:** regra forte, explícita e auditável.
- **Negative preference:** solução que deve ser evitada em contextos semelhantes.
- **Exception:** decisão deliberada que não altera o padrão.

### Fluxo

```text
Correção do usuário
→ identificar decisão original e contexto
→ classificar tipo de feedback
→ aplicar ao projeto
→ sugerir promoção para preferência quando recorrente
→ registrar evidência, escopo e confiança
```

### Regras

- A IA não promove automaticamente uma correção isolada a Guardrail.
- Preferência deve registrar condições: objetivo, formato, apresentador, estilo e tipo de cena.
- Usuário pode visualizar, editar, desativar e excluir preferências aprendidas.
- Conflitos usam a precedência definida em FR-023.
- DirectorRun deve informar quais preferências influenciaram o plano.
- Métrica de sucesso: redução de correções repetidas no mesmo workspace.

---

## 7.22 Versionamento, duplicação e lineage

### FR-220 — ProjectVersion

Snapshots imutáveis de brief, treatment, story, plans, configs e policy snapshot.

### FR-221 — Fork copy-on-write

Duplicar projeto sem duplicar masters.

### FR-222 — Isolamento

Fork não altera original; aprovação, publicação e métricas não são copiadas.

### FR-223 — Diff e restore

Comparar e restaurar versões.

### FR-224 — Artifact lineage

Todo render aponta para inputs, segmentos, providers, prompts, configs, avaliações e planos.

---

## 7.23 Render, export e jobs

### FR-230 — Proxy first

O workflow deve materializar uma cópia de revisão antes de permitir qualquer
render final. O proxy é uma saída version-bound: identifica exatamente
`ProjectVersion`, `EditPlan`, source, operação, artifact e manifest que o
produziram. Uma saída antiga, sem laudo ou pertencente a outra versão nunca
autoriza o final.

O contrato inicial de proxy usa H.264/MP4 e resolução proporcional ao formato:
540×960 em 9:16, 960×540 em 16:9, 640×800 em 4:5, 720×720 em 1:1 e 1050×450 em
21:9. Cada laudo publica uma `rangeCacheKey` canônica para reaproveitamento de
ranges imutáveis sem confundir versões, fontes ou formatos.

Depois da gravação do artifact e do manifest, o workflow executa validadores de
codec, container, resolução, duração, canvas e identidade do
`RenderElementMap`. Em seguida agrega a crítica editorial localizada, incluindo
range temporal e target quando disponíveis. Conflito de legenda com região
facial protegida é hard issue; saída da área segura é warning.

O estado do laudo é fechado:

- `blocked`: contém hard issue e `finalAllowed=false`; não há ação humana capaz
  de ignorar o bloqueio;
- `warning-ack-required`: não há hard issue, mas existe warning ainda não
  reconhecido; `finalAllowed=false`;
- `ready-for-final`: não há issue pendente ou um operador registrou
  conscientemente as ressalvas; `finalAllowed=true`.

O reconhecimento de warnings é uma decisão append-only, idempotente e protegida
por `reviewHash` + `revision`. Toda divergência concorrente falha fechada. API e
interface consultam o mesmo laudo persistido; a interface não pode habilitar a
exportação por estado local. A medição `timeToFirstProxyMs` usa o timestamp real
de recebimento do upload e o término efetivo do render, nunca um cronômetro
simulado no cliente.

Critérios de aceite:

1. o worker persiste o laudo somente depois de artifact, manifest e
   `RenderElementMap` convergirem;
2. o repositório de export final exige laudo `ready-for-final` da versão exata;
3. `GET /v1/projects/{projectId}/proxy-reviews` expõe o laudo com
   `projects:read`;
4. `POST /v1/projects/{projectId}/proxy-reviews` registra
   `acknowledge-warnings` com `projects:approve`, `Idempotency-Key`,
   `baseRevision` e `expectedRevision`;
5. teste E2E deve cobrir migração limpa, PostgreSQL, Bearer API, sessão humana,
   interface, replay idempotente e rejeição de decisão stale.

### FR-231 — Final render

Render por outputSpec/locale/variant.

### FR-232 — Durable jobs

Estado persistente, idempotência, retry, cancelamento, heartbeat, timeout e resume.

### FR-233 — Partial invalidation

Renderizar somente o que ficou stale.

Estado parcial auditado: `manual-edit` já materializa relações stale
version-scoped somente para outputs proxy/final afetados, sem alterar a
disponibilidade global dos bytes históricos. O worker de proxy deriva um range
persistido, recompõe esse trecho e reutiliza as partes válidas do proxy-base; a
conclusão registra uma resolução imutável, e a relação deixa de ser stale ativa
somente quando a operação substituta chega a `succeeded`. Seleção sem mudança
de render reutiliza o proxy concluído da versão-base como cache hit observável,
sem renderer nem novo artifact, e registra a operação de origem no Postgres. A
troca de transcript fonte também é explícita: `replace-source-transcript`
seleciona uma transcrição imutável por ID/hash, retima o alinhamento sobre o
áudio corrente com a mesma aritmética frame-first de rate `[0.25, 4]` do
renderer e cria nova versão. A ordem da timeline prevalece sobre a cronologia
do source e cada ocorrência repetida conserva sua própria evidência. Como toda
a cadeia editorial depende dessa
evidência, todos os outputs concluídos da base ficam stale e render permanece
bloqueado até um novo `run-director`; o Diretor resolve o transcript escolhido
pelo EditPlan, não o registro mais recente por data. A
remoção de conteúdo falado também possui impacto persistido: como recompila o
EditPlan completo a partir do transcript alinhado, `remove-spoken-content`
invalida full-timeline somente nos outputs concluídos da base, declara um proxy
integral do formato corrente e o enfileira pelo application service durável
usado pela API. Sem output-base não existe relação stale fabricada. A
execução do Diretor segue o mesmo modelo: `director-run-impact/v1` vincula o
Command ao transcript, às versões de planner/critic e às snapshots persistidas,
declara dependências de áudio/conteúdo/policy/timing/visual, invalida somente os
outputs concluídos da versão-base e solicita um proxy integral da nova direção.
O conjunto é relido no commit serializável; replay reidrata e compara payload e
linhas normalizadas. Sem output-base o proxy ainda é necessário, mas nenhuma
relação stale é inventada. A capability pública devolve impacto, invalidations
e a operação durável resultante. `set-project-lut-selection` segue o mesmo
modelo no contrato público v2: a escolha exata da receita de cor entra no
Command, `project-lut-selection-impact/v1` declara dependência visual e, quando
já existe timeline, invalida full-timeline somente nos outputs concluídos da
base e enfileira um proxy da versão-resultado. Antes do ingest, a seleção ainda
é versionada, mas o impacto fica `renderDeferredUntilTimeline` com ranges,
artifacts, invalidations e renders mínimos vazios; nenhuma duração é fabricada.
`compare-action` fecha a lista pelo outro extremo: aceitar ou reabrir uma
comparação é `no-render` e mesmo assim persiste
`compare-action-impact/v1` content-addressed, com `resultVersionId` igual ao
`baseVersionId` — a versão comparada é preservada, não substituída —,
`changeKinds=[review-state]`, todas as listas vazias e
`renderSemanticsChanged=false`. Nenhuma invalidation é gravada, nenhum render é
enfileirado e o evento declara `commandImpactHash` com
`artifactInvalidationCount=0`. O registro
`edit-command-registry.ts` é o gate que sustenta essa lista: cada Command
persistível declara render policy, schema de impacto e a evidência em código que
prova a classificação, e `createEditCommand` recusa tipo não registrado. Um
Command futuro sem política não chega ao banco.
A
operação manual `crop` persiste um retângulo normalizado dentro do clip e do
formato declarados, produz dependência somente visual e um único range mínimo;
o FFmpeg aplica esse crop antes da composição e o `RenderElementMap` reflete os
bounds resultantes. Prefixo e sufixo permanecem vindos do proxy-base. A
edição manual de texto de legenda materializa o cue no `EditPlan`, calcula o
range stale pelos frames do cue realmente alterado e recompõe apenas esse
intervalo; o renderer recebe o texto novo no mesmo input materializado. A
troca manual por B-roll também passa pelo `replace` comum: o clip novo mantém
os frames de áudio do master, o impacto limita o range do clip e o proxy
reutiliza os trechos vizinhos válidos. O executor parcial aceita até oito
ranges stale canônicos e disjuntos, intercalando trechos re-renderizados com o
proxy-base. Overlap/adjacência são fundidos; excesso, cobertura integral ou
forma inválida fazem fallback para render completo. Clips retimados usam a
timeline frame-first, rate `[0.25, 4]`, `setpts`/`atempo` e limites absolutos
arredondados sem acumular drift; reverse é rejeitado. Suporte multi-range não
autoriza subinvalidação: `move` e outros gestos que deslocam timing preservam
um envelope contínuo até o fim, pois os clips intermediários mudam de mapping. A
aplicação confirmada de review patch também persiste esse mapa: converte o
escopo temporal humano para frames, fenceia outputs da base, grava stale
atomicamente e expõe impacto/invalidações na capability pública v2 antes de
enfileirar o proxy reutilizável. A jornada golden local já combina transcript
substituído, snapshot persistível, Diretor e FFmpeg real com rates `1`, `2` e
`0.5`, 240 frames exatos, áudio e legendas retimadas. A entrega permanece
aberta até a mesma semântica cobrir todos os Commands e ranges e a jornada
integrada ser executada em PostgreSQL, implantada e aceita.

### FR-234 — Props/manifest

Salvar props e manifest reproduzíveis.

Todo recurso consumido pelo renderer — vídeo, áudio, imagem, fonte, LUT ou dado
auxiliar — possui identidade imutável, checksum, tamanho, rights/policy e
location materializada antes do início do render. Fontes e dados auxiliares são
artifacts tipados; LUTs são reconstruídas por versão/intensidade. Locations
locais ou assinadas existem apenas na lease interna e nunca alteram o hash
portátil nem aparecem na API.

No manifest reconstruível, a lista ordenada de sources deve corresponder
exatamente aos assets não-LUT do RenderInput por canonical key, checksum e
role. Nenhum recurso de mídia, fonte ou dado pode influenciar o render sem uma
edge de lineage; LUT mantém vínculo próprio por versão e intensidade.

O schema de props referencia fontes e dados por asset ID portátil, nunca por
location. Depois da materialização autorizada, o compiler resolve a fonte para
uma família interna fixa e interpreta dado auxiliar somente pelo schema fechado
e versionado `apollo-video-render-data/v1`. O worker deve reler tamanho e
checksum dos bytes antes da compilação; URI inválida, propriedade extra,
override concorrente ou mudança de identidade bloqueia o render. O renderer
aguarda o carregamento da fonte antes do primeiro frame.

Reconstrução deve partir do manifest e payload protegido efetivamente salvos.
Uma nova autorização relê rights e identidades atuais, materializa os bytes e
entrega ao renderer o mesmo input portátil; nenhum caller pode remontar props.
Reexecuções da mesma identidade devem manter canvas, fps, timeline e conteúdo
decodificado dentro do golden definido para o renderer fixado.

### FR-235 — Export matrix

Variantes × formatos × idiomas com preflight de volume/custo.

### FR-236 — Estados

Draft, ingesting, perceiving, planning, generating, reviewing-assets, rendering-proxy, reviewing-proxy, revising, rendering-final, completed, failed, canceled, archived.

Estado técnico e estado visível são contratos distintos. A API expõe uma
projeção versionada com label semântica, tone, progresso determinado somente
quando existe denominador real, estado indeterminado explícito, ação primária,
ações permitidas e terminalidade. `waiting` preserva attempt e checkpoint e só
pode retomar na mesma fase ou adiante. A entrada em espera exige a lease ativa
e a libera; a retomada cerca workspace, estado e attempt e instala uma nova
lease atomicamente sem incrementar a tentativa. Artifact disponível não se torna
globalmente stale: stale é relação da versão/variant de saída.

A leitura pública dessa relação declara `availabilityEffect: none`: o estado
visível `stale-output` oferece reconstrução para a versão nova e abertura do
resultado histórico. Uma resolução bem-sucedida remove a relação pendente; ela
não altera nem apaga o artifact que continua válido para sua versão de origem.

O lifecycle global do artifact é um enum separado e fechado: `available`,
`quarantined` ou `deleted`. Sua projeção não possui percentual, pois não é um
job. Available abre o resultado, quarantined exige inspeção e deleted preserva
somente a ação de histórico; qualquer estado desconhecido falha fechado.

Transições desse lifecycle são comandos públicos auditáveis e cercados por uma
revisão monotônica própria, distinta de rights e de ProjectVersion. Available e
quarantined podem alternar ou chegar a deleted; deleted é terminal, salvo a
repetição convergente do próprio estado. Cada comando exige motivo e
Idempotency-Key, rejeita revisão obsoleta e grava o antes/depois. Deleted é um
tombstone lógico sujeito à retention policy: a transição não remove bytes.

Em lote, o progresso visível é derivado exclusivamente dos steps persistidos.
Falha de um item não transforma itens concluídos em falha nem apresenta o lote
como concluído: a projeção distingue `partially-failed`, preserva resultados
válidos e oferece retry apenas para as falhas elegíveis.

As 14 fases persistidas de Project também formam um enum fechado. Sua projeção
mantém o mesmo label da fase técnica, usa progresso indeterminado durante
processamento, ação de revisão nas duas fases de review e 100% somente em
`completed`; `failed`, `canceled` e `archived` são terminais sem inventar
percentual. Create/list e as duas leituras de workspace expõem esse contrato de
forma aditiva; operações aninhadas no workspace usam a mesma projeção das
capabilities de operações. Dashboard, sala de lotes e editor consomem essa
projeção para label, tone, ação, terminalidade, polling e bloqueios; não mantêm
uma segunda tabela de tradução a partir do status técnico. A matriz canônica de Project permite somente os
avanços e retornos editoriais declarados, repetição convergente e terminais
sem saída; os writers atuais cercam a transição no próprio update persistido.
E2E visual/browser, estado/transições de versão e artifact, E2E PostgreSQL, deploy e aceite
continuam pendentes.

ProjectVersion não recebe lifecycle mutável. `current` é derivado pela igualdade
com `Project.currentVersionId`; todas as demais versões são `superseded`. Na
revisão, a versão atual abre o resultado, enquanto a histórica só oferece abrir
preview quando um artifact realmente existe, ou inspecionar histórico quando
não existe. Create v4, duplicate v2 e workspace v7 também expõem a versão
corrente com essa projeção. Commands v7/result v6 faz o mesmo para remove,
Director e transcript replacement; manual edit v3 cobre apply, undo, redo e
restore. Patch individual e batch v3 usam a mesma projeção; LUT selection
read/set v3 cobre seleção renderable e deferred. Comparison action v4 projeta
somente a nova versão de restore; accept/reopen continuam preservando versões.

---

## 7.24 API externa e automação

### FR-240 — Paridade API-first

Toda capacidade operável pela interface deve estar disponível por API externa versionada usando os mesmos Commands, queries, policies e state machines. Recursos puramente internos — tabelas, filas, storage keys, prompts privados e primitives do renderer — não são API pública.

Critérios adicionais de paridade:

- login, consulta de sessão e logout possuem capability IDs e operações OpenAPI;
- a GUI não chama rota privada, action server-only ou acesso direto ao banco para autenticar;
- uma operação da UI sem capability pública e contract test bloqueia o release;
- endpoints de sessão humana podem ser consumidos por um cliente HTTP que preserve cookies, enquanto integrações não humanas usam Bearer de service account.

Evidência executável F0.034: o relatório versionado `ui-capability-parity-report/v1` deriva do AST da UI e do registry canônico, relaciona 73 call sites a 66 capabilities/endpoints e aos Application services alcançáveis e cobre as 189 capabilities públicas. Seis superfícies estritamente internas possuem allowlist tipada e justificativa; exceções textuais livres são recusadas. Os gates `api:v1:validate` e `api:parity:validate` bloqueiam capability externa sem contrato, interna sem justificativa, ação da UI sem binding, rota divergente ou drift do relatório. O run hospedado `30812924567` aprovou a matriz completa com zero lacunas.

### FR-241 — Contrato público e descoberta

A API deve publicar OpenAPI e JSON Schemas versionados, IDs estáveis, enums, paginação, filtros, erros estruturados, exemplos e capability discovery. Alteração incompatível exige nova versão e janela de depreciação.

Evidência executável F0.035: `public-api/conventions.ts` define `/v1`, JSON UTF-8 fechado, IDs opacos, RFC 3339 UTC, frames inteiros semiabertos, cursor estável e filtros allowlisted. O registry é a fonte única de 189 handlers/capabilities, 340 schemas Draft 2020-12 e 151 paths OpenAPI 3.1; o gate compara todos os handlers e query params implementados com essa fonte antes do service. A evolução aditiva que publicou o `limit` já aceito pelo MVP Core elevou somente essa capability a 1.1.0. O run `30815677386` passou a matriz completa após uma falsificação real de precedência entre rota literal e dinâmica ser corrigida fail-closed. O catálogo exaustivo classifica 117 erros públicos e impede diagnóstico interno no envelope v3. Os 385 examples e os migration guides entram em bundle determinístico de 343 arquivos, incluindo o manifest, no mesmo build e são publicados como artefato CI. A baseline rejeita tanto quebra quanto adição não revisada. O registro de depreciação publica datas RFC e guide somente para versões registradas, com janela mínima de 180 dias. Um contract subtest por capability prova as 189 rotas, boundaries e projeções OpenAPI/schema. O run `30823898229` aprovou 1.035 testes, artifact documental, HTTP/PostgreSQL, build, mídia/Remotion e teardown, encerrando F0.035.

### FR-242 — Clientes, autenticação e escopos

O sistema deve suportar clientes externos e service accounts com credenciais revogáveis, escopos granulares, workspace explícito, expiração/rotação e autorização server-side. A escolha exata entre OAuth 2.1, chaves assinadas ou ambos será fechada em ADR.

O mecanismo inicial distingue dois fluxos explícitos:

1. **sessão humana:** `POST /v1/session` autentica credenciais, `GET /v1/session` consulta a sessão e `DELETE /v1/session` encerra; o token fica em cookie HTTP-only, `SameSite=Strict`, com expiração limitada;
2. **cliente externo:** cada request usa Bearer opaco de `ApiClient`, com scopes, environment, status, rotação e revogação resolvidos server-side.

Evidência executável F0.036: `ApiClient` v2 modela `type`, `scopeGrants`, `allowedEnvironments` e `createdBy`; `ServiceAccount` e `ApiCredentialRef` são contratos explícitos, imutáveis e sem material secreto. A migration PostgreSQL substitui os campos singulares anteriores sem dual-read, e os autenticadores Bearer e de sessão humana resolvem grants e ambiente permitido somente do registro durável. `apollo.clients.list`, `apollo.clients.create` e `apollo.clients.credentials.rotate` publicam responses v2 com a identidade canônica, enquanto os schemas v1 permanecem versionados no catálogo. O run hospedado `30827500404` aplicou migrations do zero e aprovou contratos, paridade UI/API, 1.036 testes, integrações PostgreSQL/HTTP, build e a matriz audiovisual completa.

A emissão/validação do Bearer também está fechada: o token opaco contém somente prefixo, IDs seguros e secret base64url de 256 bits; salt de 128 bits e hash `scrypt` permanecem server-side. Parâmetros, formatos e limites são fixos, a comparação usa `timingSafeEqual` e qualquer header/token/material criptográfico inválido converge para `AUTH_INVALID`. O run `30829124000` repetiu a matriz integral, incluindo os fluxos HTTP/PostgreSQL de criação, autenticação, rotação e revogação.

O lifecycle one-shot foi contratado no run `30830871011`: `ApiClient` não duplica verifier, `ApiCredentialRef` identifica uma credential independente e somente sua linha guarda salt/hash one-way; o secret bruto nunca é persistido. A primeira criação/rotação devolve token, enquanto replay, perda de response e vencedor concorrente devolvem apenas IDs e `secretAvailable=false`. Rotação limita overlap e revogação convergente invalida o token. A migration removeu as cópias antigas do client e o gate de schema impede seu retorno. Matriz deny-by-default, audit context, kill switches e o security E2E completo continuam microtarefas separadas de F0.036.

Incremento local de autorização: a matriz executável contém somente os 13 grants usados pelas capabilities atuais. Persistência reidratada, autenticação, guards e registry consultam a mesma allowlist; um novo `resource:action` exige alteração deliberada da matriz e uma capability que o use. O gate percorre todas as capabilities Bearer e exige o `requireScope` correspondente na rota ou no Application service compartilhado, além de recusar literals desconhecidos. Execução PostgreSQL/HTTP hospedada, deploy e aceite continuam pendentes.

O audit context local também passou a ser inseparável do actor autenticado. Bearer e UI produzem a mesma forma congelada com client, credential, workspace e environment; somente a sessão humana pode acrescentar member, login identity e role vindos da sessão PostgreSQL. Antes de avaliar um scope, o runtime compara todos esses campos e a projeção `actor`, recusando qualquer divergência. Scopes são expostos por um `ReadonlySet` sem `add/delete/clear`, evitando elevação em memória. Ledger completo, prova hospedada, deploy e aceite continuam pendentes.

O ledger local cobre agora o eixo operacional completo já implementado. Autorização de materialização e criação de `PublicOperation` para render, ingest, proxy, export, Diretor, source cleanup e long-form exigem o `AuthenticatedExternalActor`, reaplicam o scope no Application service e vinculam idempotência ao context hash. Source cleanup e long-form persistem o mesmo tuple no aggregate e na operação; divergência entre ambos falha fechada. Cancel e retry só gravam `PublicOperationControlCommand` quando uma transição efetiva vence, na mesma transação do estado e do outbox; replays convergentes não fabricam intenção. A migration preserva fisicamente linhas pré-contrato como grupo nulo, mas toda hidratação as recusa até o reset pré-produção autorizado, sem backfill de autoria. Testes locais e E2Es PostgreSQL/HTTP estão preparados; execução hospedada, deploy, aceite e cobertura das famílias restantes continuam pendentes.

O mesmo contrato cobre localmente a família de produção em lote como um pacote único. Treze mutações públicas atravessam rotas, Application services e sete repositories sem reduzir o actor a client ID: batch create/action/item action, partial retry, alignment/review, take library/selection, compatibility graph, variant recipe, portfolio preflight e batch edit preflight/commit. Todas reaplicam `projects:write`; onze aggregates/commands persistem credential, environment, authentication kind, delegação e context hash, e os fluxos idempotentes exigem o mesmo hash em replay, recuperação concorrente e commit de preflight. A hidratação recusa tuples incompletos ou adulterados. A migration não faz backfill de identidade e as jornadas PostgreSQL/HTTP foram preparadas sem execução local por ausência do banco; deploy e aceite permanecem pendentes.

O pacote local de inteligência do projeto aplica a mesma regra a nove mutações públicas: catálogos de fala, evidência e segmentos validados; documentos, avaliações, reuso e escala semânticos; desconstrução de source; e relatório de contaminação. As rotas entregam o ator completo aos Application services, que reaplicam `projects:write`, materializam um único audit context e incorporam seu hash aos fingerprints e replays. Seis repositories persistem e recalculam credential, environment, authentication kind e eventual delegação em nove aggregates. A migration mantém o grupo nullable apenas para não inventar autoria histórica, enquanto a hidratação falha fechada. O gate estrutural e os testes locais estão verdes; duas jornadas HTTP/PostgreSQL estão preparadas, ainda sem execução local, deploy ou aceite.

Commands editoriais iniciados externamente seguem agora a mesma fronteira. Remoção de fala, replacement de transcript, edição manual/restore, review patch individual e em lote e decisões de comparação carregam `AuthenticatedExternalActor` por seis Application services e seis repositories, reaplicam `projects:write` e vinculam fingerprint, replay e concorrência ao context hash. O aggregate continua sendo o único `V2EditCommand`: sua linha guarda credential, environment, authentication kind e eventual delegação, e a hidratação recalcula a identidade antes de expor o resultado. A constraint corretiva exige explicitamente os quatro campos externos obrigatórios, pois `CHECK` PostgreSQL não pode depender de `UNKNOWN`; nenhuma autoria histórica é inferida. Commands materializados pelo worker do Diretor permanecem uma família interna separada até receberem provenance durável correto. Testes locais, falsificação cross-credential e o golden FFmpeg real pelo worker estão verdes; as jornadas PostgreSQL preparadas, execução hospedada, deploy e aceite permanecem pendentes.

O pacote local de avaliação do projeto fecha mais onze aggregate heads externos: color pipeline, extração contígua, necessidades/integridade/modos de prova, acknowledgement de proxy review, iteração de qualidade, seleção de asset, MVP core gate e criação/decisão de validation envelope. Onze rotas entregam o ator completo a dez Application/repository boundaries, que reaplicam `projects:write`, isolam workspace e vinculam fingerprint, replay e vencedor concorrente ao context hash. A persistência grava o tuple canônico all-null ou completo e a hidratação falha fechada para linha pré-contrato, adulterada ou de outra credential. A migration não inventa autoria histórica. Gates locais de estrutura, schema, tipos e 1.095 testes passam; PostgreSQL real, deploy, aceite e mutações compartilhadas com workers continuam pendentes.

As três famílias compartilhadas com workers agora têm proveniência explícita. Diretor, catálogo long-form e processamento hierárquico distinguem `external-request` de `long-form-stage`: a primeira forma exige o actor autenticado completo e reaplica `projects:write`; a segunda recebe somente o audit context persistido pela operação, junto de operation ID, workflow ID, stage, input hash e idempotency key. O worker não ganha uma identidade sintética. Replay e fingerprint pertencem à credential iniciadora, enquanto FKs e fences vinculam o resultado ao lease/checkpoint exato. `V2EditCommand` do Diretor e os run heads persistem e reidratam esse vínculo; tuples históricas incompletas falham fechadas. A prova atual é local e controlada, sem PostgreSQL real, deploy ou aceite.

Para comandos de containment, a atribuição deixou de ser apenas transitória: a linha imutável persiste credential ou session identity, environment, authentication kind e o tuple delegado completo, acompanhado de hash canônico revalidado na hidratação. O fingerprint de idempotência inclui esse hash; duas pessoas atrás do mesmo principal UI não compartilham replay administrativo. Esses campos permanecem internos e não ampliam o contrato público. Commands históricos sem atribuição completa são removidos pela migration pré-produção em vez de receber identidade fabricada. As demais capabilities ainda precisam aderir ao ledger exaustivo.

O mesmo contrato passou a cercar as onze mutações administrativas de webhook, incluindo challenge. Criar endpoint/subscription, mudar seus status, verificar e ativar endpoint, provisionar/preparar/ativar/cancelar signing secrets e repetir delivery/event exige o actor autenticado no próprio Application service, materializa um `V2WebhookAdministrationCommand` com credential, delegação, target, endpoint/revision quando aplicável e fingerprint, e o persiste atomicamente com o recurso, efeito ou transição CAS. Challenge só grava autoria depois da resposta externa válida, na mesma transação da ativação; seguidores exigem esse command antes de responder como replay. Concorrência e recuperação após resposta perdida não podem trocar credential/member nem fabricar autoria; o ledger nunca contém token, chave ou ciphertext. O slice está provado por contratos locais e E2Es PostgreSQL/HTTP preparados; execução hospedada, deploy e aceite ainda mantêm F0.036 aberto.

O lifecycle público de media artifact segue agora a mesma identidade auditável. O Application service recebe o actor autenticado, aplica `artifacts:write`, oculta workspace alheio e incorpora o hash do tuple completo ao fingerprint. A transação persiste credential, environment, authentication kind e eventual delegação junto do fence de revisão, mudança de estado, replay e outbox; a hidratação recalcula o hash e falha fechada diante de adulteração. Linhas e idempotency responses anteriores sem atribuição reconstruível são removidas no reset pré-produção. A prova atual é local; PostgreSQL/HTTP hospedado, deploy e aceite continuam pendentes.

Download grants curtos também são actor-bound. Emissão exige `artifacts:read`, inclui o context hash no fingerprint e persiste a identidade completa do emissor sem armazenar o token bruto. Revogação grava estado terminal, instante e identidade completa do revogador na mesma alteração cercada; somente o mesmo context hash recebe replay convergente. Hidratação revalida emissor e revogador, e grants pré-contrato são invalidados em vez de receber autoria fabricada. O E2E final-export foi ampliado para a prova HTTP/PostgreSQL, ainda não executada no gate hospedado.

O lifecycle de upload mantém um ledger imutável para `begin`, emissão de sessão, registro de parte, conclusão e aborto. Cada entrada contém actor tuple, context hash, fingerprint e instante; parte inclui seu número. Mutação e entrada são confirmadas na mesma transação. O upload aponta para a entrada exata da sessão corrente e o repository revalida ação, workspace, upload e ator antes de aceitar conteúdo multipart; a emissão de nova sessão invalida o token anterior antes da escrita no storage. Conclusão e aborto aceitam replay somente do mesmo contexto. Uploads anteriores a esse contrato falham fechados, sem backfill de identidade. Há prova unitária local e integração PostgreSQL preparada no CI; execução hospedada, deploy e aceite pendem.

Alterações de direitos usam `AssetRightsChange` imutável por revisão. O ledger não pertence ao snapshot, porque snapshots iguais são content-addressed e podem ser reutilizados em revisões diferentes. Cada change liga base, resultado, snapshot, fingerprint, instante e ator: requisição pública exige `artifacts:rights` e contexto externo completo; derivações internas declaram origem interna explicitamente. Replay perdido converge apenas para o mesmo contexto, enquanto a mesma política aplicada por outra credential cria uma nova revisão que referencia o snapshot já existente. Ausência ou adulteração do change bloqueia a leitura. Provas locais estão verdes e a integração PostgreSQL foi ligada ao CI; execução hospedada, deploy e aceite pendem.

Criação e duplicação de projetos usam um único ledger `ProjectCreationCommand`. A entrada diferencia `create` de `duplicate`, liga Project e ProjectVersion resultantes e, na duplicação, exige os IDs exatos do projeto e da versão de origem. Credential, environment, authentication kind e eventual delegação são materializados a partir do ator autenticado, entram no fingerprint idempotente e são persistidos atomicamente com o resultado. Replay reidrata e recalcula o command hash; ausência, adulteração ou troca de credential falha fechada. O seed operacional também exige credential e environment explícitos. A prova atual é local, com migrations e E2Es PostgreSQL preparados; execução hospedada, deploy e aceite permanecem pendentes.

As mutações de LUT seguem o mesmo contrato. Importação, nova versão, lifecycle e padrão do workspace exigem `projects:write`, vinculam o fingerprint ao context hash e persistem o tuple autenticado completo na versão ou command imutável. A seleção por projeto preserva o aggregate existente: autoria externa fica no próprio `V2EditCommand`; Diretor/sistema permanecem origens internas sem simular credential. Hidratação recalcula a identidade antes de aceitar leitura ou replay, outra credential do mesmo client produz mismatch e a response não expõe o tuple. LUTs anteriores são resetadas e EditCommands externos antigos sem atribuição completa falham fechados, sem backfill. A jornada HTTP/PostgreSQL está preparada; execução hospedada, deploy e aceite permanecem pendentes.

Administração de clients e credentials adota a mesma regra por meio de `ApiAdministrationCommand`. Criação e rotação persistem o command na transação que cria o verifier e conclui a idempotência; revogação persiste a transição terminal e o command como uma unidade serializável. O target é client+credential exato, a autoria inclui credential/session e delegação completa, e nenhum secret integra command ou replay. Estados anteriores sem audit reconstruível são eliminados no reset pré-produção. O ledger global continua aberto para outras capability families.

O containment local diferencia autoridade do client e autoridade humana: `clients:admin` e `webhooks:admin` exigem member `administrator` quando a autenticação é por UI, e recuperação sob kill switch aceita somente essa role nas capabilities dedicadas. Suspend/revoke/kill switch continuam CAS, auditados e atomicamente ligados ao cancelamento das operações cercadas. O client que autentica a própria requisição não pode suspender ou revogar a si mesmo, evitando retirar o único caminho de recuperação; engage/release de kill switch continua permitido. Prova hospedada, deploy e aceite permanecem pendentes.

O security E2E HTTP/PostgreSQL foi ampliado localmente para atravessar os limites que sustentam essa política: reviewer não herda administração do principal UI, self suspend/revoke retorna conflito sem command, credential expirada retorna `AUTH_INVALID` sem registrar uso, rotação overlap-zero invalida imediatamente o token anterior e revogação permanece terminal. O teste está preparado, mas a nova versão ainda exige execução hospedada, deploy e aceite antes de concluir a última microtarefa de F0.036.

Senha humana nunca é uma credencial de integração e não deve ser enviada a MCP, Director ou provider. O ADR-142 seleciona OIDC Authorization Code + PKCE para produção, sessão opaca server-side com idle de 30 minutos, expiração absoluta de 12 horas, rotação/revogação duráveis e recuperação de credencial exclusivamente pelo IdP. O bootstrap scrypt local exige opt-in explícito e permanece apenas para desenvolvimento isolado. Discovery, Authorization Code, S256 PKCE, state, nonce, browser binding, JWKS/issuer/audience/signature, transação one-shot PostgreSQL, membership pré-autorizada e cookie aleatório opaco foram integrados no run `30773060731`; o run `30773970385` comprovou rotação convergente com chave obrigatória, predecessor bloqueado, recovery de 60 segundos e idade máxima de 15 minutos por identificador. Senha fica desabilitada no modo OIDC. IdP real, recuperação exercitada, deploy e aceite continuam requisitos abertos.

### FR-243 — Operações assíncronas e controle de jobs

Atualização local de implementação: o Diretor possui enqueue público `202`, alvo reservado de `ProjectVersion`, contexto privado persistido e worker com lease/heartbeat/fencing. O commit serializável publica a nova versão, snapshots, Command, DirectorRun, invalidações, outbox e `PublicOperation.succeeded` como uma unidade; cancelamento ou perda da lease impede publicação parcial. A jornada PostgreSQL/API foi preparada, mas ainda não executada em ambiente isolado hospedado; FR-243 permanece aberta para os demais jobs, deploy e aceite.

Atualização local de custo de FR-243: os contratos de operação v10 expõem custo apenas quando existe fonte persistida. `long-form-index` publica a soma estimada dos budgets de estágio e o teto do workflow; a medição real aparece somente após término e é derivada dos checkpoints persistidos. Outros tipos omitem custo até possuírem reserva/medição próprias. A prova local não substitui execução PostgreSQL/API hospedada, deploy ou aceite.

Ingestão, percepção, direção, geração, sincronização, lote, render e export devem responder com operation/job ID quando não forem imediatos. Clientes podem consultar status, progresso real, resultado, erro, custo, cancelabilidade, retry e resume.

### FR-244 — Webhooks e eventos

Clientes podem assinar eventos autorizados de projeto, versão, job, annotation, aprovação, artifact e budget. Entregas possuem assinatura, timestamp, ID único, retry, deduplicação, replay controlado e observabilidade.

Atualização local de implementação: transições canônicas de status de `PublicOperation` produzem `operation.status.changed` e os terminais `operation.succeeded`/`operation.failed` no mesmo commit serializável que altera a operação. A regra também cobre criação de long-form/source-cleanup, conclusão do Diretor e cancelamento em massa provocado por suspensão, revogação ou kill switch. Replay e convergência não republicam; o envelope expõe somente identidade, tipo, status, fase, tentativa e projeto opcional, sem lease, autorização, storage ou erro interno. A prova PostgreSQL hospedada, deploy e aceite permanecem pendentes, portanto FR-244 continua aberta.

Outro incremento local conecta o mesmo outbox às transições existentes de review, lifecycle e governança: criação/aplicação de annotation publica `annotation.created`/`annotation.resolved`; retorno de quarantine e entrada em quarantine publicam `artifact.ready`/`artifact.rejected`; suspensão explícita de um API client publica `client.suspended`. Replay, no-op e rollback não publicam. Payloads omitem texto/screenshot de review, reason administrativo e detalhes internos. Assim, treze dos quatorze tipos do catálogo possuem ao menos um producer real; `budget.threshold.reached` continua sem producer até existir uma fonte canônica de consumo e limiar.

A administração local passou a ter uma superfície humana API-first na área de configurações. Ela carrega endpoints, subscriptions, deliveries e catálogo em paralelo; mostra status e attempts; opera somente transitions revisionadas e idempotentes; e mantém o novo signing secret exclusivamente em memória até descarte explícito. Todas as 15 ações de rede são vinculadas pelo gate gerado a uma capability pública e ao mesmo Application service usado por clientes externos. Esta evidência é estrutural/local: jornada HTTP/PostgreSQL em browser, ações terminais destrutivas, deploy e aceite continuam pendentes.

### FR-245 — Idempotência e concorrência externa

Mutações aceitam idempotency key; alterações versionadas exigem `baseVersionId` ou precondition equivalente. A API retorna conflito estruturado, nunca sobrescreve silenciosamente e preserva o resultado de requests repetidas.

### FR-246 — Interface para agentes de IA

Capabilities operáveis devem possuir descrições, schemas e responses adequados a tool calling. Um adapter MCP pode expor o catálogo público sem duplicar regras de domínio. Agentes recebem apenas tools permitidas pelos escopos e nunca executam texto de mídia como instrução.

### FR-247 — Transferência externa de mídia

Uploads e downloads usam sessões/signed URLs de curta duração, multipart/resume, checksum, tamanho/MIME declarados e confirmação. URIs internas, credenciais e paths de storage não são expostos como contrato permanente.

### FR-248 — Preflight, dry-run e operações em lote

Operações de alto alcance ou custo devem oferecer preflight/dry-run com targets, conflicts, invalidations, jobs, custo e quota antes do commit. Lotes retornam resultado por item e suportam retry parcial segundo a mesma política da interface.

### FR-249 — Governança da API

O workspace deve administrar clients, secrets, scopes, rate limits, quotas, webhooks, usage e audit log. Deve existir ambiente ou modo de teste com provider fakes para integrações sem custo externo involuntário.

---

## 8. Jornadas principais

## 8.1 Vídeo bruto único

```text
Novo projeto
→ objetivo + briefing opcional
→ upload
→ ingest/normalize/transcribe
→ perception
→ treatment/story
→ assets
→ EditPlan
→ proxy
→ critic
→ revisão
→ final
```

## 8.2 Hooks, corpos e CTAs

```text
ProductionBatch
→ roteiro
→ 3 arquivos de gravação
→ transcript/script alignment
→ takes
→ compatibility graph
→ recipes
→ preflight de outputs
→ direção por receita
→ batch render
```

## 8.3 Material validado

```text
Importar Reel
→ marcar validationScope
→ deconstruction
→ clean segment
→ catalogar
→ buscar corpo/CTA compatíveis
→ nova receita
```

## 8.4 Depoimento

```text
Upload de depoimento
→ transcript/diarization
→ evidence extraction
→ integrity/rights
→ catalogar
→ StoryPlan solicita prova
→ retrieval
→ insert + critic
```

## 8.5 Live longa

```text
Upload 2h
→ background indexing
→ capítulos
→ moments
→ pedido de conteúdo 2min
→ contiguous ou synthesis
→ EditPlan
→ revisão
```

## 8.6 Synthetic presenter

```text
Roteiro/áudio
→ blocos
→ TTS opcional
→ alignment
→ avatar jobs
→ synthetic critic
→ masters + SpeechSegments
→ composição
```

## 8.7 Multicâmera + tela

```text
CaptureSession
→ protocol/marker
→ upload tracks
→ preserve timebase
→ sync maps + coverage
→ diagnostic/manual anchors
→ active source selection
→ edit
```

## 8.8 Localização

```text
ProjectVersion aprovado
→ locale profile
→ translation/adaptation
→ audio
→ alignment
→ lip-sync/avatar/voiceover
→ localized plan
→ outputs
```

## 8.9 Operação externa por agente de IA

```text
client/service account autorizado
→ capability discovery
→ criar projeto e upload session
→ iniciar workflow
→ acompanhar job/eventos
→ consultar proxy e QualityReport
→ criar annotation ou Command
→ preflight e aprovar versão
→ render/export
→ receber webhook e inspecionar lineage
```

O fluxo externo deve produzir os mesmos estados, versões, validações, custos e artifacts do fluxo realizado pela interface.

---

## 9. Arquitetura lógica

```text
Web App / Editor      Agentes IA      Ferramentas externas
        │                  │                   │
        └──────────────────┼───────────────────┘
                           ▼
           Public API / Automation Gateway
                           │
                           ▼
                    Application API
        │
        ├── Workspace & Projects
        ├── Media Library
        ├── Review & Commands
        └── Job Control
        │
        ▼
Workflow Orchestrator
        │
        ├── Ingest Worker
        ├── Perception Worker
        ├── Director Worker
        ├── Provider Jobs
        ├── Critic Worker
        └── Render Worker
        │
        ├───────────────┐
        ▼               ▼
Postgres + vector    Object Storage
        │               │
        └───────┬───────┘
                ▼
        Remotion + FFmpeg
```

### 9.1 Componentes

- **Web:** workspace, projetos, bibliotecas, editor, revisão e settings.
- **Public API / Automation Gateway:** autenticação de clients, schemas públicos, rate limits, idempotência, webhooks, capability discovery e adapter MCP.
- **API:** domínio, auth, commands, queries e job control.
- **Orchestrator:** state machine durável.
- **Workers:** tarefas pesadas e isoladas.
- **Provider Registry:** capabilities e routing.
- **Director:** perception → treatment → story → plan → patches.
- **Compiler:** transforma planos em props/tracks determinísticos.
- **Renderer:** Remotion + FFmpeg.
- **Critics:** hard validators + multimodal review.
- **Storage:** masters e derivados imutáveis.
- **Database:** metadata, versões, relações, jobs e embeddings.

### 9.2 Tecnologia-alvo

- Manter Next.js/React para UI/API, com versões decididas no início da implementação.
- Manter Remotion como renderer programático.
- Manter FFmpeg/ffprobe para ingest, áudio, sync, transformações técnicas e export.
- Postgres como banco-alvo; pgvector ou equivalente para busca semântica.
- Object storage S3-compatible para mídia.
- Queue/workflow durável; implementação específica será decidida em ADR.
- SQLite pode ser usado apenas em protótipos locais, não como domínio final da biblioteca.

---

## 10. Modelo de dados conceitual

### 10.1 Organização

- Workspace
- WorkspaceMember
- WorkspaceBrandKit
- WorkspaceGuardrails
- LocaleProfile
- DeliveryProfile

### 10.2 Projetos

- Project
- ProjectVersion
- ProductionBatch
- VariantRecipe
- DirectorBrief
- BriefInterpretation
- TreatmentPlan
- StoryPlan
- EditPlan
- FormatVariantPlan
- LocalizationVariant
- OutputSpec
- ReviewAnnotation

### 10.3 Mídia

- MediaAsset
- VideoAsset
- AudioAsset
- ImageAsset
- DocumentAsset
- MediaDerivative
- MediaSegment
- SpeechSegment
- EvidenceSegment
- ValidatedSegment
- LongFormMoment
- ImageAnalysis
- MediaEmbedding
- AssetRights

### 10.4 Captura e sync

- CaptureSession
- SourceTrack
- TrackClip
- SyncAnchor
- SyncMap
- TrackCoverage
- SyncDiagnostic

### 10.5 Sintético e providers

- PresenterProfile
- VoiceProfile
- ConsentRecord
- ProviderDefinition
- ProviderCredentialRef
- ProviderJob
- SyntheticMasterAsset
- TransformationBrief
- TransformationArtifact

### 10.6 Execução

- WorkflowRun
- WorkflowStep
- ArtifactEvaluation
- QualityReport
- DirectorDecision
- RenderJob
- RenderArtifact
- ArtifactLineage

### 10.7 Integrações externas

- ApiClient
- ServiceAccount
- ApiCredentialRef
- ApiScopeGrant
- IdempotencyRecord
- WebhookEndpoint
- WebhookSubscription
- WebhookDelivery
- ApiUsageRecord

---

## 11. Contratos centrais

### 11.1 SourceAsset

```ts
interface SourceAsset {
  id: string
  workspaceId: string
  kind: 'video' | 'audio' | 'image' | 'document'
  origin: 'uploaded' | 'generated' | 'imported' | 'derived'
  masterUri: string
  checksum: string
  metadata: Record<string, unknown>
  rightsId?: string
  parentAssetId?: string
}
```

### 11.2 Timeline segment

```ts
interface TimelineSegment {
  id: string
  sourceAssetId: string
  sourceStartFrame: number
  sourceEndFrame: number
  timelineStartFrame: number
  timelineEndFrame: number
  role: string
  protected?: boolean
}
```

### 11.3 OutputSpec

```ts
interface OutputSpec {
  id: string
  locale: string
  aspectRatio: '9:16' | '16:9' | '4:5' | '1:1' | '21:9' | 'custom'
  width: number
  height: number
  fps: number
  deliveryProfileId?: string
  safeArea: { top: number; right: number; bottom: number; left: number }
}
```

### 11.4 Provider adapter

```ts
interface AsyncMediaProviderAdapter {
  id: string
  capabilities(): Promise<Record<string, unknown>>
  submit(input: unknown): Promise<{ jobId: string }>
  getStatus(jobId: string): Promise<Record<string, unknown>>
  retrieve(jobId: string): Promise<Record<string, unknown>>
  cancel?(jobId: string): Promise<void>
}
```

### 11.5 Command

```ts
interface EditCommand {
  id: string
  projectVersionId: string
  author: 'user' | 'director' | 'system'
  type: string
  scope: Record<string, unknown>
  payload: Record<string, unknown>
  createdAt: string
}
```

### 11.6 Operação pública assíncrona

```ts
interface PublicOperation {
  id: string
  workspaceId: string
  clientId: string
  type: string
  status: 'queued' | 'running' | 'waiting' | 'retrying' | 'succeeded' | 'failed' | 'canceled'
  targetType: string
  targetId?: string
  projectVersionId?: string
  progress?: { completed: number; total?: number; phase: string }
  resultRef?: string
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }
  createdAt: string
  updatedAt: string
}
```

O contrato público referencia resources e operations estáveis; não serializa diretamente tabelas internas, mensagens privadas do Diretor, credentials, storage paths ou payloads específicos de providers.

---

## 12. Sistema de qualidade

## 12.1 Hard validators

- ranges válidos e sem frames negativos;
- fontes existentes e autorizadas;
- sem colisões proibidas;
- texto dentro de safe areas;
- duração legível;
- subtitle timing monotônico;
- media duration suficiente;
- sem frames pretos/freeze inesperados;
- sem clipping de áudio;
- sem job órfão;
- policy/rights gates atendidos.

## 12.2 Asset critics

- semântica;
- realismo;
- texto/logos indesejados;
- identidade;
- motion coherence;
- composição;
- qualidade técnica;
- continuidade;
- uso permitido.

## 12.3 Proxy critic

- força do hook;
- clareza narrativa;
- ritmo;
- density/pattern breaks;
- composição;
- legenda;
- B-roll congruente;
- CTA;
- coerência entre cenas;
- integridade de claims;
- áudio e cor quando disponíveis.

## 12.4 QualityReport

Problemas devem ser localizados por frame/range, severidade, evidência, sugestão e status.

## 12.5 Iteração

Máximo de iterações e custo definidos por policy. Patches localizados; nunca refazer o plano inteiro sem necessidade.

---

## 13. Requisitos não funcionais

### NFR-001 — Idempotência

Repetir request/job não pode duplicar artefatos ou corromper estado.

### NFR-002 — Resume

Jobs longos devem retomar após restart.

### NFR-003 — Observabilidade

Logs estruturados, trace por project/workflow/provider job, métricas de custo e duração.

Estado integrado parcial (`197d51d`, run `30765019248`): lifecycle, spans e alertas redigidos são persistidos em tabelas PostgreSQL tipadas e consultáveis por capability pública workspace-scoped em janela máxima de 31 dias, sem payloads ou identificadores individuais na resposta agregada. Permanecem necessários dashboard por jornada/fase, alertas de hard invariants, implantação e aceite operacional antes de concluir NFR-003.

### NFR-004 — Reprodutibilidade

Manifest, props, versões, hashes e provider config suficientes para reproduzir output quando providers permitirem.

### NFR-005 — Performance

Preview deve usar proxies. Processamento pesado nunca deve bloquear a UI.

### NFR-006 — Escalabilidade

Fila e workers independentes para ingest, IA, providers e render.

### NFR-007 — Segurança

Credenciais fora de prompts e banco em claro; acesso por workspace; URLs assinadas; auditoria de mídia sintética.

### NFR-008 — Privacidade

Assets, faces, vozes, consentimentos e depoimentos são dados sensíveis com controle de acesso e deleção rastreável.

### NFR-009 — Compatibilidade

Planos e manifests possuem versionamento e migrations.

### NFR-010 — Testabilidade

Domain puro, adapters mockáveis, golden fixtures para timing/render, E2E para jornadas críticas.

### NFR-011 — Paridade e estabilidade da API externa

Toda capability operável possui contract test público e teste de paridade UI/API. A API usa versionamento explícito, política de depreciação, erros estáveis, backward-compatibility dentro da major version e documentação gerada no mesmo build do contrato.

---

## 14. Métricas de produto e operação

### 14.1 Produto

- Tempo de material enviado até primeiro proxy.
- Percentual de projetos aprovados sem alteração manual.
- Quantidade média de patches por vídeo.
- Taxa de aceitação de B-roll/transformações.
- Taxa de reutilização de assets.
- Tempo economizado versus edição manual.
- Taxa de aprovação por formato e idioma.

### 14.2 Qualidade

- Problemas técnicos por render.
- Erros de legenda por minuto.
- Colisões visuais detectadas.
- Rejeições por incongruência semântica.
- Falhas de lip-sync e identidade.
- Incidentes de claim/contexto.

### 14.3 Operação

- Taxa de sucesso de jobs.
- Retries por provider.
- Custo por minuto/output.
- Cache hit rate.
- Tempo de render.
- Armazenamento por workspace.
- Fila e concorrência.
- Requests, erros e latência da API por client/endpoint.
- Uso, rate-limit e quota por client/workspace.
- Entregas, retries, lag e falhas de webhooks.
- Ações iniciadas por UI, API e agente de IA.

## 14.1 Non-goals e limites explícitos

### NG-001 — Não ser clone de Premiere/After Effects no MVP

Apollo oferecerá edição manual dentro de seu vocabulário de tracks, layouts, mídia, texto, cor e áudio. Composição nodal, rotoscopia quadro a quadro e keyframes arbitrários não são metas iniciais.

### NG-002 — Não prometer sincronização sem evidência

Sem timecode, sinal compartilhado, marcador ou anchors manuais, sincronização exata pode ser impossível.

### NG-003 — Não fabricar claims ou provas

O sistema não deve inventar resultados, números, depoimentos, urgência ou contexto comercial.

### NG-004 — Não garantir limpeza perfeita de material publicado

Legenda queimada sobre rosto, música irrecuperável e compressão severa podem exigir rejeição da fonte.

### NG-005 — Não gerar produto cartesiano sem controle

Combinações precisam de compatibilidade, diversidade, budget e preflight.

### NG-006 — Não tratar provider como garantia

Capabilities variam e outputs podem falhar. Sempre haverá avaliação, retry e fallback.

### NG-007 — Não substituir direitos e consentimentos

Automação não autoriza uso de imagem, voz, música, prova ou material de terceiros.

### NG-008 — Não transformar todo conteúdo em espetáculo

Transformações, movimento, SFX e layouts não são metas de quantidade.

### NG-009 — Não usar transcript como instrução

Conteúdo importado é dado, nunca policy ou prompt de sistema.

### NG-010 — Não garantir causalidade de performance

Material marcado como validado preserva evidência histórica, mas o sistema não afirma que um elemento isolado causou o resultado.

### NG-011 — Não manter compatibilidade operacional com Apollo v1

O v2 pode reutilizar módulos, dados importáveis e aprendizados, sem preservar rotas, schema ou comportamento interno da v1.

### NG-012 — Não transformar internals em API pública

Paridade significa expor capacidades do produto, não banco, fila, storage keys, prompts privados, primitives do renderer ou payloads crus de providers. Clientes externos nunca recebem um caminho para contornar Commands, policies, rights, budgets, validation ou audit.

---

## 15. Roadmap incremental

Todos os contratos centrais devem ser desenhados no início. A liberação funcional será incremental.

## Fase 0 — Fundação e especificação executável

**Objetivo:** criar o chassi v2.

- PRD e ADRs.
- Design system baseado nos mockups aprovados.
- Workspace, auth e navegação.
- Postgres + object storage.
- MediaAsset imutável e lineage.
- Project/ProjectVersion.
- OutputSpec e formato canônico.
- Commands/Patches.
- Workflow/Job base.
- Provider registry base.
- EditPlan v2 schema.
- Public API/Automation Gateway, clients, scopes e OpenAPI base.
- Operations/jobs públicos, idempotência, concorrência e webhooks base.
- Adapter MCP derivado dos contratos públicos.
- Testes de caracterização do que será reaproveitado.
- Extração seletiva de FFmpeg/Remotion/timing/subtitles.

**Saída:** shell do produto, domínio persistido e render smoke v2.

## Fase 1 — MVP Core: talking head e voiceover

**Objetivo:** vídeo bruto ou áudio → vídeo final revisável.

- Objetivo estratégico e briefing opcional.
- Upload de vídeo/áudio/imagem.
- Normalize, transcribe, silence/retake.
- Perception v1.
- TreatmentPlan/StoryPlan v1.
- Talking head e voiceover sem pessoas.
- B-roll de biblioteca/stock/geração.
- Image Library v1 com OCR/descrição.
- EditPlan v2 e renderer.
- 9:16 e 16:9.
- Cinco estilos de legenda.
- Brand Kit/Guardrails v1.
- Proxy + hard validators + critic v1.
- Editor manual básico.
- Anotações por frame/região/cena.
- Versionamento e duplicação.
- Render final e manifest.
- Paridade API para criação, upload, workflow, revisão, commands, render e export do MVP.

**Critério de saída:** um vídeo de 30–120s pode ser produzido de ponta a ponta sem intervenção obrigatória, revisado e corrigido.

## Fase 2 — Lotes, reutilização e formatos

**Objetivo:** produção de anúncios em escala.

- ProductionBatch.
- Importação de roteiro.
- Hooks/corpos/CTAs.
- Script alignment e takes.
- Compatibility graph.
- VariantRecipe.
- Batch editing/render.
- Video/Evidence/ValidatedSegment library.
- Deconstruction v1.
- Long-form: um vídeo → um short.
- 4:5, 1:1 e 21:9.
- Layout responsivo completo.
- LUT library global.
- Busca híbrida em mídia.
- API de batch, recipes, busca, reuso, preflight e retry parcial.

**Critério de saída:** lote H/B/CTA gera receitas compatíveis e múltiplos formatos com reutilização e preflight de custo.

## Fase 3 — Synthetic Presenter e transformação

**Objetivo:** gerar e reutilizar apresentadores e mundos sintéticos.

- ElevenLabs adapter.
- HeyGen adapter.
- Texto ou áudio → avatar.
- SyntheticMasterAsset.
- SpeechSegment catalog.
- Synthetic critic.
- Transformation provider adapter.
- Cutaway/background/camera motion v1.
- MCP/API transport adapters.
- Reuse/caching por hash.
- Consent and rights UI.
- API/MCP de geração e transformação com capabilities, budgets e aprovação.

**Critério de saída:** criar vídeo de personagem IA + B-roll e reaproveitar blocos sem regeneração.

## Fase 4 — Multicâmera, tela, react e long-form avançado

**Objetivo:** sessões complexas e mineração ampla.

- CaptureSession.
- Audio fingerprint sync.
- Drift/coverage/gaps.
- Manual anchors.
- Apollo Sync Marker.
- Professor + tela.
- Podcast active speaker.
- React piecewise playback map.
- Cross-library long-form retrieval.
- Editorial synthesis multi-range.
- Color match multicâmera.
- API de CaptureSession, anchors, diagnostic e sync maps autorizados.

**Critério de saída:** múltiplas fontes do mesmo evento são sincronizadas, diagnosticadas e editadas automaticamente.

## Fase 5 — Localização e áudio avançado

**Objetivo:** distribuição internacional e direção audiovisual.

- PT-BR → EN/ES.
- Locale profiles/glossaries.
- TTS/lip-sync/avatar localizado.
- EditPlan por locale.
- Legendas localizadas.
- Multi-locale output matrix.
- Music library.
- Narrative-led audio.
- SFX planner.
- Beat grid e hybrid mode.
- Music-led posterior.
- API de variantes localizadas, matriz multi-locale e direção de áudio.

**Critério de saída:** um projeto aprovado gera versões localizadas e mixadas com qualidade validada.

---

## 16. Critérios de aceite do MVP Core

### AC-001

Usuário cria workspace, configura opcionalmente marca/guardrails e inicia projeto.

### AC-002

Usuário seleciona objetivo e pode deixar briefing livre vazio.

### AC-003

Sistema aceita vídeo ou áudio, persiste master e gera proxy sem sobrescrita.

### AC-004

Sistema transcreve com timestamps utilizáveis e identifica silêncios/retakes.

### AC-005

Diretor gera TreatmentPlan, StoryPlan e EditPlan estruturados.

### AC-006

Sistema produz talking head + B-roll ou áudio + B-roll sem pessoas.

### AC-007

Assets gerados são avaliados e podem ser rejeitados/substituídos automaticamente.

### AC-008

Proxy é renderizado e passa por validação técnica e crítica localizada.

### AC-009

Usuário pausa, anota uma região/cena e aplica correção versionada.

### AC-010

Usuário faz trim, troca B-roll, altera texto/legenda/layout e desfaz.

### AC-011

Projeto pode ser duplicado sem duplicar masters.

### AC-012

Sistema exporta 9:16 e 16:9 com layout validado individualmente.

### AC-013

Render final possui manifest completo e pode ser reconstruído a partir da versão.

### AC-014

Falha ou restart não deixa projeto preso; job pode retomar ou ser reexecutado com segurança.

### AC-015

Dashboard reflete progresso, revisão, conclusão e falhas conforme referência visual aprovada.

### AC-016

Cliente externo ou agente de IA autorizado executa a jornada MVP completa — criar projeto, enviar mídia, iniciar workflow, acompanhar job, revisar proxy, aplicar Command, renderizar e exportar — com os mesmos estados, políticas, versões e artifacts da interface.

---

## 17. Riscos e mitigação

### R-01 — Escopo excessivo

**Risco:** tentar implementar todas as capacidades simultaneamente.  
**Mitigação:** contratos amplos, slices verticais e gates de fase.

### R-02 — Qualidade subjetiva

**Risco:** Diretor cumprir regras e ainda produzir vídeo ruim.  
**Mitigação:** dataset de referência, rubrica, proxy critic, preferências do workspace e feedback versionado.

### R-03 — Explosão de custos

**Risco:** lote × formato × idioma × geração.  
**Mitigação:** preflight, budgets, cache, dedupe, top-N recipes e partial retry.

### R-04 — Providers instáveis

**Risco:** APIs, custos e capabilities mudarem.  
**Mitigação:** adapters, registry, capability negotiation e fallback.

### R-05 — Contexto e claims

**Risco:** reordenação ou prova distorcer mensagem.  
**Mitigação:** integrity gates, lineage, qualifiers e critic específico.

### R-06 — Sync impossível

**Risco:** fontes sem sinal comum.  
**Mitigação:** CaptureProtocol, Apollo Marker, diagnostic e anchors manuais.

### R-07 — Biblioteca sem governança

**Risco:** mídia duplicada, sem direitos ou difícil de encontrar.  
**Mitigação:** checksum, rights, metadata tiers, embeddings e workspace scope.

### R-08 — UI virar um NLE impossível de manter

**Risco:** tentar copiar Premiere/After Effects.  
**Mitigação:** edição manual baseada no vocabulário do Apollo, extensível por Commands, com recursos avançados incrementais.

### R-09 — Prompt injection por conteúdo

**Risco:** texto de mídia/documentos ser tratado como instrução.  
**Mitigação:** separar content data de owner-authored policies; Brief Compiler e Guardrails estruturados.

### R-10 — Crescimento de storage

**Risco:** masters, proxies e outputs multiplicarem.  
**Mitigação:** content addressing, retention policies, derivatives rebuildable e quotas.

### R-11 — Superfície externa, abuso e custos por automação

**Risco:** clients comprometidos, automações defeituosas ou agentes autônomos podem vazar dados, repetir mutações ou disparar jobs caros em escala.  
**Mitigação:** credenciais revogáveis, escopos mínimos, idempotência, preflight, quotas, rate limits, budgets, audit, anomaly detection, sandbox e kill switch por client/workspace.

---

## 18. Reaproveitamento seletivo da v1

### Reaproveitar/refatorar

- Remotion scenes e primitivas.
- Estilos de legenda.
- FFmpeg normalize/cut/proxy.
- Whisper e word timings.
- Silence e retake removal.
- Timing frame-first.
- Cold open.
- Beat thumbnails e anchor vision.
- Render watchdog, locks, progress e propsOnly.
- Serviços atuais de imagem/vídeo/stock como primeiros adapters.
- Aprendizados de composição e incidentes.

### Substituir

- Prisma Project single-source.
- scenesJson/editPlanJson como estado principal.
- `claude.ts` monolítico.
- analyze route monolítica.
- Scene como contrato universal.
- editor page monolítica.
- configs JSON como fonte de verdade.
- provider coupling direto.

### Regra

Código só será reutilizado quando puder ser isolado por contrato e coberto por teste de caracterização. Não preservar arquitetura antiga por conveniência.

---

## 19. ADRs necessários antes da implementação

1. ADR-001 — Estrutura do repositório v2.
2. ADR-002 — Banco, vector search e migrations.
3. ADR-003 — Object storage e content addressing.
4. ADR-004 — Workflow/queue durável.
5. ADR-005 — EditPlan v2 schema e migrations.
6. ADR-006 — Command/Patch model.
7. ADR-007 — Provider adapter/capability registry.
8. ADR-008 — Render architecture e cache.
9. ADR-009 — Perception pipeline e metadata tiers.
10. ADR-010 — Security, credentials, rights e consent.
11. ADR-011 — Model routing e observability.
12. ADR-012 — UI state, collaborative review e optimistic updates.
13. ADR-013 — Public API, autenticação de clients, webhooks, versionamento e MCP.

## 19.1 Suíte de especificações derivadas

- [01 — Diretor e qualidade](./specs/01-director-and-quality.md)
- [02 — EditPlan, Commands e versionamento](./specs/02-editplan-commands-versioning.md)
- [03 — Ontologia da biblioteca de mídia](./specs/03-media-library-ontology.md)
- [04 — Lotes, variações e compatibilidade](./specs/04-batch-variants-compatibility.md)
- [05 — Sincronização multicâmera](./specs/05-multicam-sync.md)
- [06 — Providers sintéticos e transformação](./specs/06-synthetic-providers.md)
- [07 — UX do editor e revisão](./specs/07-editor-review-ux.md)
- [08 — Localização e áudio](./specs/08-localization-and-audio.md)
- [09 — API externa e automação](./specs/09-external-api-and-automation.md)
- [Matriz de rastreabilidade](./REQUIREMENTS-TRACEABILITY.md)

---

## 20. Questões abertas para decisão posterior

Estas questões não bloqueiam o PRD, mas precisam de decisão antes das fases correspondentes:

- Quantidade padrão de variações por lote.
- Política de retenção de masters e derivados.
- Providers iniciais de imagem/vídeo além de HeyGen/ElevenLabs.
- Modelo de permissões por membro.
- Critério de “validado” para hooks e métricas externas.
- Importação direta por URL e regras de plataforma.
- Disclosure padrão para mídia sintética por mercado.
- Limites de auto-aplicação de correções sem revisão humana.
- Estratégia de licenciamento de música, LUTs e stock.
- Política de compartilhamento de biblioteca entre workspaces.
- Duração e custo-alvo do primeiro proxy.
- Modelo de credenciais externas: OAuth 2.1, service-account keys assinadas ou ambos.
- Política de versionamento, depreciação e suporte de versões da API.
- Garantias de ordenação, retenção e replay de eventos/webhooks.
- Rate limits, quotas e eventual plano comercial por client/workspace.
- Escopo do MCP oficial e política para tools destrutivas ou de alto custo.

---

## 21. Definition of Done por feature

Uma feature só é considerada concluída quando:

1. contrato e migrations estão versionados;
2. permissões e rights foram considerados;
3. operações são idempotentes;
4. possui estados de loading/error/retry/cancel;
5. gera logs e métricas;
6. possui teste unitário do domínio;
7. possui integração com adapter mockado;
8. possui ao menos um teste E2E ou golden fixture quando visual/timing;
9. aparece corretamente no dashboard/editor;
10. respeita versionamento, lineage e invalidação;
11. possui critérios de aceite verificáveis;
12. não depende de texto de prompt como única proteção.
13. possui paridade pela API externa, schema/documentação e contract test quando for uma capacidade operável.

---

## 22. Glossário

- **Master:** arquivo original imutável.
- **Derivative:** arquivo produzido a partir de outro asset.
- **MediaSegment:** range semântico reutilizável dentro de um master.
- **SpeechSegment:** frase/reflexão catalogada.
- **EvidenceSegment:** trecho de prova/depoimento com contexto e integridade.
- **TreatmentPlan:** direção editorial e gramática visual.
- **StoryPlan:** estrutura narrativa semântica.
- **EditPlan:** timeline determinística compilável.
- **FormatVariantPlan:** layout específico de uma proporção.
- **LocalizationVariant:** derivação por idioma.
- **VariantRecipe:** combinação de segmentos, como hook + corpo + CTA.
- **DirectorRun:** execução do Agente Diretor.
- **QualityReport:** problemas localizados e scores.
- **Lineage:** grafo de origem e transformação de um artefato.
- **Guardrail:** regra estruturada de segurança/integridade.
- **Provider Adapter:** integração substituível com serviço externo.
- **CaptureSession:** conjunto sincronizável de câmeras/telas/áudios.
- **Apollo Sync Marker:** marcador visual+sonoro para alinhamento.
- **Cold open:** trecho posterior reutilizado na abertura.
- **Voiceover:** áudio conduzindo montagem sem apresentador visível.
- **Synthetic Presenter:** avatar/personagem gerado a partir de áudio.
- **API Client:** aplicação, service account, agente ou ferramenta externa com identidade, credenciais e escopos próprios.
- **Public Operation:** representação externa estável de uma operação síncrona ou job assíncrono.
- **Capability Discovery:** catálogo legível por máquina das ações e schemas disponíveis ao client.
- **MCP Adapter:** camada que traduz o contrato público em tools/resources MCP sem duplicar regras de domínio.

---

## 23. Conclusão

Apollo Video v2 deve ser construído como um sistema operacional de produção audiovisual orientado por IA, e não como uma sequência crescente de prompts e componentes de cena.

O núcleo do produto será a combinação de:

- biblioteca semântica reutilizável;
- Diretor multimodal;
- planos versionados;
- execução determinística;
- providers substituíveis;
- crítica em ciclo fechado;
- revisão visual e edição manual;
- outputs derivados por formato, variante e idioma.

O sucesso do projeto depende menos de adicionar efeitos isolados e mais de preservar esses contratos e princípios desde o primeiro ciclo.
