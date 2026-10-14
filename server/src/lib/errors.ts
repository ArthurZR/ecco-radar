/** Errors with an HTTP status and a message that is safe to show to the user. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);
