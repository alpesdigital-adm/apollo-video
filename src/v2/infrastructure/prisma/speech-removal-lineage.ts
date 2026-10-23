import type { Prisma, PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { EditorialPhraseRule } from '../../application/editorial-phrase-rules.ts'
import { collectRequestedSpeechRemovals, type SpeechRemovalLineageProject } from '../../application/requested-speech-removals.ts'
import { DomainError } from '../../domain/errors.ts'

type Reader = PrismaClient | Prisma.TransactionClient

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director lineage command payload is invalid')
  }
}

/** One project's Versions and the Commands that decide which removal requests still stand (`remove-spoken-content`, manual undo/redo/restore). */
export async function readSpeechRemovalLineage(
  client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string }>,
): Promise<SpeechRemovalLineageProject> {
  const { workspaceId, projectId } = input
  const [versions, commands] = await Promise.all([
    client.v2ProjectVersion.findMany({
      where: { workspaceId, projectId },
      select: { id: true, parentVersionId: true, commandId: true, command: { select: { type: true } }, forkedFromProjectId: true, forkedFromVersionId: true },
    }),
    client.v2EditCommand.findMany({
      where: {
        workspaceId, projectId,
        OR: [{ type: 'remove-spoken-content' }, { type: 'manual-edit', payloadJson: { contains: 'restoresVersionId' } }],
      },
      select: { id: true, type: true, payloadJson: true },
    }),
  ])
  return Object.freeze({
    versions: new Map(versions.map(({ command, ...version }) => [version.id, Object.freeze({ ...version, commandType: command?.type ?? null })] as const)),
    commands: new Map(commands.map((command) => [command.id, Object.freeze({
      id: command.id, type: command.type, payload: Object.freeze(parsePayload(command.payloadJson)),
    })] as const)),
  })
}

/** What the project asked to have cut from the speech, read from the lineage of `headVersionId` (see `collectRequestedSpeechRemovals`). */
export function readRequestedSpeechRemovals(
  client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; headVersionId: string }>,
): Promise<readonly Readonly<EditorialPhraseRule>[]> {
  return collectRequestedSpeechRemovals({
    projectId: input.projectId,
    headVersionId: input.headVersionId,
    load: (lineageProjectId) => readSpeechRemovalLineage(client, { workspaceId: input.workspaceId, projectId: lineageProjectId }),
  })
}
