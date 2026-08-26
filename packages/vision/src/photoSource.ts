export interface Photo {
  bytes: Uint8Array;
  contentType: string;
}

// Deliberately just a function type, not a full object store client — keeps
// `packages/vision` decoupled from `apps/api`'s S3 client per 04 §2's
// package-boundary intent (08 §C step 8). The real implementation (reading
// from S3/MinIO by the key the inbound webhook already persisted) lives in
// the caller that wires this package up, not here.
export type FetchByKey = (photoKey: string) => Promise<Photo>;
