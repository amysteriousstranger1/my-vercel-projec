import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import type { Config, Region } from './types.js';

dotenv.config();

const APP_DIR = path.resolve('.poker-vision');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');

interface PartialConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  interval?: number;
  monitor?: number;
  outputDir?: string;
  saveScreenshots?: boolean;
  webhookUrl?: string;
  region?: Region;
  promptPath?: string;
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const envRegion = (): Region | undefined => {
  const x = process.env.REGION_X;
  const y = process.env.REGION_Y;
  const width = process.env.REGION_WIDTH;
  const height = process.env.REGION_HEIGHT;

  if (!(x && y && width && height)) {
    return undefined;
  }

  return {
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height)
  };
};

export const defaultConfig = (): Config => ({
  apiKey: process.env.OVERSHOOT_API_KEY ?? '',
  model: process.env.OVERSHOOT_MODEL ?? 'Qwen/Qwen3-VL-32B-Instruct-FP8',
  baseUrl: process.env.OVERSHOOT_BASE_URL ?? 'https://api.overshoot.ai/v0.2',
  interval: toNumber(process.env.SCREENSHOT_INTERVAL, 2000),
  monitor: toNumber(process.env.MONITOR_INDEX, 0),
  outputDir: process.env.OUTPUT_DIR ?? './data',
  saveScreenshots: toBoolean(process.env.SAVE_SCREENSHOTS, false),
  webhookUrl: process.env.WEBHOOK_URL,
  region: envRegion(),
  promptPath: path.resolve('config/poker_prompt.txt')
});

export const loadConfig = async (): Promise<Config> => {
  const envCfg = defaultConfig();

  if (!existsSync(CONFIG_FILE)) {
    return envCfg;
  }

  const raw = await readFile(CONFIG_FILE, 'utf8');
  const fileCfg = JSON.parse(raw) as PartialConfig;

  return {
    ...envCfg,
    ...fileCfg,
    region: fileCfg.region ?? envCfg.region
  };
};

export const saveConfig = async (patch: PartialConfig): Promise<Config> => {
  await mkdir(APP_DIR, { recursive: true });
  const current = await loadConfig();
  const merged: Config = {
    ...current,
    ...patch,
    region: patch.region ?? current.region
  };

  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
};

export const getPidFilePath = (): string => path.join(APP_DIR, 'monitor.pid');
export const getMetaFilePath = (): string => path.join(APP_DIR, 'monitor-meta.json');

export const ensureAppDir = async (): Promise<void> => {
  await mkdir(APP_DIR, { recursive: true });
};
