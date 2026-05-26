import { describe, it, expect, vi, beforeEach } from "vitest";
import { planApi } from "./plan";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    stream: vi.fn().mockReturnValue({
      client: {
        connect: vi.fn(),
        abort: vi.fn(),
      },
      url: "http://localhost/brain/plan/execute/stream?user_input=test",
    }),
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

describe("plan API streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executeStream connects to /brain/plan/execute/stream", () => {
    const onEvent = vi.fn();
    const client = planApi.executeStream({ user_input: "test" }, onEvent);
    expect(api.stream).toHaveBeenCalledWith("/brain/plan/execute/stream", { user_input: "test" });
    expect(client).toBeDefined();
    expect(client.connect).toBeDefined();
    expect(client.abort).toBeDefined();
  });

  it("executeStream passes params as query string", () => {
    const onEvent = vi.fn();
    planApi.executeStream({ user_input: "hello", verify: "llm" }, onEvent);
    expect(api.stream).toHaveBeenCalledWith("/brain/plan/execute/stream", { user_input: "hello", verify: "llm" });
  });

  it("executeStream invokes onEvent with parsed data", () => {
    const onEvent = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    let capturedOnMessage: ((data: unknown) => void) | undefined;

    vi.mocked(api.stream).mockReturnValue({
      client: {
        connect: (_url: string, onMessage: (data: unknown) => void) => {
          capturedOnMessage = onMessage;
        },
        abort: vi.fn(),
      },
      url: "mock-url",
    });

    planApi.executeStream({ user_input: "test" }, onEvent, onDone, onError);

    expect(capturedOnMessage).toBeDefined();
    capturedOnMessage!({ event: "plan_start", plan_id: "p1", total_tasks: 2 });
    expect(onEvent).toHaveBeenCalledWith({ event: "plan_start", plan_id: "p1", total_tasks: 2 });
  });
});
