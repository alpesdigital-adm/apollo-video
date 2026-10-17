/** The timeline a reviewer annotated: two 3 second clips of the world's source and one subtitle cue. */
export function reviewedTimeline(plan) {
  return {
    ...plan,
    durationFrames: 180,
    sources: [{ id: 'artifact-source3', artifactId: 'artifact-source3', kind: 'video', durationSeconds: 6 }],
    videoTracks: [{
      id: 'base-video', kind: 'base-video',
      clips: [
        { id: 'clip-1', sourceArtifactId: 'artifact-source3', sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1 },
        { id: 'clip-2', sourceArtifactId: 'artifact-source3', sourceInFrame: 90, sourceOutFrame: 180, timelineInFrame: 90, timelineOutFrame: 180, rate: 1 },
      ],
    }],
    overlayTracks: [],
    subtitleTracks: [{
      id: 'captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom',
      faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32,
      cues: [{ id: 'cue-1', startFrame: 15, endFrame: 45, text: 'Texto original', anchor: 'bottom' }],
    }],
    audioTracks: [], effectTracks: [], markers: [], transitions: [],
    protectedElements: [], localeVariantRefs: [], formatVariantRefs: [], lineageRefs: ['artifact-source3'],
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
    composition: { layout: 'fit', background: 'black', foregroundScale: 1, verticalPosition: 0.5 },
    director: { plannerVersion: 'impact-test', decisions: [], assumptions: [] },
  }
}
