import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config, TableState } from './types.js';

interface SessionStats {
  events: number;
  hands: number;
  startedAt: number;
  lastAt: number;
}

export class Storage {
  private readonly outputDir: string;
  private readonly saveScreenshots: boolean;
  private readonly webhookUrl?: string;
  private readonly sessionGapMs = 5 * 60 * 1000;

  private sessionId = '';
  private sessionStats: SessionStats | null = null;

  public constructor(config: Config) {
    this.outputDir = path.resolve(config.outputDir);
    this.saveScreenshots = config.saveScreenshots;
    this.webhookUrl = config.webhookUrl;
  }

  public async init(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  public async save(state: TableState, screenshotBuffer?: Buffer): Promise<void> {
    await this.rotateSessionIfNeeded(state.timestamp);
    this.ensureSession(state.timestamp, state.board !== 'none');

    const sessionPath = path.join(this.outputDir, this.sessionId);
    const eventsPath = path.join(sessionPath, 'events');
    await mkdir(eventsPath, { recursive: true });

    const outputPath = path.join(eventsPath, `${state.timestamp}.json`);
    await writeFile(outputPath, JSON.stringify(state, null, 2), 'utf8');

    if (this.saveScreenshots && screenshotBuffer) {
      const shotsPath = path.join(sessionPath, 'screenshots');
      await mkdir(shotsPath, { recursive: true });
      await writeFile(path.join(shotsPath, `${state.timestamp}.png`), screenshotBuffer);
    }

    if (this.webhookUrl) {
      await this.postWebhook(state);
    }

    this.touchStats(state.timestamp, state.board !== 'none');
  }

  public async flushSummary(): Promise<void> {
    if (!this.sessionId || !this.sessionStats) {
      return;
    }

    const sessionPath = path.join(this.outputDir, this.sessionId);
    const summaryPath = path.join(sessionPath, 'summary.json');

    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          sessionId: this.sessionId,
          ...this.sessionStats,
          durationSec: Math.round((this.sessionStats.lastAt - this.sessionStats.startedAt) / 1000)
        },
        null,
        2
      ),
      'utf8'
    );
  }

  private ensureSession(timestamp: number, hasBoard: boolean): void {
    if (!this.sessionStats) {
      this.sessionId = this.makeSessionId(timestamp);
      this.sessionStats = {
        events: 0,
        hands: 0,
        startedAt: timestamp,
        lastAt: timestamp
      };
      return;
    }

  }

  private async rotateSessionIfNeeded(timestamp: number): Promise<void> {
    if (!this.sessionStats) {
      return;
    }

    const gap = timestamp - this.sessionStats.lastAt;
    if (gap <= this.sessionGapMs) {
      return;
    }

    await this.flushSummary();
    this.sessionId = '';
    this.sessionStats = null;
  }

  private touchStats(timestamp: number, hasBoard: boolean): void {
    if (!this.sessionStats) {
      return;
    }

    this.sessionStats.events += 1;
    this.sessionStats.lastAt = timestamp;
    if (hasBoard) {
      this.sessionStats.hands += 1;
    }
  }

  private makeSessionId(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (n: number): string => String(n).padStart(2, '0');

    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      '-',
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join('');
  }

  private async postWebhook(state: TableState): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[webhook] failed: ${message}`);
    }
  }
}
