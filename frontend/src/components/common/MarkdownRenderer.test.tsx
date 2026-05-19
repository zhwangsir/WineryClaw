import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";

vi.mock("../../hooks/useTheme", () => ({
  useIsDark: () => false,
}));

Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe("MarkdownRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders plain text", () => {
    render(<MarkdownRenderer content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders inline code", () => {
    render(<MarkdownRenderer content="Use `console.log` to debug" />);
    expect(screen.getByText("console.log")).toBeInTheDocument();
  });

  it("renders links with target=_blank", () => {
    render(<MarkdownRenderer content="[Link](https://example.com)" />);
    const link = screen.getByRole("link", { name: "Link" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders empty content gracefully", () => {
    const { container } = render(<MarkdownRenderer content="" />);
    expect(container.textContent).toBe("");
  });

  it("applies custom className", () => {
    const { container } = render(<MarkdownRenderer content="test" className="my-class" />);
    expect(container.querySelector(".my-class")).toBeInTheDocument();
  });

  it("renders headings", () => {
    render(<MarkdownRenderer content={"# H1\n\n## H2\n\n### H3"} />);
    expect(screen.getByText("H1")).toBeInTheDocument();
    expect(screen.getByText("H2")).toBeInTheDocument();
    expect(screen.getByText("H3")).toBeInTheDocument();
  });

  it("renders blockquote", () => {
    render(<MarkdownRenderer content="> quote" />);
    expect(screen.getByText("quote")).toBeInTheDocument();
  });

  it("renders unordered list", () => {
    render(<MarkdownRenderer content={"- a\n\n- b"} />);
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("renders ordered list", () => {
    render(<MarkdownRenderer content={"1. first\n\n2. second"} />);
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("renders table", () => {
    render(<MarkdownRenderer content={"| A | B |\n|---|---|\n| 1 | 2 |"} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders horizontal rule", () => {
    const { container } = render(<MarkdownRenderer content="---" />);
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("renders image", () => {
    render(<MarkdownRenderer content="![alt](https://example.com/img.png)" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://example.com/img.png");
    expect(img).toHaveAttribute("alt", "alt");
  });

  it("renders code block with copy button", async () => {
    const { container } = render(<MarkdownRenderer content={"```js\nconst x = 1;\n```"} />);
    expect(container.textContent).toContain("const x = 1;");
    const copyBtn = screen.getByRole("button");
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const x = 1;");
    });
  });

  it("renders code block without language", () => {
    render(<MarkdownRenderer content={"```\nplain\n```"} />);
    expect(screen.getByText("plain")).toBeInTheDocument();
  });

  it("renders paragraphs", () => {
    render(<MarkdownRenderer content={"para1\n\npara2"} />);
    expect(screen.getByText("para1")).toBeInTheDocument();
    expect(screen.getByText("para2")).toBeInTheDocument();
  });
});
