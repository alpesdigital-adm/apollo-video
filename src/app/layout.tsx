import type { Metadata } from 'next'
import packageJson from '../../package.json'
import './globals.css'

export const metadata: Metadata = {
  title: 'Video Editor IA',
  description: 'Automated AI-powered video editing with intelligent scene composition and real-time preview'
}

const rawBuildRevision = process.env.APOLLO_BUILD_REVISION?.trim()
const buildRevision =
  rawBuildRevision && rawBuildRevision !== 'local' && /^[a-f0-9]{7,40}$/i.test(rawBuildRevision)
    ? rawBuildRevision.slice(0, 7)
    : null
const versionLabel = `v${packageJson.version}${buildRevision ? ` · ${buildRevision}` : ''}`

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body className="bg-zinc-950 text-white">
        {children}
        <span
          aria-label={`Versão do Apollo ${versionLabel}`}
          className="pointer-events-none fixed bottom-2 right-3 z-[100] select-none font-mono text-[9px] uppercase tracking-[0.12em] text-white/25"
        >
          Apollo · {versionLabel}
        </span>
      </body>
    </html>
  )
}
