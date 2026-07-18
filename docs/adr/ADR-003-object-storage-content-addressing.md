# ADR-003 — Object storage and content addressing

Use an S3-compatible adapter: filesystem/MinIO in development and managed object storage in preview/production. SHA-256 is streamed during multipart upload; the canonical key is scoped by content digest, while workspace references retain independent rights.

Masters and derivatives use separate immutable prefixes. Short-lived signed URLs are issued only after authorization; lifecycle rules move cold masters without changing identity. Completion verifies part hashes, size and final checksum. Dedupe may reuse bytes globally but never rights, metadata or access across workspaces.
