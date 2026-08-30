import SyntheticPresentersManager from '@/components/SyntheticPresentersManager'
import { requireActiveUiPageSession } from '../_auth/ui-page-session'

export const dynamic = 'force-dynamic'

export default async function PresentersPage() {
  await requireActiveUiPageSession('/presenters')
  return <SyntheticPresentersManager />
}
