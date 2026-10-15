/** 時刻と待機。テストで差し替えられるように外から渡す */
export interface Clock {
  now(): number;
  /** ms だけ待つ。signal が中断されたら signal.reason で reject する */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
