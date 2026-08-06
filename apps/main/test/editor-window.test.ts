/**
 * Who may open an editor, and what closing one does to the bundle lock.
 *
 * Both halves are silent when they are wrong, which is why they are pinned here
 * rather than left to the window that shows them:
 *
 *  - An editor left open **holds the `.lock`** `ProjectStore.openProject` took. A
 *    close that does not release it leaves a recording the app cannot record over
 *    and a second instance cannot open, with nothing on screen to explain it.
 *  - The release is the **counted** one, and which method is called is asserted
 *    rather than inferred from the outcome. With one editor and nothing else holding
 *    the recording, `close` and `releaseProject` leave the same observable state, so
 *    a test that only checks "the project was closed" passes either way — and the
 *    case they differ in is the one that costs a finished export: an export holds the
 *    same project for the length of a job that outlives the window that started it,
 *    and an unconditional close takes its lock and its `JournalWriter` mid-job. The
 *    counting stub below is that case, played out.
 *  - `ProjectStore.close` **aborts every media part still open** for that bundle.
 *    Those are the recorder's file descriptors during a capture, so closing an
 *    editor onto a live recording would truncate somebody's footage from another
 *    window.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    ipcMain: {
      on(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
        listeners.set(channel, listener);
      },
    },
    __listeners: listeners,
  };
});

const electron = (await import('electron')) as unknown as {
  __listeners: Map<string, (event: unknown, ...args: unknown[]) => void>;
};
const { EditorWindows } = await import('../src/editor.ts');
const { CHANNEL, SUBJECT_PARAM } = await import('@loom/ipc');

interface Shown {
  role: string;
  key: string;
  search: Record<string, string>;
}

/**
 * The two methods, counted the way `ProjectStore` counts them.
 *
 * `holds` is `openProject`'s tally; `releaseProject` drops one and closes at zero;
 * `close` closes whatever the count says, which is what makes it the wrong one here.
 * Modelling both is what lets a test say "the export kept its lock" rather than only
 * "something was called".
 */
function countingStore() {
  const closed: string[] = [];
  const released: string[] = [];
  const holds = new Map<string, number>();
  const open = new Set<string>();
  return {
    closed,
    released,
    open,
    // An arrow rather than a method, like the two below it: nothing here reads
    // `this`, and a method handed out unbound is `@typescript-eslint/unbound-method`.
    hold: (id: string) => {
      holds.set(id, (holds.get(id) ?? 0) + 1);
      open.add(id);
    },
    store: {
      close: (id: string) => {
        closed.push(id);
        holds.delete(id);
        open.delete(id);
        return Promise.resolve();
      },
      releaseProject: (id: string) => {
        released.push(id);
        const held = holds.get(id);
        if (held === undefined) return Promise.resolve();
        if (held > 1) {
          holds.set(id, held - 1);
          return Promise.resolve();
        }
        holds.delete(id);
        open.delete(id);
        return Promise.resolve();
      },
    },
  };
}

function harness(activeRecordingId: string | null = null) {
  const shown: Shown[] = [];
  let onClosed: ((role: string, key: string) => void) | null = null;
  const windows = {
    show: (role: string, key: string, search: Record<string, string>) => {
      shown.push({ role, key, search });
      return { id: `${role}:${key}` };
    },
    onClosed: (callback: (role: string, key: string) => void) => {
      onClosed = callback;
    },
  };
  const projects = countingStore();
  const editors = new EditorWindows({
    store: projects.store as never,
    windows: windows as never,
    activeRecordingId: () => activeRecordingId,
  });
  editors.install();
  return {
    editors,
    shown,
    closed: projects.closed,
    released: projects.released,
    stillOpen: projects.open,
    hold: projects.hold,
    fireOpen: (id: unknown) => {
      electron.__listeners.get(CHANNEL.editorOpen)?.({}, id);
    },
    fireClosed: (role: string, key: string) => {
      onClosed?.(role, key);
    },
  };
}

beforeEach(() => {
  electron.__listeners.clear();
});

describe('opening an editor', () => {
  it('shows the editor role keyed by the recording, with the id in the URL', () => {
    const h = harness();
    h.fireOpen('rec-1');
    expect(h.shown).toEqual([
      { role: 'editor', key: 'rec-1', search: { [SUBJECT_PARAM]: 'rec-1' } },
    ]);
  });

  it('drops an id that is not one', () => {
    // A `send` has no promise to reject with, so a bad id is dropped rather than
    // answered. It becomes a window key and a query parameter, so an unbounded
    // string from a renderer is a payload and not an id.
    const h = harness();
    for (const bad of [undefined, null, 42, '', 'x'.repeat(129), { id: 'rec' }]) {
      h.fireOpen(bad);
    }
    expect(h.shown).toEqual([]);
  });

  it('refuses the bundle the recorder is using', () => {
    // Not tidiness: closing that editor later would abort the capture's own media
    // parts. The library does not offer the button either, but a library declining
    // to send a message is not an enforcement of anything.
    const h = harness('rec-live');
    h.fireOpen('rec-live');
    expect(h.shown).toEqual([]);
    expect(h.editors.open('rec-live')).toBeUndefined();
  });

  it('still opens a different recording while one is being recorded', () => {
    const h = harness('rec-live');
    h.fireOpen('rec-other');
    expect(h.shown.map((s) => s.key)).toEqual(['rec-other']);
  });
});

describe('closing an editor', () => {
  it('gives back its hold, so the bundle lock is released', async () => {
    const h = harness();
    h.hold('rec-1');
    h.fireClosed('editor', 'rec-1');
    await Promise.resolve();
    expect(h.released).toEqual(['rec-1']);
    expect(h.stillOpen.has('rec-1')).toBe(false);
  });

  it('releases its hold rather than closing the project outright', () => {
    // The two are indistinguishable in the state a lone editor leaves behind, so the
    // method is asserted directly. `close` is the unconditional one and belongs to
    // `trash`, `recoverBundle`, the recorder and `closeAll`; an editor took its
    // project through the counted `openProject` and has to give it back the same way.
    const h = harness();
    h.hold('rec-1');
    h.fireClosed('editor', 'rec-1');
    expect(h.closed).toEqual([]);
  });

  it('leaves an export of the same recording holding its lock', async () => {
    // The case the two methods differ in, and it is reachable from the shipping
    // library: Open and Export sit on the same row for the same `editable` state. An
    // export outlives the window that started it (§1.2), and a bare close would take
    // the lock and the journal out from under it — the job then fails to record its
    // own result and discards a verified MP4 that is already on disk.
    const h = harness();
    h.hold('rec-1'); // the editor
    h.hold('rec-1'); // the export
    h.fireClosed('editor', 'rec-1');
    await Promise.resolve();
    expect(h.closed).toEqual([]);
    expect(h.stillOpen.has('rec-1')).toBe(true);
  });

  it('ignores every other window closing', () => {
    const h = harness();
    for (const role of ['library', 'setup', 'recorder-hud', 'capture', 'export']) {
      h.fireClosed(role, 'default');
    }
    expect(h.closed).toEqual([]);
    expect(h.released).toEqual([]);
  });

  it('never releases the project the recorder is writing into', () => {
    // The second guard. An editor cannot normally be opened on a live recording at
    // all; if one somehow is — a recording started while an editor was already
    // open on that bundle — closing it must not reach the store for that bundle.
    const h = harness('rec-live');
    h.fireClosed('editor', 'rec-live');
    expect(h.closed).toEqual([]);
    expect(h.released).toEqual([]);
  });
});
