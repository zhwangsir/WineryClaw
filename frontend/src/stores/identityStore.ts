import { create } from "zustand";
import { message } from "antd";
import { identityApi } from "../api/identity";
import type { IdentityUser } from "../api/identity";
import { createOptimisticDelete } from "./utils";

interface IdentityState {
  users: IdentityUser[];
  loading: boolean;

  fetchUsers: () => Promise<void>;
  createUser: (data: { name: string; role: string; workspaces?: string[] }) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  users: [],
  loading: false,

  fetchUsers: async () => {
    set({ loading: true });
    try {
      const users = await identityApi.listUsers();
      set({ users, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取用户失败");
    }
  },

  createUser: async (data) => {
    try {
      await identityApi.createUser(data);
      message.success("用户创建成功");
      await get().fetchUsers();
    } catch (e: any) {
      message.error(e.message || "创建用户失败");
    }
  },

  deleteUser: createOptimisticDelete<IdentityUser>(get, set, "users", identityApi.deleteUser, {
    successMsg: "用户已删除",
    errorMsg: "删除用户失败",
  }),
}));
