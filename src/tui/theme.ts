const ESC = "\x1b[";

export const color = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,

  // Foreground
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,

  // Background
  bgBlack: `${ESC}40m`,
  bgBlue: `${ESC}44m`,
  bgCyan: `${ESC}46m`,
  bgWhite: `${ESC}47m`,
  bgGray: `${ESC}100m`,
} as const;

export const icon = {
  prompt: ">",
  selected: ">",
  dot: "·",
} as const;
