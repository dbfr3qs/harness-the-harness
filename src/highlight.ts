// Lossless per-line syntax highlighter: only ever adds SGR codes around the
// original characters, so stripping ANSI from the result yields the input.

const BASE = "\x1b[33m";
const RESET = "\x1b[0m";
const STRING = "\x1b[32m";
const COMMENT = "\x1b[2m";
const KEYWORD = "\x1b[35m";

const ALIASES: Record<string, string> = { sh: "shell", bash: "shell", zsh: "shell", shell: "shell" };
const HASH_LANGS = new Set(["shell", "python", "py", "ruby", "rb", "yaml", "yml", "toml", "perl", "r"]);
const SLASH_LANGS = new Set(["js", "javascript", "ts", "typescript", "jsx", "tsx", "c", "cpp", "java", "go", "rust", "rs", "swift", "kotlin", "json", "cs", "php"]);

const KEYWORDS = new Set([
  "if", "else", "elif", "for", "while", "do", "done", "then", "fi", "case", "esac", "in", "return", "break", "continue",
  "function", "def", "class", "const", "let", "var", "import", "export", "from", "as", "new", "try", "catch", "finally",
  "throw", "async", "await", "fn", "pub", "struct", "enum", "interface", "type", "true", "false", "null", "None", "True",
  "False", "nil", "undefined", "package", "func", "match", "with", "yield", "lambda", "switch", "default",
]);

// Shell: words that start a command and are worth highlighting.
const SEPARATORS = new Set(["|", ";", "&", "(", "{"]);

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isSpace = (c: string | undefined): boolean => c === " " || c === "\t";

export function highlightCodeLine(line: string, lang?: string): string {
  const key = (lang ?? "").trim().toLowerCase();
  const kind = ALIASES[key] ?? key;
  const shell = kind === "shell";
  const hash = shell || HASH_LANGS.has(kind) || !SLASH_LANGS.has(kind);
  const slash = !shell && (SLASH_LANGS.has(kind) || !HASH_LANGS.has(kind));

  let out = "";
  const tok = (color: string, text: string): void => {
    out += color + text + RESET + BASE;
  };
  let cmdPos = true; // shell: next word is a command
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    const prev = line[i - 1];
    // Comments run to end of line.
    if ((hash && c === "#" && (i === 0 || isSpace(prev))) || (slash && c === "/" && line[i + 1] === "/")) {
      tok(COMMENT, line.slice(i));
      i = line.length;
      break;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, line.length);
      tok(STRING, line.slice(i, j));
      i = j;
      cmdPos = false;
      continue;
    }
    if (/[0-9]/.test(c) && !isWord(prev)) {
      const m = /^(0[xX][0-9a-fA-F]+|\d+(\.\d+)?)/.exec(line.slice(i))!;
      if (!isWord(line[i + m[0].length])) {
        tok(KEYWORD, m[0]);
        i += m[0].length;
        cmdPos = false;
        continue;
      }
    }
    if (isWord(c)) {
      let j = i;
      while (j < line.length && isWord(line[j])) j++;
      const word = line.slice(i, j);
      const dotted = prev === "." || prev === "$" || prev === "-";
      if (!dotted && (KEYWORDS.has(word) || (shell && cmdPos))) tok(KEYWORD, word);
      else out += word;
      if (shell) cmdPos = KEYWORDS.has(word) && /^(then|do|else|elif|if|while)$/.test(word);
      i = j;
      continue;
    }
    if (shell && c === "-" && (i === 0 || isSpace(prev)) && /[A-Za-z-]/.test(line[i + 1] ?? "")) {
      let j = i + 1;
      while (j < line.length && !isSpace(line[j]) && line[j] !== "=") j++;
      tok(KEYWORD, line.slice(i, j));
      i = j;
      continue;
    }
    if (shell && SEPARATORS.has(c)) cmdPos = true;
    out += c;
    i++;
  }
  if (out.endsWith(RESET + BASE)) out = out.slice(0, -(RESET + BASE).length);
  else if (out.endsWith(BASE)) out = out.slice(0, -BASE.length);
  return BASE + out + RESET;
}
