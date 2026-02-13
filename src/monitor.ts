import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { captureScreenshot } from './screenshot.js';
import { isSameState, parseVisionOutput } from './parser.js';
import { VisionClient, isRateLimitError } from './vision.js';
import type { Config, TableState } from './types.js';
import { Storage } from './storage.js';

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export interface MonitorOptions {
  interval?: number;
  monitor?: number;
  outputDir?: string;
}

export class MonitorService {
  private readonly config: Config;
  private readonly vision: VisionClient;
  private readonly storage: Storage;
  private running = false;
  private previousState: TableState | null = null;
  private unchangedSince = 0;

  public constructor(config: Config, prompt: string) {
    this.config = config;
    this.vision = new VisionClient(config, prompt);
    this.storage = new Storage(config);
  }

  public async runLoop(): Promise<void> {
    this.running = true;
    await this.storage.init();

    let dynamicInterval = this.config.interval;
    let noTableStreak = 0;

    while (this.running) {
      const cycleStart = Date.now();
      try {
        const capture = await captureScreenshot({
          monitor: this.config.monitor,
          region: this.config.region,
          pngCompressionLevel: 8
        });

        const visionResponse = await this.vision.analyzeImage(capture.base64);
        console.log(`[vision] latency=${visionResponse.latencyMs}ms cache=${visionResponse.fromCache}`);

        const parsed = parseVisionOutput(visionResponse.text, Date.now());
        if (parsed.parseErrors.length > 0) {
          console.error(`[parser] ${parsed.parseErrors.join('; ')}`);
        }

        if (!parsed.hasActiveTable) {
          noTableStreak += 1;
          console.log('[monitor] no active table detected, skipping save');
          dynamicInterval = Math.min(this.config.interval * Math.max(1, noTableStreak), 15000);
        } else {
          noTableStreak = 0;
          await this.storage.save(parsed.state, capture.pngBuffer);
          this.printState(parsed.state);

          if (isSameState(this.previousState, parsed.state)) {
            if (this.unchangedSince === 0) {
              this.unchangedSince = Date.now();
            }
          } else {
            this.unchangedSince = 0;
          }

          this.previousState = parsed.state;
          const unchangedFor = this.unchangedSince === 0 ? 0 : Date.now() - this.unchangedSince;
          dynamicInterval = unchangedFor >= 30_000 ? Math.min(this.config.interval * 3, 10000) : this.config.interval;
        }
      } catch (error) {
        if (isRateLimitError(error)) {
          dynamicInterval = Math.max(dynamicInterval, error.retryAfterMs);
          console.error(`[vision] rate limited. Next attempt in ${dynamicInterval}ms`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[monitor] cycle failed: ${message}`);
          dynamicInterval = Math.min(Math.max(dynamicInterval, this.config.interval), 15000);
        }
      }

      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(100, dynamicInterval - elapsed);
      await sleep(waitMs);
    }

    await this.storage.flushSummary();
  }

  public stop(): void {
    this.running = false;
  }

  private printState(state: TableState): void {
    const board =
      state.board === 'none'
        ? 'none'
        : state.board.map((card) => `${card.rank}${card.suit}`).join(' ');

    console.log(`\n[table ${new Date(state.timestamp).toISOString()}]`);
    console.log(`Board: ${board}`);
    for (const player of state.players) {
      const cards = player.cards === 'hidden' ? 'hidden' : `${player.cards[0].rank}${player.cards[0].suit} ${player.cards[1].rank}${player.cards[1].suit}`;
      const allIn = player.isAllIn ? ' | All-In' : '';
      console.log(`${player.nickname} | ${cards} | ${player.stack}${allIn}`);
    }
    console.log('');
  }
}

export const loadPrompt = async (promptPath: string): Promise<string> => {
  const abs = path.resolve(promptPath);
  return readFile(abs, 'utf8');
};
