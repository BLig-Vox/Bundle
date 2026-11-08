/** A deliberately public message. Never include request data or private diagnostics. */
export class HttpError extends Error {
  constructor(readonly status: 400 | 413 | 415, safeMessage: string) {
    super(safeMessage);
    this.name = "HttpError";
  }
}
