import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * supabase.functions.invoke() hides non-2xx response bodies behind
 * error.context — this pulls out the function's own { error } message.
 */
export async function readFunctionsError(error: unknown, fallback: string): Promise<string> {
  try {
    const response = (error as { context?: Response })?.context;
    if (response && typeof response.json === "function") {
      const parsed = await response.clone().json();
      if (parsed?.error) return String(parsed.error);
    }
  } catch {
    /* fall through */
  }
  const message = (error as { message?: string })?.message;
  return message || fallback;
}
