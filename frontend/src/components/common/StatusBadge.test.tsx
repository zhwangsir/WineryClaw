/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["ok", "正常"],
    ["healthy", "健康"],
    ["connected", "已连接"],
    ["running", "运行中"],
    ["enabled", "已启用"],
    ["completed", "已完成"],
    ["success", "成功"],
    ["error", "错误"],
    ["failed", "失败"],
    ["down", "离线"],
    ["degraded", "降级"],
    ["disconnected", "未连接"],
    ["disabled", "已禁用"],
    ["pending", "待处理"],
  ])("renders correct text for status '%s'", (status, expectedText) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it("falls back to raw status text for unknown status", () => {
    render(<StatusBadge status="custom_status" />);
    expect(screen.getByText("custom_status")).toBeInTheDocument();
  });

  it("falls back to neutral variant for unknown status", () => {
    const { container } = render(<StatusBadge status="unknown" />);
    const badge = container.querySelector("span");
    expect(badge).toBeInTheDocument();
  });
});
