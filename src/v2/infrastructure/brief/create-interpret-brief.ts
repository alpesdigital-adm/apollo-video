import { interpretBriefService, type InterpretBrief } from '../../application/interpret-brief.ts'
import { createBriefInterpreterModelFromEnvironment } from './brief-interpreter-factory.ts'

/**
 * The briefing reader of this deployment: backed by the interpreter the environment configures, or by none. Without one, reading a
 * briefing with text fails closed with PRECONDITION_REQUIRED (see `interpret-brief.ts`); it is never an empty read.
 */
export function createInterpretBrief(environment: NodeJS.ProcessEnv = process.env): InterpretBrief {
  return interpretBriefService({ model: createBriefInterpreterModelFromEnvironment(environment) })
}
