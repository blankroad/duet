import { useCallback, useState } from "react";
import { commands } from "@/types/bindings";
import type { DuetError } from "@/types/bindings";

/**
 * Frontend 에러 표현. 백엔드의 DuetError + IPC 통신 자체 실패 케이스.
 *
 * specta가 DuetError를 closed discriminated union으로 재생성한 이후에도
 * IpcError variant를 유지하기 위해 FrontendError를 별도로 정의한다.
 */
export type FrontendError = DuetError | { kind: "IpcError"; message: string };

/**
 * Tauri command 호출용 hook.
 *
 * - command 함수와 인자 타입을 그대로 받아서 호출
 * - 로딩 / 에러 상태를 React 상태로 노출
 * - useEffect 데이터 페칭 금지 (CLAUDE.md §1): 이 hook을 통해서만
 *
 * 에러 처리:
 * - command가 `{ status: "error", error }` 반환 → `error` state에 저장 + throw
 * - IPC 자체가 reject (deserialize 실패, 채널 끊김 등) → `IpcError` 변환 후 동일 처리
 *
 * @example
 * ```tsx
 * const { data, loading, error, call } = useTauri("listDirectory");
 * // data: Entry[] | null, loading: boolean, error: FrontendError | null
 * await call({ source: { kind: "local" }, path: "/tmp" });
 * ```
 */
export type CommandsApi = typeof commands;
export type CommandName = keyof CommandsApi;

type SuccessData<K extends CommandName> = Awaited<
  ReturnType<CommandsApi[K]>
> extends { status: "ok"; data: infer D }
  ? D
  : never;

export interface UseTauriResult<K extends CommandName> {
  data: SuccessData<K> | null;
  loading: boolean;
  error: FrontendError | null;
  /** Invoke the command. Throws the FrontendError on status: "error" or IPC rejection. */
  call: (...args: Parameters<CommandsApi[K]>) => Promise<SuccessData<K>>;
}

/**
 * React hook that wraps a tauri-specta generated command function.
 *
 * The `any` cast in the implementation is an intentional bridge between the
 * statically-typed command dispatch and the generic hook signature —
 * it is not part of the hook's external API surface.
 */
export function useTauri<K extends CommandName>(cmd: K): UseTauriResult<K> {
  const [data, setData] = useState<SuccessData<K> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FrontendError | null>(null);

  const call = useCallback(
    async (...args: Parameters<CommandsApi[K]>): Promise<SuccessData<K>> => {
      setLoading(true);
      setError(null);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (commands[cmd] as any)(...args);
        if (result.status === "ok") {
          setData(result.data as SuccessData<K>);
          return result.data as SuccessData<K>;
        } else {
          setError(result.error as DuetError);
          throw result.error as DuetError;
        }
      } catch (raw: unknown) {
        // status:"error" 분기에서 throw한 경우엔 이미 DuetError 형태.
        // 네트워크/IPC 자체 reject (채널 끊김 등)는 별도로 IpcError로 변환.
        if (!isDuetError(raw)) {
          const ipcErr: FrontendError = {
            kind: "IpcError",
            message: String(raw),
          };
          setError(ipcErr);
          throw ipcErr;
        }
        throw raw;
      } finally {
        setLoading(false);
      }
    },
    [cmd],
  );

  return { data, loading, error, call };
}

function isDuetError(x: unknown): x is DuetError {
  return (
    typeof x === "object" &&
    x !== null &&
    "kind" in x &&
    typeof (x as { kind: unknown }).kind === "string"
  );
}
