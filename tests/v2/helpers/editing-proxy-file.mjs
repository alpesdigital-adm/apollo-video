// A real editing proxy for a journey whose page plays it.
//
// The ingest receipt a suite persists for a recording it registered itself (`persistReceiptForExistingVideo`) names an editing-proxy
// derivative. By default that derivative is a controlled fact with no bytes behind it; a journey that opens the project workspace in a
// browser has the page request the proxy's content, so the file has to exist: this encodes a small one from the source and returns the
// key, digest and size the receipt must name.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function writeEditingProxyFile({ ffmpeg, sourcePath, artifactRoot, key }) {
  const path = join(artifactRoot, ...key.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
    '-vf', 'scale=160:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path,
  ], { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  const bytes = await readFile(path)
  return Object.freeze({ key, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length })
}
