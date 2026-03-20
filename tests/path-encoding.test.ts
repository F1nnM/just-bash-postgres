import { describe, test, expect } from "bun:test";
import { encodeLabel, decodeLabel, pathToLtree, ltreeToPath, normalizePath } from "../src/path-encoding";

describe("encodeLabel", () => {
  test("passes through alphanumeric", () => {
    expect(encodeLabel("hello")).toBe("hello");
  });

  test("passes through hyphens", () => {
    expect(encodeLabel("my-file")).toBe("my-file");
  });

  test("encodes underscores", () => {
    expect(encodeLabel("my_file")).toBe("my__5F__file");
  });

  test("encodes dots", () => {
    expect(encodeLabel("readme.md")).toBe("readme__dot__md");
  });

  test("encodes spaces", () => {
    expect(encodeLabel("my file")).toBe("my__sp__file");
  });

  test("encodes multiple special chars", () => {
    expect(encodeLabel("my file.txt")).toBe("my__sp__file__dot__txt");
  });

  test("encodes other special characters as hex", () => {
    expect(encodeLabel("file@name")).toBe("file__40__name");
  });

  test("encodes hash", () => {
    expect(encodeLabel("file#1")).toBe("file__23__1");
  });

  test("throws on empty string", () => {
    expect(() => encodeLabel("")).toThrow("Cannot encode empty filename");
  });

  test("throws on null byte", () => {
    expect(() => encodeLabel("file\0name")).toThrow("null bytes");
  });

  test("no collision between literal __dot__ and encoded dot", () => {
    const dotEncoded = encodeLabel(".");
    const literalEncoded = encodeLabel("__dot__");
    expect(dotEncoded).not.toBe(literalEncoded);
    expect(decodeLabel(dotEncoded)).toBe(".");
    expect(decodeLabel(literalEncoded)).toBe("__dot__");
  });
});

describe("decodeLabel", () => {
  test("passes through alphanumeric", () => {
    expect(decodeLabel("hello")).toBe("hello");
  });

  test("decodes dots", () => {
    expect(decodeLabel("readme__dot__md")).toBe("readme.md");
  });

  test("decodes spaces", () => {
    expect(decodeLabel("my__sp__file")).toBe("my file");
  });

  test("decodes hex", () => {
    expect(decodeLabel("file__40__name")).toBe("file@name");
  });

  test("decodes underscores", () => {
    expect(decodeLabel("my__5F__file")).toBe("my_file");
  });

  test("roundtrips complex names", () => {
    const names = ["hello.world.txt", "my file (1).md", "résumé.pdf", "a+b=c.js", "under_score"];
    for (const name of names) {
      expect(decodeLabel(encodeLabel(name))).toBe(name);
    }
  });

  test("roundtrips emoji and non-BMP unicode", () => {
    const names = ["\u{1F4C1}folder", "file\u{1F600}.txt", "\u{1F4DD}notes"];
    for (const name of names) {
      expect(decodeLabel(encodeLabel(name))).toBe(name);
    }
  });
});

describe("normalizePath", () => {
  test("resolves .. segments", () => {
    expect(normalizePath("/home/user/../other")).toBe("/home/other");
  });

  test("resolves . segments", () => {
    expect(normalizePath("/home/./file")).toBe("/home/file");
  });

  test("normalizes double slashes", () => {
    expect(normalizePath("/home//docs")).toBe("/home/docs");
  });

  test("resolves root", () => {
    expect(normalizePath("/")).toBe("/");
  });

  test("throws on null byte", () => {
    expect(() => normalizePath("/foo\0bar")).toThrow("null bytes");
  });
});

describe("pathToLtree", () => {
  test("converts root path", () => {
    expect(pathToLtree("/", 42)).toBe("s42");
  });

  test("converts simple path", () => {
    expect(pathToLtree("/home", 42)).toBe("s42.home");
  });

  test("converts nested path", () => {
    expect(pathToLtree("/home/docs/readme.md", 42)).toBe("s42.home.docs.readme__dot__md");
  });

  test("handles trailing slash", () => {
    expect(pathToLtree("/home/docs/", 42)).toBe("s42.home.docs");
  });

  test("normalizes double slashes", () => {
    expect(pathToLtree("/home//docs", 42)).toBe("s42.home.docs");
  });

  test("normalizes .. components", () => {
    expect(pathToLtree("/home/../etc", 42)).toBe("s42.etc");
  });
});

describe("ltreeToPath", () => {
  test("converts root", () => {
    expect(ltreeToPath("s42")).toBe("/");
  });

  test("converts simple path", () => {
    expect(ltreeToPath("s42.home")).toBe("/home");
  });

  test("converts nested path with encoded chars", () => {
    expect(ltreeToPath("s42.home.docs.readme__dot__md")).toBe("/home/docs/readme.md");
  });

  test("roundtrips paths", () => {
    const paths = ["/", "/home", "/home/docs/readme.md", "/tmp/my file.txt"];
    for (const p of paths) {
      expect(ltreeToPath(pathToLtree(p, 7))).toBe(p);
    }
  });
});
