import type { Clock } from "../../src/spoon/clock.js";

/** 待機せずに時刻だけを進める Clock。待機した時間を記録する */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];

  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    this.sleeps.push(ms);
    this.current += ms;
  }
}
