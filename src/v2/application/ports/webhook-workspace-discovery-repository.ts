export interface WebhookWorkspaceDiscoveryRepository {
  listRunnableWorkspaceIds(query: Readonly<{
    asOf: string
    limit: number
    afterWorkspaceId?: string
  }>): Promise<readonly string[]>
}
