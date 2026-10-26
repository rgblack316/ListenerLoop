/** Minimal in-process FIFO job queue. No Redis; pending work is recovered from the database on startup. */
export class JobQueue {
  private readonly pending: (() => Promise<void>)[] = [];
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly concurrency = 1,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  add(job: () => Promise<void>): void {
    this.pending.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.running++;
      job()
        .catch((err) => this.onError(err))
        .finally(() => {
          this.running--;
          this.pump();
          if (this.running === 0 && this.pending.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }

  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
