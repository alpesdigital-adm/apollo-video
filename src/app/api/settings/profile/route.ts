import { NextRequest, NextResponse } from 'next/server'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import { readCreatorProfile, writeCreatorProfile } from '@/lib/creator-profile'

const AVATAR_BASENAME = 'creator-avatar'
const ALLOWED_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp'
}
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

function getUploadsDir(): string {
  return path.join(process.cwd(), 'public', 'uploads')
}

function findExistingAvatarFile(): { ext: string; filePath: string } | null {
  const uploadsDir = getUploadsDir()
  for (const ext of Object.values(ALLOWED_EXTENSIONS)) {
    const filePath = path.join(uploadsDir, `${AVATAR_BASENAME}.${ext}`)
    if (existsSync(filePath)) {
      return { ext, filePath }
    }
  }
  return null
}

function normalizeHandle(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^@+/, '')
}

export async function GET() {
  const profile = readCreatorProfile()
  const existing = findExistingAvatarFile()

  let avatarUrl: string | null = null
  if (existing) {
    const mtime = statSync(existing.filePath).mtimeMs
    avatarUrl = `/uploads/${AVATAR_BASENAME}.${existing.ext}?v=${Math.round(mtime)}`
  }

  return NextResponse.json({
    name: profile.name,
    handle: profile.handle,
    avatarUrl
  })
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const name = String(formData.get('name') ?? '').trim()
    const handle = normalizeHandle(formData.get('handle'))
    const avatar = formData.get('avatar')

    if (!name) {
      return NextResponse.json({ error: 'Nome é obrigatório' }, { status: 400 })
    }

    if (!handle) {
      return NextResponse.json({ error: '@ do Instagram é obrigatório' }, { status: 400 })
    }

    if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) {
      return NextResponse.json(
        { error: '@ inválido — use apenas letras, números, ponto e underscore' },
        { status: 400 }
      )
    }

    let avatarPath: string | null = readCreatorProfile().avatarPath

    if (avatar instanceof File && avatar.size > 0) {
      const ext = ALLOWED_EXTENSIONS[avatar.type]
      if (!ext) {
        return NextResponse.json(
          { error: 'Formato de imagem inválido — use PNG, JPG ou WEBP' },
          { status: 400 }
        )
      }

      if (avatar.size > MAX_AVATAR_BYTES) {
        return NextResponse.json(
          { error: 'Imagem muito grande — o máximo é 5MB' },
          { status: 400 }
        )
      }

      const uploadsDir = getUploadsDir()
      if (!existsSync(uploadsDir)) {
        await mkdir(uploadsDir, { recursive: true })
      }

      // Remove any previous avatar with a different extension
      const existing = findExistingAvatarFile()
      if (existing && existing.ext !== ext) {
        try {
          unlinkSync(existing.filePath)
        } catch (error) {
          console.error('Failed to remove old avatar:', error)
        }
      }

      const filename = `${AVATAR_BASENAME}.${ext}`
      const filePath = path.join(uploadsDir, filename)
      const bytes = await avatar.arrayBuffer()
      writeFileSync(filePath, Buffer.from(bytes))
      avatarPath = `/uploads/${filename}`
    }

    writeCreatorProfile({ name, handle, avatarPath })

    const existing = findExistingAvatarFile()
    let avatarUrl: string | null = null
    if (existing) {
      const mtime = statSync(existing.filePath).mtimeMs
      avatarUrl = `/uploads/${AVATAR_BASENAME}.${existing.ext}?v=${Math.round(mtime)}`
    }

    return NextResponse.json({ name, handle, avatarUrl })
  } catch (error) {
    console.error('Profile save error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao salvar perfil' },
      { status: 500 }
    )
  }
}
