import { describe, it, expect, vi, beforeEach } from "vitest";
import { metricsApi } from "./metrics";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("metrics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("query calls correct endpoint with all params", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    await metricsApi.query("cpu", "2024-01-01", "2024-01-02");
    expect(api.get).toHaveBeenCalledWith("/api/metrics/query?name=cpu&start=2024-01-01&end=2024-01-02");
  });

  it("query calls endpoint without params", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    await metricsApi.query();
    expect(api.get).toHaveBeenCalledWith("/api/metrics/query");
  });
});
