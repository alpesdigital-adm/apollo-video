'use client'

import type { ReactNode } from 'react'

type Beat = {
  index: number
  text: string
  startFrame: number
  endFrame: number
  sceneType: string | null
  thumbUrl: string | null
}

type Decision = {
  id: string
  summary: string
  decision: string
  confidence: number
}

type Annotation = { id: string; text: string; status: string; frame: number }

export type ApolloEditorWorkspaceProps = {
  project: {
    name: string
    status: string
    format: string
    engineKind?: string
    videoDuration: number
    subtitles: unknown[]
    scenes: unknown[]
    editPlan?: { overlays: unknown[]; durationFrames: number } | null
    directorDecisions?: Decision[]
    reviewAnnotations?: Annotation[]
    renderJob?: { progress: number } | null
  }
  beats: Beat[]
  player: ReactNode
  refineInput: string
  refineError: string | null
  isRefining: boolean
  isRendering: boolean
  annotationMode: boolean
  annotationText: string
  annotationOverlay: ReactNode
  onBack: () => void
  onRender: () => void
  onRefine: () => void
  onRefineInput: (value: string) => void
  onBeatClick: (beat: Beat) => void
  onToggleAnnotation: () => void
  onAnnotationText: (value: string) => void
  onSaveAnnotation: () => void
}

const navItems = [
  ['▣', 'Projetos'],
  ['▤', 'Produção em lote'],
  ['□', 'Biblioteca'],
  ['♙', 'Apresentadores IA'],
  ['◇', 'Marca e segurança'],
  ['⚙', 'Configurações']
]

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds || 0))
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    created: 'Preparando',
    normalizing: 'Normalizando',
    transcribing: 'Transcrevendo',
    analyzing: 'Direção IA',
    ready: 'Revisão',
    rendering: 'Renderizando',
    complete: 'Concluído',
    error: 'Atenção necessária'
  }
  return labels[status] || status
}

export function ApolloEditorWorkspace({
  project,
  beats,
  player,
  refineInput,
  refineError,
  isRefining,
  isRendering,
  annotationMode,
  annotationText,
  annotationOverlay,
  onBack,
  onRender,
  onRefine,
  onRefineInput,
  onBeatClick,
  onToggleAnnotation,
  onAnnotationText,
  onSaveAnnotation
}: ApolloEditorWorkspaceProps) {
  const ready = ['ready', 'rendering', 'complete'].includes(project.status)
  const duration = Math.max(project.videoDuration || 1, 1)
  const fps = Math.max(project.editPlan?.durationFrames ? project.editPlan.durationFrames / duration : 30, 1)
  const decisions = project.directorDecisions?.slice(0, 4) || []
  const mediaBeats = beats.filter((beat) => beat.thumbUrl || beat.sceneType).slice(0, 4)

  return (
    <div className="h-screen min-h-[720px] overflow-hidden bg-[#080a0d] text-[#f4f4f2] selection:bg-[#ffb51b]/30">
      <div className="grid h-full grid-cols-[206px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/10 bg-[#090b0e]">
          <div className="flex h-[62px] items-center border-b border-white/10 px-5 font-serif text-[24px] tracking-[0.08em] text-[#ffbd2e]">
            APOLLO
          </div>
          <button className="mx-2 mt-2 flex items-center justify-between rounded border border-white/10 bg-white/[0.055] px-3 py-2 text-left text-xs">
            <span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-full bg-white/10">A</span>Alpes Digital</span>
            <span className="text-white/45">⌄</span>
          </button>
          <nav className="mt-3 space-y-1 px-2" aria-label="Navegação principal">
            {navItems.map(([icon, label], index) => (
              <button key={label} onClick={index === 0 ? onBack : undefined} className={`flex w-full items-center gap-3 rounded px-3 py-2.5 text-left text-[13px] transition ${index === 0 ? 'border-l-2 border-[#ffb51b] bg-[#ffb51b]/10 text-white' : 'text-white/65 hover:bg-white/5 hover:text-white'}`}>
                <span className={index === 0 ? 'text-[#ffb51b]' : 'text-white/55'}>{icon}</span>{label}
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t border-white/10 p-3">
            <div className="flex items-center gap-2 text-xs"><span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-[#ffbd2e] to-[#6f4311] font-bold text-black">LN</span><span><b className="block font-medium">Leandro</b><small className="text-white/45">Administrador</small></span></div>
          </div>
        </aside>

        <main className="grid min-h-0 grid-rows-[62px_minmax(300px,1fr)_286px]">
          <header className="flex items-center gap-4 border-b border-white/10 bg-[#0b0d10] px-5">
            <button onClick={onBack} className="text-xl text-white/65 hover:text-white" aria-label="Voltar">←</button>
            <h1 className="min-w-0 truncate text-[15px] font-semibold">{project.name}</h1>
            <span className="rounded border border-[#ffb51b]/30 bg-[#ffb51b]/8 px-3 py-1 text-[11px] text-[#ffc240]">{statusLabel(project.status)}</span>
            <div className="ml-auto flex items-center gap-3 text-xs">
              <span className="hidden text-white/40 xl:inline">Objetivo</span><button className="hidden rounded border border-white/10 bg-white/[0.035] px-3 py-2 xl:block">Distribuição · Aquecimento</button>
              <span className="text-white/40">Formatos</span>
              <div className="flex rounded border border-white/10 bg-black/20 p-0.5"><button className="rounded bg-[#ffb51b] px-3 py-1.5 font-semibold text-black">{project.format}</button><button className="px-3 py-1.5 text-white/55">4:5</button><button className="px-3 py-1.5 text-white/55">1:1</button></div>
              <button onClick={onRender} disabled={isRendering || project.status === 'rendering'} className="rounded bg-[#ffb51b] px-5 py-2 font-semibold text-black transition hover:bg-[#ffc64d] disabled:opacity-50">{project.status === 'rendering' ? `${Math.round(project.renderJob?.progress || 0)}%` : isRendering ? 'Iniciando…' : '▶ Renderizar'}</button>
            </div>
          </header>

          <section className="grid min-h-0 grid-cols-[268px_minmax(360px,1fr)_350px]">
            <aside className="min-h-0 overflow-y-auto border-r border-white/10 bg-[#0d1013]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><b className="text-xs tracking-wide">MÍDIA</b><span className="text-white/45">⌕　≡</span></div>
              <div className="space-y-3 p-3">
                {(mediaBeats.length ? mediaBeats : beats.slice(0, 4)).map((beat, index) => (
                  <button key={beat.index} onClick={() => onBeatClick(beat)} className="group block w-full text-left">
                    <div className="mb-1 flex justify-between text-[11px] text-white/65"><span>{beat.sceneType || (index === 0 ? 'Vídeo principal' : 'Trecho selecionado')}</span><span>⋮</span></div>
                    <div className="relative aspect-video overflow-hidden rounded border border-white/10 bg-gradient-to-br from-[#25292c] to-[#0b0d0f]">
                      {beat.thumbUrl ? <img src={beat.thumbUrl} alt="" className="h-full w-full object-cover opacity-80 transition group-hover:opacity-100" /> : <div className="grid h-full place-items-center text-2xl text-white/15">▶</div>}
                      <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px]">{formatTime((beat.endFrame - beat.startFrame) / fps)}</span>
                    </div>
                  </button>
                ))}
                {!beats.length && <div className="rounded border border-dashed border-white/15 p-6 text-center text-xs text-white/35">A mídia aparecerá aqui após a análise.</div>}
              </div>
              <button className="mx-3 mb-3 w-[calc(100%-1.5rem)] rounded border border-white/10 py-2 text-xs text-white/55 hover:bg-white/5">＋ Adicionar mídia</button>
            </aside>

            <div className="relative flex min-h-0 flex-col bg-[#07090b]">
              <div className="absolute left-4 top-3 z-20 flex gap-2 text-[11px]"><span className="rounded bg-[#11151a] px-2 py-1 text-[#b790ff]">⌁ {Math.max(1, Math.round(beats.length * .2))} Hooks</span><span className="rounded bg-[#11151a] px-2 py-1 text-[#71aaff]">▦ {Math.max(1, Math.round(beats.length * .6))} Corpos</span><span className="rounded bg-[#11151a] px-2 py-1 text-[#65d98c]">♙ {Math.max(1, Math.round(beats.length * .2))} CTAs</span></div>
              <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5 pt-10">
                {ready ? <div className={`relative max-h-full overflow-hidden border border-[#ffb51b]/60 bg-black shadow-[0_0_35px_rgba(255,181,27,.08)] ${project.format === '9:16' ? 'h-full aspect-[9/16]' : 'w-[88%] aspect-video'}`}>{player}{annotationOverlay}</div> : <div className="w-[420px] rounded-xl border border-white/10 bg-[#101318] p-8 text-center"><div className="mx-auto mb-5 size-12 animate-spin rounded-full border-2 border-white/10 border-t-[#ffb51b]"/><h2 className="font-semibold">{statusLabel(project.status)}</h2><p className="mt-2 text-sm text-white/45">O Diretor está preparando o primeiro corte. Você pode sair desta tela; o processamento continuará.</p></div>}
              </div>
              <div className="flex h-12 items-center justify-between border-t border-white/10 bg-[#0d1013] px-4 py-2 text-xs"><button className="rounded border border-white/10 px-3 py-1.5">{project.format}⌄</button><div className="flex items-center gap-5 text-white/75"><span>◀◀</span><span className="text-xl">▶</span><span>▶▶</span><span>◖</span><span className="text-white/40">{formatTime(project.videoDuration)} / {formatTime(project.videoDuration)}</span></div><button onClick={onToggleAnnotation} className={`rounded border px-3 py-1.5 ${annotationMode ? 'border-[#ffb51b] bg-[#ffb51b]/10 text-[#ffc240]' : 'border-white/10 text-white/55'}`}>⌖ Anotar</button></div>
              {annotationMode && <div className="flex gap-2 border-t border-white/10 bg-[#111419] p-2"><input value={annotationText} onChange={(event) => onAnnotationText(event.target.value)} placeholder="Explique o ajuste desta área ou da cena" className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-3 py-2 text-xs outline-none focus:border-[#ffb51b]/50"/><button onClick={onSaveAnnotation} disabled={!annotationText.trim()} className="rounded bg-[#ffb51b] px-3 text-xs font-semibold text-black disabled:opacity-40">Salvar</button></div>}
            </div>

            <aside className="min-h-0 overflow-y-auto border-l border-white/10 bg-[#0e1115]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><b className="text-sm">✦ Diretor IA</b><span className="text-white/45">⌖　⋮</span></div>
              <div className="grid grid-cols-3 border-b border-white/10 text-center text-xs"><button className="py-3 text-white/50">Plano</button><button className="border-b-2 border-[#ffb51b] py-3 text-[#ffc240]">Revisão</button><button className="py-3 text-white/50">Histórico</button></div>
              <div className="space-y-2.5 p-3 text-xs">
                <section className="rounded border border-white/10 bg-white/[0.025] p-3"><div className="mb-2 flex justify-between"><b>Briefing do projeto</b><span>✎</span></div><dl className="grid grid-cols-[55px_1fr] gap-y-1 text-white/55"><dt>Objetivo:</dt><dd>Gerar demanda e elevar consciência</dd><dt>Público:</dt><dd>Definido pelo workspace</dd><dt>Tom:</dt><dd>Confiante, direto e natural</dd></dl></section>
                <section className="rounded border border-white/10 bg-white/[0.025] p-3"><b className="mb-2 block">Resumo do tratamento</b><p className="leading-relaxed text-white/55">Estrutura validada com foco em clareza, ritmo dinâmico e cortes sincronizados às falas.</p></section>
                <section className="rounded border border-white/10 bg-white/[0.025] p-3"><b className="mb-2 block">Decisões da cena atual</b>{decisions.length ? decisions.map((decision) => <div key={decision.id} className="flex gap-2 border-t border-white/8 py-2 first:border-0"><span className="text-[#ffb51b]">✦</span><span className="min-w-0 flex-1"><b className="block truncate font-medium">{decision.summary}</b><small className="text-white/45">{decision.decision}</small></span><span className="text-emerald-400">✓</span></div>) : <><div className="flex gap-2 py-2"><span className="text-[#ffb51b]">✦</span><span><b className="block font-medium">Estrutura narrativa</b><small className="text-white/45">Gancho e progressão analisados.</small></span><span className="ml-auto text-emerald-400">✓</span></div><div className="flex gap-2 border-t border-white/8 py-2"><span className="text-[#ffb51b]">▧</span><span><b className="block font-medium">Composição visual</b><small className="text-white/45">B-roll e legendas posicionados.</small></span><span className="ml-auto text-emerald-400">✓</span></div></>}</section>
                <section className="rounded border border-white/10 bg-white/[0.025] p-3"><div className="mb-2 flex items-center justify-between"><b>Qualidade estimada</b><span className="text-emerald-400">92 · Excelente</span></div><div className="h-1 overflow-hidden rounded bg-white/10"><div className="h-full w-[92%] bg-emerald-400"/></div></section>
                <textarea value={refineInput} onChange={(event) => onRefineInput(event.target.value)} placeholder="Peça uma correção ao Diretor…" className="min-h-20 w-full resize-none rounded border border-white/10 bg-black/30 p-3 text-xs outline-none focus:border-[#ffb51b]/50"/>
                {refineError && <p className="rounded bg-red-500/10 p-2 text-red-300">{refineError}</p>}
                <button onClick={onRefine} disabled={isRefining || !refineInput.trim()} className="w-full rounded bg-[#ffb51b] py-2.5 font-semibold text-black disabled:opacity-40">{isRefining ? 'Aplicando…' : '✦ Aplicar correções'}</button>
              </div>
            </aside>
          </section>

          <section className="grid min-h-0 grid-cols-[206px_minmax(0,1fr)] border-t border-white/10 bg-[#0b0e11]">
            <div className="border-r border-white/10 pt-8 text-[11px] text-white/65">{['Câmera A', 'Captura de tela', 'Áudio principal', 'B-roll', 'Legendas', 'Anotações'].map((lane) => <div key={lane} className="flex h-[37px] items-center justify-between border-t border-white/5 px-3"><span>{lane}</span><span className="text-white/35">◉　▣</span></div>)}</div>
            <div className="min-w-0 overflow-hidden">
              <div className="relative h-8 border-b border-white/10 text-[9px] text-white/40">{[0, .2, .4, .6, .8, 1].map((point) => <span key={point} className="absolute top-2" style={{left:`${point * 96 + 1}%`}}>{formatTime(duration * point)}</span>)}</div>
              <div className="relative">
                <div className="flex h-[37px] gap-0.5 border-b border-white/5 p-1">{beats.map((beat) => <button key={beat.index} onClick={() => onBeatClick(beat)} title={beat.text} className="min-w-5 overflow-hidden rounded-sm border border-white/10 bg-[#24292d] text-left text-[8px] text-white/55" style={{width:`${Math.max(2.5, ((beat.endFrame - beat.startFrame) / fps / duration) * 100)}%`}}>{beat.thumbUrl && <img src={beat.thumbUrl} alt="" className="h-full w-full object-cover opacity-55"/>}</button>)}</div>
                <div className="flex h-[37px] gap-1 border-b border-white/5 p-1">{beats.filter((beat) => beat.sceneType?.includes('Split') || beat.sceneType?.includes('Insert')).map((beat) => <div key={beat.index} className="rounded-sm bg-[#275999] px-2 py-1 text-[9px]">▣ {beat.sceneType}</div>)}</div>
                <div className="h-[37px] border-b border-white/5 bg-[repeating-linear-gradient(90deg,transparent_0,transparent_3px,rgba(74,192,119,.6)_4px,transparent_5px)] opacity-70"/>
                <div className="flex h-[37px] gap-1 border-b border-white/5 p-1">{beats.filter((beat) => beat.sceneType && beat.sceneType !== 'FullScreen').map((beat) => <div key={beat.index} className="rounded-sm border border-[#35a789] bg-[#176653]/70 px-2 py-1 text-[9px]">{beat.sceneType}</div>)}</div>
                <div className="flex h-[37px] gap-1 border-b border-white/5 p-1">{beats.slice(0, 10).map((beat) => <button key={beat.index} onClick={() => onBeatClick(beat)} className="min-w-16 flex-1 truncate rounded-sm bg-[#563d8c] px-2 text-[9px] text-white/75">{beat.text}</button>)}</div>
                <div className="flex h-[37px] gap-5 p-1">{(project.reviewAnnotations || []).map((item, index) => <div key={item.id} className="rounded-sm bg-[#5d481f] px-2 py-1 text-[9px] text-[#ffce65]">{index + 1}　{item.text}</div>)}</div>
                <div className="pointer-events-none absolute inset-y-0 left-[38%] w-px bg-[#ffb51b] shadow-[0_0_8px_#ffb51b]"><span className="absolute -top-1 -translate-x-1/2 text-[#ffb51b]">▼</span></div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
