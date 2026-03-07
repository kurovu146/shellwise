import { getDb } from "../db/connection";
import { getTotalCommandCount, getUniqueCommandCount } from "../db/queries";
import { color } from "../tui/theme";

export function runStats(): void {
  const total = getTotalCommandCount();
  const unique = getUniqueCommandCount();

  const db = getDb();
  const top = db
    .query<{ command: string; frequency: number }, []>(
      "SELECT command, frequency FROM command_stats ORDER BY frequency DESC LIMIT 10"
    )
    .all();

  const oldest = db
    .query<{ created_at: number }, []>(
      "SELECT MIN(created_at) as created_at FROM commands"
    )
    .get();

  console.log(`${color.bold}shellwise stats${color.reset}`);
  console.log(`${color.dim}─────────────────────────${color.reset}`);
  console.log(`Total executions:  ${color.cyan}${total}${color.reset}`);
  console.log(`Unique commands:   ${color.cyan}${unique}${color.reset}`);

  if (oldest?.created_at) {
    const date = new Date(oldest.created_at).toLocaleDateString();
    console.log(`History since:     ${color.cyan}${date}${color.reset}`);
  }

  if (top.length > 0) {
    console.log(`\n${color.bold}Top commands${color.reset}`);
    console.log(`${color.dim}─────────────────────────${color.reset}`);
    for (let i = 0; i < top.length; i++) {
      const num = String(i + 1).padStart(2);
      console.log(
        `${color.dim}${num}.${color.reset} ${top[i].command} ${color.dim}(${top[i].frequency}x)${color.reset}`
      );
    }
  }
}
