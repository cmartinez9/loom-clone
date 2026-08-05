/**
 * `EventLogWriter` — the append side of §2.5.
 *
 * The property that carries the phase-5 gate is here rather than in the sampler: an
 * event log's file exists only when something deliberately made it exist. Everything
 * else in this file is the same crash-shape contract the journal has, because a
 * cursor log torn by a `SIGKILL` has to be readable up to the tear.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogWriter } from '../src/fs/event-log.ts';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-event-log-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('EventLogWriter', () => {
  it('does not create its file merely by existing', async () => {
    const path = join(directory, 'clicks.ndjson');
    const writer = new EventLogWriter(path);

    expect(writer.created).toBe(false);
    expect(await exists(path)).toBe(false);

    await writer.close();
    // Still nothing. An empty `clicks.ndjson` asserts "we watched and saw none",
    // which on a machine without the Accessibility grant would be a lie.
    expect(await exists(path)).toBe(false);
  });

  it('creates an empty file when asked to, and says it has no lines', async () => {
    const path = join(directory, 'clicks.ndjson');
    const writer = new EventLogWriter(path);

    await writer.create();
    expect(writer.created).toBe(true);
    expect(writer.lineCount).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('');

    await writer.close();
    expect(await exists(path)).toBe(true);
  });

  it('appends, counts lines, and is durable across close', async () => {
    const path = join(directory, 'cursor.ndjson');
    const writer = new EventLogWriter(path);

    await writer.append('{"t":0.0163,"x":0.5213,"y":0.441,"c":"a","m":0}\n');
    await writer.append('{"t":0.0246,"x":0.5219,"y":0.4402,"c":"a","m":0}\n{"t":0.03}\n');
    await writer.sync();
    await writer.close();

    expect(writer.lineCount).toBe(3);
    const text = await readFile(path, 'utf8');
    expect(text.split('\n').filter((line) => line.length > 0)).toHaveLength(3);
    // No header. §2.5 shows a cursor log whose first line is a cursor sample; these
    // are streams, versioned by the `recording.json` that points at them.
    expect(text.startsWith('{"t":0.0163')).toBe(true);
  });

  it('appends to an existing log rather than truncating it', async () => {
    const path = join(directory, 'cursor.ndjson');
    const first = new EventLogWriter(path);
    await first.append('{"t":1}\n');
    await first.close();

    const second = new EventLogWriter(path);
    await second.append('{"t":2}\n');
    await second.close();

    expect(await readFile(path, 'utf8')).toBe('{"t":1}\n{"t":2}\n');
  });

  it('refuses a chunk with no line terminator', async () => {
    const writer = new EventLogWriter(join(directory, 'cursor.ndjson'));
    // Welding two events into one unparseable line would lose both, and the loss
    // would be invisible until something tried to read the log.
    await expect(writer.append('{"t":1}')).rejects.toThrow('line terminator');
    await writer.close();
  });

  it('ignores an empty append without creating anything', async () => {
    const path = join(directory, 'clicks.ndjson');
    const writer = new EventLogWriter(path);
    await writer.append('');
    expect(await exists(path)).toBe(false);
    await writer.close();
  });

  it('refuses to write after close', async () => {
    const writer = new EventLogWriter(join(directory, 'cursor.ndjson'));
    await writer.append('{"t":1}\n');
    await writer.close();
    await expect(writer.append('{"t":2}\n')).rejects.toThrow('closed');
    await expect(writer.create()).rejects.toThrow('closed');
  });

  it('syncs and closes cleanly when nothing was ever written', async () => {
    const writer = new EventLogWriter(join(directory, 'drawing.ndjson'));
    await expect(writer.sync()).resolves.toBeUndefined();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
