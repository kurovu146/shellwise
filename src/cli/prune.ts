import { pruneOlderThan } from "../db/queries";

export function runPrune(days: number): void {
  const deleted = pruneOlderThan(days);
  console.log(`Pruned ${deleted} entries older than ${days} days.`);
}
