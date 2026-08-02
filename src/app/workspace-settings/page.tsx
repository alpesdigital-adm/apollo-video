import WorkspaceCapabilityHub from '@/components/WorkspaceCapabilityHub'
import { requireActiveUiPageSession } from '../_auth/ui-page-session'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  await requireActiveUiPageSession('/workspace-settings')
  return <WorkspaceCapabilityHub section="settings" />
}
