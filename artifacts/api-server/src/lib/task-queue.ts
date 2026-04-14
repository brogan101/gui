import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";
import { stateOrchestrator } from "./state-orchestrator.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface AsyncJob {
  id: string;
  name: string;
  type: string;
  status: JobStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  capability?: string;
  message: string;
  error?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface JobContext {
  job: AsyncJob;
  updateProgress: (
    progress: number,
    message: string,
    metadata?: Record<string, unknown>,
  ) => void;
  publishThought: (
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) => void;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface EnqueueOptions {
  capability?: string;
  metadata?: Record<string, unknown>;
}

class AsyncTaskQueue {
  private jobs = new Map<string, AsyncJob>();
  private queue: Array<{ job: AsyncJob; handler: JobHandler }> = [];
  private emitter = new EventEmitter();
  private running = false;

  subscribe(listener: (job: AsyncJob) => void): () => void {
    this.emitter.on("job", listener);
    return () => this.emitter.off("job", listener);
  }

  listJobs(): AsyncJob[] {
    return [...this.jobs.values()].sort((l, r) =>
      r.createdAt.localeCompare(l.createdAt),
    );
  }

  getJob(jobId: string): AsyncJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  enqueue(
    name: string,
    type: string,
    handler: JobHandler,
    options: EnqueueOptions = {},
  ): AsyncJob {
    const job: AsyncJob = {
      id: randomUUID(),
      name,
      type,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
      capability: options.capability,
      message: "Queued",
      metadata: options.metadata,
    };
    this.jobs.set(job.id, job);
    this.emitter.emit("job", job);
    thoughtLog.publish({
      category: "queue",
      title: "Task Queued",
      message: `${job.name} entered the async queue`,
      metadata: { jobId: job.id, type: job.type, capability: job.capability },
    });
    this.queue.push({ job, handler });
    void this.drain();
    return job;
  }

  private updateJob(job: AsyncJob): void {
    this.jobs.set(job.id, job);
    this.emitter.emit("job", job);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    const { job, handler } = next;
    try {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      job.message = "Running";
      this.updateJob(job);

      if (job.capability) {
        await stateOrchestrator.activateCapability(job.capability, job.name, job.id);
      }

      const context: JobContext = {
        job,
        updateProgress: (progress, message, metadata) => {
          job.progress = Math.max(0, Math.min(100, progress));
          job.message = message;
          job.metadata = metadata
            ? { ...(job.metadata || {}), ...metadata }
            : job.metadata;
          this.updateJob(job);
        },
        publishThought: (title, message, metadata) => {
          thoughtLog.publish({
            category: "queue",
            title,
            message,
            metadata: { jobId: job.id, ...(metadata || {}) },
          });
        },
      };

      const result = await handler(context);
      job.status = "completed";
      job.progress = 100;
      job.result = result;
      job.finishedAt = new Date().toISOString();
      job.message = "Completed";
      this.updateJob(job);
      thoughtLog.publish({
        category: "queue",
        title: "Task Completed",
        message: `${job.name} finished successfully`,
        metadata: { jobId: job.id, type: job.type },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = message;
      job.message = message;
      this.updateJob(job);
      logger.error({ err: error, jobId: job.id, type: job.type }, "Async task failed");
      thoughtLog.publish({
        level: "error",
        category: "queue",
        title: "Task Failed",
        message: `${job.name} failed: ${message}`,
        metadata: { jobId: job.id, type: job.type },
      });
    } finally {
      if (job.capability) {
        if (job.status === "failed") {
          await stateOrchestrator.setCapability(job.capability, {
            active: false,
            phase: "error",
            detail: job.error,
            assignedJobId: undefined,
          });
        } else {
          await stateOrchestrator.releaseCapability(job.capability, job.name);
        }
      }
      this.running = false;
      void this.drain();
    }
  }
}

export const taskQueue = new AsyncTaskQueue();
