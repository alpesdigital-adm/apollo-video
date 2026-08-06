# ADR-094 — Dashboard baseado em estado real

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

O dashboard agrega projeto, versão corrente, operação pública durável mais
recente, annotations abertas e outputs concluídos da versão corrente. Dados
ausentes permanecem `null`, zero ou listas vazias, e relações incoerentes falham
fechado no domínio. Percentual e progressbar só existem quando
`completed`/`total` são medidos. Eventos disparam uma query sem cache; a leitura
anterior é cancelada e respostas fora de ordem não alteram a tela. A projeção
pública fechada determina linguagem e ação recomendada. E2E visual/browser,
execução da jornada HTTP/PostgreSQL preparada, implantação e aceite continuam
pendentes.
