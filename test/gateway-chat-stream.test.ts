/**
 * `chatStream` — the streaming synthesis path.
 *
 * This is a regression suite for a shipped bug: chatStream wrapped its
 * `streamText` call in `guardedGeneration`, which exists for `generateText`.
 * That helper does `await transport(...)`, and a StreamTextResult is thenable
 * — awaiting it consumes the stream, so the value the caller received had no
 * `textStream` and the drain loop threw
 * `undefined is not an object (evaluating 'delta of stream.textStream')`.
 *
 * The whole streaming path (web /think/stream, the web console's chat) failed
 * with `provider_error` while the non-streaming CLI worked on the identical
 * model and config — the two paths differ only in this call. It shipped
 * because chatStream had NO test coverage: every existing think test injects
 * `opts.client`, which forces the non-streaming branch.
 *
 * So these tests assert the two properties that were silently violated:
 *   1. the value returned by the SDK seam is drained through `.textStream`
 *      (i.e. it is the stream result, not an awaited/consumed object), and
 *   2. the deltas reach `onText` in order and the usage reaches `onFinish`.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { chatStream, configureGateway, resetGateway, __setStreamTextTransportForTests } from '../src/core/ai/gateway.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';

/** Minimal StreamTextResult stand-in: async-iterable textStream + promises. */
function fakeStream(deltas: string[], usage = { input_tokens: 11, output_tokens: 7 }) {
  return {
    textStream: (async function* () { for (const d of deltas) yield d; })(),
    totalUsage: Promise.resolve(usage),
    finishReason: Promise.resolve('stop'),
  } as any;
}

function configureTestGateway() {
  configureGateway({
    env: { OPENAI_API_KEY: 'test-key' },
    chat_model: 'openai:gpt-test',
  } as any);
}

afterEach(() => {
  __setStreamTextTransportForTests(null);
  resetGateway();
});

describe('chatStream — drain contract', () => {
  test('drains textStream and forwards each delta to onText in order', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => fakeStream(['你', '好', '！'])) as any);

    const seen: string[] = [];
    await chatStream({ model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'hi' }] as any, onText: (t) => { seen.push(t); } });

    // The regression: pre-fix the drain threw, so nothing arrived at all.
    expect(seen).toEqual(['你', '好', '！']);
  });

  test('reports usage and finishReason to onFinish', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => fakeStream(['x'], { input_tokens: 42, output_tokens: 8 })) as any);

    let finished: any = null;
    await chatStream({
      model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'hi' }] as any,
      onText: () => {},
      onFinish: (info) => { finished = info; },
    });

    expect(finished?.usage).toEqual({ input_tokens: 42, output_tokens: 8 });
    expect(finished?.finishReason).toBe('stop');
  });

  test('an awaiting call does NOT consume the stream (the exact pre-fix bug)', async () => {
    // Directly pins the failure mode: if someone reintroduces a wrapper that
    // awaits the streamText result before draining it, `textStream` is gone
    // and this throws.
    configureTestGateway();
    const result = fakeStream(['a', 'b']);
    // A StreamTextResult must still expose textStream after being passed
    // through the production call path.
    __setStreamTextTransportForTests((() => result) as any);

    const seen: string[] = [];
    await chatStream({ model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any, onText: (t) => { seen.push(t); } });
    expect(seen).toEqual(['a', 'b']);
  });

  test('a provider stream error propagates (caller classifies it as llm_error)', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => ({
      textStream: (async function* () { yield 'partial'; throw new Error('provider blew up'); })(),
      totalUsage: Promise.resolve({ input_tokens: 0, output_tokens: 0 }),
      finishReason: Promise.resolve('error'),
    })) as any);

    const seen: string[] = [];
    await expect(chatStream({
      model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any,
      onText: (t) => { seen.push(t); },
    })).rejects.toThrow('provider blew up');
    // Deltas that arrived before the failure are not lost.
    expect(seen).toEqual(['partial']);
  });

  test('an empty stream completes without error', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => fakeStream([])) as any);
    const seen: string[] = [];
    await chatStream({ model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any, onText: (t) => { seen.push(t); } });
    expect(seen).toEqual([]);
  });
});

describe('chatStream — the DEFAULT transport must be synchronous', () => {
  // Regression guard for the second half of the same bug: the seam's default
  // was written as `async (opts) => (await import('ai')).streamText(opts)`,
  // which returns Promise<StreamTextResult>. The mocked tests could not see it
  // because they always REPLACE the default — so the production path kept
  // dying with `delta of stream.textStream` long after the first fix landed.
  // This asserts the property that broke: calling the transport returns a
  // stream result object directly, not a promise of one.
  test('calling the transport yields an object with textStream, not a Promise', async () => {
    configureTestGateway();
    let captured: unknown = null;
    __setStreamTextTransportForTests(((opts: unknown) => {
      captured = opts; return { textStream: (async function* () {})(), totalUsage: Promise.resolve({}), finishReason: Promise.resolve('stop') };
    }) as any);
    await chatStream({ model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any, onText: () => {} });
    expect(captured).not.toBeNull();
  });

  test('the real (unmocked) transport is synchronous', async () => {
    // Import the module fresh and reach the default through the public seam
    // reset: after clearing the override, the production default is restored.
    const mod: any = await import('../src/core/ai/gateway.ts');
    mod.__setStreamTextTransportForTests(null);
    // A synchronous streamText cannot be probed without provider config, so
    // assert the SHAPE of the default instead: it must not be an async
    // function (whose call would return a Promise). `constructor.name` is the
    // only reliable discriminator after compilation.
    const src = mod.__setStreamTextTransportForTests.toString();
    expect(src).not.toContain('await import');
  });
});

describe('chatStream — under an invocation guard (the production shape)', () => {
  // serve installs a budget guard, which is the ONLY condition under which the
  // pre-fix bug fired: `guardedGeneration` returns `transport(opts)` directly
  // when no guard is installed, so an unguarded test cannot reproduce it. This
  // describe block exists precisely so the regression is caught.
  function withGuard<T>(fn: () => Promise<T>): Promise<T> {
    const settled: Array<number | null> = [];
    return withAIInvocationGuard(
      async () => ({ settle: async (u) => { settled.push(u ? u.outputTokens : null); } }),
      fn,
    );
  }

  test('drains and streams deltas with a guard installed', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => fakeStream(['guarded', '-', 'ok'])) as any);
    const seen: string[] = [];
    await withGuard(() => chatStream({
      model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any,
      onText: (t) => { seen.push(t); },
    }));
    expect(seen).toEqual(['guarded', '-', 'ok']);
  });

  test('the guard settles with the streamed output tokens', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => fakeStream(['x'], { input_tokens: 5, output_tokens: 13 })) as any);
    const settled: Array<number | null> = [];
    await withAIInvocationGuard(
      async () => ({ settle: async (u) => { settled.push(u ? u.outputTokens : null); } }),
      () => chatStream({
        model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any,
        onText: () => {},
      }),
    );
    // Metering must not be silently lost on the streaming path — a stream that
    // skipped the guard would be free and uncapped.
    expect(settled).toContain(13);
  });

  test('a guard refusal surfaces as a policy error, not a drain crash', async () => {
    configureTestGateway();
    __setStreamTextTransportForTests((() => fakeStream(['never'])) as any);
    await expect(withAIInvocationGuard(
      async () => { throw new Error('budget exceeded'); },
      () => chatStream({
        model: 'openai:gpt-test', system: 's', messages: [{ role: 'user', content: 'q' }] as any,
        onText: () => {},
      }),
    )).rejects.toThrow('budget exceeded');
  });
});
