import Link from 'next/link'

import { APP_SHELL_DESTINATIONS, type AppShellDestinationId } from '@/v2/domain/app-shell'
import WorkspaceSelector from './WorkspaceSelector'

const NAVIGATION_ICON_PATHS = [
  'M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v5A1.5 1.5 0 0 1 10.5 12h-5A1.5 1.5 0 0 1 4 10.5v-5Zm8 8A1.5 1.5 0 0 1 13.5 12h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-5Z',
  'M5 4h14v4H5V4Zm0 6h14v4H5v-4Zm0 6h14v4H5v-4Z',
  'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11ZM4 9h16',
  'M8 8a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm-3 12c.7-4 3-6 7-6s6.3 2 7 6',
  'M12 3 4 7v6c0 4.6 3.3 7.4 8 8 4.7-.6 8-3.4 8-8V7l-8-4Zm-3 9 2 2 4-5',
  'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-3.5 2-1-2-3-2.2.2L15.5 6 16 4h-4l-1 2-2.5.2L7 4 4 6l.8 2.2L3 10v4l2 1',
] as const

function NavigationIcon({ index }: Readonly<{ index: number }>) {
  return <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24"><path d={NAVIGATION_ICON_PATHS[index]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>
}

export default function AppShellNavigation({ active }: Readonly<{ active: AppShellDestinationId }>) {
  return (
    <><WorkspaceSelector /><nav aria-label="Navegação principal" className="mt-6 space-y-1" data-testid="app-shell-navigation">
      {APP_SHELL_DESTINATIONS.map((destination, index) => {
        const className = destination.id === active
          ? 'flex items-center gap-3 rounded-xl border border-[#e0af37]/20 bg-[#e0af37]/10 px-3 py-2.5 text-sm font-medium text-[#f0c65c]'
          : 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[#8e8a82] transition hover:bg-white/[0.035] hover:text-white'
        if (!destination.available) {
          return <div aria-disabled="true" className={`${className} cursor-not-allowed opacity-50`} data-destination={destination.id} key={destination.id} title="Capability V2 ainda não integrada"><NavigationIcon index={index} />{destination.label}<span className="ml-auto text-[8px] uppercase tracking-wider">pendente</span></div>
        }
        return <Link aria-current={destination.id === active ? 'page' : undefined} className={className} href={destination.href} key={destination.id}><NavigationIcon index={index} />{destination.label}</Link>
      })}
    </nav></>
  )
}
