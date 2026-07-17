# ADR-115 — Seleção comparável de alternativas de montagem

Candidatos podem variar hook, ordem permitida, assets e pattern breaks. Hard gates executam antes de score e custo; candidatos reprovados continuam inspecionáveis, mas sem score. Todos os elegíveis usam a mesma versão de rubrica. O vencedor é determinístico por score, custo e ID, enquanto empate e baixa confidence exigem revisão. Diversidade é medida em quatro eixos.
