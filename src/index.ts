#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ensureAppDir, getMetaFilePath, getPidFilePath, loadConfig, saveConfig } from './config.js';
import { MonitorService, loadPrompt } from './monitor.js';
import { parseVisionOutput } from './parser.js';
import { listDisplays, captureScreenshot } from './screenshot.js';
import { VisionClient } from './vision.js';
import type { Config, Region } from './types.js';

interface StartOptions {
  interval?: string;
  monitor?: string;
  output?: string;
}

const program = new Command();
const modulePath = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(modulePath);
const rootDir = path.resolve(moduleDir, '..');

const resolveTtsxBinary = (): string => {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(rootDir, 'node_modules', '.bin', `tsx${ext}`);
};

program
  .name('poker-vision')
  .description('Real-time poker table recognition for macOS')
  .version('1.0.0');

program
  .command('start')
  .description('Start background monitoring')
  .option('--interval <ms>', 'Screenshot interval in ms')
  .option('--monitor <index>', 'Monitor index')
  .option('--output <dir>', 'Output directory')
  .action(async (options: StartOptions) => {
    const pidPath = getPidFilePath();

    if (existsSync(pidPath)) {
      const pid = Number((await readFile(pidPath, 'utf8')).trim());
      if (Number.isFinite(pid) && isProcessAlive(pid)) {
        console.error(`Monitor already running with PID ${pid}`);
        process.exitCode = 1;
        return;
      }
      await rm(pidPath, { force: true });
    }

    const cfg = await loadConfig();
    const patched: Partial<Config> = {};

    if (options.interval) {
      const interval = Number(options.interval);
      if (!Number.isFinite(interval) || interval <= 0) {
        console.error('--interval must be a positive number');
        process.exitCode = 1;
        return;
      }
      patched.interval = interval;
    }
    if (options.monitor) {
      const monitor = Number(options.monitor);
      if (!Number.isInteger(monitor) || monitor < 0) {
        console.error('--monitor must be a non-negative integer');
        process.exitCode = 1;
        return;
      }
      patched.monitor = monitor;
    }
    if (options.output) {
      patched.outputDir = path.resolve(options.output);
    }

    const nextConfig = Object.keys(patched).length > 0 ? await saveConfig(patched) : cfg;
    if (!nextConfig.apiKey) {
      console.error('Missing OVERSHOOT_API_KEY. Set it via `poker-vision config --api-key <key>` or .env');
      process.exitCode = 1;
      return;
    }

    await ensureAppDir();

    const tsxBin = resolveTtsxBinary();
    const child = spawn(tsxBin, ['src/index.ts', 'run-worker'], {
      detached: true,
      stdio: 'ignore',
      cwd: rootDir,
      env: process.env
    });

    child.unref();

    await writeFile(pidPath, String(child.pid), 'utf8');
    await writeFile(
      getMetaFilePath(),
      JSON.stringify({ startedAt: Date.now(), pid: child.pid }, null, 2),
      'utf8'
    );

    console.log(`Monitoring started (PID: ${child.pid})`);
  });

program
  .command('stop')
  .description('Stop monitoring')
  .action(async () => {
    const pidPath = getPidFilePath();

    if (!existsSync(pidPath)) {
      console.log('No monitor process found');
      return;
    }

    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    if (Number.isFinite(pid) && isProcessAlive(pid)) {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped monitor PID ${pid}`);
    } else {
      console.log('Monitor PID file existed, but process was not running');
    }

    await rm(pidPath, { force: true });
  });

program
  .command('analyze')
  .description('Analyze a single screenshot file')
  .argument('<imagePath>', 'Path to png/jpg screenshot')
  .action(async (imagePath: string) => {
    const cfg = await loadConfig();
    if (!cfg.apiKey) {
      console.error('Missing OVERSHOOT_API_KEY. Set it via `poker-vision config --api-key <key>` or .env');
      process.exitCode = 1;
      return;
    }

    const absPath = path.resolve(imagePath);
    const imageBuffer = await readFile(absPath);
    const prompt = await loadPrompt(cfg.promptPath);
    const vision = new VisionClient(cfg, prompt);

    const result = await vision.analyzeImage(imageBuffer.toString('base64'));
    const parsed = parseVisionOutput(result.text);

    console.log(parsed.state.rawResponse);
    console.log('\n--- Parsed JSON ---');
    console.log(JSON.stringify(parsed.state, null, 2));
    if (parsed.parseErrors.length > 0) {
      console.error('\nParse warnings:');
      for (const err of parsed.parseErrors) {
        console.error(`- ${err}`);
      }
    }
  });

program
  .command('config')
  .description('Set configuration values')
  .option('--api-key <key>', 'Overshoot API key')
  .option('--interval <ms>', 'Interval in ms')
  .option('--monitor <index>', 'Monitor index')
  .option('--output <dir>', 'Output directory')
  .option('--webhook <url>', 'Webhook URL')
  .option('--base-url <url>', 'Vision API base URL')
  .action(
    async (options: { apiKey?: string; interval?: string; monitor?: string; output?: string; webhook?: string; baseUrl?: string }) => {
    const patch: Partial<Config> = {};
    if (options.apiKey) {
      patch.apiKey = options.apiKey;
    }
    if (options.interval) {
      const interval = Number(options.interval);
      if (!Number.isFinite(interval) || interval <= 0) {
        console.error('--interval must be a positive number');
        process.exitCode = 1;
        return;
      }
      patch.interval = interval;
    }
    if (options.monitor) {
      const monitor = Number(options.monitor);
      if (!Number.isInteger(monitor) || monitor < 0) {
        console.error('--monitor must be a non-negative integer');
        process.exitCode = 1;
        return;
      }
      patch.monitor = monitor;
    }
    if (options.output) {
      patch.outputDir = path.resolve(options.output);
    }
    if (options.webhook) {
      patch.webhookUrl = options.webhook;
    }
    if (options.baseUrl) {
      patch.baseUrl = options.baseUrl;
    }

    const cfg = await saveConfig(patch);
    console.log('Config saved');
    console.log(JSON.stringify({ ...cfg, apiKey: cfg.apiKey ? '***' : '' }, null, 2));
  }
  );

program
  .command('set-region')
  .description('Set capture region (x y width height)')
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const x = Number(await rl.question('x: '));
    const y = Number(await rl.question('y: '));
    const width = Number(await rl.question('width: '));
    const height = Number(await rl.question('height: '));
    rl.close();

    if (![x, y, width, height].every(Number.isFinite)) {
      console.error('Region values must be numbers');
      process.exitCode = 1;
      return;
    }

    const region: Region = { x, y, width, height };
    await saveConfig({ region });
    console.log('Region saved');
  });

program
  .command('monitors')
  .description('List available displays')
  .action(async () => {
    const displays = await listDisplays();
    for (const display of displays) {
      console.log(`${display.id}: ${display.name}`);
    }
  });

program
  .command('run-worker')
  .description('Internal worker process. Do not run directly.')
  .action(async () => {
    const cfg = await loadConfig();
    if (!cfg.apiKey) {
      throw new Error('Missing API key in worker process');
    }

    const prompt = await loadPrompt(cfg.promptPath);
    const monitor = new MonitorService(cfg, prompt);

    process.on('SIGTERM', () => monitor.stop());
    process.on('SIGINT', () => monitor.stop());

    await monitor.runLoop();
  });

program
  .command('capture-test')
  .description('Take one screenshot and save to output dir')
  .action(async () => {
    const cfg = await loadConfig();
    const shot = await captureScreenshot({ monitor: cfg.monitor, region: cfg.region });
    const outDir = path.resolve(cfg.outputDir);
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `capture-${Date.now()}.png`);
    await writeFile(outPath, shot.pngBuffer);
    console.log(`Saved: ${outPath}`);
  });

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const run = async (): Promise<void> => {
  await program.parseAsync(process.argv);
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exitCode = 1;
});
