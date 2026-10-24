import type { CommandProxyRender } from '../application/enqueue-project-proxy-render.ts'
import { presentPublicOperation } from './presenters.ts'

/**
 * What a project-wide Command answers about the proxy render it would otherwise enqueue (Director, spoken-content removal, LUT
 * selection, ColorPlan). A Version with ONE output carries `operation`, as always. A Version with SEVERAL carries `proxyRenders`
 * instead: the Command committed, no proxy was enqueued (a proxy is rendered for one output and no Command chooses), and each
 * listed output's proxy is requested with `apollo.projects.proxy-renders.enqueue` and that `variantId`. It is an answer, never a
 * refusal: the same request replayed answers the same.
 */
export const COMMAND_PROXY_RENDERS_PER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'outputs'],
  properties: {
    status: { const: 'per-output-request-required' },
    reason: { const: 'output-variant-required' },
    outputs: {
      type: 'array', minItems: 2, maxItems: 64,
      items: {
        type: 'object', additionalProperties: false, required: ['variantId', 'aspectRatio'],
        properties: {
          variantId: { type: 'string', minLength: 1, maxLength: 128 },
          aspectRatio: { anyOf: [{ type: 'string', minLength: 1, maxLength: 16 }, { type: 'null' }] },
        },
      },
    },
  },
} as const)

/** The fields a Command response spreads for its proxy render: `operation` (one output) or `proxyRenders` (several). */
export function presentCommandProxyRender(proxy: CommandProxyRender) {
  if (proxy.status === 'enqueued') return { operation: presentPublicOperation(proxy.operation) }
  return {
    proxyRenders: {
      status: proxy.status, reason: proxy.reason,
      outputs: proxy.outputs.map(({ variantId, aspectRatio }) => ({ variantId, aspectRatio })),
    },
  }
}

/** Whether the proxy part of a Command's answer was a replay: a deferral writes nothing, so it never makes the answer a first one. */
export function commandProxyRenderReplayed(proxy: CommandProxyRender): boolean {
  return proxy.status === 'enqueued' ? proxy.replayed : true
}
