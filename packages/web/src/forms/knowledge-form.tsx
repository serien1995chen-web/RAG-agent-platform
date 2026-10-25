'use client';

import { FormControl, FormErrorMessage, FormHelperText, FormLabel } from '@chakra-ui/react';
import {
  Controller,
  useForm,
  type ControllerRenderProps,
  type FieldErrors,
  type FieldValues,
  type Path,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
} from 'react-hook-form';
import type { ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { KnowledgeRequestError } from '../client/knowledge-client';
import { useKnowledgeI18n, type MessageKey } from '../i18n';

export const newSpaceFormSchema = z.object({
  kind: z.enum(['space', 'folder']),
  name: z
    .string()
    .min(1, { message: 'validation.required' })
    .max(120, { message: 'validation.maxLength' }),
  description: z.string().max(2000, { message: 'validation.maxLength' }),
  accessMode: z.enum(['workspace', 'restricted']),
  sourceAclMode: z.enum(['inherited', 'enforced']),
  sourcePermissionEnabled: z.boolean(),
});

export const updateSpaceFormSchema = z.object({
  name: z.string().max(120, { message: 'validation.maxLength' }),
  description: z.string().max(2000, { message: 'validation.maxLength' }),
});

export const sourceFormSchema = z.object({
  kind: z.enum(['text', 'file', 'url', 'template', 'image']),
  name: z
    .string()
    .min(1, { message: 'validation.required' })
    .max(240, { message: 'validation.maxLength' }),
  directoryId: z.string(),
});

export const segmentFormSchema = z.object({
  question: z
    .string()
    .min(1, { message: 'validation.required' })
    .max(100000, { message: 'validation.maxLength' }),
  answer: z
    .string()
    .min(1, { message: 'validation.required' })
    .max(100000, { message: 'validation.maxLength' }),
});

export const tagFormSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, { message: 'validation.pattern' }),
  label: z
    .string()
    .min(1, { message: 'validation.required' })
    .max(80, { message: 'validation.maxLength' }),
  tagType: z.enum(['string', 'number', 'datetime', 'array']),
  options: z.string(),
  required: z.boolean(),
});

export const collaboratorFormSchema = z.object({
  memberId: z.string().min(1, { message: 'validation.required' }),
  role: z.enum(['read', 'write', 'manage']),
});

export const tagAssignmentFormSchema = z.object({
  sourceId: z.string().min(1, { message: 'validation.required' }),
  tagId: z.string().min(1, { message: 'validation.required' }),
  value: z.string(),
});

export type NewSpaceFormValues = z.infer<typeof newSpaceFormSchema>;
export type UpdateSpaceFormValues = z.infer<typeof updateSpaceFormSchema>;
export type SourceFormValues = z.infer<typeof sourceFormSchema>;
export type SegmentFormValues = z.infer<typeof segmentFormSchema>;
export type TagFormValues = z.infer<typeof tagFormSchema>;
export type CollaboratorFormValues = z.infer<typeof collaboratorFormSchema>;
export type TagAssignmentFormValues = z.infer<typeof tagAssignmentFormSchema>;

function zodResolver<TValues extends FieldValues>(schema: ZodType<TValues>): Resolver<TValues> {
  return async (values) => {
    const result = await schema.safeParseAsync(values);
    if (result.success) return { values: result.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join('.');
      if (key.length > 0 && errors[key] === undefined) {
        errors[key] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors: errors as FieldErrors<TValues> };
  };
}

export function useKnowledgeForm<TValues extends FieldValues>(
  schema: ZodType<TValues>,
  options: Omit<UseFormProps<NoInfer<TValues>>, 'resolver'> = {},
): UseFormReturn<TValues> {
  return useForm<TValues>({
    mode: 'onSubmit',
    ...options,
    resolver: zodResolver(schema),
  });
}

export function FormField<TValues extends FieldValues>(props: {
  control: UseFormReturn<TValues>['control'];
  name: Path<TValues>;
  label: string;
  hint?: string;
  render: (field: ControllerRenderProps<TValues, Path<TValues>>) => ReactNode;
}) {
  const { t } = useKnowledgeI18n();
  return (
    <Controller
      control={props.control}
      name={props.name}
      render={({ field, fieldState }) => (
        <FormControl isInvalid={fieldState.error !== undefined}>
          <FormLabel m={0} fontSize="xs" fontWeight="700">
            {props.label}
          </FormLabel>
          {props.render(field)}
          {fieldState.error ? (
            <FormErrorMessage>
              {fieldState.error.message?.startsWith('validation.')
                ? t(fieldState.error.message as MessageKey)
                : t('validation.invalid')}
            </FormErrorMessage>
          ) : props.hint ? (
            <FormHelperText m={0} color="kn.inkMuted" fontSize="xs">
              {props.hint}
            </FormHelperText>
          ) : null}
        </FormControl>
      )}
    />
  );
}

export async function submitWithProblem<TValues extends FieldValues>(
  action: () => Promise<void>,
  setProblem: (problem: unknown) => void,
  form?: UseFormReturn<TValues>,
): Promise<boolean> {
  setProblem(null);
  try {
    await action();
    return true;
  } catch (problem) {
    setProblem(problem);
    if (form) {
      for (const [field, message] of Object.entries(fieldErrorsFromProblem(problem))) {
        form.setError(field as Path<TValues>, { type: 'server', message });
      }
    }
    return false;
  }
}

export function fieldErrorsFromProblem(problem: unknown): Record<string, string> {
  if (!(problem instanceof KnowledgeRequestError)) return {};
  const field = problem.problem.error.details.field;
  return typeof field === 'string' && field.length > 0
    ? { [field]: problem.problem.error.code }
    : {};
}
