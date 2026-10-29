import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditRecord } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  private readonly statements: {
    get: StatementSync;
    set: StatementSync;
    delete: StatementSync;
    list: StatementSync;
    audit: StatementSync;
  };
  private transactionDepth = 0;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0) > 1) {
      this.db.close();
      throw new Error(
        'Database schema is newer than this application. Restore a compatible build or backup.',
      );
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(namespace,key));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL,
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, detail TEXT);
      CREATE INDEX IF NOT EXISTS audit_guild_time ON audit(guild_id,created_at);
      CREATE TABLE IF NOT EXISTS confirmations(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,action TEXT NOT NULL,input TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,content TEXT NOT NULL,due_at INTEGER NOT NULL,interval_ms INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',last_error TEXT,nonce TEXT NOT NULL DEFAULT '',retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due_at);
      CREATE TABLE IF NOT EXISTS quota(scope TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,
        PRIMARY KEY(scope,day));
      PRAGMA user_version=1;`);
    this.statements = {
      get: this.db.prepare('SELECT value FROM kv WHERE namespace=? AND key=?'),
      set: this.db.prepare(
        'INSERT INTO kv VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      ),
      delete: this.db.prepare('DELETE FROM kv WHERE namespace=? AND key=?'),
      list: this.db.prepare('SELECT key,value FROM kv WHERE namespace=? AND substr(key,1,?)=? ORDER BY key'),
      audit: this.db.prepare(
        'INSERT INTO audit(created_at,guild_id,user_id,action,status,detail) VALUES(?,?,?,?,?,?)',
      ),
    };
  }
  get<T>(namespace: string, key: string): T | undefined {
    const row = this.statements.get.get(namespace, key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  set(namespace: string, key: string, value: unknown): void {
    const payload = JSON.stringify(value);
    if (payload === undefined) throw new TypeError('Cannot persist undefined');
    this.statements.set.run(namespace, key, payload, Date.now());
  }
  delete(namespace: string, key: string): boolean {
    return this.statements.delete.run(namespace, key).changes > 0;
  }
  list<T>(namespace: string, prefix = ''): { key: string; value: T }[] {
    // substr treats '%' and '_' literally; keys are never interpolated into SQL.
    return this.statements.list
      .all(namespace, prefix.length, prefix)
      .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as T }));
  }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === 'AsyncFunction') throw new TypeError('Transactions must be synchronous');
    if (this.transactionDepth > 0) {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new TypeError('Transactions must be synchronous');
      return result;
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new TypeError('Transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  audit(record: AuditRecord): void {
    this.statements.audit.run(
      Date.now(),
      record.guildId,
      record.userId,
      record.action,
      record.status,
      record.detail?.slice(0, 500) ?? null,
    );
  }
  prune(auditDays: number, memoryDays: number, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM audit WHERE created_at<?').run(now - auditDays * 86400000);
      this.db.prepare('DELETE FROM confirmations WHERE expires_at<?').run(now);
      this.db
        .prepare(
          "DELETE FROM kv WHERE namespace IN ('privacy.personal','media.search','ai.conversations','core.conversationActions') AND json_extract(value,'$.expiresAt')<=?",
        )
        .run(now);
      this.db
        .prepare(
          "DELETE FROM kv WHERE namespace IN ('ai.conversations','ai.documents','ai.epochs') AND updated_at<?",
        )
        .run(now - memoryDays * 86400000);
      this.db
        .prepare('DELETE FROM quota WHERE day<?')
        .run(new Date(now - 2 * 86400000).toISOString().slice(0, 10));
      this.db
        .prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND due_at<?")
        .run(now - 7 * 86400000);
    });
  }
  close(): void {
    this.db.close();
  }
}
