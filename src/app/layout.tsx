import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Video Editor IA',
  description: 'Automated AI-powered video editing with intelligent scene composition and real-time preview'
}

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body className="bg-zinc-950 text-white">
        {children}
      </body>
    </html>
  )
}
