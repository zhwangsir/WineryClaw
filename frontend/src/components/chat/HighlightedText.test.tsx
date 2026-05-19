/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import HighlightedText from "./HighlightedText";

describe("HighlightedText", () => {
  it("renders plain text when highlight is empty", () => {
    render(<HighlightedText text="Hello world" highlight="" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders plain text when highlight is whitespace", () => {
    render(<HighlightedText text="Hello world" highlight="   " />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("highlights matching text", () => {
    const { container } = render(<HighlightedText text="Hello world" highlight="world" />);
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(container.textContent).toContain("Hello world");
    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBe(1);
    expect(marks[0]).toHaveTextContent("world");
  });

  it("is case insensitive", () => {
    render(<HighlightedText text="Hello World" highlight="world" />);
    expect(screen.getByText("World")).toBeInTheDocument();
  });

  it("escapes special regex characters in highlight", () => {
    render(<HighlightedText text="price is $5.00" highlight="$5.00" />);
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });

  it("highlights multiple occurrences", () => {
    const { container } = render(<HighlightedText text="foo bar foo" highlight="foo" />);
    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBe(2);
  });
});
