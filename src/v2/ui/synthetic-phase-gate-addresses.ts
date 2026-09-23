export interface SyntheticPhaseGateAddressReference {
  type: string
  id: string
  hash: string
}

export interface SyntheticPhaseGateAddress {
  capabilityId: string
  href: string
}

/**
 * Produces a link only when the exact resource capability is present in the
 * caller's filtered registry. Ledger rows without a public read-by-id route
 * remain identifiers, never links to a list endpoint that cannot address them.
 */
export function addressSyntheticPhaseGateReference(input: {
  gateProjectId: string
  reference: Readonly<SyntheticPhaseGateAddressReference>
  publishedCapabilityIds: ReadonlySet<string>
}): Readonly<SyntheticPhaseGateAddress> | null {
  const projectId = encodeURIComponent(input.gateProjectId)
  const referenceId = encodeURIComponent(input.reference.id)
  const address = (() => {
    switch (input.reference.type) {
      case 'provider-job':
        return {
          capabilityId: 'apollo.projects.provider-jobs.read',
          href: `/v1/projects/${projectId}/provider-jobs/${referenceId}`,
        }
      case 'synthetic-audio-master':
        return {
          capabilityId: 'apollo.projects.synthetic-audio-masters.read',
          href: `/v1/projects/${projectId}/synthetic-audio-masters/${referenceId}`,
        }
      case 'synthetic-master':
        return {
          capabilityId: 'apollo.projects.synthetic-masters.get',
          href: `/v1/projects/${projectId}/synthetic-masters/${referenceId}`,
        }
      case 'alignment-artifact':
        return {
          capabilityId: 'apollo.artifacts.read',
          href: `/v1/artifacts/${referenceId}`,
        }
      case 'project':
        return {
          capabilityId: 'apollo.projects.workspace.read',
          href: `/v1/projects/${referenceId}`,
        }
      default:
        return null
    }
  })()
  return address && input.publishedCapabilityIds.has(address.capabilityId)
    ? Object.freeze(address)
    : null
}
