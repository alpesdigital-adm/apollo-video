# ADR-153 — Identidade de câmera é a faixa dobrada, e colisão é recusa

- **Estado:** aceito
- **Data:** 2026-09-06
- **Contexto:** F4.012 e F4.013, Wave 20
- **Relacionado:** [ADR-127](ADR-127-color-and-export-matrix.md), [ADR-130](ADR-130-session-clock-and-sync-evidence.md), `docs/specs/05-multicam-sync.md` §29 e §30

## Contexto

Três lugares precisam falar da mesma câmera e nenhum deles usa a mesma
gramática de identificador:

- um ângulo é um `CaptureTrack`, cuja gramática de id
  (`capture-session.ts:50`) aceita maiúsculas, `:` e `/`;
- um alvo de cor é uma chave de `ColorPlan.cameras`, que precisa satisfazer o
  TOKEN de `color-and-export.ts:80` — `^[a-z0-9][a-z0-9._/-]{0,127}$`, só
  minúsculas;
- um clipe renderizado carrega `EditorialCutClip.cameraId`, e o renderer baixa a
  caixa antes de indexar o manifesto de cor
  (`ffmpeg-editorial-proxy-renderer.ts:507`).

Outros agregados pelos quais o mesmo id transita — diagnóstico de sync,
marcadores, síntese — recusam `/` de todo.

As duas alternativas erradas eram tentadoras. Chavear pelo **dispositivo**
falha porque duas faixas podem sair do mesmo corpo de câmera. Chavear pelo
**asset** falha porque uma faixa tem vários (um take partido é várias partes).

## Decisão

**A chave de câmera é o `trackId` em minúsculas, com todo caractere fora de
`[a-z0-9._-]` dobrado para `-`, derivada num único lugar
(`src/v2/domain/camera-identity.ts`).**

A dobra é lossy de propósito: é ela que torna a chave portável entre as três
gramáticas. E lossy quer dizer que duas faixas distintas podem cair na mesma
chave.

**Uma colisão é recusada, nunca resolvida em silêncio**, com
`CAMERA_IDENTITY_COLLISION`, nomeando as duas faixas. Quem precisa de mais de
uma chave chama `colorCameraIdsForSession`, que devolve o mapa inteiro; pedir
uma faixa de cada vez, por `colorCameraIdForTrack`, não permite pular a
checagem, porque a checagem só existe onde o conjunto inteiro é visível.

## Consequências

**O que melhora.** Uma correção de cor aplicada "na outra câmera" é o pior tipo
de erro possível: ela renderiza, é plausível, e não aparece em log nenhum. A
recusa transforma esse erro invisível numa mensagem que nomeia as duas faixas.

**O que piora.** Uma sessão cujas faixas se chamem `cam/A` e `cam-A` não pode
ser dirigida nem casada até que alguém renomeie uma delas. É uma parede, e
declarada: o texto do erro diz exatamente qual par colidiu e qual chave os dois
produziram.

**O que fica fechado por consequência.** A função é pura, total e determinística
— o mesmo `trackId` dá a mesma chave em qualquer máquina — o que importa porque
a chave entra em hash canônico de plano de cor e de compilação.
