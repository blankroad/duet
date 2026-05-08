import { useCallback, useState } from "react";
import { commands } from "@/types/bindings";
import type { DuetError } from "@/types/bindings";

/**
 * Tauri command 호출용 hook.
 *
 * - command 함수와 인자 타입을 그대로 받아서 호출
 * - 로딩 / 에러 상태를 React 상태로 노출
 * - useEffect 데이터 페칭 금지 (CLAUDE.md §1): 이 hook을 통해서만
 *
 * @example
 * ```tsx
 * const { data, loading, error, call } = useTauri("listDirectory");
 * // data: Entry[] | null, loading: boolean, error: DuetError | null
 * await call({ source: { kind: "local" }, path: "/tmp" });
 * ```
 */
export type CommandsApi = typeof commands;
export type CommandName = keyof CommandsApi;

/** Return type exposed to consumers. */
interface UseTauriResult<T> {
  data: T | null;
  loading: boolean;
  error: DuetError | null;
  /** Invoke the command. Throws the DuetError on status: "error". */
  call: (...args: unknown[]) => Promise<T>;
}

/**
 * React hook that wraps a tauri-specta generated command function.
 *
 * The `any` casts in the implementation are intentional bridges between the
 * statically-typed command dispatch and the generic hook signature —
 * they are not part of the hook's external API surface.
 */
export function useTauri<K extends CommandName>(
  cmd: K,
): UseTauriResult<
  Awaited<ReturnType<CommandsApi[K]>> extends { status: "ok"; data: infer D } ? D : never
> {
  type Out = Awaited<ReturnType<CommandsApi[K]>> extends { status: "ok"; data: infer D }
    ? D
    : never;

  const [data, setData] = useState<Out | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DuetError | null>(null);

  const call = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (...args: any[]): Promise<Out> => {
      setLoading(true);
      setError(null);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await (commands as any)[cmd](...args);
        if (result.status === "ok") {
          setData(result.data as Out);
          return result.data as Out;
        } else {
          setError(result.error as DuetError);
          throw result.error as DuetError;
        }
      } finally {
        setLoading(false);
      }
    },
    [cmd],
  );

  return { data, loading, error, call };
}
