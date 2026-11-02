import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyRotatingLogger, formatLocalDate } from "./rotating-logger.ts";

describe("formatLocalDate", () => {
  test("formats year, month, and day with leading zeroes", () => {
    const d = new Date(2026, 10, 2); // November is month 10 (0-indexed)
    expect(formatLocalDate(d)).toBe("2026-11-02");
  });

  test("formats single-digit day and month correctly", () => {
    const d = new Date(2026, 0, 5); // January 5
    expect(formatLocalDate(d)).toBe("2026-01-05");
  });
});

describe("DailyRotatingLogger", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `test-rotating-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test("creates logs directory and writes to current day log file", () => {
    const logsDir = join(testDir, "logs");
    const fakeNow = new Date(2026, 10, 2, 10, 0, 0); // 2026-11-02
    const logger = new DailyRotatingLogger({
      logDir: logsDir,
      now: () => fakeNow,
      teeToConsole: false,
    });

    logger.write("first log line\n");
    logger.write("second log line\n");

    const expectedFile = join(logsDir, "runner-2026-11-02.log");
    expect(existsSync(expectedFile)).toBe(true);
    expect(readFileSync(expectedFile, "utf8")).toBe("first log line\nsecond log line\n");

    logger.uninstall();
  });

  test("rotates to a new file when the date advances", () => {
    const logsDir = join(testDir, "logs");
    let currentFakeTime = new Date(2026, 10, 2, 23, 59, 50); // 2026-11-02
    const logger = new DailyRotatingLogger({
      logDir: logsDir,
      now: () => currentFakeTime,
      teeToConsole: false,
    });

    logger.write("day 1 entry\n");
    const day1File = join(logsDir, "runner-2026-11-02.log");
    expect(existsSync(day1File)).toBe(true);
    expect(readFileSync(day1File, "utf8")).toBe("day 1 entry\n");

    // Advance date to next day
    currentFakeTime = new Date(2026, 10, 3, 0, 0, 10); // 2026-11-03
    logger.write("day 2 entry\n");

    const day2File = join(logsDir, "runner-2026-11-03.log");
    expect(existsSync(day2File)).toBe(true);
    expect(readFileSync(day2File, "utf8")).toBe("day 2 entry\n");
    // Day 1 file remains untouched
    expect(readFileSync(day1File, "utf8")).toBe("day 1 entry\n");

    logger.uninstall();
  });

  test("cleans up log files older than maxDays", () => {
    const logsDir = join(testDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // Create simulated historical log files
    writeFileSync(join(logsDir, "runner-2026-10-01.log"), "ancient log"); // > 30 days old
    writeFileSync(join(logsDir, "runner-2026-10-20.log"), "old log"); // ~13 days before 2026-11-02
    writeFileSync(join(logsDir, "runner-2026-11-01.log"), "yesterday log"); // 1 day before
    writeFileSync(join(logsDir, "other-file.txt"), "keep me"); // unrelated file

    const fakeNow = new Date(2026, 10, 2, 12, 0, 0); // 2026-11-02
    const logger = new DailyRotatingLogger({
      logDir: logsDir,
      maxDays: 7, // keep 7 days
      now: () => fakeNow,
      teeToConsole: false,
    });

    const deleted = logger.cleanOldLogs();
    expect(deleted).toContain("runner-2026-10-01.log");
    expect(deleted).toContain("runner-2026-10-20.log");
    expect(deleted).not.toContain("runner-2026-11-01.log");

    expect(existsSync(join(logsDir, "runner-2026-10-01.log"))).toBe(false);
    expect(existsSync(join(logsDir, "runner-2026-10-20.log"))).toBe(false);
    expect(existsSync(join(logsDir, "runner-2026-11-01.log"))).toBe(true);
    expect(existsSync(join(logsDir, "other-file.txt"))).toBe(true);

    logger.uninstall();
  });

  test("intercepts process.stdout.write and process.stderr.write when installed", () => {
    const logsDir = join(testDir, "logs");
    const fakeNow = new Date(2026, 10, 2, 12, 0, 0);
    const logger = new DailyRotatingLogger({
      logDir: logsDir,
      now: () => fakeNow,
      teeToConsole: false,
    });

    logger.install();
    process.stdout.write("stdout message\n");
    process.stderr.write("stderr message\n");
    logger.uninstall();

    const expectedFile = join(logsDir, "runner-2026-11-02.log");
    expect(existsSync(expectedFile)).toBe(true);
    expect(readFileSync(expectedFile, "utf8")).toBe("stdout message\nstderr message\n");
  });
});
