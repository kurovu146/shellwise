import { search, type ScoredResult } from "../search";
import { enableRawMode, disableRawMode, parseKeypress } from "../tui/input";
import {
  write,
  clearLine,
  moveCursorUp,
  moveCursorToColumn,
  hideCursor,
  showCursor,
  getTerminalSize,
  clearDown,
  closeTty,
} from "../tui/renderer";
import { renderSearchBox, getSearchBoxCursorCol } from "../tui/components/search-box";
import { renderResultList } from "../tui/components/result-list";
import { renderStatusBar } from "../tui/components/status-bar";

interface SearchState {
  query: string;
  cursorPos: number;
  results: ScoredResult[];
  selectedIndex: number;
  scrollOffset: number;
  renderedLines: number;
}

export async function runSearch(initialQuery: string = ""): Promise<void> {
  const cwd = process.env.PWD || process.cwd();

  const state: SearchState = {
    query: initialQuery,
    cursorPos: initialQuery.length,
    results: [],
    selectedIndex: 0,
    scrollOffset: 0,
    renderedLines: 0,
  };

  // Initial search
  state.results = search({ query: state.query, cwd });

  // Setup
  enableRawMode();
  write(hideCursor());

  const cleanup = () => {
    // Clear rendered UI
    if (state.renderedLines > 0) {
      write(moveCursorUp(state.renderedLines));
    }
    write(clearDown());
    write(showCursor());
    write(moveCursorToColumn(1));
    disableRawMode();
    closeTty();
  };

  // Handle unexpected exit
  const onExit = () => {
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  // Render initial frame
  render(state);

  // Input loop
  try {
    for await (const chunk of readStdin()) {
      const key = parseKeypress(chunk);

      if (key.type === "special" && key.key === "escape") {
        cleanup();
        // Output nothing = cancel
        return;
      }

      if (key.type === "ctrl" && key.char === "c") {
        cleanup();
        return;
      }

      if (key.type === "special" && key.key === "enter") {
        const selected = state.results[state.selectedIndex];
        cleanup();
        if (selected) {
          // Output to stdout for shell to capture
          process.stdout.write(selected.command);
        }
        return;
      }

      let needsSearch = false;

      if (key.type === "char") {
        state.query =
          state.query.slice(0, state.cursorPos) +
          key.char +
          state.query.slice(state.cursorPos);
        state.cursorPos += key.char.length;
        needsSearch = true;
      } else if (key.type === "special") {
        switch (key.key) {
          case "backspace":
            if (state.cursorPos > 0) {
              state.query =
                state.query.slice(0, state.cursorPos - 1) +
                state.query.slice(state.cursorPos);
              state.cursorPos--;
              needsSearch = true;
            }
            break;

          case "delete":
            if (state.cursorPos < state.query.length) {
              state.query =
                state.query.slice(0, state.cursorPos) +
                state.query.slice(state.cursorPos + 1);
              needsSearch = true;
            }
            break;

          case "left":
            if (state.cursorPos > 0) state.cursorPos--;
            break;

          case "right":
            if (state.cursorPos < state.query.length) state.cursorPos++;
            break;

          case "home":
            state.cursorPos = 0;
            break;

          case "end":
            state.cursorPos = state.query.length;
            break;

          case "tab":
          case "down":
            if (state.results.length > 0) {
              state.selectedIndex = (state.selectedIndex + 1) % state.results.length;
              adjustScroll(state);
            }
            break;

          case "shift-tab":
          case "up":
            if (state.results.length > 0) {
              state.selectedIndex =
                (state.selectedIndex - 1 + state.results.length) % state.results.length;
              adjustScroll(state);
            }
            break;
        }
      } else if (key.type === "ctrl") {
        switch (key.char) {
          case "a":
            state.cursorPos = 0;
            break;
          case "e":
            state.cursorPos = state.query.length;
            break;
          case "u":
            state.query = state.query.slice(state.cursorPos);
            state.cursorPos = 0;
            needsSearch = true;
            break;
          case "w": {
            // Delete word backward
            const before = state.query.slice(0, state.cursorPos);
            const trimmed = before.replace(/\S+\s*$/, "");
            state.query = trimmed + state.query.slice(state.cursorPos);
            state.cursorPos = trimmed.length;
            needsSearch = true;
            break;
          }
        }
      }

      if (needsSearch) {
        state.results = search({ query: state.query, cwd });
        state.selectedIndex = 0;
        state.scrollOffset = 0;
      }

      render(state);
    }
  } finally {
    cleanup();
  }
}

function getVisibleCount(): number {
  const { rows } = getTerminalSize();
  return Math.min(Math.max(rows - 4, 3), 15); // 3 minimum, 15 max
}

function adjustScroll(state: SearchState): void {
  const visibleCount = getVisibleCount();
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollOffset + visibleCount) {
    state.scrollOffset = state.selectedIndex - visibleCount + 1;
  }
}

function render(state: SearchState): void {
  const { cols } = getTerminalSize();
  const visibleCount = getVisibleCount();

  // Move up to clear previous render
  if (state.renderedLines > 0) {
    write(moveCursorUp(state.renderedLines));
  }

  const lines: string[] = [];

  // Search box
  lines.push(
    clearLine() +
      renderSearchBox({ query: state.query, cursorPos: state.cursorPos }, cols)
  );

  // Separator
  lines.push(clearLine() + `\x1b[90m${"─".repeat(cols)}\x1b[0m`);

  // Results
  const resultLines = renderResultList(
    {
      results: state.results,
      selectedIndex: state.selectedIndex,
      scrollOffset: state.scrollOffset,
      visibleCount,
    },
    cols
  );

  for (const line of resultLines) {
    lines.push(clearLine() + line);
  }

  // Pad remaining visible slots
  for (let i = resultLines.length; i < visibleCount; i++) {
    lines.push(clearLine());
  }

  // Separator + Status bar
  lines.push(clearLine() + `\x1b[90m${"─".repeat(cols)}\x1b[0m`);
  lines.push(clearLine() + renderStatusBar(state.results.length, cols));

  // Write all lines
  write(lines.join("\r\n") + "\r\n");

  // Track rendered lines for next clear
  state.renderedLines = lines.length;

  // Position cursor at search box
  write(moveCursorUp(lines.length));
  write(
    moveCursorToColumn(getSearchBoxCursorCol({ query: state.query, cursorPos: state.cursorPos }))
  );
  write(showCursor());
}

async function* readStdin(): AsyncGenerator<Buffer> {
  const stdin = process.stdin;
  stdin.resume();

  const buffers: Buffer[] = [];
  let resolve: (() => void) | null = null;

  stdin.on("data", (data: Buffer) => {
    buffers.push(data);
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  while (true) {
    if (buffers.length === 0) {
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
    while (buffers.length > 0) {
      yield buffers.shift()!;
    }
  }
}
