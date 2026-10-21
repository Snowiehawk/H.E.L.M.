import { describe, expect, it } from "vitest";
import { parseOutputLinks, validateLoopbackUrl } from "./links";

describe("loopback output link policy", () => {
  it("accepts exact local destinations and retains path/query/Unicode", () => {
    for (const url of [
      "http://localhost:3000/a?q=1#top",
      "https://127.0.0.1/Ω",
      "http://[::1]:8080/",
      "HTTP://LOCALHOST/",
    ])
      expect(validateLoopbackUrl(url).ok).toBe(true);
  });
  it("rejects disguised authorities, normalization tricks, credentials and protocols", () => {
    for (const url of [
      "http://localhost.evil/",
      "http://localhost./",
      "http://localhost@evil/",
      "http://evil@localhost/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://%6cocalhost/",
      "http://localhost:0/",
      "http://localhost:65536/",
      "file:///tmp/a",
      "javascript:alert(1)",
      "data:text/plain,a",
      "vscode://file/a",
      "http://localhost/\r\nx",
      "http://localhost/%0d%0A",
      "http://localhost\\@evil",
      " http://localhost/",
      "http://[::1]evil/",
      "http://[::ffff:127.0.0.1]/",
    ])
      expect(validateLoopbackUrl(url).ok, url).toBe(false);
  });
  it("shows actual OSC8 targets even when labels look safe", () => {
    const links = parseOutputLinks(
      "\u001b]8;;https://evil.example/\u001b\\http://localhost:3000\u001b]8;;\u001b\\\nVisit (http://localhost:4000/a).\n\u001b[32mhttp://[::1]:8080/\u001b[0m",
    );
    expect(links[0]).toMatchObject({
      label: "http://localhost:3000",
      target: "https://evil.example/",
      allowed: false,
    });
    expect(links).toContainEqual({
      label: "http://localhost:4000/a",
      target: "http://localhost:4000/a",
      allowed: true,
      reason: undefined,
    });
    expect(links.some((link) => link.target === "http://[::1]:8080/" && link.allowed)).toBe(true);
  });
  it("bounds output, destinations and result count", () => {
    expect(
      parseOutputLinks(
        Array.from({ length: 300 }, (_, index) => `http://localhost:${1000 + index}/`).join("\n"),
      ),
    ).toHaveLength(256);
    expect(validateLoopbackUrl("http://localhost/" + "a".repeat(4096)).ok).toBe(false);
  });
});
