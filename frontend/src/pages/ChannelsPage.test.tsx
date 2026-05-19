import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChannelsPage from "./ChannelsPage";
import { useChannelStore } from "../stores/channelStore";

const fetchChannels = vi.fn();
const disconnectChannel = vi.fn();
const toggleChannel = vi.fn();
const connectChannel = vi.fn().mockResolvedValue(undefined);
const fetchMessages = vi.fn();
const deleteChannel = vi.fn();

const defaultMock = {
  channels: [
    { id: "c1", name: "Telegram Bot", type: "telegram", connected: true },
    { id: "c2", name: "Discord Bot", type: "discord", connected: false },
  ],
  loading: false,
  fetchChannels,
  disconnectChannel,
  toggleChannel,
  connectChannel,
  fetchMessages,
  messages: [{ content: "hello", timestamp: new Date().toISOString() }],
  deleteChannel,
};

vi.mock("../stores/channelStore", () => ({
  useChannelStore: vi.fn(() => defaultMock),
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Modal: { ...actual.Modal, confirm: vi.fn(({ onOk }) => onOk?.()) },
  };
});

describe("ChannelsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      channels: [...defaultMock.channels],
      messages: [...defaultMock.messages],
    });
  });

  it("renders channels", () => {
    render(<ChannelsPage />);
    expect(screen.getByText("Telegram Bot")).toBeInTheDocument();
    expect(screen.getByText("Discord Bot")).toBeInTheDocument();
  });

  it("calls fetchChannels on mount", () => {
    render(<ChannelsPage />);
    expect(fetchChannels).toHaveBeenCalled();
  });

  it("refreshes channels", () => {
    render(<ChannelsPage />);
    fireEvent.click(screen.getByText("刷新"));
    expect(fetchChannels).toHaveBeenCalledTimes(2);
  });

  it("shows loading skeleton", () => {
    vi.mocked(useChannelStore).mockReturnValue({ ...defaultMock, channels: [], loading: true });
    render(<ChannelsPage />);
    expect(document.querySelectorAll("[style*='background: var(--c-hover)']").length).toBeGreaterThan(0);
  });

  it("shows empty state", () => {
    vi.mocked(useChannelStore).mockReturnValue({ ...defaultMock, channels: [], loading: false });
    render(<ChannelsPage />);
    expect(screen.getByText("暂无通道")).toBeInTheDocument();
  });

  it("opens connect drawer and submits", async () => {
    render(<ChannelsPage />);
    fireEvent.click(screen.getByText("连接新通道"));
    expect(document.querySelector(".ant-drawer")).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("例如: 我的 Telegram 机器人") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "NewChannel" } });

    const typeSelect = document.querySelector(".ant-select-selection-search-input") as HTMLInputElement;
    if (typeSelect) {
      fireEvent.mouseDown(typeSelect);
      const option = document.querySelector(".ant-select-item-option-content") as HTMLElement;
      if (option) fireEvent.click(option);
    }

    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    if (tokenInput) fireEvent.change(tokenInput, { target: { value: "token123" } });

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(connectChannel).toHaveBeenCalled();
    });
  });

  it("disconnects connected channel", () => {
    render(<ChannelsPage />);
    fireEvent.click(screen.getByText("断开"));
    expect(disconnectChannel).toHaveBeenCalledWith("c1");
  });

  it("connects disconnected channel", () => {
    render(<ChannelsPage />);
    fireEvent.click(screen.getByText("连接"));
    expect(toggleChannel).toHaveBeenCalledWith("c2");
  });

  it("opens messages drawer with content", async () => {
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    expect(fetchMessages).toHaveBeenCalledWith("c1");
    await waitFor(() => {
      expect(screen.getByText("hello")).toBeInTheDocument();
    });
  });

  it("opens messages drawer with empty state", async () => {
    vi.mocked(useChannelStore).mockReturnValue({ ...defaultMock, messages: [] });
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    await waitFor(() => {
      expect(screen.getByText("暂无消息")).toBeInTheDocument();
    });
  });

  it("renders message with text fallback", async () => {
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      messages: [{ text: "text msg" }],
    });
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    await waitFor(() => {
      expect(screen.getByText("text msg")).toBeInTheDocument();
    });
  });

  it("renders message with message fallback", async () => {
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      messages: [{ message: "message msg" }],
    });
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    await waitFor(() => {
      expect(screen.getByText("message msg")).toBeInTheDocument();
    });
  });

  it("renders message with object fallback", async () => {
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      messages: [{ key: "value" }],
    });
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    await waitFor(() => {
      expect(screen.getByText(/"key"/)).toBeInTheDocument();
    });
  });

  it("deletes channel via Modal.confirm", () => {
    render(<ChannelsPage />);
    const deleteButtons = screen.getAllByText("删除");
    fireEvent.click(deleteButtons[0]);
    expect(deleteChannel).toHaveBeenCalledWith("c1");
  });

  it("shows connect error", async () => {
    const rejectConnect = vi.fn().mockRejectedValue(new Error("auth failed"));
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      channels: [...defaultMock.channels],
      connectChannel: rejectConnect,
    });
    render(<ChannelsPage />);
    fireEvent.click(screen.getByText("连接新通道"));

    const nameInput = screen.getByPlaceholderText("例如: 我的 Telegram 机器人") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "BadChannel" } });

    const typeSelect = document.querySelector(".ant-select-selection-search-input") as HTMLInputElement;
    if (typeSelect) {
      fireEvent.mouseDown(typeSelect);
      const option = document.querySelector(".ant-select-item-option-content") as HTMLElement;
      if (option) fireEvent.click(option);
    }

    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    if (tokenInput) fireEvent.change(tokenInput, { target: { value: "bad" } });

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(rejectConnect).toHaveBeenCalled();
    });
  });

  it("renders invalid timestamp fallback", async () => {
    const spy = vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(() => {
      throw new Error("bad date");
    });
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      messages: [{ content: "hello", timestamp: "invalid-date" }],
    });
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    await waitFor(() => {
      expect(screen.getByText("hello")).toBeInTheDocument();
    });
    spy.mockRestore();
  });

  it("renders message with JSON stringify fallback catch", async () => {
    const circular: any = { self: null };
    circular.self = circular;
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      messages: [circular],
    });
    render(<ChannelsPage />);
    const msgButtons = screen.getAllByText("消息");
    fireEvent.click(msgButtons[0]);
    await waitFor(() => {
      expect(fetchMessages).toHaveBeenCalledWith("c1");
    });
  });

  it("shows connect error without message", async () => {
    const rejectConnect = vi.fn().mockRejectedValue({});
    vi.mocked(useChannelStore).mockReturnValue({
      ...defaultMock,
      connectChannel: rejectConnect,
    });
    render(<ChannelsPage />);
    fireEvent.click(screen.getByText("连接新通道"));

    const nameInput = screen.getByPlaceholderText("例如: 我的 Telegram 机器人") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Bad" } });

    const typeSelect = document.querySelector(".ant-select-selection-search-input") as HTMLInputElement;
    if (typeSelect) {
      fireEvent.mouseDown(typeSelect);
      const option = document.querySelector(".ant-select-item-option-content") as HTMLElement;
      if (option) fireEvent.click(option);
    }

    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    if (tokenInput) fireEvent.change(tokenInput, { target: { value: "bad" } });

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(rejectConnect).toHaveBeenCalled();
    });
  });
});
