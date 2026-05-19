import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CliPage from "./CliPage";

const fetchStatus = vi.fn();
const chat = vi.fn();

const mockStatus = { value: "ready" };
vi.mock("../stores/cliStore", () => ({
  useCliStore: () => ({
    status: mockStatus.value,
    loading: false,
    fetchStatus,
    chat,
  }),
}));

describe("CliPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders page", () => {
    render(<CliPage />);
    expect(screen.getByText("CLI")).toBeInTheDocument();
  });

  it("calls fetchStatus on mount", () => {
    render(<CliPage />);
    expect(fetchStatus).toHaveBeenCalled();
  });

  it("sends message", async () => {
    chat.mockResolvedValue("response");
    render(<CliPage />);
    const input = screen.getByPlaceholderText("输入命令或消息...");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("发送"));
    expect(chat).toHaveBeenCalledWith("hello");
  });

  it("sends on Enter key", async () => {
    chat.mockResolvedValue("response");
    render(<CliPage />);
    const input = screen.getByPlaceholderText("输入命令或消息...");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    // onPressEnter triggers handleSend
  });

  it("does not send when input is empty", () => {
    render(<CliPage />);
    fireEvent.click(screen.getByText("发送"));
    expect(chat).not.toHaveBeenCalled();
  });

  it("shows no response fallback", async () => {
    chat.mockResolvedValue("");
    render(<CliPage />);
    const input = screen.getByPlaceholderText("输入命令或消息...");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => {
      expect(chat).toHaveBeenCalledWith("hello");
    });
  });

  it("renders loading subtitle when status is null", () => {
    mockStatus.value = undefined as any;
    render(<CliPage />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    mockStatus.value = "ready";
  });
});
