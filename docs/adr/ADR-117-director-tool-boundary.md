# ADR-117 — Ferramentas tipadas como única fronteira do Diretor

O modelo recebe cinco ferramentas: buscar mídia, criar plano, propor asset, avaliar candidato e propor patch. Cada chamada valida argumentos, workspace/projeto, rights, budget e base version antes de alcançar um application service. A interface não entrega Prisma, filesystem ou storage ao agente; mutação direta é impossível pelo tipo de dependência. A mesma fronteira está exposta externamente em `/api/director/tools`.
