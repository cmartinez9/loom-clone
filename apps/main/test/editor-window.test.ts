/**
 * Who may open an editor, and what closing one does to the bundle lock.
 *
 * Both halves are silent when they are wrong, which is why they are pinned here
 * rather than left to the window that shows them:
 *
 *  - An editor left open **holds the `.lock`** `ProjectStore.openProject` took. A
 *    close that does not release it leaves a recording the app cannot record over
 *    and a second instance cannot open, with nothing on screen to explain it.
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

function harness(activeRecordingId: string | null = null) {
  const shown: Shown[] = [];
  const closed: string[] = [];
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
  const store = {
    close: (id: string) => {
      closed.push(id);
      return Promise.resolve();
    },
  };
  const editors = new EditorWindows({
    store: store as never,
    windows: windows as never,
    activeRecordingId: () => activeRecordingId,
  });
  editors.install();
  return {
    editors,
    shown,
    closed,
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
  it('closes the project, so the bundle lock is released', () => {
    const h = harness();
    h.fireClosed('editor', 'rec-1');
    expect(h.closed).toEqual(['rec-1']);
  });

  it('ignores every other window closing', () => {
    const h = harness();
    for (const role of ['library', 'setup', 'recorder-hud', 'capture', 'export']) {
      h.fireClosed(role, 'default');
    }
    expect(h.closed).toEqual([]);
  });

  it('never closes the project the recorder is writing into', () => {
    // The second guard. An editor cannot normally be opened on a live recording at
    // all; if one somehow is — a recording started while an editor was already
    // open on that bundle — closing it must not pull the capture's descriptors.
    const h = harness('rec-live');
    h.fireClosed('editor', 'rec-live');
    expect(h.closed).toEqual([]);
  });
});
