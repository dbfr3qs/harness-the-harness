// One to five dots and back: ., .., ..., ...., ....., ...., ..., ..
export const SPINNER_FRAMES = [1, 2, 3, 4, 5, 4, 3, 2].map((n) => ".".repeat(n));

export interface Spinner {
  start(): void;
  stop(): void; // erases the animation, leaving the cursor where it started
}

/**
 * A placeholder animation shown while waiting for the model. It draws on the current line
 * with `\r` and erases itself on stop, so it is a no-op when output is not a terminal.
 */
export function createSpinner(
  stream: { write(s: string): unknown; isTTY?: boolean } = process.stdout,
  intervalMs = 150,
): Spinner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;

  const draw = () => {
    stream.write(`\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}\x1b[K`);
    frame++;
  };

  return {
    start() {
      if (!stream.isTTY || timer) return;
      frame = 0;
      draw();
      timer = setInterval(draw, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      stream.write(`\r\x1b[K`);
    },
  };
}
