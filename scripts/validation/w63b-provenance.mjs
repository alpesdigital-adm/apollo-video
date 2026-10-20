import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'

/**
 * Which code ran. The freeze covers the generator and the comparison code, not the runner, so a result must prove the runner on its own:
 * the HEAD, the SHA-256 of the runner and of this module as they were on disk, and the full `git status --porcelain` of the tree. A run
 * refuses to start when the runner or this module differ from HEAD (modified, staged or untracked), so `head` plus the runner hash
 * identify the exact runner that produced the numbers.
 */
export async function collectProvenance({ root, files, git }) {
  const head = await git('rev-parse', 'HEAD')
  const status = (await git('status', '--porcelain')).split(/\r?\n/).filter(Boolean)
  const entries = []
  for (const file of files) {
    const repoPath = relative(root, file).replaceAll('\\', '/')
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex')
    const dirty = status.filter((line) => {
      // the caller's git() may trim the first line, so the status code is parsed, not sliced
      const path = line.replace(/^\s*\S+\s+/, '').replaceAll('"', '')
      return path === repoPath || path.startsWith(`${repoPath} ->`) || path.endsWith(`-> ${repoPath}`)
    })
    entries.push({ file: repoPath, sha256, dirty: dirty.length > 0 })
  }
  return { head, files: entries, status, treeClean: status.length === 0 }
}

export function assertRunnerClean(provenance) {
  const dirty = provenance.files.filter((entry) => entry.dirty).map((entry) => entry.file)
  if (dirty.length) throw new Error(`refusing to run: ${dirty.join(', ')} differ from HEAD ${provenance.head}; commit the runner first so the result names the code that ran`)
  return provenance
}
