import { describe, it, expect, vi } from 'vitest';
import { createReasoningStream } from './reasoning-stream.ts';
import type { ViewEvent } from './claude-code-responder.ts';

const thinking: ViewEvent = { kind: 'thinking', text: 'hmm' };
const text: ViewEvent = { kind: 'text', text: 'done' };

describe('createReasoningStream (#109 ephemeral reasoning bridge)', () => {
  it('delivers emitted events to a subscriber in order', () => {
    const stream = createReasoningStream();
    const seen: ViewEvent[] = [];
    stream.subscribe((e) => seen.push(e));
    stream.emit(thinking);
    stream.emit(text);
    expect(seen).toEqual([thinking, text]);
  });

  it('drops events emitted before anyone subscribes (live typing has no value once past)', () => {
    const stream = createReasoningStream();
    stream.emit(thinking); // no subscriber yet
    const seen: ViewEvent[] = [];
    stream.subscribe((e) => seen.push(e));
    stream.emit(text);
    expect(seen).toEqual([text]);
  });

  it('stops delivering after unsubscribe (panel dispose)', () => {
    const stream = createReasoningStream();
    const listener = vi.fn();
    const unsubscribe = stream.subscribe(listener);
    stream.emit(thinking);
    unsubscribe();
    stream.emit(text);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(thinking);
  });

  it('lets a listener unsubscribe mid-dispatch without skipping the others', () => {
    // A listener that tears down as an event arrives (panel closing) must not
    // corrupt the in-progress fan-out — the copy-before-iterate guards this.
    const stream = createReasoningStream();
    const seen: string[] = [];
    const off = stream.subscribe(() => {
      seen.push('a');
      off();
    });
    stream.subscribe(() => seen.push('b'));
    stream.emit(thinking);
    expect(seen).toEqual(['a', 'b']);
  });
});
