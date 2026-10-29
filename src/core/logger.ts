const secretPattern =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|Bot\s+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,})/g;
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value.replace(secretPattern, '[REDACTED]');
  for (const secret of secrets) if (secret.length > 8) result = result.split(secret).join('[REDACTED]');
  return result;
}
export class Logger {
  constructor(private readonly secrets: readonly string[] = []) {}
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write('info', event, fields);
  }
  error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.write('error', event, {
      ...fields,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
  private write(level: string, event: string, fields: Record<string, unknown>): void {
    process.stdout.write(
      redact(
        JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
        this.secrets,
      ) + '\n',
    );
  }
}
