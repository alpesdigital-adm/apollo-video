import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';
import { SubtitleEntry, ColorPalette, SubtitleWord, SubtitleStyle } from '../lib/types';

const DEFAULT_ACCENT = '#FFB800';

interface SubtitleTikTokProps {
  subtitle: SubtitleEntry;
  palette: ColorPalette;
  isVisible: boolean;
  // 'two-word-center' is used during split-50 segments: at most two words at a
  // time, large and centered on the 50/50 seam, karaoke highlight preserved.
  mode?: 'default' | 'two-word-center';
  // Subtitle preset. 'kinetic' (default) = comportamento original intocado.
  subtitleStyle?: SubtitleStyle;
}

// Per-preset spec for the parametrized subtitle presets (everything except the
// original 'kinetic' path, which is left untouched below). chunkSize = quantas
// palavras por vez (re-chunk word-level); container = caixa/pill/none; cores por
// estado (ativa/dita/futura); pop = spring na palavra ativa; stroke = contorno
// preto grosso; '@accent' resolve para palette.accent em runtime.
interface SubtitlePresetSpec {
  chunkSize: number;
  container: 'none' | 'box' | 'pill';
  activeColor: string;
  pastColor: string;
  futureColor: string;
  pop: boolean;
  stroke: boolean;
  dropShadow: boolean;
  uppercase: boolean;
  lowercase: boolean;
  fontSize: number;
  fontWeight: number;
}

const PRESET_SPECS: Record<Exclude<SubtitleStyle, 'kinetic'>, SubtitlePresetSpec> = {
  'karaoke-box': {
    chunkSize: 3,
    container: 'box',
    activeColor: '#FFD400',
    pastColor: '#FFFFFF',
    futureColor: '#FFFFFF',
    pop: true,
    stroke: false,
    dropShadow: false,
    uppercase: false,
    lowercase: false,
    fontSize: 58,
    fontWeight: 800,
  },
  'karaoke-pill': {
    chunkSize: 5,
    container: 'pill',
    activeColor: '#FFFFFF',
    pastColor: '#FFFFFF',
    futureColor: 'rgba(255,255,255,0.45)',
    pop: false,
    stroke: false,
    dropShadow: false,
    uppercase: false,
    lowercase: false,
    fontSize: 52,
    fontWeight: 700,
  },
  'caps-stroke': {
    chunkSize: 3,
    container: 'none',
    activeColor: '#FFD400',
    pastColor: '#FFFFFF',
    futureColor: '#FFFFFF',
    pop: true,
    stroke: true,
    dropShadow: false,
    uppercase: true,
    lowercase: false,
    fontSize: 66,
    fontWeight: 800,
  },
  'clean-color': {
    chunkSize: 2,
    container: 'none',
    activeColor: '@accent',
    pastColor: '#FFFFFF',
    futureColor: '#FFFFFF',
    pop: false,
    stroke: false,
    dropShadow: true,
    uppercase: false,
    lowercase: true,
    fontSize: 62,
    fontWeight: 800,
  },
};

// Returns the frame at which the given timed word starts, relative to the
// composition timeline (not relative to the subtitle).
function wordStartFrame(word: SubtitleWord, fps: number): number {
  return Math.round(word.start * fps);
}

interface KaraokeWord {
  word: string;
  timedWord: SubtitleWord | null; // null = no timing info for this word
}

// Match plain-text words in `phraseText` back to the timed words array so
// we can attach timing info per word for the highlight.
function buildKaraokeWords(
  phraseText: string,
  chunkTimedWords: SubtitleWord[]
): KaraokeWord[] {
  const phraseWords = phraseText.split(' ').filter(Boolean);
  // Build a lookup from normalized word text to its timed entry (first match).
  // We consume entries in order to handle repeated words correctly.
  const remaining = [...chunkTimedWords];

  return phraseWords.map((pw) => {
    const idx = remaining.findIndex(
      (tw) => tw.word.toLowerCase() === pw.toLowerCase()
    );
    if (idx !== -1) {
      const timedWord = remaining[idx];
      remaining.splice(idx, 1);
      return { word: pw, timedWord };
    }
    return { word: pw, timedWord: null };
  });
}

export const SubtitleTikTok: React.FC<SubtitleTikTokProps> = ({
  subtitle,
  palette,
  isVisible,
  mode = 'default',
  subtitleStyle = 'kinetic',
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const currentTime = frame / config.fps;

  if (!isVisible) {
    return null;
  }

  const accentColor = palette?.accent ?? DEFAULT_ACCENT;

  // --- Determine active chunk and its timed words ---
  const timedWords = normalizeTimedWords(subtitle.words);
  const hasWordTimings = timedWords.length > 0;

  // Defense-in-depth: the subtitle's own endTime is expected to already cover
  // the last word (see generateSubtitlesFromTranscription in silence.ts), but
  // guard against stale/short endTime data so the final word's visibility
  // never gets clipped by the fade-out window below.
  const lastWordEnd = hasWordTimings
    ? timedWords[timedWords.length - 1].end
    : subtitle.endTime;
  const effectiveEndTime = Math.max(subtitle.endTime, lastWordEnd + 0.05);

  const duration = effectiveEndTime - subtitle.startTime;
  const timeInSubtitle = currentTime - subtitle.startTime;

  const opacity = interpolate(
    timeInSubtitle,
    [0, 0.1, duration - 0.1, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // --- two-word-center mode (split-50 seam) ---
  if (mode === 'two-word-center') {
    const pair = getTwoWordPair(subtitle, timedWords, currentTime, timeInSubtitle, duration);
    return (
      <AbsoluteFill style={{ opacity }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '0 0.3em',
            padding: '0 60px',
            textAlign: 'center',
            fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
            textShadow: '0 6px 22px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9)',
          }}
        >
          {pair.map((kw, i) => (
            <TwoWordSpan
              key={i}
              word={kw.word}
              timedWord={kw.timedWord}
              currentTime={currentTime}
              frame={frame}
              fps={config.fps}
              accentColor={accentColor}
            />
          ))}
        </div>
      </AbsoluteFill>
    );
  }

  // --- Parametrized presets (everything except 'kinetic') ---
  // two-word-center (split-50 seam) always takes precedence above; below the
  // seam, when a non-default preset is selected we re-chunk by word count and
  // render the chosen box/pill/stroke/color style. 'kinetic' falls through to
  // the original path untouched.
  if (subtitleStyle !== 'kinetic') {
    const spec = PRESET_SPECS[subtitleStyle];
    const chunk = getChunkWords(
      subtitle,
      timedWords,
      currentTime,
      timeInSubtitle,
      duration,
      spec.chunkSize
    );
    const resolvedActive = spec.activeColor === '@accent' ? accentColor : spec.activeColor;

    const containerStyle: React.CSSProperties = {
      display: 'inline-flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      alignItems: 'baseline',
      maxWidth: '82%',
      gap: '0 0.28em',
      textAlign: 'center',
      fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
      lineHeight: 1.1,
    };
    if (spec.container === 'box') {
      containerStyle.background = 'rgba(0,0,0,0.8)';
      containerStyle.borderRadius = 12;
      containerStyle.padding = '10px 22px';
    } else if (spec.container === 'pill') {
      containerStyle.background = 'rgba(10,10,14,0.82)';
      containerStyle.borderRadius = 9999;
      containerStyle.padding = '14px 34px';
    }

    return (
      <AbsoluteFill style={{ opacity }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 560,
            display: 'flex',
            justifyContent: 'center',
            padding: '0 60px',
          }}
        >
          <div style={containerStyle}>
            {chunk.map((kw, i) => (
              <PresetWordSpan
                key={i}
                word={kw.word}
                timedWord={kw.timedWord}
                currentTime={currentTime}
                frame={frame}
                fps={config.fps}
                spec={spec}
                activeColor={resolvedActive}
              />
            ))}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  const phrase = getCurrentSubtitlePhrase(subtitle, currentTime, timeInSubtitle, duration);

  // Get timed words that belong to the current phrase chunk so we can do
  // per-word highlight. Only available when word timestamps exist.
  let chunkTimedWords: SubtitleWord[] = [];
  if (hasWordTimings) {
    const chunks = buildTimedPhraseChunks(timedWords);
    const activeChunk = chunks.find(
      (c) => currentTime >= c.start - 0.04 && currentTime < c.end + 0.08
    ) ?? chunks.reduce<typeof chunks[0] | null>((best, c) => {
      if (!best) return c;
      const bestDist = Math.abs(currentTime - (best.start + best.end) / 2);
      const cDist = Math.abs(currentTime - (c.start + c.end) / 2);
      return cDist < bestDist ? c : best;
    }, null);

    if (activeChunk) {
      chunkTimedWords = timedWords.filter(
        (tw) => tw.start >= activeChunk.start - 0.04 && tw.end <= activeChunk.end + 0.08
      );
    }
  }

  const lines = splitSubtitleLines(phrase);

  // When we have word timing, build a flat list of KaraokeWord for the whole
  // phrase so we can assign colors per-word across lines.
  const karaokeWords = hasWordTimings && chunkTimedWords.length > 0
    ? buildKaraokeWords(phrase, chunkTimedWords)
    : null;

  // Pointer into karaokeWords to distribute across lines
  let wordCursor = 0;

  return (
    <AbsoluteFill
      style={{
        opacity,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 86,
          right: 86,
          bottom: 560,
          textAlign: 'center',
          fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
          color: '#FFFFFF',
          textShadow: '0 5px 18px rgba(0, 0, 0, 0.95), 0 1px 2px rgba(0,0,0,0.9)',
        }}
      >
        {lines.map((line, lineIndex) => {
          const fontSize = getLineFontSize(line);

          if (!karaokeWords) {
            // Fallback: static white line (no timing info)
            return (
              <div
                key={lineIndex}
                style={{
                  fontSize,
                  fontWeight: 850,
                  lineHeight: 1.08,
                  whiteSpace: 'nowrap',
                }}
              >
                {line}
              </div>
            );
          }

          // Assign karaoke words to this line
          const lineWordCount = line.split(' ').filter(Boolean).length;
          const lineKaraokeWords = karaokeWords.slice(wordCursor, wordCursor + lineWordCount);
          wordCursor += lineWordCount;

          return (
            <div
              key={lineIndex}
              style={{
                fontSize,
                fontWeight: 850,
                lineHeight: 1.08,
                whiteSpace: 'nowrap',
              }}
            >
              {lineKaraokeWords.map((kw, wi) => (
                <KaraokeWordSpan
                  key={wi}
                  word={kw.word}
                  timedWord={kw.timedWord}
                  currentTime={currentTime}
                  frame={frame}
                  fps={config.fps}
                  accentColor={accentColor}
                  isLast={wi === lineKaraokeWords.length - 1}
                />
              ))}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

interface KaraokeWordSpanProps {
  word: string;
  timedWord: SubtitleWord | null;
  currentTime: number;
  frame: number;
  fps: number;
  accentColor: string;
  isLast: boolean;
}

const KaraokeWordSpan: React.FC<KaraokeWordSpanProps> = ({
  word,
  timedWord,
  currentTime,
  frame,
  fps,
  accentColor,
  isLast,
}) => {
  let color: string;
  let scale = 1;

  if (timedWord !== null) {
    const isActive = currentTime >= timedWord.start && currentTime < timedWord.end;
    const isPast = currentTime >= timedWord.end;

    if (isActive) {
      color = accentColor;
      // Pop: spring from 1→1.12 over ~4 frames when word becomes active
      const framesSinceStart = frame - wordStartFrame(timedWord, fps);
      const pop = spring({
        frame: Math.max(0, framesSinceStart),
        fps,
        config: { damping: 14, stiffness: 200, mass: 0.6 },
        from: 1.0,
        to: 1.12,
        durationInFrames: 6,
      });
      scale = pop;
    } else if (isPast) {
      color = '#FFFFFF';
    } else {
      // Future word
      color = 'rgba(255,255,255,0.75)';
    }
  } else {
    // No timing for this word — treat as white (no highlight)
    color = '#FFFFFF';
  }

  return (
    <span
      style={{
        color,
        display: 'inline-block',
        transform: `scale(${scale})`,
        transformOrigin: 'center bottom',
        // Space after word (except last in line)
        marginRight: isLast ? 0 : '0.22em',
      }}
    >
      {word}
    </span>
  );
};

interface TwoWordSpanProps {
  word: string;
  timedWord: SubtitleWord | null;
  currentTime: number;
  frame: number;
  fps: number;
  accentColor: string;
}

const TwoWordSpan: React.FC<TwoWordSpanProps> = ({
  word,
  timedWord,
  currentTime,
  frame,
  fps,
  accentColor,
}) => {
  let color = '#FFFFFF';
  let scale = 1;

  if (timedWord !== null) {
    const isActive = currentTime >= timedWord.start && currentTime < timedWord.end;
    const isFuture = currentTime < timedWord.start;
    if (isActive) {
      color = accentColor;
      const framesSinceStart = frame - wordStartFrame(timedWord, fps);
      scale = spring({
        frame: Math.max(0, framesSinceStart),
        fps,
        config: { damping: 14, stiffness: 200, mass: 0.6 },
        from: 1.0,
        to: 1.1,
        durationInFrames: 6,
      });
    } else if (isFuture) {
      color = 'rgba(255,255,255,0.75)';
    }
  }

  return (
    <span
      style={{
        color,
        fontSize: 92,
        fontWeight: 800,
        lineHeight: 1.02,
        letterSpacing: '-0.02em',
        display: 'inline-block',
        transform: `scale(${scale})`,
        transformOrigin: 'center',
      }}
    >
      {word}
    </span>
  );
};

interface PresetWordSpanProps {
  word: string;
  timedWord: SubtitleWord | null;
  currentTime: number;
  frame: number;
  fps: number;
  spec: SubtitlePresetSpec;
  activeColor: string;
}

// One word inside a parametrized preset chunk. Color/progression is driven by
// the preset spec: active word = activeColor, already-spoken = pastColor,
// upcoming = futureColor; optional spring pop; optional thick black stroke
// (paint-order stroke so the fill isn't eaten) for caps-stroke.
const PresetWordSpan: React.FC<PresetWordSpanProps> = ({
  word,
  timedWord,
  currentTime,
  frame,
  fps,
  spec,
  activeColor,
}) => {
  let color = spec.pastColor;
  let scale = 1;

  if (timedWord !== null) {
    const isActive = currentTime >= timedWord.start && currentTime < timedWord.end;
    const isFuture = currentTime < timedWord.start;
    if (isActive) {
      color = activeColor;
      if (spec.pop) {
        const framesSinceStart = frame - wordStartFrame(timedWord, fps);
        scale = spring({
          frame: Math.max(0, framesSinceStart),
          fps,
          config: { damping: 14, stiffness: 200, mass: 0.6 },
          from: 1.0,
          to: 1.12,
          durationInFrames: 6,
        });
      }
    } else if (isFuture) {
      color = spec.futureColor;
    } else {
      color = spec.pastColor;
    }
  }

  const style: React.CSSProperties = {
    color,
    fontSize: spec.fontSize,
    fontWeight: spec.fontWeight,
    letterSpacing: '-0.01em',
    display: 'inline-block',
    transform: `scale(${scale})`,
    transformOrigin: 'center bottom',
  };
  if (spec.uppercase) style.textTransform = 'uppercase';
  if (spec.lowercase) style.textTransform = 'lowercase';
  if (spec.stroke) {
    style.WebkitTextStroke = '8px #000000';
    style.paintOrder = 'stroke fill';
    style.textShadow = '0 3px 10px rgba(0,0,0,0.55)';
  } else if (spec.dropShadow) {
    style.textShadow = '0 4px 16px rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.85)';
  } else if (spec.container === 'none') {
    style.textShadow = '0 4px 14px rgba(0,0,0,0.85)';
  }

  return <span style={style}>{word}</span>;
};

// Return the active chunk of `size` words for the current instant. Uses
// word-level timings (fixed consecutive groups, picking the group whose window
// contains the time) when available; otherwise splits the plain text into
// groups distributed evenly across the subtitle's duration (no per-word
// highlight in that degraded case). Shared base for all parametrized presets.
function getChunkWords(
  subtitle: SubtitleEntry,
  timedWords: SubtitleWord[],
  currentTime: number,
  timeInSubtitle: number,
  duration: number,
  size: number
): KaraokeWord[] {
  const groupSize = Math.max(1, size);
  if (timedWords.length > 0) {
    const groups: SubtitleWord[][] = [];
    for (let i = 0; i < timedWords.length; i += groupSize) {
      groups.push(timedWords.slice(i, i + groupSize));
    }
    const active =
      groups.find((g) => {
        const start = g[0].start;
        const end = g[g.length - 1].end;
        return currentTime >= start - 0.04 && currentTime < end + 0.08;
      }) ??
      groups
        .map((g) => ({
          g,
          dist: Math.abs(currentTime - (g[0].start + g[g.length - 1].end) / 2),
        }))
        .sort((a, b) => a.dist - b.dist)[0]?.g ??
      [];
    return active.map((tw) => ({ word: tw.word, timedWord: tw }));
  }

  const words = normalizeText(subtitle.text).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const groups: string[][] = [];
  for (let i = 0; i < words.length; i += groupSize) {
    groups.push(words.slice(i, i + groupSize));
  }
  const fraction = duration > 0 ? Math.max(0, Math.min(0.999, timeInSubtitle / duration)) : 0;
  const index = Math.min(groups.length - 1, Math.floor(fraction * groups.length));
  return groups[index].map((word) => ({ word, timedWord: null }));
}

// Return at most two words for the current instant. Uses word-level timings
// (fixed consecutive pairs, picking the pair whose window contains the time)
// when available; otherwise splits the phrase into pairs distributed evenly
// across the subtitle's duration.
function getTwoWordPair(
  subtitle: SubtitleEntry,
  timedWords: SubtitleWord[],
  currentTime: number,
  timeInSubtitle: number,
  duration: number
): KaraokeWord[] {
  if (timedWords.length > 0) {
    const pairs: SubtitleWord[][] = [];
    for (let i = 0; i < timedWords.length; i += 2) {
      pairs.push(timedWords.slice(i, i + 2));
    }
    const active =
      pairs.find((p) => {
        const start = p[0].start;
        const end = p[p.length - 1].end;
        return currentTime >= start - 0.04 && currentTime < end + 0.08;
      }) ??
      pairs
        .map((p) => ({
          p,
          dist: Math.abs(currentTime - (p[0].start + p[p.length - 1].end) / 2),
        }))
        .sort((a, b) => a.dist - b.dist)[0]?.p ??
      [];
    return active.map((tw) => ({ word: tw.word, timedWord: tw }));
  }

  const words = normalizeText(subtitle.text).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const pairs: string[][] = [];
  for (let i = 0; i < words.length; i += 2) {
    pairs.push(words.slice(i, i + 2));
  }
  const fraction = duration > 0 ? Math.max(0, Math.min(0.999, timeInSubtitle / duration)) : 0;
  const index = Math.min(pairs.length - 1, Math.floor(fraction * pairs.length));
  return pairs[index].map((word) => ({ word, timedWord: null }));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function canWrapWithinTwoLines(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length <= 40) {
    return true;
  }

  const words = normalized.split(' ').filter(Boolean);
  for (let index = 1; index < words.length; index += 1) {
    const first = words.slice(0, index).join(' ');
    const second = words.slice(index).join(' ');
    if (first.length <= 40 && second.length <= 40) {
      return true;
    }
  }

  return false;
}

function splitIntoPhrases(text: string): string[] {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const phrases: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if ((next.length > 80 || !canWrapWithinTwoLines(next)) && current) {
      phrases.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    phrases.push(current);
  }

  return phrases.length > 0 ? phrases : [normalizeText(text)];
}

function normalizeTimedWords(words?: SubtitleEntry['words']): SubtitleWord[] {
  if (!Array.isArray(words)) {
    return [];
  }

  return words
    .map((entry) => {
      if (typeof entry === 'string') {
        return null;
      }

      const word = normalizeText(entry.word || '');
      const start = Number(entry.start);
      const end = Number(entry.end);

      if (!word || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return null;
      }

      return { word, start, end };
    })
    .filter(Boolean) as SubtitleWord[];
}

function buildTimedPhraseChunks(words: SubtitleWord[]): Array<{ text: string; start: number; end: number }> {
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let currentWords: SubtitleWord[] = [];

  const flush = () => {
    if (currentWords.length === 0) {
      return;
    }

    chunks.push({
      text: currentWords.map((word) => word.word).join(' '),
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
    });
    currentWords = [];
  };

  for (const word of words) {
    const nextWords = [...currentWords, word];
    const nextText = nextWords.map((item) => item.word).join(' ');
    const nextDuration = nextWords[nextWords.length - 1].end - nextWords[0].start;

    if (
      currentWords.length > 0 &&
      (nextText.length > 80 || nextDuration > 2.6 || !canWrapWithinTwoLines(nextText))
    ) {
      flush();
    }

    currentWords.push(word);

    const currentText = currentWords.map((item) => item.word).join(' ');
    if (/[.!?;:]$/.test(word.word) && currentText.length >= 24) {
      flush();
    }
  }

  flush();
  return chunks;
}

function getCurrentSubtitlePhrase(
  subtitle: SubtitleEntry,
  currentTime: number,
  timeInSubtitle: number,
  duration: number
): string {
  const timedWords = normalizeTimedWords(subtitle.words);
  if (timedWords.length > 0) {
    const chunks = buildTimedPhraseChunks(timedWords);
    const activeChunk = chunks.find((chunk) => (
      currentTime >= chunk.start - 0.04 && currentTime < chunk.end + 0.08
    ));

    if (activeChunk) {
      return activeChunk.text;
    }

    const nearestChunk = chunks
      .map((chunk) => ({
        chunk,
        distance: Math.abs(currentTime - ((chunk.start + chunk.end) / 2)),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.chunk;

    if (nearestChunk) {
      return nearestChunk.text;
    }
  }

  const phrases = splitIntoPhrases(subtitle.text);
  if (phrases.length <= 1 || duration <= 0) {
    return phrases[0] || '';
  }

  const totalWeight = phrases.reduce((sum, phrase) => sum + Math.max(1, phrase.length), 0);
  const elapsedWeight = Math.max(0, Math.min(1, timeInSubtitle / duration)) * totalWeight;
  let cursor = 0;

  for (const phrase of phrases) {
    cursor += Math.max(1, phrase.length);
    if (elapsedWeight <= cursor) {
      return phrase;
    }
  }

  return phrases[phrases.length - 1];
}

function splitSubtitleLines(phrase: string): string[] {
  const normalized = normalizeText(phrase);
  if (normalized.length <= 40) {
    return [normalized];
  }

  const words = normalized.split(' ').filter(Boolean);
  let bestSplit: string[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 1; index < words.length; index += 1) {
    const first = words.slice(0, index).join(' ');
    const second = words.slice(index).join(' ');

    if (first.length <= 40 && second.length <= 40) {
      const score = Math.abs(first.length - second.length);
      if (score < bestScore) {
        bestScore = score;
        bestSplit = [first, second];
      }
    }
  }

  if (bestSplit) {
    return bestSplit;
  }

  return [normalized.slice(0, 40).trim(), normalized.slice(40, 80).trim()].filter(Boolean);
}

function getLineFontSize(line: string): string {
  if (line.length > 34) {
    return '42px';
  }

  if (line.length > 28) {
    return '46px';
  }

  if (line.length > 22) {
    return '52px';
  }

  return '58px';
}
