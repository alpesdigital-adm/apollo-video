import type { ImageDetectedEntity, ImageObservation, ImageOcrRegion } from '../../domain/image-analysis.ts'

export interface ImageVisionProvider {
  analyze(input: { sourcePath: string; width: number; height: number; signal?: AbortSignal }): Promise<Readonly<{
    ocr: ImageObservation<ImageOcrRegion>; faces: ImageObservation<ImageDetectedEntity>; objects: ImageObservation<ImageDetectedEntity>
    inferredTags: readonly { value: string; confidence: number; provenance: string }[]
  }>>
}
export interface ImageAnalysisProcessor {
  analyze(input: { operationId: string; sourcePath: string; signal?: AbortSignal }): Promise<Readonly<{
    width: number; height: number; dominantColors: readonly string[]
    ocr: ImageObservation<ImageOcrRegion>; faces: ImageObservation<ImageDetectedEntity>; objects: ImageObservation<ImageDetectedEntity>
    inferredTags: readonly { value: string; confidence: number; provenance: string }[]; observedDescription: string
    thumbnail: { path: string; sha256: string; byteSize: number; width: number; height: number }
    preview: { path: string; sha256: string; byteSize: number; width: number; height: number }
  }>>
  cleanup(operationId: string): Promise<void>
}
