import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ObjectStore {
  putObject(buffer: Buffer, contentType: string): Promise<string>;
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
  };
}
