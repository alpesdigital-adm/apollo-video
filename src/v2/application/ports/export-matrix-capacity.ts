export interface ExportMatrixCapacity {
  operatorMaximumCostMinorUnits: number
  operatorAvailableStorageBytes: number
}

export interface ExportMatrixCapacityProvider {
  read(workspaceId: string): Promise<Readonly<ExportMatrixCapacity>>
}
