/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders description text", () => {
    render(<EmptyState description="No data here" />);
    expect(screen.getByText("No data here")).toBeInTheDocument();
  });

  it("renders default icon when no icon provided", () => {
    const { container } = render(<EmptyState description="Empty" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders custom icon when provided", () => {
    render(<EmptyState description="Empty" icon={<span data-testid="custom-icon">🎉</span>} />);
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });

  it("renders action button when actionLabel and onAction are provided", () => {
    const onAction = vi.fn();
    render(<EmptyState description="Empty" actionLabel="Create" onAction={onAction} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]).toHaveTextContent("Create");
  });

  it("calls onAction when action button is clicked", () => {
    const onAction = vi.fn();
    render(<EmptyState description="Empty" actionLabel="Create" onAction={onAction} />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("does not render action button when onAction is missing", () => {
    render(<EmptyState description="Empty" actionLabel="Create" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not render action button when actionLabel is missing", () => {
    const onAction = vi.fn();
    render(<EmptyState description="Empty" onAction={onAction} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
