import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Config, RateLimitError as RateLimitErrorType, VisionResponse } from './types.js';
import { RateLimitError } from './types.js';

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const hashImage = (base64: string): string => createHash('sha256').update(base64).digest('hex');

const extractText = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const body = payload as Record<string, unknown>;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }

  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) {
        return text;
      }
    }
  }

  return '';
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/, '');

const getCompletionsUrl = (baseUrl: string): string => `${normalizeBaseUrl(baseUrl)}/chat/completions`;

export class VisionClient {
  private readonly config: Config;
  private readonly prompt: string;
  private readonly cache = new Map<string, string>();

  public constructor(config: Config, prompt: string) {
    this.config = config;
    this.prompt = prompt;
  }

  public async analyzeImage(base64Png: string): Promise<VisionResponse> {
    const cacheKey = hashImage(base64Png);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { text: cached, latencyMs: 0, fromCache: true };
    }

    const maxRetries = 4;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const started = performance.now();
      try {
        const text = await this.callHttpCompatible(base64Png);
        const latencyMs = Math.round(performance.now() - started);
        this.cache.set(cacheKey, text);
        return { text, latencyMs, fromCache: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (/429|rate limit|too many requests/i.test(message)) {
          const backoffMs = Math.min(15000, 1000 * 2 ** attempt);
          if (attempt === maxRetries - 1) {
            throw new RateLimitError(`Rate limited after ${maxRetries} attempts`, backoffMs);
          }
          await sleep(backoffMs);
          continue;
        }

        if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
          const backoffMs = Math.min(10000, 800 * 2 ** attempt);
          if (attempt === maxRetries - 1) {
            throw new Error(`Vision timeout after ${maxRetries} attempts`);
          }
          await sleep(backoffMs);
          continue;
        }

        throw error;
      }
    }

    throw new Error('Vision retries exhausted unexpectedly');
  }

  private async callHttpCompatible(base64Png: string): Promise<string> {
    const url = getCompletionsUrl(this.config.baseUrl);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: this.prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Png}` } }
            ]
          }
        ],
        temperature: 0
      })
    });

    const rawText = await response.text();
    let body: unknown = null;
    try {
      body = rawText ? (JSON.parse(rawText) as unknown) : null;
    } catch {
      body = null;
    }

    if (response.status === 404) {
      const base = normalizeBaseUrl(this.config.baseUrl);
      if (base.endsWith('/v0.2') || base.endsWith('/api/v0.2')) {
        throw new Error(
          'Overshoot v0.2 does not expose /chat/completions. Its API is stream/WebRTC-only. ' +
            'For this Node screenshot workflow, configure an OpenAI-compatible Vision endpoint in OVERSHOOT_BASE_URL.'
        );
      }
      throw new Error(`Vision endpoint not found: ${url}`);
    }

    if (!response.ok) {
      const details = body ? JSON.stringify(body) : rawText.slice(0, 400);
      throw new Error(`Vision HTTP error ${response.status}: ${details}`);
    }

    const text = extractText(body);
    if (!text.trim()) {
      throw new Error(`Vision response missing text. Raw=${rawText.slice(0, 400)}`);
    }

    return text;
  }
}

export const isRateLimitError = (error: unknown): error is RateLimitErrorType => {
  return error instanceof RateLimitError;
};
