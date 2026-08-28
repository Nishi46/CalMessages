import { Redis } from 'ioredis';

// BullMQ's Worker uses blocking Redis commands to wait for jobs, which
// requires maxRetriesPerRequest: null on the connection it's given (bullmq's
// own connection docs) — set here so both the producer (Queue) and consumer
// (Worker) skeletons in queue.ts can share one connection.
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
