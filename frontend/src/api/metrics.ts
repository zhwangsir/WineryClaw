import { api } from "./client";

export const metricsApi = {
  query: (name?: string, start?: string, end?: string) =>
    api.get<Record<string, unknown>>(`/api/metrics/query${name ? `?name=${name}` : ""}${start ? `&start=${start}` : ""}${end ? `&end=${end}` : ""}`),
};
