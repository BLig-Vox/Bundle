import { EntitySchema } from "@mikro-orm/core";

/** Storage row for the Bundle SQLite queue. Payloads are JSON, never executable source. */
export class BundleJob {
  id!: number;
  queue!: string;
  type!: string;
  payloadJson!: string;
  availableAt!: number;
  reservedAt!: number | null;
  reservationToken!: string | null;
  attempts!: number;
  maxAttempts!: number;
  failedAt!: number | null;
  failureCode!: string | null;
  createdAt!: number;
}

export default new EntitySchema<BundleJob>({
  class: BundleJob,
  tableName: "bundle_jobs",
  properties: {
    id: { type: "integer", primary: true },
    queue: { type: "string", fieldName: "queue_name", length: 64 },
    type: { type: "string", fieldName: "job_type", length: 128 },
    payloadJson: { type: "text", fieldName: "payload_json" },
    availableAt: { type: "integer", fieldName: "available_at" },
    reservedAt: { type: "integer", fieldName: "reserved_at", nullable: true },
    reservationToken: { type: "string", fieldName: "reservation_token", length: 43, nullable: true },
    attempts: { type: "integer" },
    maxAttempts: { type: "integer", fieldName: "max_attempts" },
    failedAt: { type: "integer", fieldName: "failed_at", nullable: true },
    failureCode: { type: "string", fieldName: "failure_code", length: 64, nullable: true },
    createdAt: { type: "integer", fieldName: "created_at" },
  },
  indexes: [{ name: "bundle_jobs_ready_idx", properties: ["queue", "failedAt", "availableAt", "reservedAt", "id"] }],
  checks: [
    { name: "bundle_jobs_queue_length", expression: "length(queue_name) between 1 and 64" },
    { name: "bundle_jobs_type_length", expression: "length(job_type) between 1 and 128" },
    { name: "bundle_jobs_payload_length", expression: "length(payload_json) <= 16384" },
    { name: "bundle_jobs_attempt_bounds", expression: "max_attempts between 1 and 20 and attempts between 0 and max_attempts" },
    { name: "bundle_jobs_lease_pair", expression: "(reserved_at is null and reservation_token is null) or (reserved_at is not null and reservation_token is not null)" },
    { name: "bundle_jobs_failure_pair", expression: "(failed_at is null and failure_code is null) or (failed_at is not null and failure_code in ('handler_failed', 'attempts_exhausted', 'unregistered_job', 'invalid_payload'))" },
    { name: "bundle_jobs_created_time", expression: "created_at between 0 and 9007199254740991" },
    { name: "bundle_jobs_available_time", expression: "available_at between 0 and 9007199254740991" },
    { name: "bundle_jobs_reserved_time", expression: "reserved_at is null or reserved_at between 0 and 9007199254740991" },
    { name: "bundle_jobs_failed_time", expression: "failed_at is null or failed_at between 0 and 9007199254740991" },
  ],
});
