import type { AnalyzeResult, CardRank, CardSuit, Player, PokerCard, TableState } from './types.js';

const CARD_RE = /^([2-9TJQKA])([hdcs])$/;

const parseCard = (raw: string): PokerCard | null => {
  const trimmed = raw.trim();
  const match = CARD_RE.exec(trimmed);
  if (!match) {
    return null;
  }

  return {
    rank: match[1] as CardRank,
    suit: match[2] as CardSuit
  };
};

const parseBoard = (rawBoard: string, errors: string[]): PokerCard[] | 'none' => {
  if (rawBoard.trim().toLowerCase() === 'none') {
    return 'none';
  }

  const cards = rawBoard
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const parsed: PokerCard[] = [];
  for (const card of cards) {
    const parsedCard = parseCard(card);
    if (!parsedCard) {
      errors.push(`Invalid board card: ${card}`);
      continue;
    }
    parsed.push(parsedCard);
  }

  return parsed.length > 0 ? parsed : 'none';
};

const parsePlayerLine = (line: string, errors: string[]): Player | null => {
  const parts = line
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    errors.push(`Invalid player line: ${line}`);
    return null;
  }

  const [nickname, cardsRaw, stack, status] = parts;

  if (!nickname) {
    errors.push(`Missing nickname in line: ${line}`);
    return null;
  }

  let cards: Player['cards'] = 'hidden';
  if (cardsRaw && cardsRaw.toLowerCase() !== 'hidden' && cardsRaw !== '??') {
    const cardParts = cardsRaw.split(/\s+/).filter(Boolean);
    if (cardParts.length === 2) {
      const firstCard = cardParts[0];
      const secondCard = cardParts[1];
      if (!firstCard || !secondCard) {
        errors.push(`Expected two cards or hidden: ${cardsRaw}`);
        return null;
      }
      const c1 = parseCard(firstCard);
      const c2 = parseCard(secondCard);
      if (c1 && c2) {
        cards = [c1, c2];
      } else {
        errors.push(`Invalid player cards: ${cardsRaw}`);
      }
    } else {
      errors.push(`Expected two cards or hidden: ${cardsRaw}`);
    }
  }

  const player: Player = {
    nickname,
    cards,
    stack: stack ?? '?'
  };

  if (status === 'All-In') {
    player.isAllIn = true;
  }

  return player;
};

export const parseVisionOutput = (rawResponse: string, timestamp = Date.now()): AnalyzeResult => {
  const errors: string[] = [];
  const normalized = rawResponse.replace(/\r\n/g, '\n').trim();

  const boardMatch = normalized.match(/^Board:\s*(.+)$/m);
  if (!boardMatch) {
    errors.push('Missing "Board:" line');
  }

  const board = parseBoard(boardMatch?.[1] ?? 'none', errors);

  const lines = normalized.split('\n');
  const playersHeader = lines.findIndex((line) => line.trim() === 'Players:');
  if (playersHeader === -1) {
    errors.push('Missing "Players:" header');
  }

  const playerLines = playersHeader === -1 ? [] : lines.slice(playersHeader + 1).map((x) => x.trim()).filter(Boolean);

  const players: Player[] = [];
  for (const playerLine of playerLines) {
    const player = parsePlayerLine(playerLine, errors);
    if (player) {
      players.push(player);
    }
  }

  const state: TableState = {
    timestamp,
    board,
    players,
    rawResponse
  };

  return {
    state,
    parseErrors: errors,
    hasActiveTable: players.length > 0
  };
};

const cardEquals = (left: PokerCard, right: PokerCard): boolean => left.rank === right.rank && left.suit === right.suit;

export const isSameState = (a: TableState | null, b: TableState): boolean => {
  if (!a) {
    return false;
  }

  if (a.players.length !== b.players.length) {
    return false;
  }

  if (a.board === 'none' && b.board !== 'none') {
    return false;
  }

  if (a.board !== 'none' && b.board === 'none') {
    return false;
  }

  if (a.board !== 'none' && b.board !== 'none') {
    if (a.board.length !== b.board.length) {
      return false;
    }
    for (let i = 0; i < a.board.length; i += 1) {
      const leftCard = a.board[i];
      const rightCard = b.board[i];
      if (!leftCard || !rightCard) {
        return false;
      }
      if (!cardEquals(leftCard, rightCard)) {
        return false;
      }
    }
  }

  for (let i = 0; i < a.players.length; i += 1) {
    const p1 = a.players[i];
    const p2 = b.players[i];
    if (!p1 || !p2) {
      return false;
    }

    if (p1.nickname !== p2.nickname || p1.stack !== p2.stack || Boolean(p1.isAllIn) !== Boolean(p2.isAllIn)) {
      return false;
    }

    if (p1.cards === 'hidden' && p2.cards === 'hidden') {
      continue;
    }

    if (p1.cards === 'hidden' || p2.cards === 'hidden') {
      return false;
    }

    if (!cardEquals(p1.cards[0], p2.cards[0]) || !cardEquals(p1.cards[1], p2.cards[1])) {
      return false;
    }
  }

  return true;
};
