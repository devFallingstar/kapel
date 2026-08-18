const REGEXP_SPECIAL = new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
]);

/**
 * Translates a minimal glob syntax (`*`, `**`, `?`) into a RegExp that matches a forward-slash
 * separated relative path in full. `**` matches across directory boundaries (including zero
 * directories); `*` matches within a single path segment; `?` matches a single non-separator
 * character. Used as a fallback path matcher when `fs.promises.glob` is unavailable, and to
 * filter grep results by filename glob.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (REGEXP_SPECIAL.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
