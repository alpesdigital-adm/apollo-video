# W67 — protocolo do oráculo de pixels finais v1

Estado em 2026-10-09: **especificação; corpus, anotações e implementação pendentes**. Este documento não é um pré-registro de amostras concluído nem evidência de qualidade. Abrange F1.032 e os dois formatos do plano W61–W70. O holdout W62 permanece fechado e não pode ser reutilizado nesta prova.

## Independência e autoridade

O objeto avaliado é o MP4 disponível no storage, identificado por SHA-256 e tamanho, depois de full decode. RenderInput, RenderElementMap, plano de crop e observações do detector são informações a confrontar, nunca o ground truth. O oráculo não pode importar o solver, transformar boxes usando a trajetória que está avaliando ou repetir o detector do produto como única verificação.

Há duas provas diferentes. Um corpus controlado mede se o critic identifica defeitos conhecidos. A revisão do master real verifica os outputs W70 e permanece vinculada a cada novo arquivo. Passar a primeira prova não aprova o segundo caso nem qualifica o detector W62.

Ground truth de faces vem de caixas humanas com origem e licença verificáveis e convenção explícita (face visível ou cabeça inteira). Anotações geradas por modelo não recebem origem humana. Sem anotação de olhos, `eyeCoordinates` e `eyeDetection` são desconhecidos: proteger toda a caixa humana de face é uma regra conservadora de sobreposição, não detecção de olhos. Oclusão, cabeça fora da imagem ou ambiguidade exigem adjudicação; não se infere ausência de rosto da ausência de anotação.

## Congelamento obrigatório antes do primeiro render avaliado

O manifesto deve registrar: IDs de source/asset e hashes dos bytes, direitos e atribuição; IDs dos anotadores e método de adjudicação; boxes/máscaras e sua convenção; PTS e timebase racionais; split de desenvolvimento e avaliação com IDs disjuntos; OutputSpec de 9:16 e 16:9; safe area e regiões proibidas por formato; texto esperado, intervalos e limites de densidade; versão/hash do protocolo e código do oráculo. Registrar explicitamente campos desconhecidos.

Também congelar o pacote de defeitos, seu gerador independente, versão e labels esperados **antes de executar o renderer sob teste**. O gerador não pode usar o solver do produto para decidir onde colocar um defeito. A seleção não depende de resultados do detector. Licença, bytes, dimensões, orientação e existência das anotações são verificadas antes da seleção final. Manifesto incompleto bloqueia execução qualificada; não preencher IDs fictícios.

Cada formato exige no mínimo um controle limpo e dois outputs defeituosos distintos. Distribuir os três defeitos obrigatórios entre esses outputs: legenda sobre região humana protegida, sujeito cortado e CTA fora da safe area. Manter casos com defeito único para atribuição e um caso combinado para independência das issues. Controle limpo precisa de evidência humana suficiente para cada dimensão alegada; uma imagem sintética sem rosto só pode ser limpa quanto às dimensões que realmente exercita.

O congelamento inclui frames negativos adjacentes ao defeito, início/fim de cue, corte e transição. Não escolher somente frames favoráveis após render. Versões posteriores preservam falhas e usam conjunto de avaliação novo, sem rebatizar resultados antigos como aprovação.

## Medição independente

1. Ler o artifact pelo storage contratado, verificar hash/tamanho e decodificar todos os frames. Preservar lista de PTS, duração, resolução, pixel format, color metadata e logs sanitizados. Falha de decode ou frame ausente bloqueia o arquivo.
2. No corpus controlado, extrair todos os frames e máscaras de referência produzidas pelo gerador independente, com código separado do renderer. A referência de geometria deve ser validada contra anotações humanas; não tomar crop/anchor do produto como verdade. Comparar também o MP4 final com sua referência sem overlays para identificar tinta efetivamente desenhada, usando diferença de pixels e tolerância congelada em calibração. Ambiguidade de compressão ou registro retorna `unknown`, nunca ausência de tinta.
3. No master real, a geometria pode ser conferida por registro independente dos pixels source/output ou por anotação humana direta dos frames finais. Registro precisa de erro medido contra pontos de referência independentes; erro acima do limite congelado torna a amostra desconhecida. Não substituir esta verificação por aplicação do RenderElementMap às caixas source.
4. Verificar sobreposição da tinta real com região humana protegida, clipping do sujeito, safe area de texto/CTA/logo, texto e intervalos efetivamente desenhados, densidade e limites de velocidade/enquadramento acordados. OCR pode auxiliar a leitura, mas não serve sozinho como prova de ausência de texto, de face ou de clipping.
5. Conferir pixels contra mapa e receipt como teste de consistência adicional. Divergência gera issue; concordância dos dois artefatos derivados do mesmo renderer não estabelece segurança.

## Limiares e limites da afirmação

No corpus controlado obrigatório, a aceitação exige **zero falso seguro**, recall de defeitos **100%**, precisão **100%** e **zero amostras desconhecidas** nos casos congelados. A unidade é defeito × formato × intervalo, não quantidade de pixels. Reportar matriz de confusão e denominadores por classe e formato. Este pequeno conjunto prova regressões concretas, não uma garantia estatística populacional; os limiares W61 de detecção continuam independentes e não são relaxados.

Para colisão, qualquer interseção confirmada entre tinta e região protegida reprova. Não há tolerância que permita tinta sobre olhos/face. Margem de incerteza deve expandir a região protegida pelo erro máximo de registro/calibração previamente medido; erro não medido é desconhecido. Bounds de safe area são inclusivos e específicos do OutputSpec congelado. Não inventar uma safe area universal depois de ver o output.

Precisão de PTS é de um tick na timebase decodificada para associação de amostra. Esta tolerância não permite deslocar cue por um frame para evitar colisão: toda cue é verificada no primeiro e último frame em que há tinta e em todos os frames do corpus controlado. Erro de segmentação da tinta, densidade, velocidade/aceleração e margens editoriais precisam de valores e unidades no manifesto antes da avaliação; enquanto ausentes, essas dimensões não podem passar.

Amostragem esparsa no master limita a cobertura aos frames medidos. Aprovação de segurança integral requer cobertura suficiente explicitamente demonstrada e revisão integral dos dois vídeos; gaps permanecem `unknown/review`. Não interpolar segurança através de cortes, oclusões ou intervalos sem observação.

## Contrato de evidência e integração

Ponto de partida inspecionado: `src/v2/domain/format-quality-critic.ts` recebe `RenderElementMap`, subjects e anchor plan; suas medições de bounds, colisão e densidade são geométricas. `src/v2/application/render-workflow.ts` consome esse critic. Esses componentes podem continuar como verificações do plano/mapa, mas não comprovam leitura dos pixels finais. A implementação W67 exige um port de análise do artifact e evidência persistida independente antes de combinar o veredito; não basta renomear o report existente ou anexar o hash do MP4 às mesmas contas.

QualityReport imutável deve vincular workspace/projeto/ProjectVersion, variant/OutputSpec, operação e attempt produtor, MP4 SHA/tamanho, RenderInput hash, mapa/receipt hash, source hashes, protocolo/calibração/código do oráculo, manifesto de GT, sample IDs/PTS/frame hashes, cobertura/gaps, métricas e issues por elemento/range. Evidência e artefatos privados ficam referenciados por identidade segura; não incluir credenciais ou paths privados em resposta pública.

Persistência revalida autoridade, direitos atuais, identidade do artifact, base/variant aplicáveis e fencing/cancelamento. Report de versão ou hash anterior não autoriza o novo arquivo. Uma variante bloqueada não pode ser promovida ou exportada; a outra precisa de sua própria prova. Critic não altera StoryPlan canônico e não resolve uma issue por mutação do report antigo.

Testes obrigatórios incluem adulteração de bytes/map/receipt, report de outra variante/workspace, rights revogados, cancelamento e lease takeover antes da publicação, replay e Commands entre leitura/publicação. Guardar frames e diagnóstico antes de asserts; timeout não dispensa postflight de processos/conexões. Browser/revisão humana e aceitação do proprietário permanecem etapas separadas.

## Próximo gate concreto

Selecionar assets elegíveis independentes do holdout W62, obter/anexar anotações humanas e congelar o manifesto completo com tolerâncias de segmentação/registro. Até isso ocorrer, a W67 está em especificação; nenhum modelo reprovado, fixture mecânica ou supressão geral de legendas pode converter este documento em critic visual validado.

### Seleção inicial de metadados (antes de aquisição/render)

Usar somente Open Images validation e excluir todos os 180 IDs do manifesto W62 V5, além de qualquer ID adicional já submetido a inferência. Não ler pixels ou predições do holdout. Candidatos têm caixas humanas `xclick`/`activemil`, sem group/depiction/occluded/truncated; rotação 0, licença de imagem CC BY 2.0/4.0 em metadados, URLs HTTPS, OriginalMD5 válido e tamanho original entre 1 e 5.000.000 bytes. Estas condições não comprovam direitos atuais ou correspondência dos pixels adquiridos.

Dividir os IDs elegíveis por primeiro byte de SHA-256 UTF-8 `w67-v1|split|<id>`: menor que 128 desenvolvimento, demais avaliação. Em cada split, ordenar por SHA-256 `w67-v1|<split>|<stratum>|<id>` e ID como desempate; selecionar dois IDs com exatamente uma caixa elegível e dois com múltiplas caixas elegíveis. Rejeitar imagem que possua qualquer anotação facial inválida/excluída, para não transformar a exclusão de uma caixa em ausência de outro rosto. Congelar IDs e linhas originais antes de baixar. Ausência de quota ou falha de direitos/bytes é registrada, sem substituir por resultado conveniente. Imagens independentes publicadas fornecem GT humano de caixa facial; olhos continuam desconhecidos. Oito imagens são controles mecânicos, não corpus de qualificação populacional nem prova de movimento natural.

Fontes primárias consultadas: [descrição Open Images V7](https://storage.googleapis.com/openimages/web/factsfigures_v7.html) e [formato/downloads](https://storage.googleapis.com/openimages/web/download_v7.html). A descrição distingue caixas assistidas/verificadas por humanos no treinamento das caixas desenhadas manualmente em validation/test. Preservar o campo `Source` original. Em validation/test, a fonte declara anotação exaustiva para classes com label positivo, incluindo partes humanas; exigir também label humano positivo de face e vincular hash/linha do CSV. O subconjunto restrito de partes humanas descrito na mesma página refere-se ao treinamento e não é filtro adicional para este selector de validation.
