export type Range = [number, number];
export type EditorialRange = { sourceId: string; rangeMs: Range; text: string; claim?: string; qualifier?: string; attribution?: string; contextRequired?: string[] };
export function synthesizeEditorialStory(ranges: EditorialRange[], objective: string) {
  const ordered = [...ranges].sort((a, b) => a.rangeMs[0] - b.rangeMs[0]);
  const bridges = ordered.slice(1).map((item, index) => ({ between: [ordered[index].sourceId, item.sourceId], omissionMs: Math.max(0, item.rangeMs[0] - ordered[index].rangeMs[1]), narration: item.contextRequired?.length ? undefined : `bridge:${objective}`, supported: !item.contextRequired?.length }));
  return { objective, ranges: ordered, durationMs: ordered.reduce((sum, item) => sum + item.rangeMs[1] - item.rangeMs[0], 0), claims: ordered.filter(item => item.claim).map(item => ({ claim: item.claim, qualifier: item.qualifier, attribution: item.attribution })), bridges, omissionsExplicit: true };
}

export type CaptureTrack = { id: string; role: 'camera' | 'screen' | 'audio-master' | 'scratch-audio' | 'reference'; device: string; assetId: string; timebase: number; coverage: Range[]; events: { type: string; pts: number }[]; includeInFinalMix: boolean };
export type CaptureSession = { id: string; protocol?: string; clockRate: number; tracks: CaptureTrack[] };
export function addCaptureTrack(session: CaptureSession, track: CaptureTrack) { return { ...session, tracks: [...session.tracks, track] }; }

export type ClockPiece = { sourceRange: Range; sessionRange: Range; rate: number; offset: number; precisionMs: number; confidence: number };
export function sourceToSession(piece: ClockPiece, pts: number) { if (pts < piece.sourceRange[0] || pts > piece.sourceRange[1]) throw new Error('outside-piece'); return piece.offset + pts * piece.rate; }
export function sessionToSource(piece: ClockPiece, time: number) { if (time < piece.sessionRange[0] || time > piece.sessionRange[1]) throw new Error('outside-piece'); return (time - piece.offset) / piece.rate; }

export type SyncSignal = { method: 'timecode' | 'metadata' | 'marker' | 'audio-fingerprint' | 'visual-event' | 'manual-anchor'; score: number; anchors: { sourceMs: number; sessionMs: number }[]; reason?: string };
const SYNC_ORDER: SyncSignal['method'][] = ['timecode', 'metadata', 'marker', 'audio-fingerprint', 'visual-event', 'manual-anchor'];
export function chooseSyncStrategy(signals: SyncSignal[]) {
  const ranked = [...signals].sort((a, b) => b.score - a.score || SYNC_ORDER.indexOf(a.method) - SYNC_ORDER.indexOf(b.method));
  const selected = ranked[0];
  const status = !selected || selected.score < .55 ? 'insufficient-evidence' : selected.score < .82 ? 'review' : 'auto-apply';
  return { selected, status, alternatives: ranked.slice(1).map(item => ({ method: item.method, score: item.score, discardedBecause: item.reason ?? 'lower-score' })) };
}

export function isCovered(coverage: Range[], range: Range) { return coverage.some(interval => range[0] >= interval[0] && range[1] <= interval[1]); }
export function coverageDiagnostic(track: CaptureTrack, requested: Range) { const available = isCovered(track.coverage, requested); const gaps = track.coverage.slice(1).map((interval, index): Range => [track.coverage[index][1], interval[0]]).filter(gap => gap[1] > gap[0]); return { available, gaps, action: available ? 'selectable' : 'choose-other-source' }; }

export function fitDrift(anchors: { sourceMs: number; sessionMs: number }[]) {
  if (anchors.length < 2) throw new Error('at-least-two-anchors-required');
  const first = anchors[0], last = anchors.at(-1)!;
  const rate = (last.sessionMs - first.sessionMs) / (last.sourceMs - first.sourceMs), offset = first.sessionMs - first.sourceMs * rate;
  const residuals = anchors.map(anchor => anchor.sessionMs - (offset + anchor.sourceMs * rate));
  const maxResidualMs = Math.max(...residuals.map(Math.abs));
  return { rate, offset, ppm: (rate - 1) * 1_000_000, maxResidualMs, nonlinear: maxResidualMs > 40, safeForSpeechStretch: Math.abs((rate - 1) * 1_000_000) <= 1000 && maxResidualMs <= 40 };
}

export function detectClockPieces(points: { pts: number; fingerprint?: string; anchorSessionMs?: number }[]) {
  const pieces: { sourceRange: Range; reason: string }[] = []; let start = points[0]?.pts ?? 0;
  for (let i = 1; i < points.length; i++) if (points[i].pts <= points[i - 1].pts || points[i].pts - points[i - 1].pts > 2000) { pieces.push({ sourceRange: [start, points[i - 1].pts], reason: points[i].pts <= points[i - 1].pts ? 'rewind-or-restart' : 'gap' }); start = points[i].pts; }
  if (points.length) pieces.push({ sourceRange: [start, points.at(-1)!.pts], reason: 'continuous' });
  return pieces;
}

export function alignSeparateAudio(session: CaptureSession, masterId: string, signalsByTrack: Record<string, SyncSignal[]>) {
  const master = session.tracks.find(track => track.id === masterId && track.role === 'audio-master'); if (!master) throw new Error('audio-master-required');
  return session.tracks.filter(track => track.id !== masterId).map(track => ({ trackId: track.id, result: chooseSyncStrategy(signalsByTrack[track.id] ?? []), finalAudioId: master.id, discardScratch: track.role === 'scratch-audio' || !track.includeInFinalMix, warnings: [...(track.events.some(event => event.type === 'silence') ? ['silent-channel'] : []), ...(track.timebase !== master.timebase ? ['sample-rate-mismatch'] : [])] }));
}
