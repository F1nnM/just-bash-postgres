import { describe, test, expect } from "bun:test";
import { encodeLabel, decodeLabel, pathToLtree, ltreeToPath } from "../src/path-encoding";

describe("encodeLabel", () => {
  test("passes through alphanumeric", () => {
    expect(encodeLabel("hello")).toBe("hello");
  });

  test("passes through hyphens and underscores", () => {
    expect(encodeLabel("my-file_name")).toBe("my-file_name");
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

  test("roundtrips complex names", () => {
    const names = ["hello.world.txt", "my file (1).md", "résumé.pdf", "a+b=c.js"];
    for (const name of names) {
      expect(decodeLabel(encodeLabel(name))).toBe(name);
    }
  });
});

describe("pathToLtree", () => {
  test("converts root path", () => {
    expect(pathToLtree("/", 42)).toBe("u42");
  });

  test("converts simple path", () => {
    expect(pathToLtree("/home", 42)).toBe("u42.home");
  });

  test("converts nested path", () => {
    expect(pathToLtree("/home/docs/readme.md", 42)).toBe("u42.home.docs.readme__dot__md");
  });

  test("handles trailing slash", () => {
    expect(pathToLtree("/home/docs/", 42)).toBe("u42.home.docs");
  });

  test("normalizes double slashes", () => {
    expect(pathToLtree("/home//docs", 42)).toBe("u42.home.docs");
  });
});

describe("ltreeToPath", () => {
  test("converts root", () => {
    expect(ltreeToPath("u42")).toBe("/");
  });

  test("converts simple path", () => {
    expect(ltreeToPath("u42.home")).toBe("/home");
  });

  test("converts nested path with encoded chars", () => {
    expect(ltreeToPath("u42.home.docs.readme__dot__md")).toBe("/home/docs/readme.md");
  });

  test("roundtrips paths", () => {
    const paths = ["/", "/home", "/home/docs/readme.md", "/tmp/my file.txt"];
    for (const p of paths) {
      expect(ltreeToPath(pathToLtree(p, 7))).toBe(p);
    }
  });
});
