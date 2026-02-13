import sharp from 'sharp';
import screenshot from 'screenshot-desktop';
import type { Region } from './types.js';

export interface DisplayInfo {
  id: number;
  name: string;
}

export interface CaptureOptions {
  monitor: number;
  region?: Region;
  pngCompressionLevel?: number;
}

export interface CaptureResult {
  pngBuffer: Buffer;
  base64: string;
}

export const listDisplays = async (): Promise<DisplayInfo[]> => {
  const displays = await screenshot.listDisplays();
  return displays.map((d, index) => ({
    id: Number.isFinite(d.id) ? d.id : index,
    name: d.name ?? `Display-${index}`
  }));
};

const cropIfNeeded = async (input: Buffer, region?: Region): Promise<Buffer> => {
  if (!region) {
    return input;
  }

  return sharp(input)
    .extract({
      left: Math.max(0, Math.floor(region.x)),
      top: Math.max(0, Math.floor(region.y)),
      width: Math.max(1, Math.floor(region.width)),
      height: Math.max(1, Math.floor(region.height))
    })
    .png({ compressionLevel: 6, palette: false })
    .toBuffer();
};

export const captureScreenshot = async (options: CaptureOptions): Promise<CaptureResult> => {
  try {
    const raw = await screenshot({ screen: options.monitor, format: 'png' });
    const cropped = await cropIfNeeded(raw, options.region);
    const compressed = await sharp(cropped)
      .png({
        compressionLevel: options.pngCompressionLevel ?? 8,
        adaptiveFiltering: true,
        effort: 6
      })
      .toBuffer();

    return {
      pngBuffer: compressed,
      base64: compressed.toString('base64')
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/permission|not authorized|screen recording|denied/i.test(message)) {
      throw new Error(
        [
          'No Screen Recording permission on macOS.',
          'Open: System Settings -> Privacy & Security -> Screen Recording, then allow Terminal/Codex app and restart it.'
        ].join(' ')
      );
    }
    throw error;
  }
};
