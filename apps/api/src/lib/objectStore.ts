import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface ObjectStore {
  putObject(buffer: Buffer, contentType: string): Promise<string>;
  // Feeds VisionProvider.recognize()'s FetchByKey (09 §D step 15) — reads
  // back the photo this same store wrote at inbound-webhook time, keyed by
  // the object key persisted on the meal_content trigger's payload.
  getObject(key: string): Promise<StoredObject>;
}

export interface S3ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

// S3-compatible per 04 §1 — this same client works against MinIO (local dev) or a
// real S3-compatible bucket in staging/production by swapping the endpoint.
export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async putObject(buffer, contentType) {
      const key = `meal-photos/${randomUUID()}`;
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
      return key;
    },
    async getObject(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const bytes = (await result.Body?.transformToByteArray()) ?? new Uint8Array();
      return { bytes, contentType: result.ContentType ?? 'application/octet-stream' };
    },
  };
}
