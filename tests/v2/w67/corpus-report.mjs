import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * W67 controlled corpus - the publication of a run: Markdown tables from `evaluation.json`, `render-ledger.json` and the frozen manifest.
 * Pure formatting: it computes nothing the evaluator did not, and it prints every failure. It is not part of the frozen measurement code.
 *
 *   node corpus-report.mjs <frozen.json> <run-dir> <out.md>
 */
const [frozenPath, runDirectory, outPath] = process.argv.slice(2)
if (!frozenPath || !runDirectory || !outPath) throw new Error('usage: corpus-report.mjs <frozen.json> <run-dir> <out.md>')
const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'))
const evaluation = JSON.parse(readFileSync(join(runDirectory, 'evaluation.json'), 'utf8'))
const ledger = JSON.parse(readFileSync(join(runDirectory, 'render-ledger.json'), 'utf8'))
const pct = (value) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`)
const lines = []
const { summary } = evaluation
lines.push('### Resultado por defeito × formato', '')
lines.push('| defeito | formato | unidades rotuladas | detectadas | exatas | falso seguro | marcações em unidade sem rótulo | quadros extras | quadros unknown |')
lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const row of summary.rows) lines.push(`| ${row.className} | ${row.format} | ${row.labelledUnits} | ${row.detectedUnits} | ${row.exactUnits} | ${row.falseSafeUnits} | ${row.falsePositiveUnits} | ${row.extraFrames} | ${row.unknownFrames} |`)
lines.push('', `Totais: ${summary.totals.outputs} saídas, ${summary.totals.labelledUnits} unidades rotuladas; detectadas ${summary.totals.detectedUnits} (recall ${pct(summary.totals.recallDetected)}), exatas ${summary.totals.exactUnits} (recall exato ${pct(summary.totals.recallExact)}); falso seguro ${summary.totals.falseSafeUnits}; falsos positivos ${summary.totals.falsePositiveUnits}; precisão exata ${pct(summary.totals.precisionExact)}; hard de código sem classe ${summary.totals.unmappedHard}; quadros unknown ${summary.totals.unknownFrames}; falhas de decodificação ${summary.totals.decodeFailures}. **Aceite: ${summary.accepted ? 'ATENDIDO' : 'NÃO ATENDIDO'}.**`, '')
lines.push('### Por saída (veredito, issues, unknowns por verificação)', '')
lines.push('| saída | veredito | unknown por verificação | issues hard | warnings |')
lines.push('| --- | --- | --- | --- | --- |')
for (const entry of evaluation.evaluations) {
  const unknown = Object.entries(entry.unknownByCheck).map(([check, count]) => `${check}: ${count}`).join('; ') || '—'
  const hard = entry.units.filter((unit) => unit.flaggedFrames > 0).map((unit) => `${unit.className} ${unit.flaggedFrames} quadros (${unit.exact ? 'exato' : `${unit.insideFrames} dentro / ${unit.outsideFrames} fora`})`).join('; ') || '—'
  const other = entry.unmappedHard.map((issue) => `${issue.code} ${issue.range.join('-')}`).join('; ')
  lines.push(`| ${entry.outputId} | ${entry.verdict} | ${unknown} | ${[hard, other].filter(Boolean).join('; ') || '—'} | ${entry.warnings.map((warning) => warning.code).join(', ') || '—'} |`)
}
lines.push('', '### Unidades rotuladas não exatas ou com falso seguro', '')
const failing = evaluation.evaluations.flatMap((entry) => entry.units.filter((unit) => unit.labelled && (!unit.exact || unit.falseSafe)))
if (failing.length === 0) lines.push('Nenhuma.')
else {
  lines.push('| saída | classe | intervalo | quadros marcados dentro | fora | falso-seguro (quadros) | unknown (quadros) |', '| --- | --- | --- | ---: | ---: | ---: | ---: |')
  for (const unit of failing) lines.push(`| ${unit.outputId} | ${unit.className} | ${unit.interval?.join('–')} | ${unit.insideFrames} | ${unit.outsideFrames} | ${unit.falseSafeFrames} | ${unit.unknownFrames} |`)
}
lines.push('', '### Oráculo × caixa humana (informativo, quadros com a caixa inteira no canvas)', '')
lines.push('| modelo | quadros com rosto inteiro | encontrado (IoU ≥ 0,3) | recall | detecções sem relação com a caixa |', '| --- | ---: | ---: | ---: | ---: |')
const totals = {}
for (const extra of evaluation.extras) for (const [model, counters] of Object.entries(extra.oracleVsHumanBox)) {
  totals[model] ??= { visible: 0, found: 0, extra: 0 }
  totals[model].visible += counters.visible; totals[model].found += counters.found; totals[model].extra += counters.extra
}
for (const [model, counters] of Object.entries(totals)) lines.push(`| ${model} | ${counters.visible} | ${counters.found} | ${pct(counters.visible ? counters.found / counters.visible : null)} | ${counters.extra} |`)
lines.push('', '### Registro por pixels × construção (informativo)', '')
lines.push('| saída | quadros medidos | IoU mediana da projeção com a caixa humana por construção | IoU mínima |', '| --- | ---: | ---: | ---: |')
for (const extra of evaluation.extras) lines.push(`| ${extra.outputId} | ${extra.projection.frames} | ${extra.projection.medianIou?.toFixed(3) ?? 'n/a'} | ${extra.projection.minIou?.toFixed(3) ?? 'n/a'} |`)
lines.push('', '### Sanidade dos rótulos nos pixels entregues (a tinta toca a caixa humana? o CTA excede a safe area?)', '')
lines.push('| saída | legenda (quadro, pixels de tinta, dentro da caixa humana) | CTA (quadro, excesso em px) | fração visível da caixa humana no quadro 60 |', '| --- | --- | --- | ---: |')
for (const extra of evaluation.extras) {
  const caption = extra.labelSanity.captionOverGroundTruthFace
  lines.push(`| ${extra.outputId} | ${caption.frame}, ${caption.inkPixels}, ${caption.inkInsideHumanBox} | ${extra.labelSanity.ctaOvershootPixels.frame}, ${extra.labelSanity.ctaOvershootPixels.overshoot === null ? 'sem tinta' : extra.labelSanity.ctaOvershootPixels.overshoot.toFixed(1)} | ${extra.labelSanity.groundTruthVisibleShareAtFrame60.toFixed(2)} |`)
}
lines.push('', '### Planejador: onde a cue caiu × faixa-alvo do rótulo', '')
lines.push('| saída | faixa decidida | faixa-alvo | bloqueadores fabricados |', '| --- | --- | --- | --- |')
for (const entry of ledger.outputs) lines.push(`| ${entry.outputId} | ${entry.plannerDecision.anchor} | ${entry.plannerDecision.expectedTarget} | ${entry.plannerDecision.blockers.join(', ') || '—'} |`)
lines.push('', '### Porta de exportação (decisão do código de produção sobre os relatórios reais)', '')
lines.push('| saída | aprovada | códigos que bloqueiam | códigos de aviso |', '| --- | --- | --- | --- |')
for (const decision of evaluation.exportGate.decisions) lines.push(`| ${decision.outputId} | ${decision.approved ? 'sim' : 'não'} | ${decision.blockingCodes.join(', ') || '—'} | ${decision.warningCodes.join(', ') || '—'} |`)
lines.push('', `Arquivos promovidos (emulação por cópia endereçada por conteúdo): ${evaluation.exportGate.promotedFiles}; variantes bloqueadas: ${evaluation.exportGate.blockedVariants}.`, '')
lines.push('| foto | 9:16 | 16:9 | aprovados | bloqueados |', '| --- | --- | --- | --- | --- |')
for (const entry of evaluation.exportGate.independence) lines.push(`| ${entry.imageId} | ${entry.tall} | ${entry.wide} | ${entry.approved.join(', ') || '—'} | ${entry.blocked.join(', ') || '—'} |`)
lines.push('', '### Identidade do run', '')
lines.push(`- manifesto congelado: \`manifestHash\` ${frozen.manifestHash}; FFmpeg ${ledger.ffmpegVersion} (SHA-256 ${ledger.ffmpegSha256}); harness ${ledger.harnessRunId}; render ${ledger.startedAt} → ${ledger.finishedAt}`)
lines.push(`- fontes: ${ledger.sources.map((source) => `${source.imageId} (mirror ${source.mirrorSha256.slice(0, 12)}…, mp4 ${source.sourceSha256.slice(0, 12)}…)`).join('; ')}`)
writeFileSync(outPath, `${lines.join('\n')}\n`)
console.log(`wrote ${outPath}`)
