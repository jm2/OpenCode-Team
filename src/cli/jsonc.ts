/**
 * Minimal JSONC reader for opencode.json.
 *
 * Strips // and /* *\/ comments and trailing commas, but only OUTSIDE string
 * literals. The regexes this replaces could not tell the difference, so they
 * damaged ordinary values:
 *
 *   "file:///Users/me/plugin.js"   -> truncated, parse fails
 *   "https://gw.example//v1"       -> truncated, parse fails
 *   "a // b"                       -> truncated, parse fails
 *   "src/**\/*.ts"                  -> silently rewritten to "src*.ts"
 *
 * The last one is the dangerous kind: the file still parsed, and the installer
 * wrote the altered permission rule back to disk.
 */

export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    // String literal: copy verbatim, honouring escapes.
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        const c = text[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    // Line comment.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }

    // Block comment. An unterminated one runs to the end, as in JSONC.
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Trailing comma: drop it when the next significant token, skipping
    // whitespace and comments, closes an object or array.
    if (ch === ",") {
      let k = i + 1;
      for (;;) {
        while (k < n && /\s/.test(text[k]!)) k += 1;
        if (text[k] === "/" && text[k + 1] === "/") {
          while (k < n && text[k] !== "\n") k += 1;
          continue;
        }
        if (text[k] === "/" && text[k + 1] === "*") {
          const end = text.indexOf("*/", k + 2);
          k = end === -1 ? n : end + 2;
          continue;
        }
        break;
      }
      if (text[k] === "}" || text[k] === "]") {
        i += 1;
        continue;
      }
    }

    out += ch;
    i += 1;
  }
  return out;
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}
