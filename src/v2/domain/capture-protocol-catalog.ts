import {
  createCaptureProtocol,
  type CaptureProtocol,
  type CaptureScenario,
} from './capture-protocol.ts'
import { assertDomain } from './errors.ts'

/**
 * The four published capture protocols (F4.009 / FR-147, spec 05 §14.2).
 *
 * These are content-addressed and versioned: publishing a change means
 * publishing version 2, never editing version 1. A session evaluated last
 * month must still be readable against the protocol it was actually judged by,
 * or the evaluation becomes a claim about a document that no longer exists.
 *
 * Every `required` entry names a capability that disappears without it. That
 * constraint is enforced in the constructor, and it is what stops this file
 * drifting into a wish list — if you cannot say what breaks, it is a
 * recommendation.
 */

const PUBLISHED_AT = '2026-09-04T00:00:00.000Z'

/**
 * Teacher and screen: two recorders that usually share no clock and often no
 * sound. This is the scenario the marker exists for.
 */
const TEACHER_AND_SCREEN = createCaptureProtocol({
  protocolId: 'teacher-and-screen-v1',
  scenario: 'teacher-and-screen',
  version: 1,
  title: 'Professor e tela',
  summary: 'Uma câmera no professor e uma captura de tela, gravadas por ferramentas diferentes que quase nunca compartilham relógio.',
  bestCeiling: 'automatic',
  expectedTracks: [
    { role: 'camera-main', minimum: 1, maximum: 2, mustCarryAudio: true, note: 'A câmera do professor, com o áudio dela.' },
    { role: 'screen', minimum: 1, maximum: 1, mustCarryAudio: true, note: 'A captura de tela, com o áudio do sistema ou do microfone.' },
  ],
  requirements: [
    {
      requirementId: 'teacher-camera-present',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-present', role: 'camera-main', minimum: 1 },
      statement: 'Grave o professor com uma câmera dedicada, além da captura de tela.',
      losesCapabilities: ['reference-cross-check'],
      consequence: 'Sem a câmera não há segunda fonte para conferir o alinhamento da tela; o corte fica preso ao que a tela mostrar.',
    },
    {
      requirementId: 'screen-present',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-present', role: 'screen', minimum: 1 },
      statement: 'Envie a captura de tela original, não uma regravação da tela filmada pela câmera.',
      losesCapabilities: ['reference-cross-check'],
      consequence: 'Filmar o monitor perde legibilidade e introduz cintilação; a tela original é a única fonte utilizável.',
    },
    {
      requirementId: 'screen-carries-audio',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-carries-sync-audio', role: 'screen' },
      statement: 'Deixe o microfone ativo na gravação de tela, mesmo que esse áudio não vá para o vídeo final.',
      losesCapabilities: ['audio-fingerprint'],
      consequence: 'Sem áudio na tela não há evento acústico em comum, e o alinhamento passa a depender inteiramente do marker ou de anchor manual.',
    },
    {
      requirementId: 'start-marker',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'start' },
      statement: 'Emita o Apollo Sync Marker com as duas gravações já rodando, antes de começar a falar.',
      losesCapabilities: ['marker-correlation'],
      consequence: 'Sem o marker inicial o deslocamento entre câmera e tela precisa ser encontrado por outro meio, e nenhum outro meio é tão exato.',
    },
    {
      requirementId: 'end-marker',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'end' },
      statement: 'Emita o marker de novo ao terminar, antes de parar qualquer gravação.',
      losesCapabilities: ['drift-measurement'],
      consequence: 'Com um único marker dá para alinhar o início, mas não para medir a deriva ao longo da aula; uma hora de aula pode terminar meio segundo fora.',
    },
    {
      requirementId: 'no-unmarked-restart',
      level: 'required',
      verification: 'observed',
      check: { kind: 'single-continuous-recording', role: 'screen' },
      statement: 'Não pause nem reinicie a captura de tela; se for inevitável, emita um marker novo logo após retomar.',
      losesCapabilities: ['continuous-piecewise-map'],
      consequence: 'Uma retomada sem marker cria um trecho cujo deslocamento ninguém mediu, e o sistema recusa resolver tempos dentro dele.',
    },
    {
      requirementId: 'headphones',
      level: 'recommended',
      verification: 'attested',
      check: { kind: 'operator-attestation' },
      statement: 'Use fones durante a aula para o áudio do computador não voltar pelo microfone da câmera.',
      losesCapabilities: ['audio-fingerprint'],
      consequence: 'O áudio do computador vazando para a câmera cria uma correlação falsa: as duas faixas parecem alinhadas quando não estão.',
    },
  ],
  publishedAt: PUBLISHED_AT,
})

/** Podcast: several cameras, one good recorder, and scratch audio everywhere. */
const PODCAST = createCaptureProtocol({
  protocolId: 'podcast-v1',
  scenario: 'podcast',
  version: 1,
  title: 'Podcast',
  summary: 'Duas ou mais câmeras e um gravador de áudio dedicado, onde o som que vai ao ar não é o som que sincroniza.',
  bestCeiling: 'automatic',
  expectedTracks: [
    { role: 'camera-main', minimum: 1, maximum: null, mustCarryAudio: true, note: 'Cada câmera grava o próprio áudio de referência.' },
    { role: 'master-audio', minimum: 1, maximum: 1, mustCarryAudio: true, note: 'O gravador dedicado: o som que vai ao ar.' },
  ],
  requirements: [
    {
      requirementId: 'master-audio-present',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-present', role: 'master-audio', minimum: 1 },
      statement: 'Grave o áudio principal num gravador dedicado, separado das câmeras.',
      losesCapabilities: ['reference-cross-check'],
      consequence: 'O áudio das câmeras costuma bastar para sincronizar e não para publicar; sem o gravador o produto final herda o som pior.',
    },
    {
      requirementId: 'cameras-keep-scratch-audio',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-carries-sync-audio', role: 'camera-main' },
      statement: 'Mantenha o microfone das câmeras ligado, mesmo sabendo que esse áudio será descartado na mixagem.',
      losesCapabilities: ['audio-fingerprint'],
      consequence: 'É o áudio ruim das câmeras que casa com o áudio bom do gravador; desligá-lo remove a única evidência que alinha os dois.',
    },
    {
      requirementId: 'two-cameras',
      level: 'recommended',
      verification: 'observed',
      check: { kind: 'distinct-devices', minimum: 3 },
      statement: 'Use ao menos duas câmeras em corpos diferentes, além do gravador de áudio.',
      losesCapabilities: [],
      consequence: 'Com uma câmera só não há para onde cortar; o episódio inteiro fica num plano.',
    },
    {
      requirementId: 'start-marker',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'start' },
      statement: 'Emita o marker com tudo gravando, antes da primeira fala.',
      losesCapabilities: ['marker-correlation'],
      consequence: 'Sem marker o alinhamento depende só da correlação de áudio, que erra quando duas pessoas falam ao mesmo tempo.',
    },
    {
      requirementId: 'end-marker',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'end' },
      statement: 'Emita o marker de novo no fim, antes de parar qualquer gravador.',
      losesCapabilities: ['drift-measurement'],
      consequence: 'Gravadores baratos derivam alguns milissegundos por minuto; sem o segundo marker isso só aparece na edição, como lábios fora de sincronia no fim.',
    },
  ],
  publishedAt: PUBLISHED_AT,
})

/**
 * React: the hardest case, because the reference material is inside the
 * recording and the reactor pauses it at will.
 */
const REACT = createCaptureProtocol({
  protocolId: 'react-v1',
  scenario: 'react',
  version: 1,
  title: 'React',
  summary: 'Alguém reagindo a um vídeo, onde o material de referência aparece dentro da própria gravação e é pausado, voltado e repetido.',
  bestCeiling: 'automatic-with-review',
  expectedTracks: [
    { role: 'reaction', minimum: 1, maximum: null, mustCarryAudio: true, note: 'A câmera da pessoa reagindo.' },
    { role: 'reference-video', minimum: 1, maximum: 1, mustCarryAudio: true, note: 'O vídeo original, enviado à parte.' },
  ],
  requirements: [
    {
      requirementId: 'reference-video-present',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-present', role: 'reference-video', minimum: 1 },
      statement: 'Envie o vídeo original à parte, além da gravação da reação.',
      losesCapabilities: ['reference-cross-check', 'audio-fingerprint'],
      consequence: 'Sem o original não há como encontrar quais trechos foram assistidos, nem em que ordem; sobra só a fala do reactor.',
    },
    {
      requirementId: 'reaction-present',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-present', role: 'reaction', minimum: 1 },
      statement: 'Grave a reação em arquivo próprio, não apenas como captura da tela inteira.',
      losesCapabilities: ['reference-cross-check'],
      consequence: 'Uma captura única da tela mistura reação e referência num só sinal, e nada consegue separá-los depois.',
    },
    {
      requirementId: 'reaction-carries-audio',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-carries-sync-audio', role: 'reaction' },
      statement: 'Deixe o áudio do vídeo original audível na gravação da reação, ainda que baixo.',
      losesCapabilities: ['audio-fingerprint'],
      consequence: 'É o som do original vazando na reação que permite localizar os trechos assistidos; sem ele o alinhamento vira trabalho manual trecho a trecho.',
    },
    {
      requirementId: 'start-marker',
      level: 'recommended',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'start' },
      statement: 'Emita o marker antes de dar play no vídeo original.',
      losesCapabilities: ['marker-correlation'],
      consequence: 'Sem marker o começo é encontrado por correlação, que é mais lenta e menos exata quando o reactor fala por cima.',
    },
  ],
  publishedAt: PUBLISHED_AT,
})

/** Multicam: many bodies, one event, and no assumption that any clock agrees. */
const MULTICAM = createCaptureProtocol({
  protocolId: 'multicam-v1',
  scenario: 'multicam',
  version: 1,
  title: 'Multicâmera',
  summary: 'Várias câmeras cobrindo o mesmo evento, cada uma com o próprio relógio e o próprio momento de começar.',
  bestCeiling: 'automatic',
  expectedTracks: [
    { role: 'camera-main', minimum: 1, maximum: null, mustCarryAudio: true, note: 'A câmera principal, que costuma virar a referência.' },
    { role: 'camera-alt', minimum: 1, maximum: null, mustCarryAudio: true, note: 'As demais câmeras do evento.' },
  ],
  requirements: [
    {
      requirementId: 'multiple-cameras',
      level: 'required',
      verification: 'observed',
      check: { kind: 'distinct-devices', minimum: 2 },
      statement: 'Use ao menos dois corpos de câmera distintos; dois cartões da mesma câmera não são multicâmera.',
      losesCapabilities: ['reference-cross-check'],
      consequence: 'Com um corpo só não há ângulo alternativo para cortar, e a sessão não é multicâmera por definição.',
    },
    {
      requirementId: 'every-camera-keeps-audio',
      level: 'required',
      verification: 'observed',
      check: { kind: 'track-carries-sync-audio', role: 'camera-alt' },
      statement: 'Mantenha o áudio ligado em todas as câmeras, inclusive nas que só entram como corte.',
      losesCapabilities: ['audio-fingerprint'],
      consequence: 'Uma câmera muda não tem como ser alinhada por som e passa a exigir marker ou anchor manual só para ela.',
    },
    {
      requirementId: 'start-marker',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'start' },
      statement: 'Emita o marker com todas as câmeras já rodando, antes do evento começar.',
      losesCapabilities: ['marker-correlation'],
      consequence: 'Câmeras que começam em momentos diferentes só têm um instante em comum se alguém o criar; o marker é esse instante.',
    },
    {
      requirementId: 'end-marker',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'end' },
      statement: 'Emita o marker no fim, antes de parar a primeira câmera.',
      losesCapabilities: ['drift-measurement'],
      consequence: 'Sem o segundo marker a deriva entre corpos diferentes não é medida, e num evento longo os ângulos se separam progressivamente.',
    },
    {
      requirementId: 'marker-after-restart',
      level: 'required',
      verification: 'observed',
      check: { kind: 'marker-observed', position: 'after-restart' },
      statement: 'Se qualquer câmera parar por cartão cheio ou bateria, emita um marker novo assim que ela voltar.',
      losesCapabilities: ['continuous-piecewise-map'],
      consequence: 'O trecho posterior à retomada tem deslocamento próprio; sem marker novo ele fica sem mapa e nada é resolvido ali dentro.',
    },
  ],
  publishedAt: PUBLISHED_AT,
})

export const PUBLISHED_CAPTURE_PROTOCOLS: readonly Readonly<CaptureProtocol>[] = Object.freeze([
  TEACHER_AND_SCREEN,
  PODCAST,
  REACT,
  MULTICAM,
])

export function findCaptureProtocol(protocolId: string): Readonly<CaptureProtocol> {
  const protocol = PUBLISHED_CAPTURE_PROTOCOLS.find((entry) => entry.protocolId === protocolId)
  assertDomain(protocol !== undefined, 'CAPTURE_PROTOCOL_NOT_FOUND', `capture protocol ${protocolId} is not published`)
  return protocol!
}

/** The current protocol for a scenario: the highest published version. */
export function currentProtocolForScenario(scenario: CaptureScenario): Readonly<CaptureProtocol> {
  const candidates = PUBLISHED_CAPTURE_PROTOCOLS
    .filter((entry) => entry.scenario === scenario)
    .sort((left, right) => right.version - left.version)
  assertDomain(
    candidates.length > 0,
    'CAPTURE_PROTOCOL_NOT_FOUND',
    `no capture protocol is published for ${scenario}`,
  )
  return candidates[0]!
}
