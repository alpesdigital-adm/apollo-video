# ADR-094 — Dashboard baseado em estado real

> **Status:** Accepted
>
> **Data:** 17 de julho de 2026

O dashboard agrega projeto e job recente, representa versão/review desconhecidos
como `null` e só mostra percentual quando completed/total são medidos. Eventos
disparam nova query. Seis estados determinam linguagem e ação recomendada.
