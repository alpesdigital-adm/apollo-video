import { requireActiveUiPageSession } from '../_auth/ui-page-session'

export const dynamic = 'force-dynamic'

export default async function BatchesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireActiveUiPageSession('/batches')
  return children
}
