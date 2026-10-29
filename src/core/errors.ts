export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
/** A remote mutation has a real receipt; interruption must never invite blindly repeating it. */
export class CompletedActionError extends UserError {
  readonly actions: readonly string[];
  constructor(actions: readonly string[]) {
    const completed = [...new Set(actions)];
    super(
      `Completed ${completed.join(', ')}. The response was interrupted or cancelled after completion; those changes were not repeated.`,
    );
    this.name = 'CompletedActionError';
    this.actions = Object.freeze(completed);
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
