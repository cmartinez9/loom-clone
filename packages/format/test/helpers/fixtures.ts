/**
 * Fixture documents.
 *
 * These are the architecture report's own examples (§2.2, §2.3, §2.6), trimmed to
 * what a test needs and kept structurally identical. If the report's shape and
 * these disagree, the report is right and these are the bug.
 */

import { currentSchemaId } from '../../src/schema.ts';
import type { ProjectDoc } from '../../src/types/project.ts';
import type { RecordingDoc } from '../../src/types/recording.ts';
import type { EditDocument } from '../../src/types/edit.ts';

export const FIXTURE_ID = '01K1Y7QZ8N3M4P5R6S7T8V9W0X';

export function fixtureProject(overrides: Partial<ProjectDoc> = {}): ProjectDoc {
  return {
    schema: currentSchemaId('loom.project'),
    appVersion: '0.1.0',
    id: FIXTURE_ID,
    name: 'Untitled',
    createdAt: '2026-08-04T14:32:11.482Z',
    modifiedAt: '2026-08-04T14:41:03.117Z',
    state: 'editable',
    editRevision: 47,
    sizeBytes: 2_384_912_004,
    exports: [],
    ...overrides,
  };
}

export function fixtureRecording(overrides: Partial<RecordingDoc> = {}): RecordingDoc {
  return {
    schema: currentSchemaId('loom.recording'),
    clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
    display: {
      id: 1,
      name: 'Built-in Liquid Retina XDR',
      logicalSize: [1728, 1117],
      pixelSize: [3456, 2234],
      scaleFactor: 2,
      colorSpace: 'display-p3',
    },
    tracks: {
      screen: {
        kind: 'video',
        parts: [
          {
            file: 'media/screen.000.mp4',
            index: 'media/screen.000.index.json',
            codec: 'avc1.640034',
            size: [3456, 2234],
            startTimeSec: 0,
            durationSec: 312.433,
            frameCount: 6104,
            rate: { mode: 'variable', nominalFps: 30, observedFps: 19.5 },
            colr: {
              primaries: 'bt709',
              transfer: 'iec61966-2-1',
              matrix: 'bt709',
              fullRange: false,
            },
            endedEarly: false,
          },
        ],
      },
      // Two parts, because a webcam unplug-and-replug is the case the format was
      // designed for (§7.4) and a fixture that never exercises it is not a fixture.
      webcam: {
        kind: 'video',
        deviceId: '3F45',
        deviceName: 'FaceTime HD Camera',
        parts: [
          {
            file: 'media/webcam.000.mp4',
            index: 'media/webcam.000.index.json',
            codec: 'avc1.4d402a',
            size: [1280, 720],
            startTimeSec: 0.0417,
            durationSec: 141.882,
            frameCount: 4256,
            rate: { mode: 'constant', nominalFps: 30, observedFps: 29.998 },
            endedEarly: true,
            endReason: 'device-lost',
          },
          {
            file: 'media/webcam.001.mp4',
            index: 'media/webcam.001.index.json',
            codec: 'avc1.4d402a',
            size: [1280, 720],
            startTimeSec: 149.204,
            durationSec: 163.229,
            frameCount: 4896,
            rate: { mode: 'constant', nominalFps: 30, observedFps: 29.997 },
            endedEarly: false,
          },
        ],
      },
      mic: {
        kind: 'audio',
        deviceId: 'BuiltInMic',
        deviceName: 'MacBook Pro Microphone',
        parts: [
          {
            file: 'media/mic.000.m4a',
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            channels: 1,
            startTimeSec: 0.0213,
            durationSec: 312.398,
            measuredSampleRate: 48000.37,
            gaps: [{ atSec: 118.402, durationSec: 0.0213, cause: 'device-glitch' }],
            endedEarly: false,
          },
        ],
      },
      system: {
        kind: 'audio',
        source: 'getdisplaymedia-loopback',
        constraints: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
        parts: [
          {
            file: 'media/system.000.m4a',
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            channels: 2,
            startTimeSec: 0.0089,
            durationSec: 312.412,
            measuredSampleRate: 47999.88,
            gaps: [],
            endedEarly: false,
          },
        ],
      },
    },
    events: {
      cursor: { file: 'events/cursor.ndjson', hz: 120, sampleCount: 37_492 },
      clicks: { file: 'events/clicks.ndjson', available: true, source: 'cgeventtap' },
      drawing: { file: 'events/drawing.ndjson', strokeCount: 4 },
      cursorImages: 'cursors/index.json',
    },
    capture: {
      app: '0.1.0',
      os: '26.5.1',
      permissions: {
        screen: 'granted',
        camera: 'granted',
        microphone: 'granted',
        accessibility: true,
      },
      requestedFps: 30,
      resolutionClamp: '4k',
      droppedFrames: { screen: 0, webcam: 2 },
    },
    integrity: {
      finalizedAt: '2026-08-04T14:37:24.001Z',
      recoveredFromCrash: false,
      truncatedToSec: null,
    },
    ...overrides,
  };
}

/**
 * The §2.6 edit document, with the parts that exercise the model: a generated
 * spring-driven zoom track under a hand-authored curve-driven one, a bubble that
 * changes shape, an annotation span with its own channels, and two clips.
 */
export function fixtureEdit(overrides: Partial<EditDocument> = {}): EditDocument {
  return {
    schema: currentSchemaId('loom.edit'),
    revision: 47,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips: [
      { id: 'c1', sourceStart: 4.2, sourceEnd: 118.4, speed: 1 },
      { id: 'c2', sourceStart: 131.9, sourceEnd: 305.1, speed: 1 },
    ],
    tracks: [
      {
        id: 't-zoom-auto',
        kind: 'transform',
        target: 'zoom',
        domain: 'source',
        origin: 'generated',
        generator: {
          type: 'auto-zoom-on-click',
          params: {
            preRollSec: 0.6,
            postRollSec: 1.2,
            minDurationSec: 1,
            mergeGapSec: 0.8,
            clusterBox: [0.5, 0.7],
            targetFill: 0.6,
            amountRange: [1.2, 2.5],
          },
          inputs: { clicks: 'sha256:41ba', cursor: 'sha256:9c07' },
          generatedAt: '2026-08-04T14:38:02.114Z',
        },
        blend: 'replace',
        blendMs: 250,
        activeRanges: [
          [22.1, 27.9],
          [64.55, 69.1],
        ],
        enabled: true,
        channels: {
          amount: {
            spring: { tension: 200, mass: 2.25, friction: 40 },
            clamp: [1, 4],
            keys: [
              { t: 22.1, v: 1, ease: { kind: 'spring' } },
              { t: 22.7, v: 1.85, ease: { kind: 'spring' } },
              { t: 27.9, v: 1, ease: { kind: 'spring' } },
            ],
          },
          center: {
            spring: { tension: 200, mass: 2.25, friction: 40 },
            keys: [
              { t: 22.1, v: [0.5, 0.5], ease: { kind: 'spring' } },
              { t: 22.7, v: [0.312, 0.688], ease: { kind: 'spring' } },
            ],
          },
        },
      },
      {
        id: 't-zoom-manual',
        kind: 'transform',
        target: 'zoom',
        domain: 'source',
        origin: 'manual',
        blend: 'replace',
        blendMs: 300,
        activeRanges: [[140, 152]],
        enabled: true,
        channels: {
          amount: {
            keys: [
              { t: 140, v: 1, ease: { kind: 'cubic', p1: [0.32, 0], p2: [0, 1] } },
              { t: 141.2, v: 2.4, ease: { kind: 'hold' } },
              { t: 152, v: 1, ease: { kind: 'hold' } },
            ],
          },
        },
      },
      {
        id: 't-bubble',
        kind: 'transform',
        target: 'bubble',
        domain: 'source',
        origin: 'manual',
        blend: 'replace',
        blendMs: 0,
        activeRanges: [[0, 1e9]],
        enabled: true,
        shapePreset: 'circle',
        channels: {
          center: {
            keys: [
              { t: 0, v: [0.88, 0.84], ease: { kind: 'hold' } },
              { t: 97.2, v: [0.12, 0.84], ease: { kind: 'hold' } },
            ],
          },
          sizeY: { keys: [{ t: 0, v: 0.22, ease: { kind: 'hold' } }] },
          aspect: {
            keys: [
              { t: 0, v: 1, ease: { kind: 'linear' } },
              { t: 97.2, v: 1.7778, ease: { kind: 'hold' } },
            ],
          },
          corner01: {
            keys: [
              { t: 0, v: 1, ease: { kind: 'linear' } },
              { t: 97.2, v: 0.12, ease: { kind: 'hold' } },
            ],
          },
          opacity: { keys: [{ t: 0, v: 1, ease: { kind: 'hold' } }] },
          mirror: { keys: [{ t: 0, v: 1, ease: { kind: 'hold' } }] },
        },
      },
      {
        id: 't-ann',
        kind: 'object',
        target: 'annotation',
        domain: 'source',
        origin: 'manual',
        blend: 'replace',
        blendMs: 0,
        activeRanges: [[60, 66.5]],
        enabled: true,
        channels: {},
        spans: [
          {
            id: 'a1',
            start: 60,
            end: 66.5,
            type: 'arrow',
            style: { stroke: '#FF3B30', strokeWidth: 0.004, fill: 'none', shadow: true },
            channels: {
              from: {
                keys: [
                  { t: 60, v: [0.2, 0.3], ease: { kind: 'cubic', p1: [0.2, 0], p2: [0, 1] } },
                  { t: 61, v: [0.2, 0.3], ease: { kind: 'hold' } },
                ],
              },
              opacity: {
                keys: [
                  { t: 60, v: 0, ease: { kind: 'linear' } },
                  { t: 60.25, v: 1, ease: { kind: 'hold' } },
                ],
              },
            },
          },
        ],
      },
      {
        id: 't-audio-mic',
        kind: 'audio',
        target: 'audio:mic',
        domain: 'source',
        origin: 'manual',
        blend: 'replace',
        blendMs: 0,
        activeRanges: [[0, 1e9]],
        enabled: true,
        channels: { gainDb: { keys: [{ t: 0, v: 0, ease: { kind: 'hold' } }] } },
        spans: [{ id: 'm1', start: 88.4, end: 91.2, type: 'mute' }],
      },
      {
        id: 't-cursor',
        kind: 'transform',
        target: 'cursor',
        domain: 'source',
        origin: 'manual',
        blend: 'replace',
        blendMs: 0,
        activeRanges: [[0, 1e9]],
        enabled: true,
        channels: {
          scale: { keys: [{ t: 0, v: 1.4, ease: { kind: 'hold' } }] },
          opacity: { keys: [{ t: 0, v: 1, ease: { kind: 'hold' } }] },
        },
        smoothing: { tension: 470, mass: 3, friction: 70 },
        clickSpring: { tension: 530, mass: 1, friction: 40 },
        hideWhenIdleSec: null,
      },
    ],
    ...overrides,
  };
}
