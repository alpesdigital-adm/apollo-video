import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { renderMedia, selectComposition } from '@remotion/renderer'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024

async function readRequest() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.byteLength
    if (size > MAX_REQUEST_BYTES) throw new Error('render request is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function contentType(filePath) {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.webm') return 'video/webm'
  if (extension === '.mp3') return 'audio/mpeg'
  if (extension === '.wav') return 'audio/wav'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '')
  if (!match || (!match[1] && !match[2])) return null
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength)
  const end = suffixLength === null && match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}

async function startPrivateAssetServer(inputProps) {
  const token = randomBytes(24).toString('hex')
  const assets = new Map()
  const uriToId = new Map()

  const markLocation = async (value) => {
    if (typeof value !== 'string' || !value.startsWith('file:')) return value
    let id = uriToId.get(value)
    if (!id) {
      const url = new URL(value)
      if (url.username || url.password || url.search || url.hash) {
        throw new Error('local asset URI is invalid')
      }
      const filePath = fileURLToPath(url)
      const metadata = await stat(filePath)
      if (!metadata.isFile() || metadata.size <= 0) throw new Error('local asset is invalid')
      id = String(uriToId.size)
      uriToId.set(value, id)
      assets.set(id, { filePath, size: metadata.size })
    }
    return { __privateAssetId: id }
  }

  const markedProps = structuredClone(inputProps)
  markedProps.videoSrc = await markLocation(markedProps.videoSrc)
  for (const scene of markedProps.scenes ?? []) {
    if (!scene?.props || typeof scene.props !== 'object') continue
    if ('imageSrc' in scene.props) scene.props.imageSrc = await markLocation(scene.props.imageSrc)
    if ('videoSrc' in scene.props) scene.props.videoSrc = await markLocation(scene.props.videoSrc)
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const match = new RegExp(`^/${token}/([0-9]+)$`).exec(url.pathname)
      const asset = match ? assets.get(match[1]) : null
      if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) {
        response.writeHead(404).end()
        return
      }
      const range = parseRange(request.headers.range, asset.size)
      const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': contentType(asset.filePath),
      }
      if (request.headers.range && !range) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${asset.size}` }).end()
        return
      }
      const start = range?.start ?? 0
      const end = range?.end ?? asset.size - 1
      response.writeHead(range ? 206 : 200, {
        ...headers,
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${asset.size}` } : {}),
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      createReadStream(asset.filePath, { start, end }).pipe(response)
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('private asset server failed')

  const unmarkLocation = (value) => {
    if (
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      '__privateAssetId' in value
    ) {
      return `http://127.0.0.1:${address.port}/${token}/${value.__privateAssetId}`
    }
    return value
  }
  markedProps.videoSrc = unmarkLocation(markedProps.videoSrc)
  for (const scene of markedProps.scenes ?? []) {
    if (!scene?.props || typeof scene.props !== 'object') continue
    if ('imageSrc' in scene.props) scene.props.imageSrc = unmarkLocation(scene.props.imageSrc)
    if ('videoSrc' in scene.props) scene.props.videoSrc = unmarkLocation(scene.props.videoSrc)
  }
  return {
    inputProps: markedProps,
    close: () => new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    ),
  }
}

function positiveInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

async function main() {
  const request = await readRequest()
  if (request?.schemaVersion !== 'apollo-remotion-render-request/v1') {
    throw new Error('render request schema is invalid')
  }
  if (typeof request.outputPath !== 'string' || !isAbsolute(request.outputPath)) {
    throw new Error('render output path is invalid')
  }
  const width = positiveInteger(request.width, 'width', 8192)
  const height = positiveInteger(request.height, 'height', 8192)
  const fps = positiveInteger(request.fps, 'fps', 120)
  const durationInFrames = positiveInteger(request.durationInFrames, 'durationInFrames', 5_184_000)
  if (!request.inputProps || typeof request.inputProps !== 'object' || Array.isArray(request.inputProps)) {
    throw new Error('render input props are invalid')
  }

  const privateAssets = await startPrivateAssetServer(request.inputProps)
  try {
    const serveUrl = resolve(process.cwd(), 'build')
    const selected = await selectComposition({
      serveUrl,
      id: 'apollo-video',
      inputProps: privateAssets.inputProps,
      logLevel: 'error',
    })
    await renderMedia({
      serveUrl,
      composition: { ...selected, width, height, fps, durationInFrames },
      inputProps: privateAssets.inputProps,
      codec: 'h264',
      outputLocation: request.outputPath,
      overwrite: true,
      crf: 23,
      pixelFormat: 'yuv420p',
      imageFormat: 'jpeg',
      concurrency: 1,
      disallowParallelEncoding: true,
      logLevel: 'error',
    })
  } finally {
    await privateAssets.close()
  }
  process.stdout.write(JSON.stringify({ ok: true, schemaVersion: 'apollo-remotion-render-result/v1' }))
}

main().catch((error) => {
  process.stderr.write(`RENDER_WORKER_FAILED: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
})
