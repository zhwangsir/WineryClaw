import { api } from "./client";

export interface IdentityUser {
  id: string;
  name: string;
  role: string;
  workspaces: string[];
  createdAt: string;
}

export const identityApi = {
  listUsers: () => api.get<{ users: IdentityUser[] }>("/api/identity/users").then((r) => r.users),
  getUser: (id: string) => api.get<{ ok: boolean; user: IdentityUser }>(`/api/identity/user/${id}`).then((r) => r.user),
  createUser: (data: { name: string; role: string; workspaces?: string[] }) =>
    api.post<{ user: IdentityUser }>("/api/identity/user", data).then((r) => r.user),
  checkWorkspaceAccess: (userId: string, workspaceId: string) =>
    api.get<{ ok: boolean; access: boolean }>(`/api/identity/user/${userId}/workspaces/${workspaceId}`).then((r) => r.access),
  deleteUser: (id: string) => api.delete(`/api/identity/user/${id}`).then((r: any) => r.ok),
};
