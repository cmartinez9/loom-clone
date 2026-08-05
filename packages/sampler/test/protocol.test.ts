/**
 * The wire protocol, against strings.
 *
 * The parser's one non-obvious rule gets most of the attention here: an unavailable
 * click state whose reason this build does not recognise becomes `unknown`, never
 * `null`. `null` is how the protocol says "clicks are fine", and a build that says
 * that about a state it does not understand has silently degraded — which is the
 * exact failure phase 5 exists to make impossible.
 */

import { describe, expect, it } from 'vitest';
import { LineSplitter, parseHelperLine } from '../src/protocol.ts';

describe('parseHelperLine', () => {
  it('reads a cursor sample', () => {
    expect(
      parseHelperLine('{"k":"cursor","tUs":1234,"x":0.5213,"y":0.441,"c":"ab","m":8}'),
    ).toEqual({
      k: 'cursor',
      tUs: 1234,
      x: 0.5213,
      y: 0.441,
      c: 'ab',
      m: 8,
    });
  });

  it('keeps a normalized position outside 0–1 rather than clamping it', () => {
    // The cursor left the recorded display. Clamping would invent a position on an
    // edge it never touched, and phase 10's camera would pan to it.
    const line = parseHelperLine('{"k":"cursor","tUs":1,"x":-0.31,"y":1.44,"c":"","m":0}');
    expect(line).toMatchObject({ x: -0.31, y: 1.44 });
  });

  it('never reads an unrecognised failure as "clicks are fine"', () => {
    const line = parseHelperLine(
      '{"k":"status","tUs":1,"clicks":{"available":false,"reason":"martian-tap",' +
        '"requested":true,"axTrusted":true,"tapCreated":true,"tapEnabled":false}}',
    );
    expect(line).toMatchObject({ k: 'status', clicks: { available: false, reason: 'unknown' } });
  });

  it('treats a missing reason on an unavailable tap as unknown, not as null', () => {
    const line = parseHelperLine('{"k":"status","tUs":1,"clicks":{"available":false}}');
    expect(line).toMatchObject({ clicks: { available: false, reason: 'unknown' } });
  });

  it('reports no reason only when clicks are actually available', () => {
    const line = parseHelperLine(
      '{"k":"status","tUs":1,"clicks":{"available":true,"reason":null,"requested":true,' +
        '"axTrusted":true,"tapCreated":true,"tapEnabled":true}}',
    );
    expect(line).toMatchObject({ clicks: { available: true, reason: null } });
  });

  it('rejects a cursor image id that is not a lowercase hex sha256', () => {
    // The id becomes a filename via `cursorImagePath`. A dropped line here is a
    // counted loss; an accepted one would be a path from a child process.
    const bad =
      '{"k":"cursorimg","id":"../../etc/passwd","shape":"arrow","hotspot":[0,0],' +
      '"size":[1,1],"png":"iVBOR"}';
    expect(parseHelperLine(bad)).toBeNull();
  });

  it('rejects malformed and truncated lines instead of guessing', () => {
    expect(parseHelperLine('{"k":"cursor","tUs":1,"x":0.5')).toBeNull();
    expect(parseHelperLine('{"k":"cursor","tUs":1,"x":"half","y":0.5}')).toBeNull();
    expect(
      parseHelperLine('{"k":"click","tUs":1,"e":"wiggle","b":0,"x":0,"y":0,"m":0}'),
    ).toBeNull();
    expect(parseHelperLine('[]')).toBeNull();
    expect(parseHelperLine('   ')).toBeNull();
    expect(parseHelperLine('{"k":"something-new","tUs":1}')).toBeNull();
  });

  it('rejects a non-finite coordinate', () => {
    // `NaN` is not JSON, but `1e999` parses to Infinity and would normalize into a
    // position no renderer can use.
    expect(parseHelperLine('{"k":"cursor","tUs":1,"x":1e999,"y":0.5,"c":"","m":0}')).toBeNull();
  });
});

describe('LineSplitter', () => {
  it('holds a partial line until its newline arrives', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(splitter.push('2}\n{"c":3}\n')).toEqual(['{"b":2}', '{"c":3}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('returns a torn final line rather than dropping it silently', () => {
    const splitter = new LineSplitter();
    splitter.push('{"a":1}\n{"b":2');
    // The caller counts it as unparseable — a loss it can report, not one it hides.
    expect(splitter.flush()).toEqual(['{"b":2']);
  });
});
