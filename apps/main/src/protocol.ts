/**
 * The `loom://` custom protocol. Architecture report §1.4:
 *
 * > `mediaUrl` returns a `loom://` URL served by `protocol.handle()` in main with
 * > byte-range support. **No `file://`, no `nodeIntegration`, nothing in the
 * > renderer that can read the user's disk.**
 *
 * Two hosts, and adding a third needs a reason:
 *
 * - `loom://app/…` serves the renderer bundle. Using it instead of `file://` gives
 *   every window a real origin — which is what makes a strict CSP, `fetch`, and
 *   relative URLs behave the same in a packaged app as they do against the dev
 *   server.
 * - `loom://recording/<id>/<path>` serves read-only bytes from inside one
 *   `.loomrec`, confined by `ProjectStore.resolveBundleFile`.
 *
 * The handler can only read. It has no branch that writes, and the path it is
 * given is resolved, realpath'd and bounds-checked by the store before it is
 * opened — a symlink planted inside `media/` cannot turn a video request into a
 * read of the user's home directory.
 */

import { protocol } from 'electron';
import { LOOM_HOST, LOOM_SCHEME } from '@loom/ipc';
import { serveFile } from './media-reader.ts';
import { PathEscapeError, UnknownRecordingError, type ProjectStore } from './project-store.ts';
import { join, normalize, sep } from 'node:path';

/**
 * Declare the scheme's privileges. **Must be called before `app.whenReady()`** —
 * Electron reads this table when the first renderer process starts, and calling it
 * later silently does nothing.
 */
export function registerLoomScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOOM_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Range requests and `<video src>` need a streaming protocol.
        stream: true,
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ]);
}

export interface ProtocolOptions {
  store: ProjectStore;
  /** Absolute path to the built renderer directory (`dist/renderer`). */
  rendererRoot: string;
}

/** Install the handler. Call once, after `app.whenReady()`. */
export function installLoomProtocol(options: ProtocolOptions): void {
  protocol.handle(LOOM_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }

    const rangeHeader = request.headers.get('Range');

    switch (url.hostname) {
      case LOOM_HOST.app:
        return serveApp(options.rendererRoot, url, rangeHeader);
      case LOOM_HOST.recording:
        return serveRecording(options.store, url, rangeHeader);
      default:
        return new Response('not found', { status: 404 });
    }
  });
}

/**
 * Serve the packaged renderer.
 *
 * The renderer root is inside the app bundle (an asar in a packaged build), so
 * this is our own code, not user data. It is still path-confined: a bug that let
 * `loom://app/../../..` out of the bundle would be a file-read primitive handed to
 * whatever ends up in a renderer.
 */
async function serveApp(root: string, url: URL, rangeHeader: string | null): Promise<Response> {
  const requested = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const relative = requested === '' ? 'library.html' : requested;
  const normalized = normalize(relative);
  if (normalized.startsWith('..') || normalized.startsWith(sep) || normalized.includes('\0')) {
    return new Response('forbidden', { status: 403 });
  }
  const path = join(root, normalized);
  if (!path.startsWith(root + sep)) return new Response('forbidden', { status: 403 });

  try {
    return await serveFile(path, rangeHeader);
  } catch {
    return new Response('not found', { status: 404 });
  }
}

/** Serve one file from inside one bundle, read-only. */
async function serveRecording(
  store: ProjectStore,
  url: URL,
  rangeHeader: string | null,
): Promise<Response> {
  // `loom://recording/<id>/<rest…>`
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent);
  const [id, ...rest] = segments;
  if (id === undefined || rest.length === 0) return new Response('not found', { status: 404 });

  try {
    const path = await store.resolveBundleFile(id, rest.join('/'));
    return await serveFile(path, rangeHeader);
  } catch (error) {
    if (error instanceof PathEscapeError) return new Response('forbidden', { status: 403 });
    if (error instanceof UnknownRecordingError) return new Response('not found', { status: 404 });
    return new Response('not found', { status: 404 });
  }
}
