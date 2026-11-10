import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import hljs from "highlight.js/lib/common";
import { PreviewContent } from "@/components/pane/PreviewContent";
import "@/i18n";

afterEach(cleanup);

it("browse-08: external and relative markdown links cancel default app navigation", () => {
  const view = render(
    <PreviewContent
      name="R2.md"
      text="[outside](https://example.org/r2) [relative](sibling.md#next)"
      truncated={false}
    />,
  );
  const links = view.container.querySelectorAll("a");
  expect(links.length).toBe(2);
  const observations: boolean[] = [];
  const observe = (event: Event) => {
    observations.push(event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", observe);
  try {
    for (const link of links)
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
  } finally {
    document.removeEventListener("click", observe);
  }
  expect(links[1]?.getAttribute("href")).toBe("sibling.md#next");
  expect(observations).toEqual([true, true]);
});

it("browse-07: independently measure prose, CSV and markdown rendering", () => {
  const length = 256 * 1024;
  const fill = (line: string) =>
    line.repeat(Math.ceil(length / line.length)).slice(0, length);
  const prose = fill(
    "The review records every document and folder. A person opens a file, reads the notes, and continues with the next item.\n",
  );
  const csv = fill(
    "2026-11-08,customer-42,review complete,123.45,true,Seoul\n",
  );
  const results: Record<string, number> = {};
  for (const [name, text] of [
    ["prose.txt", prose],
    ["table.csv", csv],
  ]) {
    const start = performance.now();
    const result = hljs.highlightAuto(text!);
    results[`${name}:highlightAuto_ms`] = performance.now() - start;
    expect(result.value.length).toBeGreaterThan(0);
  }
  for (const [name, text] of [
    ["plain.md", prose],
    ["unlabelled.md", "```\n" + csv + "\n```"],
    ["csv-labelled.md", "```csv\n" + csv + "\n```"],
  ]) {
    const start = performance.now();
    const html = renderToStaticMarkup(
      <PreviewContent name={name!} text={text!} truncated={false} />,
    );
    results[`${name}:render_ms`] = performance.now() - start;
    expect(html.length).toBeGreaterThan(0);
  }
  console.info("browse-sol2-preview-performance", JSON.stringify(results));
}, 60_000);
