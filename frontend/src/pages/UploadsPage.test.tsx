/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import UploadsPage from "./UploadsPage";

const upload = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    loading: false,
    upload,
    ...overrides,
  };
}

vi.mock("../stores/uploadsStore", () => ({
  useUploadsStore: vi.fn(() => createMockStore()),
}));

import { useUploadsStore } from "../stores/uploadsStore";

describe("UploadsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUploadsStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <UploadsPage />
      </BrowserRouter>
    );
    expect(screen.getByText("上传")).toBeInTheDocument();
  });

  it("triggers upload on file selection", async () => {
    upload.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <UploadsPage />
      </BrowserRouter>
    );

    const file = new File(["content"], "test.txt", { type: "text/plain" });
    const uploadInput = document.querySelector("input[type='file']") as HTMLInputElement;
    expect(uploadInput).toBeTruthy();

    if (uploadInput) {
      fireEvent.change(uploadInput, { target: { files: [file] } });
      await waitFor(() => {
        expect(upload).toHaveBeenCalled();
      });
    }
  });

  it("shows loading state", () => {
    vi.mocked(useUploadsStore).mockImplementation(() => createMockStore({ loading: true }) as any);
    render(
      <BrowserRouter>
        <UploadsPage />
      </BrowserRouter>
    );
    expect(screen.getByText("选择文件上传")).toBeInTheDocument();
  });
});
