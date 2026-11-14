import { it, expect } from "vitest";
import { renderPageMarkdown } from "../src/index";

it("does not repeat a leading H1 that equals the title, keeps a different one", () => {
  const ref = { path: "/q", title: "Quickstart", summary: "Five minutes." };
  expect(renderPageMarkdown({ ref, body: "\n# Quickstart\n\nStep one.\n" } as never)).toBe("# Quickstart\n> Five minutes.\n\nStep one.\n");
  expect(renderPageMarkdown({ ref, body: "# Getting going\n\nStep one." } as never)).toBe("# Quickstart\n> Five minutes.\n\n# Getting going\n\nStep one.\n");
});
