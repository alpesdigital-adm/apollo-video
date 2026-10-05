'use client'

import { useEffect, useRef } from 'react'

import {
  createProjectEventFeedController,
  type ProjectEventFeedResult,
  type ProjectEventFeedTransport,
  dashboardFeedEventType,
} from '@/v2/ui/project-event-feed-controller'

interface FeedEnvelope {
  data?: {
    events?: unknown[]
    nextCursor?: unknown
    hasMore?: unknown
  }
  error?: { code?: string }
}

function browserTransport(workspaceId: string): ProjectEventFeedTransport { return {
  async read({ after, limit, signal }): Promise<ProjectEventFeedResult> {
    const search = new URLSearchParams({ limit: String(limit) })
    if (after) search.set('after', after)
    else search.set('startAt', 'latest')
    const response = await fetch(`/v1/events/feed?${search.toString()}`, {
      signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (response.status === 401) return { kind: 'unauthorized' }
    let payload: FeedEnvelope
    try {
      payload = await response.json() as FeedEnvelope
    } catch {
      return { kind: 'error' }
    }
    if (!response.ok && payload.error?.code === 'INVALID_ARGUMENT') {
      return { kind: 'cursor-rejected' }
    }
    const data = payload.data
    if (
      !response.ok || !data || !Array.isArray(data.events) ||
      typeof data.nextCursor !== 'string' || typeof data.hasMore !== 'boolean'
    ) {
      return { kind: 'error' }
    }
    return {
      kind: 'page',
      eventTypes: data.events.flatMap((event) => {
        const type = dashboardFeedEventType(event, workspaceId)
        return type ? [type] : []
      }),
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
    }
  },
} }

/**
 * Follows the authenticated workspace's persisted dashboard events and calls
 * `onProjectsChanged` when another client or worker changed a project.
 * The events are only a refetch signal; callers keep deriving every card from
 * `GET /v1/projects`.
 */
export function useProjectEventFeed(handlers: {
  workspaceId: string
  onProjectsChanged: () => void
  onUnauthorized: () => void
}) {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    const controller = createProjectEventFeedController({
      transport: browserTransport(handlers.workspaceId),
      onRelevantEvent: () => latest.current.onProjectsChanged(),
      onUnauthorized: () => latest.current.onUnauthorized(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      isVisible: () => document.visibilityState === 'visible',
      subscribeVisibility: (callback) => {
        document.addEventListener('visibilitychange', callback)
        return () => document.removeEventListener('visibilitychange', callback)
      },
    })
    controller.start()
    return () => controller.stop()
  }, [handlers.workspaceId])
}
