/**
 * Typed error hierarchy for the event ledger.
 *
 * Doctrine: errors at production boundaries carry a `kind` discriminator
 * so the driver can route on them. Generic `Error` is forbidden in the
 * event-collector code path.
 */

/** Discriminated error kinds. Closed enum — adding a new kind is an
 *  intentional API change. */
export type EventLedgerErrorKind =
  | 'event-malformed'           // zod validation failed at ingest
  | 'chain-broken'              // chain integrity violated on read
  | 'sequence-conflict'         // monotonic_seq collision under contention
  | 'wal-corruption'            // WAL file unreadable / partial line
  | 'fsync-failed'              // OS rejected the durable write
  | 'io-error'                  // generic filesystem error (disk full, perms, etc.)
  | 'shutdown-in-progress'      // collector is draining; new writes refused
  | 'tenant-mismatch';          // event tenant_id doesn't match the run's tenant

export class EventLedgerError extends Error {
  readonly kind: EventLedgerErrorKind;
  /** Optional: the event_id this error pertains to. */
  readonly event_id?: string;
  /** Optional: arbitrary structured detail for forensics. */
  readonly details?: Record<string, unknown>;
  /** Whether the driver should retry this operation. */
  readonly retryable: boolean;

  constructor(opts: {
    kind: EventLedgerErrorKind;
    message: string;
    event_id?: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
    cause?: Error;
  }) {
    super(opts.message);
    this.name = 'EventLedgerError';
    this.kind = opts.kind;
    this.event_id = opts.event_id;
    this.details = opts.details;
    this.retryable = opts.retryable ?? defaultRetryable(opts.kind);
    if (opts.cause) {
      // Preserve the underlying error for forensic surfacing.
      (this as unknown as { cause: Error }).cause = opts.cause;
    }
  }

  /** Serializable form for the event payload when an error itself
   *  becomes a logged event. */
  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      event_id: this.event_id,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

function defaultRetryable(kind: EventLedgerErrorKind): boolean {
  switch (kind) {
    case 'io-error':
    case 'fsync-failed':
    case 'sequence-conflict':
      return true;
    case 'event-malformed':
    case 'chain-broken':
    case 'wal-corruption':
    case 'shutdown-in-progress':
    case 'tenant-mismatch':
      return false;
  }
}

/** Helper to wrap an arbitrary thrown value into an EventLedgerError. */
export function wrapError(kind: EventLedgerErrorKind, message: string, cause: unknown): EventLedgerError {
  if (cause instanceof EventLedgerError) return cause;
  const err = cause instanceof Error ? cause : new Error(String(cause));
  return new EventLedgerError({ kind, message, cause: err });
}
