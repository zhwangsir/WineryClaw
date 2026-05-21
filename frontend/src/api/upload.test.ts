/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadApi, readFileAsBase64 } from "./upload";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "./client";

describe("upload API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readFileAsBase64 resolves with base64 string", async () => {
    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    const result = await readFileAsBase64(file);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("upload calls correct endpoint with base64 data", async () => {
    const file = new File(["hello world"], "hello.txt", { type: "text/plain" });
    vi.mocked(api.post).mockResolvedValue({ ok: true, url: "/uploads/hello.txt" });

    const result = await uploadApi.upload(file);

    expect(api.post).toHaveBeenCalledWith(
      "/api/upload",
      expect.objectContaining({
        filename: "hello.txt",
        type: "text/plain",
      })
    );
    expect(result).toEqual({ ok: true, url: "/uploads/hello.txt" });
  });
});
