/**
 * Safe deletion of all files associated with a project (uploads, generated
 * images, renders, and the refine snapshot). Used by the project DELETE
 * route. Best-effort: individual fs errors are swallowed and logged.
 */

import { existsSync } from 'fs'
import { readdir, stat, unlink } from 'fs/promises'
import path from 'path'

interface ProjectFileFields {
  id: string
  rawVideoPath?: string | null
  normalizedPath?: string | null
  renderedVideoPath?: string | null
}

export interface DeleteProjectFilesResult {
  files: number
  bytes: number
}

const SCAN_DIRS = ['uploads', 'generated-images', 'renders'] as const
const PROTECTED_PREFIX = 'creator-avatar'

function toAbsolutePath(candidate: string): string {
  // Paths may be stored as absolute filesystem paths or as public-relative
  // paths (e.g. "/uploads/xyz.mp4"). Normalize both to an absolute path.
  if (path.isAbsolute(candidate)) {
    return candidate
  }
  const relative = candidate.startsWith('/') ? candidate.slice(1) : candidate
  return path.join(process.cwd(), 'public', relative)
}

async function safeUnlink(filePath: string, result: DeleteProjectFilesResult): Promise<void> {
  try {
    if (!existsSync(filePath)) return
    const info = await stat(filePath)
    if (!info.isFile()) return
    await unlink(filePath)
    result.files += 1
    result.bytes += info.size
  } catch (error) {
    console.warn(`deleteProjectFiles: failed to remove ${filePath}:`, error)
  }
}

async function removeMatchingInDir(
  dir: string,
  projectId: string,
  result: DeleteProjectFilesResult
): Promise<void> {
  try {
    if (!existsSync(dir)) return
    const entries = await readdir(dir)
    for (const entry of entries) {
      if (entry.startsWith(PROTECTED_PREFIX)) continue
      if (!entry.startsWith(projectId)) continue
      await safeUnlink(path.join(dir, entry), result)
    }
  } catch (error) {
    console.warn(`deleteProjectFiles: failed to scan ${dir}:`, error)
  }
}

/**
 * Deletes every file on disk associated with a project:
 *  - the explicit raw/normalized/rendered video paths on the project row
 *  - any file in public/uploads, public/generated-images, public/renders
 *    whose basename starts with the project id
 *  - the refine undo snapshot at data/snapshots/<id>.json
 *
 * Never touches files whose basename starts with "creator-avatar".
 * Best-effort: individual failures are logged via console.warn and do not
 * throw.
 */
export async function deleteProjectFiles(
  project: ProjectFileFields
): Promise<DeleteProjectFilesResult> {
  const result: DeleteProjectFilesResult = { files: 0, bytes: 0 }

  const explicitPaths = [project.rawVideoPath, project.normalizedPath, project.renderedVideoPath]
  for (const p of explicitPaths) {
    if (!p) continue
    if (path.basename(p).startsWith(PROTECTED_PREFIX)) continue
    await safeUnlink(toAbsolutePath(p), result)
  }

  for (const dirName of SCAN_DIRS) {
    const dir = path.join(process.cwd(), 'public', dirName)
    await removeMatchingInDir(dir, project.id, result)
  }

  const snapshotPath = path.join(process.cwd(), 'data', 'snapshots', `${project.id}.json`)
  await safeUnlink(snapshotPath, result)

  return result
}
