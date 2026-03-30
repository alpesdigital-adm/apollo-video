import type { Metadata } from 'next'
import { Sora } from 'next/font/google'
import './globals.css'

const sora = Sora({ subsets: ['latin'] })

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
      <body className={`${sora.className} bg-zinc-950 text-white`}>
        {children}
      </body>
    </html>
  )
}
