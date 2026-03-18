import { CronExpressionParser } from "cron-parser";

export function getNextRunAt(expression: string, currentDate = new Date()): string {
  return CronExpressionParser.parse(expression, { currentDate }).next().toISOString();
}

export function isTaskDue(nextRunAt?: string, now = new Date()): boolean {
  if (!nextRunAt) {
    return true;
  }

  return new Date(nextRunAt).getTime() <= now.getTime();
}
