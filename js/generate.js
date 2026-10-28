// "Create from text": sends a passage to Claude from the browser with the user's own
// API key and returns scenario JSON. Uses the same prompt and schema as
// tools/article_to_scenario.py (tools/scenario_prompt.md, scenario.schema.json).

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm';
const MODEL = 'claude-opus-5-5';

let sdkPromise;
const loadSdk = () => (sdkPromise ||= import(SDK_URL).then((m) => m.default));

export class GenerateError extends Error {
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code; // key into the i18n strings: gen.err.<code>
  }
}

/**
 * Generate a scenario. onProgress({ phase: 'thinking' | 'writing', chars }) is called
 * as the response streams in. Abort with `signal`.
 */
export async function generateScenario({ apiKey, text, signal, onProgress }) {
  const [Anthropic, system, schema] = await Promise.all([
    loadSdk().catch(() => { throw new GenerateError('sdk'); }),
    fetch('tools/scenario_prompt.md').then((r) => r.text()),
    fetch('scenario.schema.json').then((r) => r.json()),
  ]);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  let message;
  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        system,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema } },
        // If the request is declined by a safety classifier, retry it on the
        // recommended fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: `Build a scenario from this text:\n\n<article>\n${text}\n</article>` }],
      },
      { signal },
    );
    onProgress?.({ phase: 'thinking', chars: 0 });
    stream.on('text', (_delta, snapshot) => onProgress?.({ phase: 'writing', chars: snapshot.length }));
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) throw new GenerateError('aborted');
    if (e instanceof Anthropic.AuthenticationError) throw new GenerateError('auth');
    if (e instanceof Anthropic.PermissionDeniedError) throw new GenerateError('permission', e.message);
    if (e instanceof Anthropic.RateLimitError) throw new GenerateError('ratelimit');
    if (e instanceof Anthropic.BadRequestError) throw new GenerateError('badrequest', e.message);
    if (e instanceof Anthropic.APIConnectionError) throw new GenerateError('network');
    if (e instanceof Anthropic.APIError) throw new GenerateError('api', e.message);
    throw e;
  }

  if (message.stop_reason === 'refusal') throw new GenerateError('refusal');
  if (message.stop_reason === 'max_tokens') throw new GenerateError('truncated');
  const out = message.content.find((b) => b.type === 'text');
  try {
    const scenario = JSON.parse(out.text);
    scenario.overlays ||= [];
    return scenario;
  } catch {
    throw new GenerateError('parse');
  }
}
