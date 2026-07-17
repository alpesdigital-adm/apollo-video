# ADR-121 — Da revisão visual ao PatchSet auditável

O preview é ligado à ProjectVersion e ao hash do proxy. Annotation guarda frame, range, screenshot, região, targets e autor sem alterar a versão. O RenderElementMap resolve hit-test com transparência e prioridade. Texto livre é interpretado somente em operações tipadas; ambiguidades, proteção, policy e budget bloqueiam antes do commit. Aplicação cria versão e comparação. Batch é atômico por padrão.
