/**
 * The clipboard half of captain decision 9.
 *
 * > Clipboard copy must place the **actual file** (so it pastes into Slack,
 * > Messages, Mail as a video), **not a path string**.
 *
 * That is a claim about a specific macOS pasteboard type, and the failure mode is
 * silent: `clipboard.writeText(path)` looks like it worked and pastes thirty
 * characters of text. So what is asserted here is the *content* of what goes on the
 * pasteboard — a plist naming the file — rather than that a function was called.
 *
 * **The platform end is verified separately and by hand**, because a pasteboard is
 * global state and a test that wrote to it would clobber whatever the person running
 * it had copied. Measured on this machine, Electron 43: writing this payload to
 * `NSFilenamesPboardType` makes `osascript -e 'clipboard info'` report
 * `«class furl»`, and `the clipboard as «class furl»` returns the file — which is a
 * file reference, not text, and is what an app reads when it decides a paste is an
 * attachment. That reading is recorded in `CLAUDE.md`'s carried-forward list, since
 * no automated run re-establishes it.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FILENAMES_PASTEBOARD_TYPE,
  copyFileToClipboard,
  fileClipboardPayload,
} from '../src/export/clipboard.ts';

describe('the file clipboard payload', () => {
  it('is a plist naming the file, on the type that means "these are files"', () => {
    const payload = fileClipboardPayload(['/Users/x/Movies/Demo.mp4']);
    expect(payload.format).toBe(FILENAMES_PASTEBOARD_TYPE);
    expect(payload.xml).toContain('<plist version="1.0">');
    expect(payload.xml).toContain('<array>');
    expect(payload.xml).toContain('<string>/Users/x/Movies/Demo.mp4</string>');
    // The thing decision 9 rules out: the path as bare text with no file semantics.
    expect(payload.xml.trim().startsWith('/Users')).toBe(false);
  });

  it('escapes a path XML cannot carry literally', () => {
    const payload = fileClipboardPayload(['/Users/x/Q3 <draft> & "final".mp4']);
    expect(payload.xml).toContain('/Users/x/Q3 &lt;draft&gt; &amp; &quot;final&quot;.mp4');
    // And nothing unescaped survives to break the parse: no bare angle bracket, and
    // every `&` begins an entity rather than being one.
    const inner = payload.xml.slice(payload.xml.indexOf('<string>') + 8);
    const path = inner.slice(0, inner.indexOf('</string>'));
    expect(path).not.toMatch(/[<>]/);
    expect(path).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos);)/);
  });

  it('refuses a relative path rather than resolving it', () => {
    // The pasteboard is read by another process with another working directory, so a
    // relative path there is not this file — it is a different one, or none.
    expect(() => fileClipboardPayload(['Movies/Demo.mp4'])).toThrow(/relative/);
    expect(() => fileClipboardPayload([])).toThrow(/at least one file/);
  });
});

describe('copyFileToClipboard', () => {
  it('hands the platform the payload and reports success', () => {
    const writeBuffer = vi.fn();
    expect(copyFileToClipboard('/Users/x/Demo.mp4', writeBuffer)).toBe(true);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const [format, buffer] = writeBuffer.mock.calls[0] as [string, Buffer];
    expect(format).toBe(FILENAMES_PASTEBOARD_TYPE);
    expect(buffer.toString('utf8')).toContain('<string>/Users/x/Demo.mp4</string>');
  });

  it('reports a refusal rather than failing the export', () => {
    // An export whose file is on disk, verified and revealed has succeeded. Failing
    // the whole job over a pasteboard would leave the user with a finished video and
    // an error — so the result is a boolean the caller records, not a throw.
    const outcome = copyFileToClipboard('/Users/x/Demo.mp4', () => {
      throw new Error('pasteboard is busy');
    });
    expect(outcome).toBe(false);
  });
});
