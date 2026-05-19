import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import StreamingText from "./StreamingText";

describe("StreamingText", () => {
  it("renders plain text lines", () => {
    const { container } = render(<StreamingText content="Hello\nWorld" isDark={false} />);
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("World");
  });

  it("renders code block indicator", () => {
    render(<StreamingText content="```typescript" isDark={false} />);
    expect(screen.getByText("```typescript")).toBeInTheDocument();
  });

  it("renders inline code", () => {
    render(<StreamingText content="Use `console.log`" isDark={false} />);
    expect(screen.getByText("console.log")).toBeInTheDocument();
  });

  it("renders empty line as space", () => {
    const { container } = render(<StreamingText content="line1\n\nline2" isDark={false} />);
    expect(container.textContent).toContain("line1");
    expect(container.textContent).toContain("line2");
  });

  it("renders in dark mode", () => {
    render(<StreamingText content="```js" isDark={true} />);
    expect(screen.getByText("```js")).toBeInTheDocument();
  });
});
