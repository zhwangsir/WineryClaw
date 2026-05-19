import { describe, it, expect, beforeEach } from 'vitest';
import { AgentManager } from '../src/agent/agent-manager.js';

describe('AgentManager', () => {
  let manager: AgentManager;

  beforeEach(() => {
    // Clean persisted agents and tasks
    try {
      const { readdirSync, unlinkSync, rmSync } = require('fs');
      const { join } = require('path');
      const { homedir } = require('os');
      const base = join(homedir(), '.webrain', 'agents');
      for (const file of ['agents.json', 'tasks.json', 'agents.json.migrated']) {
        try { unlinkSync(join(base, file)); } catch {}
      }
      for (const subdir of ['messages', 'conversations', 'votes', 'templates', 'workflows', 'workflow-runs', 'sandboxes']) {
        try {
          const dir = join(base, subdir);
          for (const f of readdirSync(dir)) {
            if (f.endsWith('.json')) try { unlinkSync(join(dir, f)); } catch {}
          }
        } catch {}
      }
      // Post-migration: AgentManager stores each agent as its own `agent-<id>/` directory.
      // Sweep them so prior runs don't inflate workspace listAgents() counts.
      try {
        for (const entry of readdirSync(base)) {
          if (entry.startsWith('agent-')) {
            try { rmSync(join(base, entry), { recursive: true, force: true }); } catch {}
          }
        }
      } catch {}
    } catch {}
    manager = new AgentManager({ mainBrainUrl: 'http://127.0.0.1:18790', subBrainUrl: 'http://127.0.0.1:3000' });
  });

  it('should create default agent on init', () => {
    const agents = manager.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some(a => a.id === 'agent-default')).toBe(true);
  });

  it('should create agent', () => {
    const agent = manager.createAgent({
      name: 'Test Agent',
      description: 'Test',
      capabilities: ['chat'],
      modelConfig: {},
      tools: ['shell'],
      channels: [],
      owner: 'test',
      workspaceId: 'default',
    });

    expect(agent.id).toBeDefined();
    expect(agent.name).toBe('Test Agent');
    expect(agent.status).toBe('idle');
    expect(agent.role).toBeUndefined();
    expect(manager.getAgent(agent.id)).toBeDefined();
  });

  it('should list agents by workspace', () => {
    manager.createAgent({
      name: 'WS1 Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'ws1',
    });
    manager.createAgent({
      name: 'WS2 Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'ws2',
    });

    expect(manager.listAgents('ws1').length).toBe(1);
    expect(manager.listAgents('ws2').length).toBe(1);
    expect(manager.listAgents().length).toBeGreaterThanOrEqual(3);
  });

  it('should update agent status', () => {
    const agent = manager.createAgent({
      name: 'Status Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    manager.updateAgentStatus(agent.id, 'running');
    expect(manager.getAgent(agent.id)!.status).toBe('running');
  });

  it('should update agent fields', () => {
    const agent = manager.createAgent({
      name: 'Updatable', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const updated = manager.updateAgent(agent.id, { name: 'Updated', role: 'tester' });
    expect(updated!.name).toBe('Updated');
    expect(updated!.role).toBe('tester');
  });

  it('should delete agent and cleanup', () => {
    const agent = manager.createAgent({
      name: 'Deletable', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    expect(manager.deleteAgent(agent.id)).toBe(true);
    expect(manager.getAgent(agent.id)).toBeUndefined();
  });

  it('should create and manage tasks', () => {
    const agent = manager.createAgent({
      name: 'Task Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });

    const task = manager.createTask(agent.id, 'chat', { message: 'hello' }, 'ctx-1');
    expect(task.taskId).toBeDefined();
    expect(task.status).toBe('pending');

    const tasks = manager.listTasks(agent.id);
    expect(tasks.some(t => t.taskId === task.taskId)).toBe(true);

    manager.completeTask(task.taskId, { reply: 'hi' });
    expect(manager.getTask(task.taskId)!.status).toBe('completed');
    expect(manager.getTask(task.taskId)!.result).toEqual({ reply: 'hi' });
  });

  it('should fail task', () => {
    const agent = manager.createAgent({
      name: 'Fail Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const task = manager.createTask(agent.id, 'custom', {}, 'ctx-1');
    manager.failTask(task.taskId, 'Something broke');
    expect(manager.getTask(task.taskId)!.status).toBe('failed');
    expect(manager.getTask(task.taskId)!.error).toBe('Something broke');
  });

  it('should cancel task', () => {
    const agent = manager.createAgent({
      name: 'Cancel Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const task = manager.createTask(agent.id, 'chat', {}, 'ctx-1');
    expect(manager.cancelTask(task.taskId)).toBe(true);
    expect(manager.getTask(task.taskId)!.status).toBe('cancelled');
  });

  it('should delegate task between agents', async () => {
    const from = manager.createAgent({
      name: 'Delegator', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const to = manager.createAgent({
      name: 'Delegatee', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });

    const task = await manager.delegateTask(from.id, to.id, 'tool', { tool: 'shell' }, 'ctx-delegate');
    expect(task.agentId).toBe(to.id);
    expect(task.status).toBe('pending');
  });

  it('should create proposals and vote', () => {
    const agent = manager.createAgent({
      name: 'Voter', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });

    const prop = manager.createProposal(agent.id, 'deploy', 'Go to prod?', 1, 60);
    expect(prop.status).toBe('open');

    const result = manager.vote(agent.id, prop.id, 'yes', 'LGTM');
    expect(result.ok).toBe(true);
    expect(result.proposal!.status).toBe('passed');
  });

  it('should list and close proposals', () => {
    const agent = manager.createAgent({
      name: 'Proposer', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const p1 = manager.createProposal(agent.id, 't1', 'd1', 5, 3600);
    const p2 = manager.createProposal(agent.id, 't2', 'd2', 5, 3600);

    expect(manager.listProposals('open').length).toBe(2);

    manager.closeProposal(p1.id);
    expect(manager.getProposal(p1.id)!.status).toBe('rejected');
    expect(manager.listProposals('open').length).toBe(1);
  });

  it('should manage templates', () => {
    const templates = manager.listTemplates();
    expect(templates.length).toBe(7);

    const coder = manager.getTemplate('tpl-coder');
    expect(coder).toBeDefined();
    expect(coder!.blueprint.role).toBe('coder');
  });

  it('should instantiate template and create agent', () => {
    const result = manager.instantiateTemplate('tpl-researcher', { name: 'My Researcher' });
    expect(result.ok).toBe(true);
    expect(result.card).toBeDefined();
    expect(result.card!.name).toBe('My Researcher');
  });

  it('should manage workflows', () => {
    const result = manager.createWorkflow({
      name: 'Test WF',
      description: 'd',
      nodes: [
        { id: 'n1', type: 'delay', name: 'n1', config: {}, delayMs: 10 },
      ],
      edges: [],
      owner: 'test',
      workspaceId: 'default',
      version: '1.0.0',
    });
    expect(result.ok).toBe(true);
    expect(manager.getWorkflow(result.workflow!.id)).toBeDefined();
  });

  it('should provide comprehensive stats', () => {
    const stats = manager.getStats();
    expect(stats.agents).toBeDefined();
    expect(stats.tasks).toBeDefined();
    expect(stats.collaboration).toBeDefined();
    expect(stats.templates).toBeDefined();
    expect(stats.workflows).toBeDefined();
    expect(stats.sandbox).toBeDefined();
  });

  it('should create sandbox policy on agent creation', () => {
    const agent = manager.createAgent({
      name: 'Sandboxed', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const policy = manager.getSandboxPolicy(agent.id);
    expect(policy).toBeDefined();
    expect(policy!.agentId).toBe(agent.id);
  });

  it('should manage sandbox sessions', () => {
    const agent = manager.createAgent({
      name: 'Session Agent', description: 'd', capabilities: [], modelConfig: {}, tools: [], channels: [],
      owner: 'test', workspaceId: 'default',
    });
    const session = manager.createSandboxSession(agent.id);
    expect(session.sessionId).toBeDefined();
    expect(session.agentId).toBe(agent.id);
  });
});
