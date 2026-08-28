import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL_CONSUMER;
    if (!connectionString) {
      throw new Error('DATABASE_URL_CONSUMER is not set');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

// What every query function actually needs — satisfied by both a bare Pool
// (each call grabs its own connection) and a PoolClient checked out inside
// withTransaction (every call shares one connection/transaction). Query
// functions that need to compose with a caller's transaction (10 breakdown
// §A step 2) take this instead of calling getPool() directly.
export type DbClient = Pick<pg.Pool | pg.PoolClient, 'query'>;

// 10 breakdown §A step 3: none of Sprints 1-5's query functions needed
// multi-statement atomicity — this is the first (meal_log insert + free-tier
// increment, 04 §8.1, must commit or roll back together).
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
