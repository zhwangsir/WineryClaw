/**
 * Agent Collaboration Engine — A2A Protocol Implementation
 * 广播、点对点通信、任务委托链、共识投票
 */

import { AgentCard } from "./agent-manager.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ===== A2A Message Types =====

export type A2AMessageType =
  | "broadcast"        // 广播给所有 Agent
  | "direct"           // 点对点消息
  | "request"          // 请求（需响应）
  | "response"         // 响应
  | "delegate"         // 任务委托
  | "delegate_result"  // 委托结果返回
  | "vote"             // 共识投票
  | "vote_result"      // 投票结果
  | "heartbeat";       // 心跳

export interface A2AMessage {
  id: string;
  type: A2AMessageType;
  from: string;        // sender agent id
  to?: string;         // target agent id (optional for broadcast)
  topic?: string;      // message topic / channel
  payload: Record<string, unknown>;
  inReplyTo?: string;  // references parent message id
  timestamp: string;
  ttl?: number;        // time-to-live in seconds
}

export interface A2ARequest {
  id: string;
  from: string;
  to: string;
  action: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  timestamp: string;
}

export interface A2AResponse {
  id: string;
  requestId: string;
  from: string;
  to: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  timestamp: string;
}

export interface AgentVote {
  agentId: string;
  proposalId: string;
  vote: "yes" | "no" | "abstain";
  reason?: string;
  timestamp: string;
}

export interface ConsensusProposal {
  id: string;
  topic: string;
  description: string;
  proposerId: string;
  quorum: number;      // minimum votes needed
  deadline: string;    // ISO timestamp
  votes: AgentVote[];
  status: "open" | "passed" | "rejected" | "expired";
  result?: unknown;
}

export interface AgentConversation {
  id: string;
  agentIds: string[];
  topic: string;
  messages: A2AMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationStats {
  totalMessages: number;
  totalConversations: number;
  activeProposals: number;
  delegatedTasks: number;
  agentActivity: Record<string, number>;
}

// ===== Callbacks =====

export type MessageHandler = (msg: A2AMessage) => void | Promise<void>;
export type AgentResolver = (id: string) => AgentCard | undefined;

// ===== Engine =====

const MSG_DIR = "~/.webrain/agents/messages";
const CONV_DIR = "~/.webrain/agents/conversations";
const VOTE_DIR = "~/.webrain/agents/votes";

export class AgentCollaborationEngine {
  private messages: A2AMessage[] = [];
  private conversations = new Map<string, AgentConversation>();
  private proposals = new Map<string, ConsensusProposal>();
  private pendingRequests = new Map<string, { resolve: (r: A2AResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers = new Map<A2AMessageType, Set<MessageHandler>>();
  private agentResolver: AgentResolver;
  private messageLimit = 10000;
  private persistenceEnabled = true;

  constructor(agentResolver: AgentResolver) {
    this.agentResolver = agentResolver;
    this.loadPersisted();
  }

  // ---- Message Routing ----

  async send(msg: Omit<A2AMessage, "id" | "timestamp">): Promise<A2AMessage> {
    const full: A2AMessage = {
      ...msg,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };

    this.messages.push(full);
    this.trimMessages();

    // Add to conversation
    this.addToConversation(full);

    // Persist
    if (this.persistenceEnabled) {
      await this.persistMessage(full);
    }

    // Route to handlers
    await this.dispatch(full);

    return full;
  }

  async broadcast(from: string, topic: string, payload: Record<string, unknown>): Promise<A2AMessage> {
    return this.send({ type: "broadcast", from, topic, payload });
  }

  async sendDirect(from: string, to: string, topic: string, payload: Record<string, unknown>): Promise<A2AMessage> {
    return this.send({ type: "direct", from, to, topic, payload });
  }

  // Request/Response pattern
  async request(from: string, to: string, action: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<A2AResponse> {
    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req: A2ARequest = {
      id: reqId,
      from,
      to,
      action,
      params,
      timeoutMs,
      timestamp: new Date().toISOString(),
    };

    // Send request message
    await this.send({
      type: "request",
      from,
      to,
      topic: action,
      payload: { request: req },
    });

    // Wait for response
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Request ${reqId} to ${to} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timer });
    });
  }

  async respond(requestId: string, from: string, to: string, ok: boolean, result?: unknown, error?: string): Promise<A2AMessage> {
    const resp: A2AResponse = {
      id: `resp-${Date.now()}`,
      requestId,
      from,
      to,
      ok,
      result,
      error,
      timestamp: new Date().toISOString(),
    };

    // Fulfill pending request
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve(resp);
    }

    return this.send({
      type: "response",
      from,
      to,
      topic: "response",
      payload: { response: resp },
      inReplyTo: requestId,
    });
  }

  // Task delegation with result callback
  async delegate(from: string, to: string, taskType: string, payload: Record<string, unknown>, contextId: string): Promise<{ taskId: string; result: Promise<unknown> }> {
    const delegateId = `dlg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Create a promise that will be resolved when the delegate result comes back
    let resolveResult!: (v: unknown) => void;
    let rejectResult!: (e: Error) => void;
    const resultPromise = new Promise<unknown>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    // Store resolver for later
    this.pendingRequests.set(delegateId, {
      resolve: (r) => resolveResult(r.result),
      reject: rejectResult,
      timer: setTimeout(() => {
        this.pendingRequests.delete(delegateId);
        rejectResult(new Error(`Delegation ${delegateId} timed out`));
      }, 120000),
    });

    await this.send({
      type: "delegate",
      from,
      to,
      topic: taskType,
      payload: { delegateId, taskType, payload, contextId },
    });

    return { taskId: delegateId, result: resultPromise };
  }

  async reportDelegationResult(delegateId: string, from: string, to: string, ok: boolean, result?: unknown, error?: string): Promise<void> {
    await this.send({
      type: "delegate_result",
      from,
      to,
      topic: "delegate_result",
      payload: { delegateId, ok, result, error },
      inReplyTo: delegateId,
    });

    // Fulfill pending delegation
    const pending = this.pendingRequests.get(delegateId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(delegateId);
      if (ok) {
        pending.resolve({ ok: true, result } as any);
      } else {
        pending.reject(new Error(error || "Delegation failed"));
      }
    }
  }

  // ---- Consensus / Voting ----

  createProposal(proposerId: string, topic: string, description: string, quorum: number, timeoutSec = 300): ConsensusProposal {
    const proposal: ConsensusProposal = {
      id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      topic,
      description,
      proposerId,
      quorum,
      deadline: new Date(Date.now() + timeoutSec * 1000).toISOString(),
      votes: [],
      status: "open",
    };
    this.proposals.set(proposal.id, proposal);
    this.persistProposalSync(proposal);

    // Broadcast proposal to all agents
    this.broadcast(proposerId, "consensus", {
      action: "propose",
      proposalId: proposal.id,
      topic,
      description,
      quorum,
      deadline: proposal.deadline,
    }).catch(() => {});

    return proposal;
  }

  castVote(agentId: string, proposalId: string, vote: "yes" | "no" | "abstain", reason?: string): { ok: boolean; proposal?: ConsensusProposal; error?: string } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { ok: false, error: "Proposal not found" };
    if (proposal.status !== "open") return { ok: false, error: `Proposal already ${proposal.status}` };
    if (new Date() > new Date(proposal.deadline)) {
      proposal.status = "expired";
      this.persistProposalSync(proposal);
      return { ok: false, error: "Proposal expired" };
    }

    // Remove existing vote from this agent
    proposal.votes = proposal.votes.filter(v => v.agentId !== agentId);
    proposal.votes.push({ agentId, proposalId, vote, reason, timestamp: new Date().toISOString() });

    // Check if consensus reached
    const yesCount = proposal.votes.filter(v => v.vote === "yes").length;
    const totalVotes = proposal.votes.length;

    if (yesCount >= proposal.quorum) {
      proposal.status = "passed";
      proposal.result = { yes: yesCount, total: totalVotes };
    } else if (totalVotes - yesCount >= proposal.quorum) {
      // Enough non-yes votes to reject
      proposal.status = "rejected";
      proposal.result = { yes: yesCount, total: totalVotes };
    }

    this.persistProposalSync(proposal);

    // Broadcast vote
    this.broadcast(agentId, "consensus", {
      action: "vote",
      proposalId,
      agentId,
      vote,
      reason,
      status: proposal.status,
    }).catch(() => {});

    return { ok: true, proposal };
  }

  getProposal(id: string): ConsensusProposal | undefined {
    return this.proposals.get(id);
  }

  listProposals(status?: ConsensusProposal["status"]): ConsensusProposal[] {
    const all = Array.from(this.proposals.values());
    return status ? all.filter(p => p.status === status) : all;
  }

  closeProposal(proposalId: string): { ok: boolean; proposal?: ConsensusProposal; error?: string } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { ok: false, error: "Proposal not found" };
    if (proposal.status !== "open") return { ok: false, error: `Already ${proposal.status}` };

    const yesCount = proposal.votes.filter(v => v.vote === "yes").length;
    proposal.status = yesCount >= proposal.quorum ? "passed" : "rejected";
    proposal.result = { yes: yesCount, total: proposal.votes.length };
    this.persistProposalSync(proposal);

    return { ok: true, proposal };
  }

  // ---- Conversations ----

  private addToConversation(msg: A2AMessage): void {
    const participants = msg.type === "broadcast"
      ? [msg.from]
      : [msg.from, msg.to].filter(Boolean) as string[];

    const convId = msg.topic || "general";
    let conv = this.conversations.get(convId);
    if (!conv) {
      conv = {
        id: convId,
        agentIds: participants,
        topic: msg.topic || "general",
        messages: [],
        createdAt: msg.timestamp,
        updatedAt: msg.timestamp,
      };
      this.conversations.set(convId, conv);
    }

    conv.messages.push(msg);
    conv.updatedAt = msg.timestamp;

    // Merge participants
    for (const p of participants) {
      if (!conv.agentIds.includes(p)) conv.agentIds.push(p);
    }

    this.persistConversationSync(conv);
  }

  getConversation(id: string): AgentConversation | undefined {
    return this.conversations.get(id);
  }

  listConversations(agentId?: string): AgentConversation[] {
    const all = Array.from(this.conversations.values());
    return agentId ? all.filter(c => c.agentIds.includes(agentId)) : all;
  }

  // ---- Handlers ----

  on(type: A2AMessageType, handler: MessageHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  private async dispatch(msg: A2AMessage): Promise<void> {
    const handlers = this.handlers.get(msg.type);
    if (handlers) {
      for (const h of handlers) {
        try {
          await h(msg);
        } catch (err) { console.error("[collaboration-engine] Error:", err);
          console.error(`[a2a] Handler error for ${msg.type}:`, err);
        }
      }
    }

    // Auto-handle delegate_result
    if (msg.type === "delegate_result") {
      const { delegateId, ok, result, error } = msg.payload as any;
      const pending = this.pendingRequests.get(delegateId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(delegateId);
        if (ok) {
          pending.resolve({ ok: true, result } as any);
        } else {
          pending.reject(new Error(error || "Delegation failed"));
        }
      }
    }
  }

  // ---- Queries ----

  getMessages(filter?: { from?: string; to?: string; type?: A2AMessageType; topic?: string; limit?: number }): A2AMessage[] {
    let result = [...this.messages];
    if (filter?.from) result = result.filter(m => m.from === filter.from);
    if (filter?.to) result = result.filter(m => m.to === filter.to);
    if (filter?.type) result = result.filter(m => m.type === filter.type);
    if (filter?.topic) result = result.filter(m => m.topic === filter.topic);
    if (filter?.limit) result = result.slice(-filter.limit);
    return result;
  }

  getStats(): CollaborationStats {
    const agentActivity: Record<string, number> = {};
    for (const m of this.messages) {
      agentActivity[m.from] = (agentActivity[m.from] || 0) + 1;
    }
    return {
      totalMessages: this.messages.length,
      totalConversations: this.conversations.size,
      activeProposals: Array.from(this.proposals.values()).filter(p => p.status === "open").length,
      delegatedTasks: this.messages.filter(m => m.type === "delegate").length,
      agentActivity,
    };
  }

  // ---- Persistence ----

  private async persistMessage(msg: A2AMessage): Promise<void> {
    try {
      const dir = join(homedir(), ".webrain", "agents", "messages");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${msg.id}.json`), JSON.stringify(msg, null, 2));
    } catch (err) { console.error("[collaboration-engine] Error:", err);
      // ignore
    }
  }

  private persistConversationSync(conv: AgentConversation): void {
    try {
      const dir = join(homedir(), ".webrain", "agents", "conversations");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${conv.id}.json`), JSON.stringify(conv, null, 2));
    } catch (err) { console.error("[collaboration-engine] Error:", err);
      // ignore
    }
  }

  private persistProposalSync(proposal: ConsensusProposal): void {
    try {
      const dir = join(homedir(), ".webrain", "agents", "votes");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2));
    } catch (err) { console.error("[collaboration-engine] Error:", err);
      // ignore
    }
  }

  private loadPersisted(): void {
    try {
      const base = join(homedir(), ".webrain", "agents");

      // Load messages
      const msgDir = join(base, "messages");
      if (existsSync(msgDir)) {
        for (const f of readdirSync(msgDir)) {
          if (f.endsWith(".json")) {
            try {
              const msg: A2AMessage = JSON.parse(readFileSync(join(msgDir, f), "utf-8"));
              this.messages.push(msg);
            } catch (err) { console.error("[collaboration-engine] Error:", err); console.error("[collab] Error:", err); }
          }
        }
      }

      // Load conversations
      const convDir = join(base, "conversations");
      if (existsSync(convDir)) {
        for (const f of readdirSync(convDir)) {
          if (f.endsWith(".json")) {
            try {
              const conv: AgentConversation = JSON.parse(readFileSync(join(convDir, f), "utf-8"));
              this.conversations.set(conv.id, conv);
            } catch (err) { console.error("[collaboration-engine] Error:", err); console.error("[collab] Error:", err); }
          }
        }
      }

      // Load proposals
      const voteDir = join(base, "votes");
      if (existsSync(voteDir)) {
        for (const f of readdirSync(voteDir)) {
          if (f.endsWith(".json")) {
            try {
              const prop: ConsensusProposal = JSON.parse(readFileSync(join(voteDir, f), "utf-8"));
              this.proposals.set(prop.id, prop);
            } catch (err) { console.error("[collaboration-engine] Error:", err); console.error("[collab] Error:", err); }
          }
        }
      }

      this.trimMessages();
    } catch (err) { console.error("[collaboration-engine] Error:", err);
      console.error("[a2a] Load persisted failed:", err);
    }
  }

  private trimMessages(): void {
    if (this.messages.length > this.messageLimit) {
      this.messages = this.messages.slice(-this.messageLimit);
    }
  }
}
