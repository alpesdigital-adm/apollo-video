export interface ProjectWorkspaceMediaRecord {
  id: string
  role: 'source-master' | 'editing-proxy' | 'editorial-proxy'
  originalFileName: string
  artifactId: string
  manifestId: string
  mediaType: 'video' | 'audio' | 'image'
  container: string
  byteSize: string
  sha256: string
  status: string
  rightsStatus?: string
  probe?: { width: number; height: number; duration: number; fps: number }
  createdAt: string
}

export interface ProjectWorkspaceRecord {
  project: {
    id: string; workspaceId: string; name: string; status: string; objective?: string;
    format?: string; locale?: string; currentVersionId?: string; createdAt: string
  }
  version?: { id: string; sequence: number; baseHash: string; createdAt: string }
  brief?: unknown
  editPlan?: {
    id: string; state: string; fps: number; durationFrames: number; clipCount: number;
    cutCount: number; automaticZoom: boolean; subtitleFaceProtection: boolean
  }
  commands: readonly {
    id: string; type: string; baseVersionId: string; resultVersionId?: string; reason?: string; createdAt: string
  }[]
  media: readonly ProjectWorkspaceMediaRecord[]
  transcripts: readonly {
    id: string; sourceArtifactId: string; language: string; provider: string; model: string;
    transcriptHash: string; text: string; wordCount: number; segmentCount: number; createdAt: string
  }[]
  operationIds: readonly string[]
}

export interface ProjectWorkspaceQueryRepository {
  read(input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectWorkspaceRecord> | null>
}
