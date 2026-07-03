import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';
import { SubtitleEntry, ColorPalette, SubtitleWord } from '../lib/types';

const DEFAULT_ACCENT = '#FFB800';

interface SubtitleTikTokProps {
  subtitle: SubtitleEntry;
  palette: ColorPalette;
  isVisible: boolean;
}

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
