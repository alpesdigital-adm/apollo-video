# ADR-148 — TransformationBrief e routing de providers

## Estado

Aceito para implementação local na Wave 15. Integração em `main`, deploy e aceite do proprietário permanecem pendentes.

## Decisão

`TransformationBrief` é um value object imutável, frame-first e content-addressed. Ele nasce de uma decisão do StoryPlan e vincula o range de origem, intenção editorial, modo, alterações permitidas, elementos protegidos, safety, safe zones, intensidade, novidade, snapshots de direitos/identidade e uma ladder de fallback que termina obrigatoriamente em `source-unchanged`.

O payload enviado a providers é uma projeção mínima. Identidades de workspace, projeto, StoryPlan, direitos e pessoa não atravessam essa fronteira. O domínio registra seis modos canônicos e exaustivos; cada modo declara capability requerida, inputs, preserves, riscos, critic e fallback sem condicionais por nome de provider.

Provider Registry é persistido por workspace. Definition e capabilities são versionadas e hash-verificadas; credenciais aparecem somente como secret reference. Health é uma série imutável de observações, e abrir o circuit breaker não apaga provider nem jobs existentes. O routing considera capability, região, limites, áudio, custo, qualidade, health e circuito. A decisão content-addressed preserva todos os candidatos e razões de descarte e não altera o brief.

## Consequências

- troca de provider preserva byte a byte o `TransformationBrief`;
- ausência de health positivo torna o provider inelegível;
- circuit aberto bloqueia novos selects, mas não cancela trabalho em andamento;
- identidade protegida exige snapshot imutável explícito;
- persistência adulterada falha fechado;
- API pública, vínculo real ao StoryPlan/rights e execução de transformação continuam sendo gates separados antes de F3.010–F3.012 poderem ser consideradas entregues.

## Renumbering note

This decision was authored as ADR-145 on branch `codex/wave15-transformation-registry`
while `claude/f3007-synthetic-master` independently published ADR-145 for the synthetic
master asset. Both merged into the Wave 16 prerequisites branch. The synthetic ADR keeps
145 because the PRD, spec 06 and the TODO already cite it by number; this one moved to
148, the first free slot after ADR-146 and ADR-147.
