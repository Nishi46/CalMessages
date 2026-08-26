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
