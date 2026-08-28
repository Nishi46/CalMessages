import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';

// 09 breakdown §A step 2: producer (scheduler loop, §C) and consumer (this
// worker) are kept as distinct functions sharing one queue, in the same
// process for now — matching Architecture §3.3's framing of them as
// separate concerns, and §6's framing of consumers as horizontally scalable
// independent of the singleton scheduler.
export const NUDGE_QUEUE_NAME = 'nudge';

export interface NudgeJobData {
  userId: string;
  localDate: string;
}

export function createNudgeQueue(connection: ConnectionOptions): Queue<NudgeJobData> {
  return new Queue<NudgeJobData>(NUDGE_QUEUE_NAME, { connection });
}

// The processor is accepted as a parameter rather than defined here so §E
// step 17's real authoritative-check + sendMessage() logic can be dropped in
// without reworking the worker skeleton.
export function createNudgeWorker(
  connection: ConnectionOptions,
  processor: Processor<NudgeJobData>,
): Worker<NudgeJobData> {
  return new Worker<NudgeJobData>(NUDGE_QUEUE_NAME, processor, { connection });
}
