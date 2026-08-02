import ProjectsPageClient from './ProjectsPageClient'
import { requireActiveUiPageSession } from './_auth/ui-page-session'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  await requireActiveUiPageSession('/')
  return <ProjectsPageClient />
}
