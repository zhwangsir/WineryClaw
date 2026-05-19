import { api } from "./client";

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  code: string;
  language: "python" | "javascript" | "typescript";
  usageCount: number;
  successRate: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  tags: string[];
}

export interface SkillStats {
  totalSkills: number;
  totalInvocations: number;
  averageSuccessRate: number;
}

export const skillsApi = {
  list: () => api.get<{ skills: Skill[] }>("/api/skills").then((r) => r.skills),
  create: (data: {
    name: string;
    description: string;
    code: string;
    language: string;
    triggerPatterns?: string[];
    tags?: string[];
  }) => api.post<{ skill: Skill }>("/api/skills", data).then((r) => r.skill),
  get: (id: string) => api.get<{ skill: Skill }>(`/api/skills/${id}`).then((r) => r.skill),
  invoke: (id: string, params?: Record<string, unknown>, session_id?: string) =>
    api.post<{ result: unknown }>(`/api/skills/${id}/invoke`, { params, session_id }).then((r) => r.result),
  update: (id: string, data: Partial<Skill>) => api.put<{ ok: boolean; skill: Skill }>(`/api/skills/${id}`, data).then((r) => r.skill),
  delete: (id: string) => api.delete<{ ok: boolean; deleted: boolean }>(`/api/skills/${id}`),
  stats: () => api.get<SkillStats>("/api/skills/stats"),
};
