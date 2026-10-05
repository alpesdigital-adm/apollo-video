import ProjectsPageClient from './ProjectsPageClient'
import { requireActiveUiPageSession } from './_auth/ui-page-session'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const session = await requireActiveUiPageSession('/')
  return <ProjectsPageClient workspaceId={session.actor.workspaceId} />
}
