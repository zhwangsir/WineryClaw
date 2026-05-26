import { api } from "./client";

export interface UploadFile {
  name: string;
  url: string;
  size: number;
  type: string;
}

export const uploadsApi = {
  upload: (filename: string, data: string, type?: string) =>
    api.post<{ ok: boolean; url?: string; name?: string; size?: number; error?: string }>("/api/upload", {
      filename,
      data,
      type,
    }),
};
