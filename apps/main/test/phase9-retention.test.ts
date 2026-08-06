/**
 * **Phase 9 gate: fail the export at each of §7.5's verification points, and the
 * sources survive every time.**
 *
 * Architecture report §8, phase 9: *"Fail the export at each of the five
 * verification points; sources survive every time."* `verify.ts` grew from five
 * named points to ten — a check that cannot say *which* of the five it was is not
 * much use to the person whose footage is on the line — so this gate covers ten.
 *
 * ## How it is bound to the list rather than to a copy of it
 *
 * {@link SCENARIOS} is a `Record<VerificationFailure, Scenario>`. Adding a member to
 * `VERIFICATION_FAILURES` without a scenario here is a **compile error**, and the run
 * below iterates the exported array rather than the object's own keys, so a scenario
 * that stops provoking its own failure is a test failure rather than a quiet gap.
 * That matters more than it looks: a retention gate covering nine of ten failure
 * modes is exactly the shape of bug that deletes somebody's footage.
 *
 * ## Why this drives the whole export rather than the predicate
 *
 * `mayDeleteSources` is a pure function and could be unit-tested in four lines. What
 * that would not establish is the thing the captain is relying on — that a *failed
 * export* leaves the recording intact — because between the verification and the
 * deletion sit the record write, the discard of the bad output, the bundle lock and
 * `#run`'s `catch`. So every case here runs the **real** `ExportSession` against the
 * **real** `ProjectStore` over a **real** bundle with real bytes in `media/` and
 * `events/`, and the only stand-ins are the two things that are genuinely Electron: a
 * `BrowserWindow` and the clipboard.
 *
 * The damage is applied where a real bad export would produce it — to the finished
 * file, after the shipping writer renamed it into place, by a `ProjectStore` subclass
 * that overrides nothing else. Every byte the verifier reads is a byte a writer could
 * really have written, and every check it runs is the shipping one.
 *
 * ## Why it cannot pass vacuously
 *
 * Three ways, because "the sources survived" is the assertion a broken gate reports
 * most cheerfully:
 *
 * 1. **The bundle really has sources.** Every run asserts a non-empty inventory
 *    *before* the export and compares the after against it by content hash, so a
 *    harness that seeded nothing would fail rather than pass ten times.
 * 2. **The failure is the one it claims.** Each scenario carries the sentence its own
 *    `VerificationError` produces and the recorded `project.json` error must match
 *    it — otherwise a scenario that failed because its window died would satisfy the
 *    survival assertion for a reason that has nothing to do with retention.
 * 3. **A control deletes.** The same harness, undamaged, must end with `media/` and
 *    `events/` empty, `state: "exported"` and a `retention` record. Without it,
 *    "sources survive a failed export" and "sources always survive" read identically.
 *
 * And `npm run verify:mutation` breaks the production predicate on disk — including
 * making the deletion unconditional, which is the mutation this file exists to
 * catch — and requires this file to notice.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL,
  exportDurationSec,
  exportFrameCount,
  type ExportCommand,
  type ExportJob,
  type ExportProgress,
} from '@loom/ipc';
import { mayDeleteSources, newEditDocument, type ProjectDoc, type RecordingId } from '@loom/format';
import { FastStartWriter } from '@loom/mux';
import { ProjectStore, RetentionNotAuthorisedError } from '../src/project-store.ts';
import { ExportSession } from '../src/export/session.ts';
import { resumeInterruptedRetention } from '../src/export/retention.ts';
import { VERIFICATION_FAILURES, type VerificationFailure } from '../src/export/verify.ts';
import { loadEncodedFixture } from '../../../packages/mux/test/helpers/fixture.ts';

const fixture = loadEncodedFixture();
/** How long the committed fixture is, as a CFR timeline. */
const FIXTURE_SEC = fixture.frames.length / fixture.fps;
/** What §7.5's fourth check will be told to expect. */
const EXPECTED_SEC = exportDurationSec(FIXTURE_SEC, fixture.fps);

// --------------------------------------------------------------- byte surgery

interface Box {
  type: string;
  /** Offset of the box header. */
  at: number;
  size: number;
  /** Offset of the box body, past the header. */
  body: number;
}

/** Boxes whose children start immediately after their 8-byte header. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function boxesIn(bytes: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at, false);
    let headerBytes = 8;
    if (size === 1) {
      // 64-bit largesize, which is what a big `mdat` uses.
      const high = view.getUint32(at + 8, false);
      const low = view.getUint32(at + 12, false);
      size = high * 0x1_0000_0000 + low;
      headerBytes = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < headerBytes || at + size > to) break;
    const type = String.fromCharCode(
      bytes[at + 4] ?? 0,
      bytes[at + 5] ?? 0,
      bytes[at + 6] ?? 0,
      bytes[at + 7] ?? 0,
    );
    found.push({ type, at, size, body: at + headerBytes });
    at += size;
  }
  return found;
}

/** The first box at `path`, e.g. `['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss']`. */
function findBox(bytes: Uint8Array, path: readonly string[]): Box {
  let from = 0;
  let to = bytes.byteLength;
  let box: Box | undefined;
  for (const [depth, type] of path.entries()) {
    box = boxesIn(bytes, from, to).find((candidate) => candidate.type === type);
    if (box === undefined) throw new Error(`no ${path.slice(0, depth + 1).join('/')} in this file`);
    from = box.body;
    to = box.at + box.size;
    if (depth < path.length - 1 && !CONTAINERS.has(type)) {
      throw new Error(`${type} is not a container, so ${path.join('/')} cannot be walked`);
    }
  }
  if (box === undefined) throw new Error('an empty box path');
  return box;
}

const STBL = ['moov', 'trak', 'mdia', 'minf', 'stbl'] as const;

/** Overwrite one big-endian `uint32` and hand the buffer back. */
function patchU32(bytes: Uint8Array, at: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint32(at, value, false);
  return copy;
}

/** A movie with `frames` samples, one sync sample at the front, of a given length. */
function craftMovie(frames: number, durationSec: number): Uint8Array {
  const timescale = fixture.fps * 1000;
  const durationUnits = Math.max(1, Math.round((durationSec * timescale) / frames));
  const writer = new FastStartWriter({
    video: { width: fixture.width, height: fixture.height, timescale, avcC: fixture.avcC },
  });
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const byteLength = 32 + (i % 5);
    payloads.push(new Uint8Array(byteLength).fill(i & 0xff));
    writer.addVideoSample({
      byteLength,
      durationUnits,
      isKey: i === 0,
      timestampUs: Math.round((i * durationUnits * 1e6) / timescale),
    });
  }
  const plan = writer.plan();
  const bytes = new Uint8Array(plan.totalBytes);
  bytes.set(plan.header, 0);
  let at = plan.header.byteLength;
  for (const payload of payloads) {
    bytes.set(payload, at);
    at += payload.byteLength;
  }
  return bytes;
}

// ----------------------------------------------------------------- scenarios

/**
 * How one verification failure is provoked, and what proves it was that one.
 *
 * `damage` runs on the finished file's bytes, after the shipping writer renamed it
 * into place — `null` means unlink it. `frames` and `decodes` cover the two failures
 * that are not a property of the bytes: an encode that stopped early, and a decoder
 * that refuses the last GOP.
 */
interface Scenario {
  /** What this models. */
  why: string;
  damage?: (bytes: Uint8Array) => Uint8Array | null;
  /** How many frames the stand-in window encodes. Default: what the timeline asks. */
  frames?: (asked: number) => number;
  /** What the export window answers §7.5's fifth check with. Default: yes. */
  decodes?: boolean;
  /** Part of the message this failure — and no other — produces. */
  mustSay: RegExp;
}

const SCENARIOS: Record<VerificationFailure, Scenario> = {
  missing: {
    why: 'the rename reported success and the file is not there',
    damage: () => null,
    mustSay: /is not there/,
  },
  empty: {
    why: 'a full volume: the file exists and holds nothing',
    damage: () => new Uint8Array(0),
    mustSay: /is empty/,
  },
  undemuxable: {
    why: 'a corrupt header — an `mvhd` version no reader understands',
    damage: (bytes) => {
      const mvhd = findBox(bytes, ['moov', 'mvhd']);
      const copy = new Uint8Array(bytes);
      copy[mvhd.body] = 1;
      return copy;
    },
    mustSay: /does not demux/,
  },
  'not-faststart': {
    why: 'a writer that streamed into the output: legal, playable, and moov last',
    damage: (bytes) => {
      const top = boxesIn(bytes, 0, bytes.byteLength);
      const moov = top.find((box) => box.type === 'moov');
      if (moov === undefined) throw new Error('the export has no moov');
      const out = new Uint8Array(bytes.byteLength);
      let at = 0;
      for (const box of top) {
        if (box.type === 'moov') continue;
        out.set(bytes.subarray(box.at, box.at + box.size), at);
        at += box.size;
      }
      out.set(bytes.subarray(moov.at, moov.at + moov.size), at);
      return out;
    },
    mustSay: /does not begin with ftyp \+ moov/,
  },
  'no-video-track': {
    why: 'a header describing the only track as sound',
    damage: (bytes) => {
      const hdlr = findBox(bytes, ['moov', 'trak', 'mdia', 'hdlr']);
      const copy = new Uint8Array(bytes);
      // `hdlr`: version+flags, pre_defined, then the four-character handler type.
      copy.set(new TextEncoder().encode('soun'), hdlr.body + 8);
      return copy;
    },
    mustSay: /carries no video track/,
  },
  'no-samples': {
    why: 'sample tables that describe nothing — a mux that wrote a header and no media',
    damage: (bytes) => {
      const stts = findBox(bytes, [...STBL, 'stts']);
      const stsz = findBox(bytes, [...STBL, 'stsz']);
      const chunks = boxesIn(bytes, findBox(bytes, STBL).body, 0 + bytes.byteLength).find(
        (box) => box.type === 'co64' || box.type === 'stco',
      );
      if (chunks === undefined) throw new Error('the export has no chunk offset table');
      let out = patchU32(bytes, stts.body + 4, 0);
      out = patchU32(out, stsz.body + 8, 0);
      return patchU32(out, chunks.body + 4, 0);
    },
    mustSay: /has no samples/,
  },
  duration: {
    why: 'an encode that stopped half way and reported success',
    frames: (asked) => Math.floor(asked / 2),
    mustSay: /§7\.5 allows/,
  },
  'no-sync-sample': {
    why: 'a file with no keyframe at all, so nothing in it can be decoded',
    damage: (bytes) => patchU32(bytes, findBox(bytes, [...STBL, 'stss']).body + 4, 0),
    mustSay: /no sync sample precedes the last frame/,
  },
  'gop-too-long': {
    why: 'a final GOP past what the verifier will read back',
    // The fixture keyframes every 30, so this one cannot be reached by damaging it:
    // the whole file is replaced with a movie of the right length and one keyframe.
    damage: () => craftMovie(700, EXPECTED_SEC),
    mustSay: /the final GOP is 700 frames/,
  },
  'last-frame': {
    why: 'the bytes are structurally perfect and the picture does not decode',
    decodes: false,
    mustSay: /does not decode/,
  },
};

// ------------------------------------------------------------------- harness

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly contents = new EventEmitter();
  readonly webContents = {
    isLoading: (): boolean => false,
    once: (event: string, listener: (...args: unknown[]) => void): void => {
      this.contents.once(event, listener);
    },
    send: (channel: string, payload: unknown): void => {
      expect(channel).toBe(CHANNEL.exportCommand);
      this.emit('command', payload);
    },
  };
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

/**
 * The shipping store, with one seam: the finished file can be damaged the way a bad
 * export would have produced it.
 *
 * A subclass rather than a fake, and it overrides exactly one method, so everything
 * phase 9 depends on — the retention record, the ordered deletion, the bundle lock,
 * the `project.json` queue — is the real thing. The damage lands *after*
 * `super.finalizeExport`, which is where the writer's own `rename(2)` happened, so
 * the verifier is reading a file that is in place under its real name exactly as
 * §7.5 describes.
 */
class DamagingStore extends ProjectStore {
  damage: Scenario['damage'] | undefined = undefined;

  override async finalizeExport(jobId: string): ReturnType<ProjectStore['finalizeExport']> {
    const finished = await super.finalizeExport(jobId);
    const damage = this.damage;
    if (damage !== undefined) {
      const next = damage(new Uint8Array(await readFile(finished.path)));
      if (next === null) await rm(finished.path, { force: true });
      else await writeFile(finished.path, next);
    }
    return finished;
  }
}

interface Harness {
  root: string;
  store: DamagingStore;
  session: ExportSession;
  window: FakeWindow;
  progress: ExportProgress[];
  recordingId: RecordingId;
  bundleDir: string;
  exportsDir: string;
}

let harness: Harness;

/**
 * The raw sources a recording has. Real bytes in the two directories §7.5 names,
 * plus the two it does not, so "deleted exactly what it was told to" is measurable.
 *
 * `recording.json` is deliberately absent: it would put this job on §5.3's
 * stream-copy path or hand the window audio to mix, and retention deletes
 * *directories* rather than tracks. What matters here is that the bytes exist and
 * that something could take them.
 */
async function seedSources(dir: string): Promise<void> {
  await writeFile(join(dir, 'media', 'screen.000.mp4'), Buffer.alloc(4096, 7));
  await writeFile(join(dir, 'media', 'screen.000.index.json'), '{"schema":"loom.index/1"}\n');
  await writeFile(join(dir, 'media', 'mic.000.m4a'), Buffer.alloc(2048, 9));
  await writeFile(join(dir, 'media', 'webcam.000.mp4'), Buffer.alloc(1024, 3));
  await writeFile(join(dir, 'events', 'cursor.ndjson'), '{"t":0,"x":0.5,"y":0.5}\n');
  await writeFile(join(dir, 'events', 'clicks.ndjson'), '{"t":1,"button":0}\n');
  await writeFile(join(dir, 'cursors', 'index.json'), '{"schema":"loom.cursors/1"}\n');
  await writeFile(join(dir, 'thumbs', 'poster.jpg'), Buffer.alloc(512, 5));
}

/**
 * Every file under the bundle's source directories, with a hash of its contents.
 *
 * Recursive, because `thumbs/strip/` is a directory the §2.1 layout creates, and a
 * walk that only listed the top level would report a filmstrip as absent and compare
 * equal against one that had been deleted.
 */
async function inventory(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const sub of prefix === '' ? ['media', 'events', 'cursors', 'thumbs'] : ['']) {
    const at = prefix === '' ? join(dir, sub) : dir;
    const label = prefix === '' ? sub : prefix;
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        Object.assign(out, await inventory(path, `${label}/${entry.name}`));
      } else {
        out[`${label}/${entry.name}`] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      }
    }
  }
  return out;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-retention-'));
  const store = new DamagingStore({
    recordingsRoot: join(root, 'recordings'),
    settingsPath: join(root, 'settings.json'),
    appVersion: '0.0.0-test',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();
  const created = await store.create('Retention');
  // A clip list covering the whole fixture, so the compiled timeline is as long as
  // the media the stand-in window encodes and §7.5's fourth check has a real
  // expectation to measure against.
  await writeFile(
    join(created.paths.dir, 'edit.json'),
    JSON.stringify({
      ...newEditDocument(),
      clips: [{ id: 'whole', sourceStart: 0, sourceEnd: FIXTURE_SEC, speed: 1 }],
    }),
    'utf8',
  );
  await seedSources(created.paths.dir);

  const window = new FakeWindow();
  const progress: ExportProgress[] = [];
  const session = new ExportSession({
    store,
    openWindow: () => window as unknown as Electron.BrowserWindow,
    findWindow: () =>
      window.destroyed ? undefined : (window as unknown as Electron.BrowserWindow),
    closeWindow: () => {
      window.destroyed = true;
    },
    broadcast: (p) => progress.push(p),
    copyToClipboard: () => true,
    reveal: () => true,
    newJobId: () => 'job-1',
  });

  harness = {
    root,
    store,
    session,
    window,
    progress,
    recordingId: created.id,
    bundleDir: created.paths.dir,
    exportsDir: join(root, 'recordings', 'Exports'),
  };
});

afterEach(async () => {
  await harness.session.shutdown();
  await harness.store.closeAll();
  await rm(harness.root, { recursive: true, force: true });
});

/** Play the export page's part: announce the encoder, send its chunks, report done. */
function encodeLikeTheWindow(jobId: string, frames: number): void {
  const { session } = harness;
  session.onMeta({
    jobId,
    kind: 'video',
    decoderConfig: {
      codec: 'avc1.640028',
      codedWidth: fixture.width,
      codedHeight: fixture.height,
      description: fixture.avcC,
    },
  });
  for (const [i, frame] of fixture.frames.slice(0, frames).entries()) {
    session.onChunk({
      jobId,
      kind: 'video',
      data: frame.data,
      isKey: frame.isKey,
      timestampUs: Math.round((i * 1e6) / fixture.fps),
    });
  }
  session.onPassDone({ jobId, kind: 'video', sampleCount: frames });
}

function framesFor(job: ExportJob): number {
  return Math.min(fixture.frames.length, exportFrameCount(job.durationSec, job.settings.fps));
}

/** Wire the stand-in window up for one scenario and run the export to a verdict. */
async function runExport(scenario: Partial<Scenario> = {}): Promise<ExportProgress> {
  harness.store.damage = scenario.damage;
  harness.window.on('command', (command: ExportCommand) => {
    if (command.kind === 'start') {
      const asked = framesFor(command.job);
      encodeLikeTheWindow(command.job.jobId, scenario.frames?.(asked) ?? asked);
      return;
    }
    if (command.kind !== 'verify') return;
    const ok = scenario.decodes ?? true;
    harness.session.onDecoded({
      jobId: command.jobId,
      ok,
      framesDecoded: ok ? command.request.chunks.length : 0,
      lastTimestampUs: ok ? command.request.expectLastTimestampUs : null,
      ...(ok ? {} : { error: 'the decoder produced no frames' }),
    });
  });
  await harness.session.start(harness.recordingId, { name: 'Export' });
  return settled();
}

async function settled(): Promise<ExportProgress> {
  for (let i = 0; i < 4000; i++) {
    const last = harness.progress.at(-1);
    if (last !== undefined && ['done', 'failed', 'cancelled'].includes(last.phase)) return last;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(
    `the job never settled; saw ${JSON.stringify(harness.progress.map((p) => p.phase))}`,
  );
}

async function projectDoc(): Promise<ProjectDoc> {
  return JSON.parse(await readFile(join(harness.bundleDir, 'project.json'), 'utf8')) as ProjectDoc;
}

// ---------------------------------------------------------------- the gate

describe('§7.5 obligation 1 — a failed export deletes nothing', () => {
  // The list, not a copy of it. A member added to `VERIFICATION_FAILURES` with no
  // scenario fails to compile above; one whose scenario stops firing fails here.
  it.each(VERIFICATION_FAILURES.map((failure) => [failure] as const))(
    'keeps every source when verification fails at %s',
    async (failure) => {
      const scenario = SCENARIOS[failure];
      const before = await inventory(harness.bundleDir);
      // Not vacuous: there is something to lose. A harness that seeded nothing would
      // satisfy every assertion below.
      expect(Object.keys(before).length, scenario.why).toBeGreaterThan(0);

      const outcome = await runExport(scenario);

      // It failed, and it failed at *this* check — otherwise the survival below is
      // evidence about something else entirely.
      expect(outcome.phase).toBe('failed');
      expect(outcome.error ?? '').toMatch(scenario.mustSay);

      // The whole gate, in one line: byte-for-byte, every source still there.
      expect(await inventory(harness.bundleDir)).toEqual(before);

      const doc = await projectDoc();
      expect(doc.retention).toBeUndefined();
      expect(doc.state).not.toBe('exported');
      // And the record the export wrote is one no future launch may act on either:
      // this is what `resumeInterruptedRetention` and a second export would read.
      const record = doc.exports[0];
      expect(record).toBeDefined();
      if (record === undefined) return;
      expect(record.error ?? '').toMatch(scenario.mustSay);
      expect(mayDeleteSources(record).mayDelete).toBe(false);
    },
    60_000,
  );

  it('CONTROL: the same harness deletes the sources when the export verifies', async () => {
    // Without this, "sources survive a failed export" and "sources always survive"
    // read identically — and the second passes a build that never honours the
    // captain's decision at all.
    const before = await inventory(harness.bundleDir);
    expect(Object.keys(before)).toContain('media/screen.000.mp4');

    const outcome = await runExport();
    expect(outcome.error).toBeUndefined();
    expect(outcome.phase).toBe('done');
    expect(outcome.result?.sourcesDeleted).toBe(true);
    expect(outcome.result?.retentionReasons).toEqual([]);

    // §7.5's two directories are empty, and the two it does not name are untouched:
    // deleting more than the authoritative document says is the one direction this
    // must never err in.
    const after = await inventory(harness.bundleDir);
    expect(Object.keys(after).filter((path) => path.startsWith('media/'))).toEqual([]);
    expect(Object.keys(after).filter((path) => path.startsWith('events/'))).toEqual([]);
    expect(after['cursors/index.json']).toBe(before['cursors/index.json']);
    expect(after['thumbs/poster.jpg']).toBe(before['thumbs/poster.jpg']);

    // The directories themselves survive their contents, so the §2.1 layout is still
    // valid for whatever reads this bundle next.
    expect(await readdir(join(harness.bundleDir, 'media'))).toEqual([]);

    const doc = await projectDoc();
    expect(doc.state).toBe('exported');
    expect(doc.retention?.reason).toBe('export-verified');
    expect(doc.retention?.sourcesDeletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // And the one thing that must never go: the user's finished work.
    expect(await readdir(harness.exportsDir)).toEqual(['Export.mp4']);
  }, 60_000);

  it('CONTROL: the exported MP4 outlives the sources it was made from', async () => {
    await runExport();
    const bytes = await readFile(join(harness.exportsDir, 'Export.mp4'));
    expect(bytes.byteLength).toBeGreaterThan(0);
    const doc = await projectDoc();
    expect(doc.exports[0]?.verified?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.exports[0]?.path).toContain('Export.mp4');
  }, 60_000);
});

describe('§7.5 obligation 4 — the escape hatch', () => {
  it('keeps every source when the export asked to', async () => {
    const before = await inventory(harness.bundleDir);
    harness.window.on('command', (command: ExportCommand) => {
      if (command.kind === 'start') {
        encodeLikeTheWindow(command.job.jobId, framesFor(command.job));
      } else if (command.kind === 'verify') {
        harness.session.onDecoded({
          jobId: command.jobId,
          ok: true,
          framesDecoded: command.request.chunks.length,
          lastTimestampUs: command.request.expectLastTimestampUs,
        });
      }
    });
    await harness.session.start(harness.recordingId, { name: 'Kept', keepSources: true });
    const outcome = await settled();

    expect(outcome.phase).toBe('done');
    expect(outcome.result?.sourcesKept).toBe(true);
    // Not the negation of the other: a surface that inferred "still editable" from
    // `sourcesKept` would be right here and wrong for a deletion that failed.
    expect(outcome.result?.sourcesDeleted).toBe(false);
    expect(outcome.result?.retentionReasons.join(' ')).toMatch(/keep the sources/);

    expect(await inventory(harness.bundleDir)).toEqual(before);
    const doc = await projectDoc();
    expect(doc.state).not.toBe('exported');
    expect(doc.retention).toBeUndefined();
    expect(doc.exports[0]?.sourcesKept).toBe(true);
  }, 60_000);
});

describe('§7.5 obligation 3 — an unexported recording is never auto-deleted', () => {
  it('refuses to delete sources that no verified export authorised', async () => {
    // The store's own gate, and the reason obligation 3 is a property of the method
    // rather than of its callers. `recordRetention` is what authorises this, and it
    // is only ever called after a verification that returned no failure.
    await harness.store.openProject(harness.recordingId);
    await expect(
      harness.store.deleteSources(harness.recordingId, ['media']),
    ).rejects.toBeInstanceOf(RetentionNotAuthorisedError);
    expect(await readdir(join(harness.bundleDir, 'media'))).not.toEqual([]);
  });

  it('does not list an ordinary editable recording as an interrupted deletion', async () => {
    expect(await harness.store.listInterruptedRetention()).toEqual([]);
    // ...and the launch-time pass therefore touches nothing.
    const before = await inventory(harness.bundleDir);
    expect(await resumeInterruptedRetention(harness.store)).toEqual([]);
    expect(await inventory(harness.bundleDir)).toEqual(before);
  });
});

describe('§7.5 ordering — a deletion that was interrupted is finished, not forgotten', () => {
  it('finishes a deletion whose retention record was written and nothing else', async () => {
    // The crash between step 1 and step 2, reconstructed: `project.json` carries the
    // record, the media is all still there, and the state still says `editable`.
    // `apps/main/test/retention-crash.test.ts` produces this state with a real
    // `SIGKILL`; this asserts what the next launch does with it.
    await harness.store.openProject(harness.recordingId);
    await harness.store.recordRetention(harness.recordingId, {
      sourcesDeletedAt: new Date().toISOString(),
      reason: 'export-verified',
    });
    await harness.store.releaseProject(harness.recordingId);

    expect(await harness.store.listInterruptedRetention()).toHaveLength(1);
    const outcomes = await resumeInterruptedRetention(harness.store);
    expect(outcomes).toEqual([{ id: harness.recordingId, finished: true }]);

    const after = await inventory(harness.bundleDir);
    expect(Object.keys(after).filter((path) => path.startsWith('media/'))).toEqual([]);
    expect(Object.keys(after).filter((path) => path.startsWith('events/'))).toEqual([]);
    expect((await projectDoc()).state).toBe('exported');
    // Idempotent: a second launch finds nothing left to finish.
    expect(await harness.store.listInterruptedRetention()).toEqual([]);
  });
});
