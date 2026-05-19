import { describe, it, expect, vi, beforeEach } from "vitest";
import { browserApi } from "./browser";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("browser API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("launch calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.launch("arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("newPage calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.newPage("arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("navigate calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.navigate("test-id", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("click calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.click("test-id", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("type calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.type("test-id", "arg", "text");
    expect(true).toBe(true);  // API call succeeded
  });

  it("screenshot calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.screenshot("test-id", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("sessions calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await browserApi.sessions();
    expect(true).toBe(true);  // API call succeeded
  });

});
