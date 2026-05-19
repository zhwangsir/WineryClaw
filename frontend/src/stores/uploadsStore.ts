import { create } from "zustand";
import { message } from "antd";
import { uploadsApi } from "../api/uploads";

interface UploadsState {
  loading: boolean;
  upload: (file: File) => Promise<void>;
}

export const useUploadsStore = create<UploadsState>((set) => ({
  loading: false,

  upload: async (file) => {
    set({ loading: true });
    try {
      const reader = new FileReader();
      const data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await uploadsApi.upload(file.name, data, file.type);
      if (res.ok) {
        message.success(`上传成功: ${res.name}`);
      } else {
        message.error(res.error || "上传失败");
      }
    } catch (e: any) {
      message.error(e.message || "上传失败");
    } finally {
      set({ loading: false });
    }
  },
}));
