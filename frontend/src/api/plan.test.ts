import { describe, it, expect, vi, beforeEach } from "vitest";
import { planApi } from "./plan";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "./client";

describe("plan API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("execute posts to /brain/plan/execute with user_input", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, overall_success: true });
    await planApi.execute({ user_input: "do A then B and verify each step", verify: "presence" });
    expect(api.post).toHaveBeenCalledWith("/brain/plan/execute", {
      user_input: "do A then B and verify each step",
      verify: "presence",
    });
  });

  it("execute posts plan object when supplied", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    const plan = {
      plan_id: "p1",
      user_input: "x",
      tasks: [{ id: "t1", description: "do something" }],
      confidence: 0.7,
      reasoning: "one-step",
    };
    await planApi.execute({ plan, session_id: "s1", agent_id: "a1", verify: "llm" });
    expect(api.post).toHaveBeenCalledWith("/brain/plan/execute", {
      plan,
      session_id: "s1",
      agent_id: "a1",
      verify: "llm",
    });
  });

  it("returns the response body unchanged", async () => {
    const fake = {
      ok: true,
      overall_success: false,
      failed_task_ids: ["t1"],
      total_attempts: 5,
      results: [{ task_id: "t1", description: "x", final_output: "", succeeded: false, attempts: [] }],
    };
    vi.mocked(api.post).mockResolvedValue(fake);
    const res = await planApi.execute({ user_input: "complex" });
    expect(res).toEqual(fake);
  });
});
