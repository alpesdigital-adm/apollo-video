import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import { SubtitleEntry, ColorPalette, SubtitleWord } from '../lib/types';

interface SubtitleTikTokProps {
  subtitle: SubtitleEntry;
  palette: ColorPalette;
  isVisible: boolean;
}

export const SubtitleTikTok: React.FC<SubtitleTikTokProps> = ({
  subtitle,
  isVisible,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const currentTime = frame / config.fps;

  if (!isVisible) {
    return null;
  }

  const duration = subtitle.endTime - subtitle.startTime;
  const timeInSubtitle = currentTime - subtitle.startTime;

  const opacity = interpolate(
    timeInSubtitle,
    [0, 0.1, duration - 0.1, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const phrase = getCurrentSubtitlePhrase(subtitle, currentTime, timeInSubtitle, duration);
  const lines = splitSubtitleLines(phrase);

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
        {lines.map((line, index) => (
          <div
            key={index}
            style={{
              fontSize: getLineFontSize(line),
              fontWeight: 850,
              lineHeight: 1.08,
              whiteSpace: 'nowrap',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </AbsoluteFill>
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
