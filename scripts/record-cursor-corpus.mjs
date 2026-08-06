/**
 * Record the phase-10 corpus: real `.loomrec` bundles with real cursor logs.
 *
 *   node scripts/record-cursor-corpus.mjs [--out DIR] [--count 10] [--seconds 20]
 *                                         [--manual] [--keep-driver-log]
 *
 * The phase-10 gate is *"seasickness budget assertions pass on **10 real recordings**"*
 * (§8), and "real" is the load-bearing word. Everything below the `CGEventPost` in the
 * driver is the shipping path: the real `loom-input-sampler` polling the real window
 * server at 120 Hz, the real `CGEventTap`, the real `InputSampler` folding its NDJSON
 * into §2.5's shapes, written into a real bundle made by `createBundle`. What is *not*
 * real is the hand: by default `scripts/cursor-driver.m` moves the mouse, because this
 * runs unattended. `--manual` records exactly the same artifacts with a person moving
 * it, changes no code, and is how a captain-recorded corpus is made.
 *
 * `corpus/manifest.json` says which of the two produced every recording, so nothing
 * downstream has to guess and no test can quietly claim a hand it did not have.
 *
 * ## What it also measures, and why that is here
 *
 * `data/loom-scope/decision-accessibility-clicks.md` closes with *"Post-grant event
 * rate and latency are unmeasured. Validate during the build."* Phase 2 confirmed the
 * tap was live from a signed bundle but nobody clicked during its window. This is the
 * consumer, so it takes the reading: the driver prints the `CLOCK_UPTIME_RAW`
 * microsecond at which it posted each event, `loom-input-sampler.m` stamps every line
 * it emits from the same clock, and the difference is a latency rather than two numbers
 * from two clocks. The result lands in `manifest.json` under `clickCapture`.
 *
 * **Without the Accessibility grant there is no reading, and the manifest says so
 * rather than reporting a zero.** That is the whole shape of phase 5: `count` is
 * `null`, not `0`, when the tap was never live.
 *
 * ## Cost, and the pointer
 *
 * This takes over the mouse for `count × seconds` plus a little — about four minutes at
 * the defaults. The driver restores the pointer where it found it, caps its own run at
 * 180 s, and exits on its own deadline whether or not this process is still alive.
 */

import { build } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createBundle } from '@loom/format/fs';
import { currentSchemaId, isoTimestamp, ulid } from '@loom/format';
import { buildNativeSampler, NATIVE_BINARY } from '../packages/sampler/native/build.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

const outDir = resolve(arg('out', join(root, 'packages/edl/test/corpus')));
const count = Number(arg('count', '10'));
const seconds = Number(arg('seconds', '20'));
const manual = process.argv.includes('--manual');
const keepDriverLog = process.argv.includes('--keep-driver-log');

/**
 * Ten sessions that are not ten copies of one session.
 *
 * `pace` scales pointing amplitude and speed together; `clickRate` decides how often a
 * move ends in a click, a double-click or a burst. A comfort budget that only ever saw
 * one kind of session would not be a check.
 */
const PROFILES = [
  { name: 'calm-reading', pace: 0.45, clickRate: 0.2 },
  { name: 'calm-forms', pace: 0.55, clickRate: 0.8 },
  { name: 'demo-walkthrough', pace: 0.75, clickRate: 0.5 },
  { name: 'demo-clicky', pace: 0.8, clickRate: 0.9 },
  { name: 'ordinary-editing', pace: 1.0, clickRate: 0.45 },
  { name: 'ordinary-browsing', pace: 1.0, clickRate: 0.7 },
  { name: 'brisk-navigation', pace: 1.3, clickRate: 0.35 },
  { name: 'brisk-clicky', pace: 1.4, clickRate: 0.85 },
  { name: 'restless', pace: 1.7, clickRate: 0.25 },
  { name: 'hurried', pace: 2.0, clickRate: 0.6 },
];

const DRIVER_SOURCE = join(root, 'scripts/cursor-driver.m');
const DRIVER_BINARY = join(root, 'dist/tools/loom-cursor-driver');

async function buildDriver() {
  await mkdir(dirname(DRIVER_BINARY), { recursive: true });
  await run('clang', [
    '-fobjc-arc',
    '-fmodules',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-mmacosx-version-min=14.0',
    '-framework',
    'Foundation',
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    '-o',
    DRIVER_BINARY,
    DRIVER_SOURCE,
  ]);
  return DRIVER_BINARY;
}

/** `@loom/sampler` is TypeScript; bundle it once and import the real `InputSampler`. */
async function loadSampler(scratch) {
  const outfile = join(scratch, 'sampler.mjs');
  await build({
    entryPoints: [join(root, 'packages/sampler/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Everything bundled: the output lands in a temp directory, where a bare
    // `@loom/format` specifier has no `node_modules` to resolve against. `platform:
    // 'node'` already leaves the builtins alone.
    outfile,
  });
  return import(pathToFileURL(outfile).href);
}

/** The helper's own `CLOCK_UPTIME_RAW` microsecond, which is what `t0Us` is measured on. */
async function probeNowUs() {
  const { stdout } = await run(NATIVE_BINARY, ['probe']);
  const probe = JSON.parse(stdout.trim().split('\n').pop());
  return { tUs: probe.tUs, display: probe.display, clicks: probe.clicks };
}

/** A filesystem sink for the sampler. Scripts write their own files; the app never does. */
async function makeSink(dir) {
  const fs = await import('node:fs/promises');
  const logPath = (log) => join(dir, 'events', `${log}.ndjson`);
  return {
    async create(log) {
      await fs.writeFile(logPath(log), '', { flag: 'a' });
    },
    async append(log, ndjson) {
      await fs.appendFile(logPath(log), ndjson, 'utf8');
    },
    async sync(log) {
      let handle = null;
      try {
        handle = await fs.open(logPath(log), 'r');
        await handle.sync();
      } catch {
        // The log may not exist yet; the sampler syncs on a timer, not on a write.
      } finally {
        await handle?.close();
      }
    },
    async writeCursorImage(sha256, png) {
      await fs.writeFile(join(dir, 'cursors', `${sha256}.png`), png);
    },
    async writeCursorIndex(doc) {
      await fs.writeFile(join(dir, 'cursors', 'index.json'), `${JSON.stringify(doc, null, 2)}\n`);
    },
  };
}

/**
 * Drive the pointer, and return every event the driver says it posted.
 *
 * `onSessionEnd` fires on the driver's `session-end` line, which it emits before
 * walking the pointer back to where it found it. The recorder stops the sampler there,
 * so the walk home — a deliberate, fast, full-screen move that no cursor would make —
 * is outside the log rather than the worst pan in it.
 */
function drive(binary, { seconds: driveSeconds, seed, pace, clickRate }, onSessionEnd) {
  return new Promise((fulfil, reject) => {
    let hello = null;
    const child = spawn(binary, [
      '--seconds',
      String(driveSeconds),
      '--seed',
      String(seed),
      '--pace',
      String(pace),
      '--click-rate',
      String(clickRate),
    ]);
    const posts = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.k === 'session-end') onSessionEnd();
          else if (parsed.k === 'hello') hello = parsed;
          else if (parsed.k !== 'bye') posts.push(parsed);
        } catch {
          // A partial line at exit is not worth failing a recording over.
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(`[driver] ${chunk}`));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) fulfil({ posts, hello });
      else reject(new Error(`cursor driver exited with ${code}`));
    });
  });
}

function wait(ms) {
  return new Promise((fulfil) => setTimeout(fulfil, ms));
}

/**
 * Post-grant click rate and latency, from one clock.
 *
 * `null` — never a zero — when the tap was not live: that distinction is the whole of
 * phase 5 and the reason this measurement was outstanding in the first place.
 */
function clickReading(posts, hello, clickLines, capability, t0Us) {
  const postedDowns = posts.filter((p) => p.e === 'down');
  // **Both** sides, each from its own process. TCC keys on the exact code identity of
  // the responsible process, so the sampler being trusted says nothing about the
  // binary that posts — and a synthetic click that was never delivered would otherwise
  // be reported as a click the tap missed. `posterTrusted` is `AXIsProcessTrusted()`
  // read inside `cursor-driver.m`; `capability` is the sampler's own answer.
  const posterTrusted = hello === null ? null : hello.axTrusted === true;
  if (!capability.available || capability.count === null || posterTrusted !== true) {
    return {
      measured: false,
      reason:
        posterTrusted === false
          ? 'poster-not-trusted'
          : posterTrusted === null && !manual
            ? 'poster-did-not-report'
            : capability.reason,
      axTrusted: capability.axTrusted,
      tapEnabled: capability.tapEnabled,
      posterTrusted,
      posterPid: hello?.pid ?? null,
      postedDowns: postedDowns.length,
      observedDowns: null,
      deliveredFraction: null,
      latencyMs: null,
    };
  }

  const observed = clickLines.filter((line) => line.e === 'down').map((line) => line.t);
  const latencies = [];
  let at = 0;
  for (const post of postedDowns) {
    const postSec = (post.tUs - t0Us) / 1e6;
    // The tap sees an event after the window server does; match each post to the first
    // observation at or after it that has not already been claimed.
    while (at < observed.length && observed[at] < postSec - 0.001) at++;
    if (at >= observed.length) break;
    const delta = observed[at] - postSec;
    if (delta >= 0 && delta < 0.5) {
      latencies.push(delta * 1000);
      at++;
    }
  }
  latencies.sort((a, b) => a - b);
  const at_ = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  return {
    measured: latencies.length > 0,
    reason: capability.reason,
    axTrusted: capability.axTrusted,
    tapEnabled: capability.tapEnabled,
    posterTrusted,
    posterPid: hello?.pid ?? null,
    postedDowns: postedDowns.length,
    observedDowns: observed.length,
    deliveredFraction:
      postedDowns.length > 0 ? Number((observed.length / postedDowns.length).toFixed(4)) : null,
    latencyMs:
      latencies.length === 0
        ? null
        : {
            samples: latencies.length,
            min: Number(latencies[0].toFixed(3)),
            median: Number(at_(0.5).toFixed(3)),
            p95: Number(at_(0.95).toFixed(3)),
            max: Number(latencies[latencies.length - 1].toFixed(3)),
          },
  };
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('this app, and this corpus, are macOS-only');
    return 2;
  }

  await buildNativeSampler();
  if (!existsSync(NATIVE_BINARY)) {
    console.error(`the input sampler is missing at ${NATIVE_BINARY}`);
    return 2;
  }

  const driver = manual ? null : await buildDriver();
  const scratch = await mkdtemp(join(tmpdir(), 'loom-corpus-'));
  const { InputSampler } = await loadSampler(scratch);

  await mkdir(outDir, { recursive: true });

  const first = await probeNowUs();
  console.log(
    `sampler probe: display ${first.display.display} ${first.display.logicalSize.join('×')} ` +
      `@${first.display.scaleFactor}×, clicks ${first.clicks.available ? 'LIVE' : first.clicks.reason}`,
  );
  if (!first.clicks.available) {
    console.warn(
      'Accessibility is not granted to this process, so clicks.ndjson will not exist and\n' +
        'the post-grant click rate/latency reading cannot be taken. Cursor position needs\n' +
        'no permission and is recorded either way (captain decision 8).',
    );
  }
  if (!manual) {
    console.warn(
      `\nThe pointer will be driven for about ${Math.ceil((count * (seconds + 3)) / 60)} minutes. ` +
        `Ctrl-C restores it.\n`,
    );
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const profile = PROFILES[i % PROFILES.length];
    const id = ulid();
    const name = `phase10-${String(i).padStart(2, '0')}-${profile.name}`;
    // A fixed `createdAt` so the bundle directory names are stable across runs of
    // this script; `createBundle` prefixes the name with a timestamp (§2.1).
    const bundle = await createBundle(outDir, {
      id,
      name,
      createdAt: new Date(Date.UTC(2026, 7, 5, 12, 0, i)),
    });
    const dir = bundle.paths.dir;

    const origin = await probeNowUs();
    const sampler = new InputSampler({
      sink: await makeSink(dir),
      t0Us: origin.tUs,
      helperPath: NATIVE_BINARY,
      displayId: origin.display.display,
      clicks: true,
      onError: (error) => console.warn(`[sampler] ${error.message}`),
    });
    await sampler.start();

    let posts = [];
    let hello = null;
    if (manual) {
      console.log(`  [${i + 1}/${count}] ${name}: move the mouse for ${seconds}s…`);
      await wait(seconds * 1000);
    } else {
      let stopped = null;
      const driven = await drive(
        driver,
        { seconds, seed: i + 1, pace: profile.pace, clickRate: profile.clickRate },
        () => {
          stopped ??= sampler.stop();
        },
      );
      posts = driven.posts;
      hello = driven.hello;
      if (hello !== null && hello.axTrusted !== true) {
        console.warn(
          `  [driver pid ${hello.pid}] AXIsProcessTrusted() is false: synthetic clicks ` +
            `will not be delivered, and no click latency will be recorded.`,
        );
      }
      await stopped;
    }

    await sampler.stop();
    const capability = sampler.capability;
    const health = sampler.health;
    const events = sampler.recordingEvents();
    const display = sampler.displayInfo ?? origin.display;

    const cursorLines = await readNdjson(join(dir, 'events/cursor.ndjson'));
    const clickLines = await readNdjson(join(dir, 'events/clicks.ndjson'));
    const positions = cursorLines.filter((line) => line.e === undefined);
    const durationSec =
      positions.length > 0 ? positions[positions.length - 1].t - positions[0].t : 0;

    const recording = {
      schema: currentSchemaId('loom.recording'),
      clock: { kind: 'videoframe-timestamp-us', t0Us: origin.tUs },
      display: {
        id: display.display,
        name: 'driven corpus display',
        logicalSize: display.logicalSize,
        pixelSize: [
          display.logicalSize[0] * display.scaleFactor,
          display.logicalSize[1] * display.scaleFactor,
        ],
        scaleFactor: display.scaleFactor,
        colorSpace: 'display-p3',
      },
      // No media: this corpus exists for the event logs, and §2.3 lets a track be
      // absent rather than empty. `sourceDurationSec` therefore reads 0 and every
      // consumer passes the cursor log's own extent explicitly.
      tracks: {},
      events,
      capture: {
        app: 'loom-clone corpus recorder',
        os: process.platform + ' ' + release(),
        permissions: {
          screen: 'not-determined',
          camera: 'not-determined',
          microphone: 'not-determined',
          accessibility: capability.axTrusted,
        },
        // No video was captured; the number is required by §2.3 and this is the
        // honest one for a recording that has no frames.
        requestedFps: 0,
        resolutionClamp: 'none',
        droppedFrames: {},
      },
      integrity: { finalizedAt: isoTimestamp(), recoveredFromCrash: false, truncatedToSec: null },
    };
    await writeFile(bundle.paths.recording, `${JSON.stringify(recording, null, 2)}\n`);

    if (keepDriverLog && posts.length > 0) {
      await writeFile(
        join(outDir, `${name}.driver.ndjson`),
        posts.map((p) => JSON.stringify(p)).join('\n') + '\n',
      );
    }

    const entry = {
      name,
      bundle: basename(dir),
      hand: manual ? 'human' : 'scripted',
      profile: manual ? null : profile,
      seconds,
      durationSec: Number(durationSec.toFixed(3)),
      cursorSamples: positions.length,
      samplesPerSec: durationSec > 0 ? Number((positions.length / durationSec).toFixed(2)) : 0,
      droppedLines: health.dropped,
      clickCapture: clickReading(posts, hello, clickLines, capability, origin.tUs),
    };
    entries.push(entry);
    console.log(
      `  [${i + 1}/${count}] ${name}: ${entry.cursorSamples} samples in ` +
        `${entry.durationSec}s (${entry.samplesPerSec} Hz), clicks ` +
        `${entry.clickCapture.observedDowns ?? 'unavailable'}/${entry.clickCapture.postedDowns}` +
        (entry.clickCapture.latencyMs === null
          ? ''
          : ` median ${entry.clickCapture.latencyMs.median} ms`),
    );
  }

  const manifest = {
    generatedAt: isoTimestamp(),
    tool: 'scripts/record-cursor-corpus.mjs',
    /**
     * The corpus-wide answer to the captain's open question, in one place.
     *
     * `data/loom-scope/decision-accessibility-clicks.md`: *"Post-grant event rate and
     * latency are unmeasured. Validate during the build."* `measured: false` here means
     * exactly that it still is — never a zero.
     */
    clickCapture: aggregateClicks(entries),
    hand: manual ? 'human' : 'scripted',
    note: manual
      ? 'Cursor moved by a person. Everything else is the shipping sampler path.'
      : 'Cursor moved by scripts/cursor-driver.m posting real CGEvents. Everything ' +
        'below CGEventPost is the shipping sampler path: the window server moved the ' +
        'real pointer, loom-input-sampler polled it at 120 Hz through the real API, ' +
        'and InputSampler wrote the log.',
    os: process.platform,
    recordings: entries,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${entries.length} recordings -> ${outDir}`);

  await rm(scratch, { recursive: true, force: true });
  return 0;
}

/**
 * Fold the per-recording readings into one.
 *
 * Latency percentiles are taken over the pooled samples rather than over the
 * per-recording medians: ten medians of five clicks each is not a distribution.
 */
function aggregateClicks(entries) {
  const usable = entries.filter((e) => e.clickCapture.measured);
  if (usable.length === 0) {
    return {
      measured: false,
      reason: entries[0]?.clickCapture.reason ?? 'no-recordings',
      recordings: entries.length,
      note:
        'Post-grant click rate and latency remain unmeasured. Both the posting and ' +
        'the observing process must hold the Accessibility grant.',
    };
  }
  const posted = usable.reduce((n, e) => n + e.clickCapture.postedDowns, 0);
  const observed = usable.reduce((n, e) => n + e.clickCapture.observedDowns, 0);
  const seconds = usable.reduce((n, e) => n + e.durationSec, 0);
  const all = [];
  for (const e of usable) {
    // Rebuilt from the per-recording summary: the raw per-click latencies are not kept
    // (they would be 40 KB of manifest), so the pooled figures below are the min of
    // mins, the max of maxes, and a sample-weighted mean of the medians.
    all.push(e.clickCapture.latencyMs);
  }
  const samples = all.reduce((n, l) => n + l.samples, 0);
  const weighted = (pick) => all.reduce((n, l) => n + pick(l) * l.samples, 0) / samples;
  return {
    measured: true,
    recordings: usable.length,
    postedDowns: posted,
    observedDowns: observed,
    deliveredFraction: posted > 0 ? Number((observed / posted).toFixed(4)) : null,
    observedRateHz: seconds > 0 ? Number((observed / seconds).toFixed(3)) : null,
    latencyMs: {
      samples,
      min: Number(Math.min(...all.map((l) => l.min)).toFixed(3)),
      meanOfMedians: Number(weighted((l) => l.median).toFixed(3)),
      meanOfP95: Number(weighted((l) => l.p95).toFixed(3)),
      max: Number(Math.max(...all.map((l) => l.max)).toFixed(3)),
    },
  };
}

async function readNdjson(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

process.exitCode = await main();
