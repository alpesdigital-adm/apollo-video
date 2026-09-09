import { requireActiveUiPageSession } from '../_auth/ui-page-session'

export const dynamic = 'force-dynamic'

export default async function LocalizationLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireActiveUiPageSession('/localization')
  return children
}
