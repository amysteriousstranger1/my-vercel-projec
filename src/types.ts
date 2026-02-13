export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type CardSuit = 'h' | 'd' | 'c' | 's';

export interface PokerCard {
  rank: CardRank;
  suit: CardSuit;
}

export interface Player {
  nickname: string;
  cards: [PokerCard, PokerCard] | 'hidden';
  stack: string;
  isAllIn?: boolean;
}

export interface TableState {
  timestamp: number;
  board: PokerCard[] | 'none';
  players: Player[];
  rawResponse: string;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Config {
  apiKey: string;
  model: string;
  baseUrl: string;
  interval: number;
  monitor: number;
  outputDir: string;
  saveScreenshots: boolean;
  webhookUrl?: string;
  region?: Region;
  promptPath: string;
}

export interface AnalyzeResult {
  state: TableState;
  parseErrors: string[];
  hasActiveTable: boolean;
}

export interface VisionResponse {
  text: string;
  latencyMs: number;
  fromCache: boolean;
}

export class RateLimitError extends Error {
  public readonly retryAfterMs: number;

  public constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
