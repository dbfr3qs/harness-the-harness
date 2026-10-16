export interface MenuItem<T> {
  label: string;
  value: T;
  hint?: string; // shown dimmed after the label
  disabled?: string; // reason it can't be chosen; the cursor skips it
}

export interface MenuState {
  index: number;
  done?: "select" | "cancel";
}

// What the keypress handler needs from Node's keypress events.
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

/** Moves the cursor or finishes, skipping disabled items. Pure, so it can be tested without a terminal. */
export function menuKey<T>(items: MenuItem<T>[], state: MenuState, key: Key): MenuState {
  const step = (dir: 1 | -1): MenuState => {
    for (let i = 1; i <= items.length; i++) {
      const next = (state.index + dir * i + items.length) % items.length;
      if (!items[next]!.disabled) return { index: next };
    }
    return state;
  };
  if (key.ctrl && (key.name === "c" || key.name === "d")) return { ...state, done: "cancel" };
  switch (key.name) {
    case "up":
    case "k":
      return step(-1);
    case "down":
    case "j":
    case "tab":
      return step(1);
    case "return":
    case "enter":
      return items[state.index]?.disabled ? state : { ...state, done: "select" };
    case "escape":
    case "q":
      return { ...state, done: "cancel" };
  }
  // 1-9 picks an item directly.
  const n = Number(key.sequence);
  if (Number.isInteger(n) && n >= 1 && n <= items.length && !items[n - 1]!.disabled) return { index: n - 1, done: "select" };
  return state;
}

const DIM = "\x1b[2m";
const BOLD_CYAN = "\x1b[1;36m";
const RESET = "\x1b[0m";

/** The menu as lines of text; `color` adds highlighting for a terminal. */
export function renderMenu<T>(title: string, items: MenuItem<T>[], index: number, color = true): string[] {
  const width = Math.max(...items.map((i) => i.label.length));
  const lines = [`${title} ${color ? DIM : ""}(↑/↓ or 1-${items.length}, Enter to choose, Esc to cancel)${color ? RESET : ""}`];
  items.forEach((item, i) => {
    const pointer = i === index ? "❯" : " ";
    const note = item.disabled ?? item.hint ?? "";
    const label = `${i + 1}. ${item.label.padEnd(width)}`;
    if (!color) {
      lines.push(`${pointer} ${label}${note ? `  ${note}` : ""}`);
    } else if (item.disabled) {
      lines.push(`${DIM}${pointer} ${label}  ${note}${RESET}`);
    } else {
      const body = i === index ? `${BOLD_CYAN}${label}${RESET}` : label;
      lines.push(`${i === index ? BOLD_CYAN : ""}${pointer}${RESET} ${body}${note ? `  ${DIM}${note}${RESET}` : ""}`);
    }
  });
  return lines;
}

/**
 * Shows an arrow-key menu on a TTY and resolves with the chosen value, or undefined if cancelled.
 * readline already has `input` in raw mode with keypress events; its own keypress listeners are
 * set aside while the menu is open so keys don't land in the prompt line, then put back.
 */
export function selectFromMenu<T>(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  title: string,
  items: MenuItem<T>[],
  initial: number,
): Promise<T | undefined> {
  const first = items[initial] && !items[initial].disabled ? initial : items.findIndex((i) => !i.disabled);
  if (first < 0) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let state: MenuState = { index: first };
    let drawn = 0;
    const draw = () => {
      const lines = renderMenu(title, items, state.index);
      // Move back to the menu's first line and redraw it in place.
      const up = drawn > 0 ? `\x1b[${drawn}F` : "\r";
      output.write(`${up}\x1b[J${lines.join("\n")}\n`);
      drawn = lines.length;
    };

    const saved = input.listeners("keypress") as ((...args: unknown[]) => void)[];
    input.removeAllListeners("keypress");
    const onKey = (_s: string | undefined, key: Key | undefined) => {
      state = menuKey(items, state, key ?? {});
      if (!state.done) return draw();
      input.off("keypress", onKey);
      for (const l of saved) input.on("keypress", l);
      output.write(`\x1b[${drawn}F\x1b[J\x1b[?25h`); // clear the menu, show the cursor
      resolve(state.done === "select" ? items[state.index]!.value : undefined);
    };
    input.on("keypress", onKey);
    output.write("\x1b[?25l"); // hide the cursor while the menu is up
    draw();
  });
}
