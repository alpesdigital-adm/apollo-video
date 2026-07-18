import type { Metadata } from 'next'

import LoginForm from './LoginForm'

export const metadata: Metadata = {
  title: 'Entrar — Apollo Studio',
  description: 'Acesso privado ao workspace de produção do Apollo Studio.',
}

const frames = [
  { label: 'HOOK', width: 'w-[38%]', tone: 'bg-[#7167ff]' },
  { label: 'CORPO', width: 'w-[74%]', tone: 'bg-[#343848]' },
  { label: 'CTA', width: 'w-[28%]', tone: 'bg-[#9b7aff]' },
]

export default function LoginPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#08090d] text-[#f4f5f7] lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(440px,0.92fr)]">
      <section className="relative hidden min-h-screen overflow-hidden border-r border-white/8 bg-[#0b0c12] p-12 lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div className="absolute inset-0 opacity-[0.035]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '48px 48px' }} />
        <div className="relative flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-[#7167ff] text-lg font-black text-white shadow-[0_0_36px_rgba(113,103,255,0.28)]">A</div>
          <div><p className="text-[11px] uppercase tracking-[0.24em] text-[#858a9b]">Apollo studio</p><p className="mt-0.5 text-sm font-medium text-[#d7d9e0]">Direção e edição inteligente</p></div>
        </div>

        <div className="relative max-w-2xl py-16">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.24em] text-[#8e87ff]">Sala de edição</p>
          <h1 className="text-5xl font-semibold leading-[0.98] tracking-[-0.055em] xl:text-7xl">Cada corte<br /><span className="text-[#777c8d]">tem uma razão.</span></h1>
          <p className="mt-7 max-w-lg text-base leading-7 text-[#8d92a2]">Entre para acompanhar decisões do diretor, revisar cenas e transformar material bruto em campanhas prontas para distribuição.</p>

          <div className="mt-14 overflow-hidden rounded-2xl border border-white/10 bg-[#07080c] shadow-2xl shadow-black/30">
            <div className="flex h-10 items-center justify-between border-b border-white/8 px-4 text-[10px] uppercase tracking-[0.18em] text-[#676c7d]"><span>Timeline / campanha 01</span><span>00:00:24:18</span></div>
            <div className="relative space-y-2 p-4 pb-5">
              <div className="absolute bottom-0 left-[27%] top-0 w-px bg-[#8b83ff] shadow-[0_0_12px_#7167ff]"><span className="absolute -left-[3px] -top-px h-2 w-2 rotate-45 bg-[#8b83ff]" /></div>
              {frames.map((frame, index) => <div className="grid grid-cols-[54px_1fr] items-center gap-3" key={frame.label}><span className="text-[9px] font-semibold tracking-[0.14em] text-[#5e6373]">V{index + 1}</span><div className="h-9 overflow-hidden rounded-md bg-[#13151d] p-1"><div className={`flex h-full items-center rounded px-2 text-[8px] font-bold tracking-[0.15em] text-white/75 ${frame.width} ${frame.tone}`}>{frame.label}</div></div></div>)}
              <div className="grid grid-cols-[54px_1fr] items-center gap-3"><span className="text-[9px] font-semibold tracking-[0.14em] text-[#5e6373]">A1</span><div className="flex h-9 items-center gap-[3px] overflow-hidden rounded-md bg-[#13151d] px-2">{Array.from({ length: 46 }, (_, index) => <span className="w-px bg-[#7068d8]/70" key={index} style={{ height: `${8 + ((index * 13) % 19)}px` }} />)}</div></div>
            </div>
          </div>
        </div>

        <div className="relative flex items-center justify-between border-t border-white/8 pt-6 text-[11px] text-[#5f6473]"><span>Workspace privado</span><span className="font-mono">APOLLO / 2026</span></div>
      </section>

      <section className="relative flex min-h-screen items-center justify-center px-6 py-12 sm:px-10">
        <div className="absolute left-6 top-6 flex items-center gap-2 lg:hidden"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#7167ff] font-black">A</span><span className="text-xs uppercase tracking-[0.2em] text-[#8b90a0]">Apollo studio</span></div>
        <div className="w-full max-w-[420px]">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#8e87ff]">Acesso privado</p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.045em] text-white">Entre na sala de edição.</h2>
          <p className="mt-4 max-w-sm text-[15px] leading-6 text-[#8d92a2]">Use suas credenciais para continuar de onde parou.</p>
          <LoginForm />
        </div>
      </section>
    </main>
  )
}
