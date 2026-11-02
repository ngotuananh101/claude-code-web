/**
 * Daily rotating file logger for runner daemon output.
 *
 * Automatically records all daemon stdout and stderr into a date-stamped file
 * (`logs/runner-YYYY-MM-DD.log`), rotates at midnight, and purges older logs
 * to prevent disk bloat.
 */

import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export type RotatingLoggerOptions = {
  /** Directory where log files are stored. Created recursively if missing. */
  logDir: string;
  /** Maximum days of historical logs to keep before purging. Defaults to 14 days. */
  maxDays?: number;
  /** File prefix for daily logs. Defaults to "runner-". */
  filePrefix?: string;
  /** Whether to mirror output to the original console streams. Defaults to true. */
  teeToConsole?: boolean;
  /** Custom time provider for testing date transitions. */
  now?: () => Date;
};

/** Formats a Date object into a local date string "YYYY-MM-DD". */
export function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class DailyRotatingLogger {
  readonly logDir: string;
  readonly maxDays: number;
  readonly filePrefix: string;
  readonly teeToConsole: boolean;
  private readonly now: () => Date;

  private currentFd: number | null = null;
  private currentDateStr: string | null = null;
  private origStdoutWrite: typeof process.stdout.write | null = null;
  private origStderrWrite: typeof process.stderr.write | null = null;

  constructor(opts: RotatingLoggerOptions) {
    this.logDir = opts.logDir;
    this.maxDays = opts.maxDays ?? 14;
    this.filePrefix = opts.filePrefix ?? "runner-";
    this.teeToConsole = opts.teeToConsole ?? true;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Installs interception hooks on process.stdout and process.stderr so all
   * console and stream output is appended to the current day's log file.
   */
  install(): void {
    if (this.origStdoutWrite !== null) {
      return;
    }

    this.ensureCurrentDayFile();

    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    this.origStdoutWrite = origStdout;
    this.origStderrWrite = origStderr;

    process.stdout.write = (chunk: unknown, ...args: unknown[]) => {
      this.write(chunk);
      if (this.teeToConsole) {
        // @ts-expect-error Node/Bun write stream signature compatibility
        return origStdout(chunk, ...args);
      }
      return true;
    };

    process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
      this.write(chunk);
      if (this.teeToConsole) {
        // @ts-expect-error Node/Bun write stream signature compatibility
        return origStderr(chunk, ...args);
      }
      return true;
    };
  }

  /** Restores standard streams and closes the active log file handle. */
  uninstall(): void {
    if (this.origStdoutWrite !== null) {
      process.stdout.write = this.origStdoutWrite;
      this.origStdoutWrite = null;
    }
    if (this.origStderrWrite !== null) {
      process.stderr.write = this.origStderrWrite;
      this.origStderrWrite = null;
    }
    if (this.currentFd !== null) {
      try {
        closeSync(this.currentFd);
      } catch {}
      this.currentFd = null;
      this.currentDateStr = null;
    }
  }

  /** Writes a chunk synchronously to the active daily log file. */
  write(chunk: unknown): void {
    this.ensureCurrentDayFile();
    if (this.currentFd !== null) {
      try {
        if (typeof chunk === "string") {
          writeSync(this.currentFd, chunk);
        } else if (Buffer.isBuffer(chunk)) {
          writeSync(this.currentFd, chunk);
        } else {
          writeSync(this.currentFd, String(chunk));
        }
      } catch {}
    }
  }

  /** Returns the full path of the current day's log file. */
  getActiveLogPath(): string {
    const dateStr = formatLocalDate(this.now());
    return join(this.logDir, `${this.filePrefix}${dateStr}.log`);
  }

  /**
   * Ensures the file descriptor points to today's file, rotating if the date
   * changed across midnight, and cleans up old historical log files.
   */
  private ensureCurrentDayFile(): void {
    const now = this.now();
    const dateStr = formatLocalDate(now);

    if (this.currentDateStr === dateStr && this.currentFd !== null) {
      return;
    }

    if (this.currentFd !== null) {
      try {
        closeSync(this.currentFd);
      } catch {}
      this.currentFd = null;
    }

    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch {}

    const filename = `${this.filePrefix}${dateStr}.log`;
    const filePath = join(this.logDir, filename);

    try {
      this.currentFd = openSync(filePath, "a");
      this.currentDateStr = dateStr;
    } catch (err) {
      console.warn(`warning: could not open log file ${filePath}: ${err}`);
    }

    try {
      this.cleanOldLogs();
    } catch {}
  }

  /**
   * Scans logDir and removes date-stamped log files older than maxDays.
   * Returns the list of removed filenames.
   */
  cleanOldLogs(): string[] {
    const removed: string[] = [];
    try {
      const files = readdirSync(this.logDir);
      const prefixEscaped = this.filePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`^${prefixEscaped}(\\d{4}-\\d{2}-\\d{2})\\.log$`);

      const now = this.now();
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      for (const file of files) {
        const match = file.match(regex);
        if (!match) continue;
        const fileDateStr = match[1]!;
        const [yStr, mStr, dStr] = fileDateStr.split("-");
        if (!yStr || !mStr || !dStr) continue;

        const fileDate = new Date(Number(yStr), Number(mStr) - 1, Number(dStr)).getTime();
        if (Number.isNaN(fileDate)) continue;

        const ageInDays = Math.floor((todayMidnight - fileDate) / (24 * 60 * 60 * 1000));
        if (ageInDays > this.maxDays) {
          try {
            unlinkSync(join(this.logDir, file));
            removed.push(file);
          } catch {}
        }
      }
    } catch {}
    return removed;
  }
}
