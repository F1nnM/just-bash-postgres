const SPECIAL_ENCODINGS: Record<string, string> = {
  ".": "__dot__",
  " ": "__sp__",
};

const DECODE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIAL_ENCODINGS).map(([k, v]) => [v, k])
);

export function encodeLabel(name: string): string {
  let result = "";
  for (const char of name) {
    if (SPECIAL_ENCODINGS[char]) {
      result += SPECIAL_ENCODINGS[char];
    } else if (/[A-Za-z0-9_-]/.test(char)) {
      result += char;
    } else {
      const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      result += `__${hex}__`;
    }
  }
  return result;
}

export function decodeLabel(label: string): string {
  return label.replace(/__([A-Za-z0-9]+)__/g, (match, code) => {
    if (DECODE_MAP[match]) return DECODE_MAP[match];
    // Hex-encoded character
    const charCode = parseInt(code, 16);
    if (!isNaN(charCode) && charCode > 0) return String.fromCharCode(charCode);
    return match; // shouldn't happen, return as-is
  });
}

export function pathToLtree(posixPath: string, userId: number): string {
  const segments = posixPath.split("/").filter(Boolean);
  const prefix = `u${userId}`;
  if (segments.length === 0) return prefix;
  return prefix + "." + segments.map(encodeLabel).join(".");
}

export function ltreeToPath(ltree: string): string {
  const parts = ltree.split(".");
  // First part is the user prefix (u42), skip it
  const segments = parts.slice(1);
  if (segments.length === 0) return "/";
  return "/" + segments.map(decodeLabel).join("/");
}
