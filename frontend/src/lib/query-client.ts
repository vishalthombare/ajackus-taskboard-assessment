import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();

export function clearQueryCache() {
  void queryClient.cancelQueries();
  queryClient.clear();
}
