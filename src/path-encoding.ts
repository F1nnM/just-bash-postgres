const SPECIAL_ENCODINGS: Record<string, string> = {
  ".": "__dot__",
  " ": "__sp__",
};

const DECODE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIAL_ENCODINGS).map(([k, v]) => [v, k])
);

export function encodeLabel(name: string): string {
  if (name.length === 0) throw new Error("Cannot encode empty filename");
  let result = "";
  for (const char of name) {
    if (char === "\0") throw new Error("Filenames cannot contain null bytes");
    if (SPECIAL_ENCODINGS[char]) {
      result += SPECIAL_ENCODINGS[char];
    } else if (char === "_") {
      // Encode underscores to prevent collisions with __XX__ escape sequences
      result += "__5F__";
    } else if (/[A-Za-z0-9-]/.test(char)) {
      result += char;
    } else {
      const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0");
      result += `__${hex}__`;
    }
  }
  return result;
}

export function decodeLabel(label: string): string {
  return label.replace(/__([A-Za-z0-9]+)__/g, (match, code) => {
    if (DECODE_MAP[match]) return DECODE_MAP[match];
    const charCode = parseInt(code, 16);
    if (!isNaN(charCode) && charCode > 0) return String.fromCodePoint(charCode);
    return match;
  });
}

export function normalizePath(p: string): string {
  if (p.includes("\0")) throw new Error("Paths cannot contain null bytes");
  const parts = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { resolved.pop(); continue; }
    resolved.push(part);
  }
  return "/" + resolved.join("/");
}

export function pathToLtree(posixPath: string, sessionId: number): string {
  const normalized = normalizePath(posixPath);
  const segments = normalized.split("/").filter(Boolean);
  const prefix = `s${sessionId}`;
  if (segments.length === 0) return prefix;
  return prefix + "." + segments.map(encodeLabel).join(".");
}

export function ltreeToPath(ltree: string): string {
  const parts = ltree.split(".");
  // First part is the session prefix (s42), skip it
  const segments = parts.slice(1);
  if (segments.length === 0) return "/";
  return "/" + segments.map(decodeLabel).join("/");
}
