import { formatLogLine, formatLogs } from './logFormat';

// Strip ANSI colours so the assertions read like the screen.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatLogLine', () => {
  it('formats PostgreSQL records with user, database and extras', () => {
    const line = JSON.stringify({
      level: 'info',
      ts: '2026-10-07T09:00:00.123456789Z',
      logger: 'postgres',
      msg: 'record',
      logging_pod: 'orders-db-1',
      record: {
        error_severity: 'ERROR',
        user_name: 'app',
        database_name: 'app',
        message: 'relation "x" does not exist',
        query: 'select * from x',
      },
    });
    expect(plain(formatLogLine(line))).toBe(
      '2026-10-07 09:00:00.123 ERROR   postgres app@app relation "x" does not exist | query: select * from x',
    );
    expect(formatLogLine(line)).toContain('\x1b[31m');
  });

  it('keeps the extra fields of instance manager lines', () => {
    const line = JSON.stringify({
      level: 'info',
      ts: '2026-10-07T09:00:00Z',
      logger: 'wal-archive',
      msg: 'Archived WAL file',
      logging_pod: 'orders-db-1',
      walName: '000000010000000000000003',
    });
    expect(plain(formatLogLine(line))).toBe(
      '2026-10-07 09:00:00Z INFO    wal-archive Archived WAL file walName=000000010000000000000003',
    );
  });

  it('accepts epoch timestamps', () => {
    const line = JSON.stringify({ level: 'info', ts: 1791363600, msg: 'hi' });
    expect(plain(formatLogLine(line))).toMatch(/^2026-\d\d-\d\d \d\d:\d\d:00\.000 INFO/);
  });

  it('passes non-JSON lines through', () => {
    expect(formatLogLine('plain text')).toBe('plain text');
    expect(formatLogLine('{not json')).toBe('{not json');
    expect(formatLogs('a\n\nb')).toBe('a\n\nb');
  });
});
