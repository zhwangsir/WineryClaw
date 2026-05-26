import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AnimatedPage, { StaggerContainer, StaggerItem, HoverCard, FadeIn } from "./AnimatedPage";

// framer-motion is globally mocked in test-setup.ts (strips motion-only props
// so they never reach DOM elements and cause React warnings)

describe("AnimatedPage", () => {
  it("renders children", () => {
    render(<AnimatedPage>content</AnimatedPage>);
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("StaggerContainer renders children", () => {
    render(<StaggerContainer>stagger</StaggerContainer>);
    expect(screen.getByText("stagger")).toBeInTheDocument();
  });

  it("StaggerItem renders children", () => {
    render(<StaggerItem>item</StaggerItem>);
    expect(screen.getByText("item")).toBeInTheDocument();
  });

  it("HoverCard renders children", () => {
    render(<HoverCard>hover</HoverCard>);
    expect(screen.getByText("hover")).toBeInTheDocument();
  });

  it("FadeIn renders children", () => {
    render(<FadeIn>fade</FadeIn>);
    expect(screen.getByText("fade")).toBeInTheDocument();
  });
});
