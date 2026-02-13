declare module 'screenshot-desktop' {
  interface ScreenshotDesktopOptions {
    screen?: number;
    format?: 'png' | 'jpg';
    filename?: string;
  }

  interface ScreenshotDesktopDisplay {
    id: number;
    name?: string;
  }

  function screenshot(options?: ScreenshotDesktopOptions): Promise<Buffer>;
  namespace screenshot {
    function listDisplays(): Promise<ScreenshotDesktopDisplay[]>;
  }

  export = screenshot;
}

declare module 'overshoot' {
  const value: unknown;
  export default value;
}
