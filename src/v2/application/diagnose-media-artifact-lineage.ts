import { DomainError } from '../domain/errors.ts'
import type {
  MediaArtifactManifestRecord,
  MediaArtifactQueryRepository,
  MediaArtifactRecord,
} from './ports/media-artifact-query-repository.ts'

export const LINEAGE_DIAGNOSTIC_ISSUE_CODES = [
  'ARTIFACT_UNAVAILABLE',
  'MANIFEST_MISSING',
  'SOURCE_NOT_FOUND',
  'SOURCE_CHECKSUM_MISMATCH',
  'SOURCE_INTEGRITY_FAILURE',
  'LINEAGE_CYCLE',
  'GRAPH_LIMIT_EXCEEDED',
  'DEPTH_LIMIT_EXCEEDED',
] as const

export type LineageDiagnosticIssueCode =
  (typeof LINEAGE_DIAGNOSTIC_ISSUE_CODES)[number]

export interface LineageDiagnosticIssue {
  code: LineageDiagnosticIssueCode
  artifactId: string
  message: string
}

export interface LineageDiagnosticNode {
  artifactId: string
  artifactKey: string
  sha256: string
  status: MediaArtifactRecord['status']
  manifestCount: number
  selectedManifest?: {
    id: string
    manifestHash: string
    schemaVersion: string
    recipe: MediaArtifactManifestRecord['recipe']
  }
}

export interface LineageDiagnosticEdge {
  sourceArtifactId: string
  targetArtifactId: string
  sha256: string
  role: string
  ordinal: number
}

export interface MediaArtifactLineageDiagnostic {
  artifactId: string
  manifestId: string
  healthy: boolean
  nodes: readonly LineageDiagnosticNode[]
  edges: readonly LineageDiagnosticEdge[]
  issues: readonly LineageDiagnosticIssue[]
  limits: {
    maxNodes: number
    maxDepth: number
    truncated: boolean
  }
}

export interface DiagnoseMediaArtifactLineageDependencies {
  repository: MediaArtifactQueryRepository
  maxNodes?: number
  maxDepth?: number
}

const DEFAULT_MAX_NODES = 256
const DEFAULT_MAX_DEPTH = 32

export function diagnoseMediaArtifactLineageService(
  dependencies: DiagnoseMediaArtifactLineageDependencies,
) {
  const maxNodes = dependencies.maxNodes ?? DEFAULT_MAX_NODES
  const maxDepth = dependencies.maxDepth ?? DEFAULT_MAX_DEPTH

  if (
    !Number.isInteger(maxNodes) ||
    maxNodes < 1 ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Lineage diagnostic limits are invalid')
  }

  return async function diagnoseMediaArtifactLineage(
    workspaceId: string,
    artifactId: string,
    manifestId: string,
  ): Promise<MediaArtifactLineageDiagnostic> {
    const normalizedArtifactId = artifactId.trim()
    const normalizedManifestId = manifestId.trim()
    if (normalizedArtifactId.length < 3 || normalizedArtifactId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'artifactId must contain 3 to 128 characters')
    }
    if (normalizedManifestId.length < 3 || normalizedManifestId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'manifestId must contain 3 to 128 characters')
    }

    const root = await dependencies.repository.findById(workspaceId, normalizedArtifactId)
    if (!root) {
      throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    }
    const requestedManifest = root.manifests.find(
      (manifest) => manifest.id === normalizedManifestId,
    )
    if (!requestedManifest) {
      throw new DomainError(
        'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
        'Media artifact manifest was not found',
      )
    }

    const nodes: LineageDiagnosticNode[] = []
    const edges: LineageDiagnosticEdge[] = []
    const issues: LineageDiagnosticIssue[] = []
    const issueKeys = new Set<string>()
    const discovered = new Set<string>()
    const active = new Set<string>()
    let truncated = false

    const addIssue = (issue: LineageDiagnosticIssue) => {
      const key = `${issue.code}:${issue.artifactId}`
      if (issueKeys.has(key)) return
      issueKeys.add(key)
      issues.push(issue)
    }

    const visit = async (
      artifact: MediaArtifactRecord,
      selectedManifest: MediaArtifactManifestRecord | undefined,
      depth: number,
    ): Promise<void> => {
      if (active.has(artifact.id)) {
        addIssue({
          code: 'LINEAGE_CYCLE',
          artifactId: artifact.id,
          message: 'Artifact lineage contains a cycle',
        })
        return
      }
      if (discovered.has(artifact.id)) return
      if (depth > maxDepth) {
        truncated = true
        addIssue({
          code: 'DEPTH_LIMIT_EXCEEDED',
          artifactId: artifact.id,
          message: 'Artifact lineage exceeds the diagnostic depth limit',
        })
        return
      }
      if (discovered.size >= maxNodes) {
        truncated = true
        addIssue({
          code: 'GRAPH_LIMIT_EXCEEDED',
          artifactId: artifact.id,
          message: 'Artifact lineage exceeds the diagnostic node limit',
        })
        return
      }

      discovered.add(artifact.id)
      active.add(artifact.id)
      const manifest = selectedManifest ?? artifact.manifests[0]

      if (artifact.status !== 'available') {
        addIssue({
          code: 'ARTIFACT_UNAVAILABLE',
          artifactId: artifact.id,
          message: 'Artifact is not available for reconstruction',
        })
      }
      if (!manifest) {
        addIssue({
          code: 'MANIFEST_MISSING',
          artifactId: artifact.id,
          message: 'Artifact has no manifest for reconstruction',
        })
      } else {
        for (const source of manifest.sources) {
          edges.push({
            sourceArtifactId: source.artifactId,
            targetArtifactId: artifact.id,
            sha256: source.sha256,
            role: source.role,
            ordinal: source.ordinal,
          })

          if (active.has(source.artifactId)) {
            addIssue({
              code: 'LINEAGE_CYCLE',
              artifactId: source.artifactId,
              message: 'Artifact lineage contains a cycle',
            })
            continue
          }
          if (discovered.has(source.artifactId)) continue

          let sourceArtifact: MediaArtifactRecord | null
          try {
            sourceArtifact = await dependencies.repository.findById(
              workspaceId,
              source.artifactId,
            )
          } catch (error) {
            if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') {
              addIssue({
                code: 'SOURCE_INTEGRITY_FAILURE',
                artifactId: source.artifactId,
                message: 'Source artifact failed integrity validation',
              })
              continue
            }
            throw error
          }

          if (!sourceArtifact) {
            addIssue({
              code: 'SOURCE_NOT_FOUND',
              artifactId: source.artifactId,
              message: 'Source artifact was not found in the workspace',
            })
            continue
          }
          if (sourceArtifact.sha256 !== source.sha256) {
            addIssue({
              code: 'SOURCE_CHECKSUM_MISMATCH',
              artifactId: source.artifactId,
              message: 'Source artifact checksum does not match the lineage edge',
            })
            continue
          }
          await visit(sourceArtifact, undefined, depth + 1)
        }
      }

      active.delete(artifact.id)
      nodes.push({
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        sha256: artifact.sha256,
        status: artifact.status,
        manifestCount: artifact.manifests.length,
        ...(manifest
          ? {
              selectedManifest: {
                id: manifest.id,
                manifestHash: manifest.manifestHash,
                schemaVersion: manifest.schemaVersion,
                recipe: {
                  id: manifest.recipe.id,
                  version: manifest.recipe.version,
                  parametersHash: manifest.recipe.parametersHash,
                },
              },
            }
          : {}),
      })
    }

    await visit(root, requestedManifest, 0)

    return {
      artifactId: root.id,
      manifestId: requestedManifest.id,
      healthy: issues.length === 0,
      nodes,
      edges,
      issues,
      limits: { maxNodes, maxDepth, truncated },
    }
  }
}
