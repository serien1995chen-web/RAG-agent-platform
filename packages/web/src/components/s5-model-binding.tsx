'use client';

import { Box, Checkbox, Flex, FormControl, FormLabel, Select, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import { Button } from './knowledge-primitives';
import {
  canSaveBinding,
  groupModelsByType,
  mergeBindingDraft,
  selectedModelCapabilities,
  stateFromProblem,
  toS5ProblemView,
  type S5ModelBindingView,
  type S5ModelParseState,
  type S5ModelView,
  type S5ProblemView,
} from './s5-model-parse-state';

export interface S5ModelValidationView {
  valid: boolean;
  modelId: string;
  modelType: S5ModelView['type'];
  capabilities: string[];
}

export interface S5ModelBindingPanelProps {
  models: readonly S5ModelView[];
  bindings: readonly S5ModelBindingView[];
  spaceVersion: number;
  onValidate(binding: S5ModelBindingView): Promise<S5ModelValidationView>;
  onSave(input: { bindings: S5ModelBindingView[]; version: number }): Promise<void>;
  labels?: Partial<{
    title: string;
    validate: string;
    save: string;
    noModels: string;
    capabilities: string;
    disabled: string;
  }>;
  messageFor?: (problem: S5ProblemView) => string;
}

const TYPE_LABELS: Record<S5ModelView['type'], string> = {
  llm: 'LLM',
  embedding: 'Embedding',
  rerank: 'Rerank',
  vlm: 'VLM',
  stt: 'STT',
  tts: 'TTS',
};

export function S5ModelBindingPanel(props: S5ModelBindingPanelProps) {
  const [draft, setDraft] = useState<S5ModelBindingView[]>(() => [...props.bindings]);
  const [validated, setValidated] = useState<Set<string>>(
    () => new Set(props.bindings.map((binding) => binding.modelType)),
  );
  const [state, setState] = useState<S5ModelParseState>('idle');
  const [problem, setProblem] = useState<S5ProblemView | null>(null);
  const groups = useMemo(() => groupModelsByType(props.models), [props.models]);
  const byType = useMemo(
    () => new Map(draft.map((binding) => [binding.modelType, binding])),
    [draft],
  );
  const labels = {
    title: 'Model bindings',
    validate: 'Validate',
    save: 'Save bindings',
    noModels: 'No authorized models',
    capabilities: 'Required capabilities',
    disabled: 'Disabled',
    ...props.labels,
  };

  const updateBinding = (binding: S5ModelBindingView) => {
    setValidated((current) => {
      const next = new Set(current);
      next.delete(binding.modelType);
      return next;
    });
    setDraft((current) => mergeBindingDraft(current, binding));
    setState('idle');
    setProblem(null);
  };

  const removeBinding = (modelType: S5ModelView['type']) => {
    setValidated((current) => {
      const next = new Set(current);
      next.delete(modelType);
      return next;
    });
    setDraft((current) => current.filter((binding) => binding.modelType !== modelType));
    setState('idle');
    setProblem(null);
  };

  const validate = async () => {
    setState('validating');
    setProblem(null);
    const accepted = new Set<string>();
    try {
      for (const binding of draft) {
        const result = await props.onValidate(binding);
        if (result.valid) accepted.add(binding.modelType);
      }
      setValidated(accepted);
      setState(accepted.size === draft.length ? 'ready' : 'validation');
    } catch (error) {
      setState(stateFromProblem(error));
      setProblem(toS5ProblemView(error));
    }
  };

  const save = async () => {
    setState('saving');
    setProblem(null);
    try {
      await props.onSave({ bindings: draft, version: props.spaceVersion });
      setState('ready');
    } catch (error) {
      setState(stateFromProblem(error));
      setProblem(toS5ProblemView(error));
    }
  };

  if (groups.length === 0) {
    return (
      <Box as="section" aria-label={labels.title} borderTopWidth="1px" borderColor="kn.line" py={4}>
        <Text fontWeight="700">{labels.title}</Text>
        <Text color="kn.inkMuted" fontSize="sm">
          {labels.noModels}
        </Text>
      </Box>
    );
  }

  return (
    <Box as="section" aria-label={labels.title} borderTopWidth="1px" borderColor="kn.line" py={4}>
      <Flex justify="space-between" align="center" gap={3} mb={4} wrap="wrap">
        <Text fontWeight="700">{labels.title}</Text>
        <Text color="kn.inkMuted" fontSize="xs">
          v{props.spaceVersion}
        </Text>
      </Flex>
      <Box
        display="grid"
        gridTemplateColumns={{ base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }}
        gap={4}
      >
        {groups.map((group) => {
          const current = byType.get(group.type);
          const selected = group.models.find((model) => model.modelId === current?.modelId);
          return (
            <Box key={group.type} minW={0}>
              <FormControl>
                <FormLabel fontSize="xs" fontWeight="700">
                  {TYPE_LABELS[group.type]}
                </FormLabel>
                <Select
                  size="sm"
                  aria-label={TYPE_LABELS[group.type]}
                  value={selected?.modelId ?? ''}
                  onChange={(event) => {
                    if (event.target.value === '') {
                      removeBinding(group.type);
                      return;
                    }
                    const model = group.models.find(
                      (candidate) => candidate.modelId === event.target.value,
                    );
                    if (!model) return;
                    updateBinding({
                      modelType: model.type,
                      modelId: model.modelId,
                      displayName: model.displayName,
                      requiredCapabilities: selectedModelCapabilities(props.models, model.modelId),
                      status: 'active',
                    });
                  }}
                >
                  <option value="">-</option>
                  {group.models.map((model) => (
                    <option key={model.modelId} value={model.modelId}>
                      {model.displayName}
                    </option>
                  ))}
                </Select>
              </FormControl>
              {selected ? (
                <Box mt={2}>
                  <Text fontSize="xs" color="kn.inkMuted" mb={1}>
                    {labels.capabilities}
                  </Text>
                  <Flex gap={2} wrap="wrap">
                    {selectedModelCapabilities(props.models, selected.modelId).map((capability) => {
                      const checked = current?.requiredCapabilities.includes(capability) ?? false;
                      return (
                        <Checkbox
                          key={capability}
                          size="sm"
                          isChecked={checked}
                          onChange={(event) => {
                            if (!current) return;
                            updateBinding({
                              ...current,
                              requiredCapabilities: event.target.checked
                                ? [...current.requiredCapabilities, capability].sort()
                                : current.requiredCapabilities.filter(
                                    (entry) => entry !== capability,
                                  ),
                            });
                          }}
                        >
                          {capability}
                        </Checkbox>
                      );
                    })}
                  </Flex>
                  <Checkbox
                    mt={2}
                    size="sm"
                    isChecked={current?.status === 'disabled'}
                    onChange={(event) =>
                      current &&
                      updateBinding({
                        ...current,
                        status: event.target.checked ? 'disabled' : 'active',
                      })
                    }
                  >
                    {labels.disabled}
                  </Checkbox>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {problem ? (
        <Text role="alert" mt={3} color="kn.danger" fontSize="sm">
          {(props.messageFor ?? ((entry) => entry.messageKey))(problem)}
        </Text>
      ) : null}
      <Flex gap={2} mt={4} wrap="wrap">
        <Button
          size="sm"
          tone="primary"
          busy={state === 'validating'}
          onClick={() => void validate()}
        >
          {labels.validate}
        </Button>
        <Button
          size="sm"
          busy={state === 'saving'}
          isDisabled={
            !canSaveBinding({ state, bindings: draft }) || validated.size !== draft.length
          }
          onClick={() => void save()}
        >
          {labels.save}
        </Button>
      </Flex>
    </Box>
  );
}
