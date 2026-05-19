import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerA2ARoutes } from "../src/server/a2a-routes.js";

function buildApp(agentManager: any): FastifyInstance {
  const app = Fastify();
  registerA2ARoutes(app, { agentManager });
  return app;
}

describe("registerA2ARoutes", () => {
  let listTasks: ReturnType<typeof vi.fn>;
  let delegateTask: ReturnType<typeof vi.fn>;
  let getTask: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;

  beforeEach(() => {
    listTasks = vi.fn();
    delegateTask = vi.fn();
    getTask = vi.fn();
    app = buildApp({ listTasks, delegateTask, getTask });
  });

  describe("GET /a2a/tasks", () => {
    it("returns the AgentManager task list under tasks[]", async () => {
      listTasks.mockReturnValue([
        { taskId: "t1", status: "pending" },
        { taskId: "t2", status: "done" },
      ]);

      const res = await app.inject({ method: "GET", url: "/a2a/tasks" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tasks).toHaveLength(2);
      expect(body.tasks[0].taskId).toBe("t1");
    });
  });

  describe("POST /a2a/task/send", () => {
    it("delegates with body fields and returns taskId + status", async () => {
      delegateTask.mockResolvedValue({ taskId: "t-new", status: "pending" });

      const res = await app.inject({
        method: "POST",
        url: "/a2a/task/send",
        payload: {
          senderId: "agent-a",
          receiverId: "agent-b",
          type: "summarize",
          payload: { url: "https://example.com" },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.taskId).toBe("t-new");
      expect(body.status).toBe("pending");

      expect(delegateTask).toHaveBeenCalledWith(
        "agent-a",
        "agent-b",
        "summarize",
        { url: "https://example.com" },
      );
    });

    it("defaults missing payload to empty object", async () => {
      delegateTask.mockResolvedValue({ taskId: "t-x", status: "pending" });

      await app.inject({
        method: "POST",
        url: "/a2a/task/send",
        payload: { senderId: "a", receiverId: "b", type: "ping" },
      });

      expect(delegateTask).toHaveBeenCalledWith("a", "b", "ping", {});
    });

    it("coerces missing string fields to empty strings", async () => {
      delegateTask.mockResolvedValue({ taskId: "t", status: "pending" });

      await app.inject({
        method: "POST",
        url: "/a2a/task/send",
        payload: {},
      });

      expect(delegateTask).toHaveBeenCalledWith("", "", "", {});
    });
  });

  describe("GET /a2a/task/:taskId", () => {
    it("returns ok:true + the task when found", async () => {
      getTask.mockReturnValue({ taskId: "t1", status: "running" });

      const res = await app.inject({ method: "GET", url: "/a2a/task/t1" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.task.taskId).toBe("t1");
      expect(getTask).toHaveBeenCalledWith("t1");
    });

    it("returns ok:false when AgentManager returns undefined", async () => {
      getTask.mockReturnValue(undefined);

      const res = await app.inject({ method: "GET", url: "/a2a/task/missing" });
      expect(res.json().ok).toBe(false);
    });
  });
});
