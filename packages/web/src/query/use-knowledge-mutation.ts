'use client';

import { useCallback, useRef } from 'react';
import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';

export interface SingleFlight<TResult> {
  run(start: () => Promise<TResult>): Promise<TResult>;
}

export function createSingleFlight<TResult>(): SingleFlight<TResult> {
  let inFlight: Promise<TResult> | null = null;

  return {
    run(start) {
      if (inFlight) return inFlight;

      const request = start();
      inFlight = request;
      void request.then(
        () => {
          if (inFlight === request) inFlight = null;
        },
        () => {
          if (inFlight === request) inFlight = null;
        },
      );
      return request;
    },
  };
}

export type KnowledgeMutationOptions<TResult, TVariables, TContext = unknown> = UseMutationOptions<
  TResult,
  Error,
  TVariables,
  TContext
> & {
  invalidateKeys?: readonly QueryKey[];
};

export function useKnowledgeMutation<TResult, TVariables, TContext = unknown>(
  options: KnowledgeMutationOptions<TResult, TVariables, TContext>,
): UseMutationResult<TResult, Error, TVariables, TContext> {
  const queryClient = useQueryClient();
  const { invalidateKeys = [], onSuccess, ...rest } = options;
  const mutation = useMutation<TResult, Error, TVariables, TContext>({
    ...rest,
    onSuccess: async (data, variables, context) => {
      await onSuccess?.(data, variables, context);
      await Promise.all(
        invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
  const singleFlight = useRef<SingleFlight<TResult> | null>(null);
  if (!singleFlight.current) singleFlight.current = createSingleFlight<TResult>();

  const mutateAsync = useCallback(
    (variables: TVariables, callbacks?: Parameters<typeof mutation.mutateAsync>[1]) => {
      return singleFlight.current!.run(() => mutation.mutateAsync(variables, callbacks));
    },
    [mutation.mutateAsync],
  );

  const mutate = useCallback(
    (variables: TVariables, callbacks?: Parameters<typeof mutation.mutate>[1]) => {
      void mutateAsync(variables, callbacks).catch(() => undefined);
    },
    [mutateAsync],
  );

  return { ...mutation, mutate, mutateAsync };
}
