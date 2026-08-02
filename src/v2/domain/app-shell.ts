export const APP_SHELL_DESTINATIONS = [
  { id: 'projects', label: 'Projetos', href: '/', available: true },
  { id: 'batches', label: 'Lotes', href: '/batches', available: true },
  { id: 'library', label: 'Biblioteca', href: '/library', available: true },
  { id: 'presenters', label: 'Apresentadores', href: '/presenters', available: true },
  { id: 'brand', label: 'Marca', href: '/brand', available: true },
  { id: 'settings', label: 'Configurações', href: '/workspace-settings', available: true },
] as const

export type AppShellDestinationId = (typeof APP_SHELL_DESTINATIONS)[number]['id']
