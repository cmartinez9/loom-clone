/**
 * Putting the exported file — the **file**, not its path — on the clipboard.
 *
 * `decision-share-target.md`, verbatim: *"Clipboard copy must place the actual file
 * (so it pastes into Slack, Messages, Mail as a video), not a path string."* That is
 * a specific requirement about a specific pasteboard type, and getting it wrong
 * produces something that looks like it worked: `clipboard.writeText(path)` puts
 * `/Users/…/Demo.mp4` on the clipboard and pastes as thirty characters of text.
 *
 * ## What macOS actually wants
 *
 * `NSFilenamesPboardType` — an XML property list holding an array of absolute
 * POSIX paths. It is the type Finder writes when you copy a file and the type
 * Slack, Mail, Messages and every Cocoa text view read when they decide a paste is
 * an attachment rather than a string. `NSPasteboardTypeFileURL` ("public.file-url")
 * is its modern replacement and is *also* read by those apps — but Electron's
 * `clipboard.writeBuffer` declares the pasteboard's types on each call, so a second
 * call clears the first, and only one of the two can be written. The older type is
 * the one with the broader set of readers, so it is the one written.
 *
 * ## Why the plist is built here rather than by a library
 *
 * So it can be tested. {@link fileClipboardPayload} is a pure function from a path
 * to the exact bytes that go on the pasteboard, and `clipboard.test.ts` asserts the
 * path is in them, that it is escaped, and — the part that matters — that what is
 * placed is a *file reference* and not the path as text. The one line that talks to
 * the platform is injected, so the decision and the syscall are testable separately.
 */

/** The macOS pasteboard type for "these are files". */
export const FILENAMES_PASTEBOARD_TYPE = 'NSFilenamesPboardType';

/** Escape the five characters XML will not carry literally inside an element. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The pasteboard payload for a list of files.
 *
 * A plist array of absolute paths. Relative paths are refused rather than resolved:
 * the pasteboard is read by another process with another working directory, so a
 * relative path there is not a file — it is a file somewhere else, or nowhere.
 */
export function fileClipboardPayload(paths: readonly string[]): {
  format: string;
  xml: string;
} {
  if (paths.length === 0) throw new Error('the clipboard needs at least one file');
  for (const path of paths) {
    if (!path.startsWith('/')) {
      throw new Error(`refusing to put a relative path on the clipboard: ${JSON.stringify(path)}`);
    }
  }
  const entries = paths.map((path) => `\t<string>${escapeXml(path)}</string>`).join('\n');
  return {
    format: FILENAMES_PASTEBOARD_TYPE,
    xml:
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n<array>\n' +
      `${entries}\n` +
      '</array>\n</plist>\n',
  };
}

/** The one call that touches the platform. Injected so the rest is testable. */
export type WriteBuffer = (format: string, buffer: Buffer) => void;

/**
 * Put one file on the clipboard.
 *
 * Returns whether it worked rather than throwing: an export whose file is on disk,
 * verified and revealed has succeeded even if the pasteboard refused it, and phase 9
 * reads {@link ExportResult.copiedToClipboard} to know which happened. Failing the
 * whole export over a clipboard would be the tail wagging the dog — and would leave
 * the user with a finished video and an error.
 */
export function copyFileToClipboard(path: string, writeBuffer: WriteBuffer): boolean {
  try {
    const payload = fileClipboardPayload([path]);
    writeBuffer(payload.format, Buffer.from(payload.xml, 'utf8'));
    return true;
  } catch (error) {
    console.error('[export] could not put the file on the clipboard:', error);
    return false;
  }
}
