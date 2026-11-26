'use client';

import {
  Box,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  NumberInput,
  NumberInputField,
  Select,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { useState } from 'react';
import {
  parseChunkingSettingsDraft,
  type S5ChunkingSettingsView,
  type S5ParseProviderConfigView,
} from '../forms/s5-model-parse-form';
import { Button } from './knowledge-primitives';
import type { ProviderVerificationLabel } from './s5-model-parse-state';

export interface S5ParseSettingsPanelProps {
  value: S5ChunkingSettingsView;
  providerConfig: S5ParseProviderConfigView;
  verification?: ProviderVerificationLabel;
  onChange(next: S5ChunkingSettingsView): void;
  onProviderConfigChange?(next: S5ParseProviderConfigView): void;
  onPreview(): void;
  labels?: Partial<{
    title: string;
    parser: string;
    providerProfile: string;
    fallback: string;
    imageHandling: string;
    timeout: string;
    textinMode: string;
    removeWatermark: string;
    pollInterval: string;
    training: string;
    mode: string;
    split: string;
    trigger: string;
    paragraphAi: string;
    paragraphDepth: string;
    chunkSize: string;
    minSize: string;
    splitter: string;
    overlap: string;
    indexSize: string;
    qaPrompt: string;
    preview: string;
    noJob: string;
    providerLiteparse: string;
    providerSangfor: string;
    providerSomark: string;
    providerTextin: string;
    providerDoc2x: string;
    fallbackLiteparse: string;
    fallbackNone: string;
    pdfFallback: string;
    imageUpload: string;
    imageKeepUrl: string;
    imageDrop: string;
    trainingChunk: string;
    trainingQa: string;
    trainingImageParse: string;
    trainingBackup: string;
    trainingTemplate: string;
    modeAuto: string;
    modeIntelligent: string;
    modeCustom: string;
    splitParagraph: string;
    splitSize: string;
    splitChar: string;
  }>;
}

function providerConfigFor(
  provider: S5ParseProviderConfigView['provider'],
  previous: S5ParseProviderConfigView,
): S5ParseProviderConfigView {
  if (provider === 'liteparse') {
    return {
      provider: 'liteparse',
      ocrEnabled: false,
      maxPages: 100_000,
      batchPages: 100,
      fallbackPdfJsOnWasmLoadError: true,
      timeoutMs: 600_000,
    };
  }
  const common = {
    provider,
    credentialProfileId: previous.provider === 'liteparse' ? '' : previous.credentialProfileId,
    fallbackProvider: previous.provider === 'liteparse' ? 'liteparse' : previous.fallbackProvider,
    imageHandling: previous.provider === 'liteparse' ? 'upload_to_storage' : previous.imageHandling,
    timeoutMs: previous.timeoutMs,
  } as const;
  if (provider === 'textin') {
    return {
      ...common,
      provider,
      parseMode: previous.provider === 'textin' ? previous.parseMode : 'auto',
      removeWatermark: previous.provider === 'textin' ? previous.removeWatermark : true,
    };
  }
  if (provider === 'doc2x') {
    return {
      ...common,
      provider,
      pollIntervalMs: previous.provider === 'doc2x' ? previous.pollIntervalMs : 5_000,
    };
  }
  if (provider === 'sangfor') {
    return {
      ...common,
      provider,
      ...(previous.provider === 'sangfor'
        ? {
            keepHeaderFooter: previous.keepHeaderFooter,
            keepAppendix: previous.keepAppendix,
            imageAnalysis: previous.imageAnalysis,
            chartAnalysis: previous.chartAnalysis,
          }
        : {}),
    };
  }
  return { ...common, provider };
}

export function S5ParseSettingsPanel(props: S5ParseSettingsPanelProps) {
  const [settings, setSettings] = useState<S5ChunkingSettingsView>(props.value);
  const [providerConfig, setProviderConfig] = useState<S5ParseProviderConfigView>(
    props.providerConfig,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const labels = {
    title: 'Parser and processing',
    parser: 'Parser',
    providerProfile: 'Credential profile',
    fallback: 'Fallback',
    imageHandling: 'Images',
    timeout: 'Timeout (ms)',
    textinMode: 'TextIn parse mode',
    removeWatermark: 'Remove watermark',
    pollInterval: 'Doc2X poll interval (ms)',
    training: 'Training type',
    mode: 'Chunk mode',
    split: 'Split mode',
    trigger: 'Chunk trigger',
    paragraphAi: 'Paragraph AI mode',
    paragraphDepth: 'Maximum paragraph depth',
    chunkSize: 'Chunk size',
    minSize: 'Minimum size',
    splitter: 'Custom separators',
    overlap: 'Overlap',
    indexSize: 'Index size',
    qaPrompt: 'QA instructions',
    preview: 'Preview configuration',
    noJob: 'Configuration preview only',
    providerLiteparse: 'LiteParse',
    providerSangfor: 'Sangfor',
    providerSomark: 'Somark',
    providerTextin: 'Textin',
    providerDoc2x: 'Doc2x',
    fallbackLiteparse: 'LiteParse',
    fallbackNone: 'None',
    pdfFallback: 'Fall back to PDF.js when loading fails',
    imageUpload: 'Upload',
    imageKeepUrl: 'Keep URL',
    imageDrop: 'Drop',
    trainingChunk: 'Chunk',
    trainingQa: 'QA',
    trainingImageParse: 'Image parse',
    trainingBackup: 'Backup',
    trainingTemplate: 'Template',
    modeAuto: 'Auto',
    modeIntelligent: 'Intelligent',
    modeCustom: 'Custom',
    splitParagraph: 'Paragraph',
    splitSize: 'Size',
    splitChar: 'Character',
    ...props.labels,
  };

  const commit = (next: S5ChunkingSettingsView) => {
    setSettings(next);
    props.onChange(next);
    const parsed = parseChunkingSettingsDraft(next);
    setErrors(parsed.success ? {} : parsed.errors);
  };

  const setField = <K extends keyof S5ChunkingSettingsView>(
    key: K,
    value: S5ChunkingSettingsView[K],
  ) => {
    commit({ ...settings, [key]: value });
  };

  const commitProvider = (next: S5ParseProviderConfigView) => {
    setProviderConfig(next);
    props.onProviderConfigChange?.(next);
  };

  return (
    <Box as="section" aria-label={labels.title} borderTopWidth="1px" borderColor="kn.line" py={4}>
      <Box
        display="grid"
        gridTemplateColumns={{ base: '1fr', md: 'repeat(2, minmax(0, 1fr))' }}
        gap={4}
      >
        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.parser}
          </FormLabel>
          <Select
            size="sm"
            value={providerConfig.provider}
            onChange={(event) =>
              commitProvider(
                providerConfigFor(
                  event.target.value as S5ParseProviderConfigView['provider'],
                  providerConfig,
                ),
              )
            }
          >
            <option value="liteparse">{labels.providerLiteparse}</option>
            <option value="sangfor">{labels.providerSangfor}</option>
            <option value="somark">{labels.providerSomark}</option>
            <option value="textin">{labels.providerTextin}</option>
            <option value="doc2x">{labels.providerDoc2x}</option>
          </Select>
          {props.verification ? (
            <Text
              mt={1}
              fontSize="xs"
              color={props.verification === 'real' ? 'kn.success' : 'kn.inkMuted'}
            >
              {props.verification.toUpperCase()}
            </Text>
          ) : null}
        </FormControl>

        {providerConfig.provider !== 'liteparse' ? (
          <>
            <FormControl isInvalid={Boolean(errors.providerProfile)}>
              <FormLabel fontSize="xs" fontWeight="700">
                {labels.providerProfile}
              </FormLabel>
              <Input
                size="sm"
                value={providerConfig.credentialProfileId}
                onChange={(event) =>
                  commitProvider({ ...providerConfig, credentialProfileId: event.target.value })
                }
              />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="xs" fontWeight="700">
                {labels.fallback}
              </FormLabel>
              <Select
                size="sm"
                value={providerConfig.fallbackProvider}
                onChange={(event) =>
                  commitProvider({
                    ...providerConfig,
                    fallbackProvider: event.target.value as 'liteparse' | 'none',
                  })
                }
              >
                <option value="liteparse">{labels.fallbackLiteparse}</option>
                <option value="none">{labels.fallbackNone}</option>
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel fontSize="xs" fontWeight="700">
                {labels.timeout}
              </FormLabel>
              <NumberInput
                min={1_000}
                max={600_000}
                value={providerConfig.timeoutMs}
                onChange={(_value, valueNumber) =>
                  commitProvider({
                    ...providerConfig,
                    timeoutMs: Number.isFinite(valueNumber) ? valueNumber : 120_000,
                  })
                }
              >
                <NumberInputField aria-label={labels.timeout} />
              </NumberInput>
            </FormControl>
            {providerConfig.provider === 'textin' ? (
              <>
                <FormControl>
                  <FormLabel fontSize="xs" fontWeight="700">
                    {labels.textinMode}
                  </FormLabel>
                  <Select
                    size="sm"
                    value={providerConfig.parseMode}
                    onChange={(event) =>
                      commitProvider({
                        ...providerConfig,
                        parseMode: event.target.value as 'auto' | 'scan',
                      })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="scan">Scan</option>
                  </Select>
                </FormControl>
                <Checkbox
                  size="sm"
                  isChecked={providerConfig.removeWatermark}
                  mt={7}
                  onChange={(event) =>
                    commitProvider({
                      ...providerConfig,
                      removeWatermark: event.target.checked,
                    })
                  }
                >
                  {labels.removeWatermark}
                </Checkbox>
              </>
            ) : null}
            {providerConfig.provider === 'doc2x' ? (
              <FormControl>
                <FormLabel fontSize="xs" fontWeight="700">
                  {labels.pollInterval}
                </FormLabel>
                <NumberInput
                  min={100}
                  max={60_000}
                  value={providerConfig.pollIntervalMs}
                  onChange={(_value, valueNumber) =>
                    commitProvider({
                      ...providerConfig,
                      pollIntervalMs: Number.isFinite(valueNumber) ? valueNumber : 5_000,
                    })
                  }
                >
                  <NumberInputField aria-label={labels.pollInterval} />
                </NumberInput>
              </FormControl>
            ) : null}
            <FormControl>
              <FormLabel fontSize="xs" fontWeight="700">
                {labels.imageHandling}
              </FormLabel>
              <Select
                size="sm"
                value={providerConfig.imageHandling}
                onChange={(event) =>
                  commitProvider({
                    ...providerConfig,
                    imageHandling: event.target.value as 'upload_to_storage' | 'keep_url' | 'drop',
                  })
                }
              >
                <option value="upload_to_storage">{labels.imageUpload}</option>
                <option value="keep_url">{labels.imageKeepUrl}</option>
                <option value="drop">{labels.imageDrop}</option>
              </Select>
            </FormControl>
          </>
        ) : (
          <Checkbox
            size="sm"
            isChecked={providerConfig.fallbackPdfJsOnWasmLoadError}
            mt={7}
            onChange={(event) =>
              commitProvider({
                ...providerConfig,
                fallbackPdfJsOnWasmLoadError: event.target.checked,
              })
            }
          >
            {labels.pdfFallback}
          </Checkbox>
        )}

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.training}
          </FormLabel>
          <Select
            size="sm"
            value={settings.trainingType}
            onChange={(event) =>
              setField('trainingType', event.target.value as S5ChunkingSettingsView['trainingType'])
            }
          >
            <option value="chunk">{labels.trainingChunk}</option>
            <option value="qa">{labels.trainingQa}</option>
            <option value="imageParse">{labels.trainingImageParse}</option>
            <option value="backup">{labels.trainingBackup}</option>
            <option value="template">{labels.trainingTemplate}</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.mode}
          </FormLabel>
          <Select
            size="sm"
            value={settings.chunkSettingMode}
            onChange={(event) =>
              setField(
                'chunkSettingMode',
                event.target.value as S5ChunkingSettingsView['chunkSettingMode'],
              )
            }
          >
            <option value="auto">{labels.modeAuto}</option>
            <option value="intelligent">{labels.modeIntelligent}</option>
            <option value="custom">{labels.modeCustom}</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.split}
          </FormLabel>
          <Select
            size="sm"
            value={settings.chunkSplitMode ?? 'paragraph'}
            onChange={(event) =>
              setField(
                'chunkSplitMode',
                event.target.value as S5ChunkingSettingsView['chunkSplitMode'],
              )
            }
          >
            <option value="paragraph">{labels.splitParagraph}</option>
            <option value="size">{labels.splitSize}</option>
            <option value="char">{labels.splitChar}</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.trigger}
          </FormLabel>
          <Select
            size="sm"
            value={settings.chunkTriggerType ?? 'minSize'}
            onChange={(event) =>
              setField(
                'chunkTriggerType',
                event.target.value as S5ChunkingSettingsView['chunkTriggerType'],
              )
            }
          >
            <option value="minSize">Minimum size</option>
            <option value="maxSize">Maximum size</option>
            <option value="forceChunk">Force chunk</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.paragraphAi}
          </FormLabel>
          <Select
            size="sm"
            value={settings.paragraphChunkAIMode ?? 'auto'}
            onChange={(event) =>
              setField(
                'paragraphChunkAIMode',
                event.target.value as S5ChunkingSettingsView['paragraphChunkAIMode'],
              )
            }
          >
            <option value="auto">Auto</option>
            <option value="force">Force</option>
            <option value="forbid">Forbid</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.paragraphDepth}
          </FormLabel>
          <NumberInput
            min={1}
            max={8}
            value={settings.paragraphChunkDeep ?? 5}
            onChange={(_value, valueNumber) =>
              setField('paragraphChunkDeep', Number.isFinite(valueNumber) ? valueNumber : 5)
            }
          >
            <NumberInputField aria-label={labels.paragraphDepth} />
          </NumberInput>
        </FormControl>

        <FormControl isInvalid={Boolean(errors.chunkSize)}>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.chunkSize}
          </FormLabel>
          <NumberInput
            min={settings.trainingType === 'qa' ? 1_000 : 64}
            max={8_000}
            value={settings.chunkSize ?? 1_000}
            onChange={(_value, valueNumber) =>
              setField('chunkSize', Number.isFinite(valueNumber) ? valueNumber : 1_000)
            }
          >
            <NumberInputField aria-label={labels.chunkSize} />
          </NumberInput>
          {errors.chunkSize ? (
            <Text mt={1} fontSize="xs" color="kn.danger">
              {errors.chunkSize}
            </Text>
          ) : null}
        </FormControl>

        <FormControl isInvalid={Boolean(errors.overlap)}>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.overlap}
          </FormLabel>
          <NumberInput
            min={0}
            max={7_999}
            value={settings.overlap ?? 0}
            onChange={(_value, valueNumber) =>
              setField('overlap', Number.isFinite(valueNumber) ? valueNumber : 0)
            }
          >
            <NumberInputField aria-label={labels.overlap} />
          </NumberInput>
        </FormControl>

        <FormControl>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.indexSize}
          </FormLabel>
          <NumberInput
            min={1}
            max={8_000}
            value={settings.indexSize ?? 1_000}
            onChange={(_value, valueNumber) =>
              setField('indexSize', Number.isFinite(valueNumber) ? valueNumber : 1_000)
            }
          >
            <NumberInputField aria-label={labels.indexSize} />
          </NumberInput>
        </FormControl>

        <FormControl isInvalid={Boolean(errors.paragraphChunkMinSize)}>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.minSize}
          </FormLabel>
          <NumberInput
            min={1}
            max={8_000}
            value={settings.paragraphChunkMinSize ?? 100}
            onChange={(_value, valueNumber) =>
              setField('paragraphChunkMinSize', Number.isFinite(valueNumber) ? valueNumber : 100)
            }
          >
            <NumberInputField aria-label={labels.minSize} />
          </NumberInput>
        </FormControl>

        <FormControl gridColumn={{ md: '1 / -1' }} isInvalid={Boolean(errors.chunkSplitter)}>
          <FormLabel fontSize="xs" fontWeight="700">
            {labels.splitter}
          </FormLabel>
          <Textarea
            size="sm"
            minH="80px"
            maxLength={1_000}
            value={settings.chunkSplitter ?? ''}
            onChange={(event) => setField('chunkSplitter', event.target.value)}
          />
        </FormControl>

        {settings.trainingType === 'qa' ? (
          <FormControl gridColumn={{ md: '1 / -1' }} isInvalid={Boolean(errors.qaPrompt)}>
            <FormLabel fontSize="xs" fontWeight="700">
              {labels.qaPrompt}
            </FormLabel>
            <Textarea
              size="sm"
              minH="100px"
              maxLength={20_000}
              value={settings.qaPrompt ?? ''}
              onChange={(event) => setField('qaPrompt', event.target.value)}
            />
          </FormControl>
        ) : null}
      </Box>
      <Box mt={4}>
        <Button size="sm" tone="primary" onClick={props.onPreview}>
          {labels.preview}
        </Button>
      </Box>
    </Box>
  );
}
