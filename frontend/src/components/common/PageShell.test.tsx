/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageShell } from "./PageShell";

describe("PageShell", () => {
  it("renders title and children", () => {
    render(
      <PageShell title="Test Title">
        <div data-testid="content">Hello</div>
      </PageShell>
    );
    expect(screen.getByText("Test Title")).toBeInTheDocument();
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    render(<PageShell title="Title" subtitle="Sub Title" />);
    expect(screen.getByText("Sub Title")).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(
      <PageShell title="Title" icon={<span data-testid="icon">🔧</span>}>
        <div />
      </PageShell>
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <PageShell title="Title" actions={<button>Action</button>}>
        <div />
      </PageShell>
    );
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });

  it("shows loading spinner when loading is true", () => {
    render(
      <PageShell title="Title" loading>
        <div data-testid="content">Content</div>
      </PageShell>
    );
    expect(screen.getByText("加载中...")).toBeInTheDocument();
    expect(screen.queryByTestId("content")).not.toBeInTheDocument();
  });

  it("does not show subtitle wrapper when subtitle is omitted", () => {
    const { container } = render(<PageShell title="Title" />);
    expect(container.querySelector("p")).not.toBeInTheDocument();
  });
});
