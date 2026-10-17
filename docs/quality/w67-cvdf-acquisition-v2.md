# W67 — aquisição de derivados oficiais v2

Pré-registro de aquisição, 2026-10-09, anterior à seleção v2 e a qualquer download, render ou oráculo v2. Complementa `w67-final-pixel-oracle-v1.md`; não altera os critérios do critic, quotas ou separação entre prova controlada e W70.

V1 permanece encerrada: primeiro landing404, segundo original429 depois de licença confirmada, seis não tentados; nenhum pixel adquirido. O inventário local posterior encontrou 27 IDs com evidência histórica de direitos, mas apenas dois originais autenticáveis; não atende às quotas. Não retomar Flickr nem mudar hostname para repetir os pedidos de originais bloqueados.

## Universo e seleção antes de adquirir

Usar Open Images validation, com os mesmos filtros de caixas humanas/label positivo, rotação 0 e metadados da v1. Excluir todos os 180 IDs W62 e quaisquer IDs já inferidos. Não abrir pixels/predições do holdout W62. Os oito IDs W67 v1 não foram inferidos, mas não serão selecionados nesta tentativa: usar o inventário local congelado `w67-local-cache-inventory-v1-r2.json`, SHA-256 `4d273863096f75a6aa3c86944657496359b757e7c9d78c5f6c6389f69c935b2d`, como ponto de partida dos candidatos já inventariados.

Antes de selecionar, revalidar localmente HTML, hash, URL da foto, licença CC BY 2.0/4.0, autor/atribuição e referência do manifesto preservado para todos os candidatos. Arquivo presente sem essa evidência não é elegível. Evidência é uma concessão de licença capturada anteriormente, com data/limitações registradas; não alegar consulta atual ao site. Nenhuma nova requisição a Flickr é parte desta versão.

Manter split definido por SHA-256 `w67-v1|split|<id>` (<128 desenvolvimento, demais avaliação), sem mover os dois originais disponíveis entre splits. Ordenar cada stratum por SHA-256 `w67-v2|<split>|<stratum>|<id>` e ID. Selecionar exatamente dois single e dois multiple por split, oito IDs no total. Publicar inventário completo de elegibilidade, quotas e hashes antes de congelar seleção. Se qualquer quota falhar, não baixar. Não diminuir quota nem substituir um selecionado após falha de aquisição; preservar falha e gate aberto.

## Bytes novos e correspondência das anotações

Fonte de pixels desta versão é o [mirror CVDF indicado nos downloads oficiais Open Images](https://storage.googleapis.com/openimages/web/download_v7.html): `https://open-images-dataset.s3.amazonaws.com/validation/<image-id>.jpg`. São derivados JPEG, frequentemente redimensionados, com nova identidade SHA-256; não são os bytes autenticados por OriginalMD5/OriginalSize. Não aplicar esses dois campos do original ao derivado.

Para cada ID congelado, obter somente a URL oficial acima, um request por vez, timeout 30 s, máximo 5 MB; total do run limitado a 5 minutos, owner/PID e término verificados. HTTP429 interrompe sem retry ou host alternativo. Registrar URL/status, Content-Length, ETag simples MD5, SHA-256/MD5 locais, dimensões, formato e EXIF. Exigir JPEG íntegro, dimensões positivas, lado maior até1024, EXIF ausente/1 e ETag MD5 correspondente; outro formato/orientação/identidade falha sem correção silenciosa. Guardar resultado separado do manifesto de seleção imutável.

O vínculo entre box normalizada e derivado usa a publicação oficial por split/ImageID e rotação metadata0. Quando original autenticado estiver disponível, comparar aspecto com tolerância de arredondamento de resize (até um pixel por dimensão) e orientação por comparação independente dos pixels; registrar método e resultado sem presumir passagem. Os dois originais já verificados podem ajudar essa conferência se selecionados, mantendo seus splits. Não escolher IDs porque a comparação posterior ficou favorável.

Sem comparação original, declarar `aspect_original_unverified` e `orientation_original_unverified`, mesmo se o JPEG não tiver EXIF de rotação. A origem oficial dá proveniência, não uma medição individual de correspondência. Se essa incerteza impedir determinar onde a face humana realmente está no derivado, a dimensão facial do critic permanece desconhecida e não pode aprovar um controle limpo. Não transformar boxes previstas por detector ou inspeção automática em nova anotação humana. A convenção face/cabeça e os olhos desconhecidos continuam explícitos.

## Congelamento posterior e limite

Depois da aquisição, registrar hashes únicos dos oito derivados, bytes de direitos, linhas/CSV humanos, split/stratum, falhas e correspondência geométrica. Duplicidade exata entre splits bloqueia; SHA diferente não comprova ausência de near-duplicate. Nenhum render/oráculo começa antes do manifesto completo e da calibração/labels de defeito especificados no protocolo principal. Quotas cumpridas na aquisição não significam corpus qualificado, modelo aprovado, W67 concluída ou aceite W70.

## Encerramento desta tentativa de seleção, 2026-10-09

O seletor local `scripts/validation/w67-select-official-derivatives-v2.py` (SHA-256 `32a8c7883f1639e29c80c3cd56f64b48af233343e1da9e42a92ab556d006e6a5`) revalidou os 27 IDs do inventário congelado. Conferiu os hashes dos CSVs e dos três manifestos de cache, filtros Open Images, exclusão dos 180 IDs W62 e oito W67 v1, URL e hash do HTML histórico, licença CC BY 2.0/4.0, nome e perfil do autor. Isso é verificação de evidência local capturada anteriormente, **não** consulta atual ao Flickr.

O inventário final privado é `C:/Users/leand/Documents/Apollo/w61-70-20261008/w67-official-derivative-eligibility-v2-r2.json`, SHA-256 `ddd50b1a597a0ce7c07158a9406977796711d60e37286b9a8e54578c34e7374d`. Vinte e seis candidatos passaram a revalidação; `491b80ed0e159494` não passou porque o campo `Author` da metadata diz `Bodie Strain` e o HTML preservado identifica o autor como `pumpkinmook`. O perfil aponta à mesma conta, mas o nome não foi equiparado por inferência. A primeira saída `w67-official-derivative-eligibility-v2.json` foi preservada como diagnóstico antes de corrigir a contabilização de múltiplas tentativas de cache; `-r2` é o inventário final.

| Split | Single elegíveis | Multiple elegíveis | Quota requerida |
| --- | ---: | ---: | ---: |
| Development | 7 | 0 | 2 de cada |
| Evaluation | 18 | 1 | 2 de cada |

Faltam dois `multiple` de development e um de evaluation. A seleção v2 **não foi criada**; nenhum derivado CVDF foi baixado, decodificado ou inferido. O gate de corpus permanece aberto. Não reduzir quota nem substituir IDs por resultado de pixels.
