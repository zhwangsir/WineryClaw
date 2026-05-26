import { api } from "./client";

export interface UserProfile {
  name: string;
  interests: string[];
  communication_style: string;
  expertise_areas: string[];
  preferred_tools: string[];
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export const userProfileApi = {
  getProfile: () => api.get<{ profile: UserProfile | null }>("/user/profile"),
  refreshProfile: () => api.post<{ profile: UserProfile | null; message?: string }>("/user/profile/refresh"),
  deleteProfile: () => api.delete<{ removed: string[] }>("/user/profile"),
};
