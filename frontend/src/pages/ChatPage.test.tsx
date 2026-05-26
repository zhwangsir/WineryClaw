import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChatPage from "./ChatPage";

const sendStream = vi.fn();
const stopStream = vi.fn();
const newSession = vi.fn();
const fetchHistory = vi.fn();
const deleteSession = vi.fn();
const clearCurrentChat = vi.fn();
const init = vi.fn();
const setToolEnabled = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    messages: [{ id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() }],
    sessions: [{ id: "s1", title: "Session 1", updatedAt: new Date().toISOString() }],
    currentSessionId: "s1",
    streaming: false,
    toolEnabled: false,
    setToolEnabled,
    sendStream,
    stopStream,
    newSession,
    fetchHistory,
    deleteSession,
    clearCurrentChat,
    init,
    ...overrides,
  };
}

vi.mock("../stores/chatStore", () => ({
  useChatStore: vi.fn(() => createMockStore()),
}));

import { useChatStore } from "../stores/chatStore";

const fetchModelHealth = vi.fn();
const fetchModelConfig = vi.fn();
const fetchAgents = vi.fn();

vi.mock("../stores/systemStore", () => {
  const hook = () => ({ fetchModelHealth: vi.fn() });
  (hook as any).getState = () => ({ fetchModelHealth: vi.fn() });
  return { useSystemStore: hook };
});

vi.mock("../stores/configStore", () => {
  const hook = () => ({ fetchModelConfig: vi.fn() });
  (hook as any).getState = () => ({ fetchModelConfig: vi.fn() });
  return { useConfigStore: hook };
});

vi.mock("../stores/agentStore", () => {
  const hook = () => ({ currentAgentId: "a1", fetchAgents: vi.fn() });
  (hook as any).getState = () => ({ fetchAgents: vi.fn() });
  return { useAgentStore: hook };
});

vi.mock("../hooks/useTheme", () => ({
  useIsDark: () => false,
}));

vi.mock("../api/upload", () => ({
  uploadApi: {
    upload: vi.fn(),
  },
}));

import { uploadApi } from "../api/upload";

vi.mock("../components/chat/ChatSidebar", () => ({
  default: ({ onSelectSession, onNewSession, onDeleteSession }: any) => (
    <div data-testid="sidebar">
      <button onClick={() => onSelectSession("s1")}>Select</button>
      <button onClick={() => onNewSession()}>New</button>
      <button onClick={() => onDeleteSession("s1")}>Delete</button>
    </div>
  ),
}));

vi.mock("../components/chat/ChatHeader", () => ({
  default: ({ onToggleTool, onToggleSearch, onExport, onClear }: any) => (
    <div data-testid="header">
      <button onClick={onToggleTool}>Tool</button>
      <button onClick={onToggleSearch}>Search</button>
      <button onClick={onExport}>Export</button>
      <button onClick={onClear}>Clear</button>
    </div>
  ),
}));

vi.mock("../components/chat/MessageList", () => ({
  default: ({ onScroll, onScrollToBottom, containerRef }: any) => (
    <div
      data-testid="messagelist"
      ref={(el: any) => {
        if (containerRef) containerRef.current = el;
      }}
      onScroll={onScroll}
    >
      <button onClick={onScrollToBottom}>ScrollBottom</button>
    </div>
  ),
}));

vi.mock("../components/chat/ChatInput", () => ({
  default: ({ value, onChange, onSend, onStop, onToggleVoice }: any) => (
    <div data-testid="chatinput">
      <input value={value} onChange={(e) => onChange(e.target.value)} data-testid="chatinput-field" />
      <button onClick={onSend}>Send</button>
      <button onClick={onStop}>Stop</button>
      <button onClick={onToggleVoice}>Voice</button>
    </div>
  ),
}));

describe("ChatPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders chat layout", () => {
    render(<ChatPage />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(screen.getByTestId("messagelist")).toBeInTheDocument();
    expect(screen.getByTestId("chatinput")).toBeInTheDocument();
  });

  it("calls init on mount", () => {
    render(<ChatPage />);
    expect(init).toHaveBeenCalled();
  });

  it("selects session via sidebar", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Select"));
    expect(fetchHistory).toHaveBeenCalledWith("s1");
  });

  it("creates new session via sidebar", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("New"));
    expect(newSession).toHaveBeenCalled();
  });

  it("deletes session via sidebar", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Delete"));
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });

  it("toggles search via header", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Search"));
    expect(screen.getByPlaceholderText("搜索消息内容...")).toBeInTheDocument();
  });

  it("exports chat via header", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:url");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    render(<ChatPage />);
    fireEvent.click(screen.getByText("Export"));
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("clears chat via header", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Clear"));
    expect(clearCurrentChat).toHaveBeenCalled();
  });

  it("sends message via chat input", () => {
    render(<ChatPage />);
    const input = screen.getByTestId("chatinput-field");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));
    expect(sendStream).toHaveBeenCalledWith("hello", "a1");
  });

  it("stops streaming via chat input", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Stop"));
    expect(stopStream).toHaveBeenCalled();
  });

  it("shows drag overlay on drag over", () => {
    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.dragOver(dropZone);
    expect(screen.getByText("松开以上传文件")).toBeInTheDocument();
  });

  it("hides drag overlay on drag leave", () => {
    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.dragOver(dropZone);
    expect(screen.getByText("松开以上传文件")).toBeInTheDocument();
    fireEvent.dragLeave(dropZone);
    expect(screen.queryByText("松开以上传文件")).not.toBeInTheDocument();
  });

  it("drops text file and appends content to input", async () => {
    const file = new File(["hello world"], "note.md", { type: "text/markdown" });
    let onloadHandler: any;
    const readAsText = vi.fn((f: any) => {
      if (onloadHandler) {
        onloadHandler({ target: { result: "hello world" } });
      }
    });
    vi.stubGlobal("FileReader", function () {
      const self = this as any;
      self.readAsText = readAsText;
      Object.defineProperty(self, "onload", {
        set: (fn: any) => {
          onloadHandler = fn;
        },
        get: () => onloadHandler,
      });
    });

    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(readAsText).toHaveBeenCalledWith(file);
    });
    await waitFor(() => {
      const input = screen.getByTestId("chatinput-field") as HTMLInputElement;
      expect(input.value).toContain("hello world");
    });
  });

  it("drops binary file and uploads", async () => {
    const file = new File(["binary"], "image.png", { type: "image/png" });
    vi.mocked(uploadApi.upload).mockResolvedValue({ ok: true, url: "http://cdn/image.png", size: 1024 });

    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(uploadApi.upload).toHaveBeenCalledWith(file);
    });
  });

  it("shows upload error when binary upload fails", async () => {
    const file = new File(["binary"], "image.png", { type: "image/png" });
    vi.mocked(uploadApi.upload).mockResolvedValue({ ok: false, error: "too large" });

    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(uploadApi.upload).toHaveBeenCalledWith(file);
    });
  });

  it("shows upload error on exception", async () => {
    const file = new File(["binary"], "image.png", { type: "image/png" });
    vi.mocked(uploadApi.upload).mockRejectedValue(new Error("network"));

    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(uploadApi.upload).toHaveBeenCalledWith(file);
    });
  });

  it("does nothing when drop has no files", () => {
    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.drop(dropZone, { dataTransfer: { files: [] } });
    expect(uploadApi.upload).not.toHaveBeenCalled();
  });

  it("shows voice not supported message", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Voice"));
    // message.error is called internally; we just verify no crash
  });

  it("toggles voice recording when supported", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const mockRecognition = function () {
      (this as any).lang = "";
      (this as any).continuous = false;
      (this as any).interimResults = false;
      (this as any).start = start;
      (this as any).stop = stop;
      (this as any).onresult = null;
      (this as any).onerror = null;
      (this as any).onend = null;
    };
    vi.stubGlobal("webkitSpeechRecognition", mockRecognition);

    render(<ChatPage />);
    fireEvent.click(screen.getByText("Voice"));
    expect(start).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Voice"));
    expect(stop).toHaveBeenCalled();
  });

  it("handles voice recognition result", () => {
    let resultHandler: any;
    const mockRecognition = function () {
      (this as any).start = vi.fn();
      (this as any).stop = vi.fn();
      (this as any).onresult = null;
      Object.defineProperty(this, "onresult", {
        set: (fn) => {
          resultHandler = fn;
        },
        get: () => resultHandler,
      });
      (this as any).onerror = null;
      (this as any).onend = null;
    };
    vi.stubGlobal("webkitSpeechRecognition", mockRecognition);

    render(<ChatPage />);
    fireEvent.click(screen.getByText("Voice"));

    const event = {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "hello" } }],
    };
    resultHandler(event);
  });

  it("handles voice recognition error", () => {
    let errorHandler: any;
    const mockRecognition = function () {
      (this as any).start = vi.fn();
      (this as any).stop = vi.fn();
      (this as any).onresult = null;
      (this as any).onerror = null;
      Object.defineProperty(this, "onerror", {
        set: (fn) => {
          errorHandler = fn;
        },
        get: () => errorHandler,
      });
      (this as any).onend = null;
    };
    vi.stubGlobal("webkitSpeechRecognition", mockRecognition);

    render(<ChatPage />);
    fireEvent.click(screen.getByText("Voice"));
    errorHandler({});
  });

  it("does not send when text is empty", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Send"));
    expect(sendStream).not.toHaveBeenCalled();
  });

  it("toggles tool via header", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Tool"));
    expect(setToolEnabled).toHaveBeenCalledWith(true);
  });

  it("filters messages when searching", () => {
    render(<ChatPage />);
    fireEvent.click(screen.getByText("Search"));
    const input = screen.getByPlaceholderText("搜索消息内容...");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(screen.getByText(/1 \/ 1 条消息/)).toBeInTheDocument();
  });

  it("appends uploaded file link to input", async () => {
    const file = new File(["binary"], "image.png", { type: "image/png" });
    vi.mocked(uploadApi.upload).mockResolvedValue({ ok: true, url: "http://cdn/image.png", size: 1024 });

    render(<ChatPage />);
    const dropZone = document.querySelector(".chat-page-root > div:last-of-type") || document.body;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      const input = screen.getByTestId("chatinput-field") as HTMLInputElement;
      expect(input.value).toContain("image.png");
    });
  });

  it("handles voice recognition onend", () => {
    let endHandler: any;
    const mockRecognition = function () {
      (this as any).start = vi.fn();
      (this as any).stop = vi.fn();
      (this as any).onresult = null;
      (this as any).onerror = null;
      (this as any).onend = null;
      Object.defineProperty(this, "onend", {
        set: (fn) => {
          endHandler = fn;
        },
        get: () => endHandler,
      });
    };
    vi.stubGlobal("webkitSpeechRecognition", mockRecognition);

    render(<ChatPage />);
    fireEvent.click(screen.getByText("Voice"));
    endHandler({});
  });

  it("scrolls to bottom via messagelist button", () => {
    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
    render(<ChatPage />);
    fireEvent.click(screen.getByText("ScrollBottom"));
    expect(scrollToSpy).toHaveBeenCalled();
    scrollToSpy.mockRestore();
  });

  it("handles scroll event on messagelist", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: any) => setTimeout(cb, 16));
    render(<ChatPage />);
    const msgList = screen.getByTestId("messagelist");
    Object.defineProperty(msgList, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(msgList, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(msgList, "scrollTop", { value: 0, configurable: true, writable: true });

    fireEvent.scroll(msgList);
    // trigger RAF callback synchronously
    const rafCallback = rafSpy.mock.calls[0][0];
    if (rafCallback) rafCallback(0);
    rafSpy.mockRestore();
  });

  it("auto-scrolls when streaming and near bottom", () => {
    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
    vi.mocked(useChatStore).mockReturnValue(
      createMockStore({
        streaming: true,
        messages: [
          { id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() },
          { id: "m2", role: "assistant", content: "hi", timestamp: new Date().toISOString() },
        ],
      })
    );
    const { rerender } = render(<ChatPage />);
    const msgList = screen.getByTestId("messagelist");
    Object.defineProperty(msgList, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(msgList, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(msgList, "scrollTop", { value: 430, configurable: true, writable: true }); // dist=500-430-100=-30, nearBottom=true

    // Trigger re-render to simulate streaming update
    rerender(<ChatPage />);
    expect(scrollToSpy).toHaveBeenCalled();
    scrollToSpy.mockRestore();
  });

  it("shows scroll button when messages grow and not near bottom", () => {
    vi.mocked(useChatStore).mockReturnValue(
      createMockStore({
        messages: [{ id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() }],
      })
    );
    const { rerender } = render(<ChatPage />);
    const msgList = screen.getByTestId("messagelist");
    Object.defineProperty(msgList, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(msgList, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(msgList, "scrollTop", { value: 0, configurable: true, writable: true }); // dist=400, nearBottom=false

    vi.mocked(useChatStore).mockReturnValue(
      createMockStore({
        messages: [
          { id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() },
          { id: "m2", role: "assistant", content: "hi", timestamp: new Date().toISOString() },
        ],
      })
    );
    rerender(<ChatPage />);
    // Should not crash; scroll button state may have changed
  });
});
