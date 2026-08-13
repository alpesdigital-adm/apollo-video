import {
  solveResponsivePlacement,
  type ResponsivePlacementInput,
} from '../domain/responsive-output.ts'

export function solveResponsivePlacementService() {
  return async function solve(input: ResponsivePlacementInput) {
    return solveResponsivePlacement(input)
  }
}
