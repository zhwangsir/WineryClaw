import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LazyPage from "./LazyPage";

describe("LazyPage", () => {
  it("renders spin container", () => {
    render(<LazyPage />);
    expect(document.querySelector(".ant-spin")).toBeInTheDocument();
  });
});
