'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Box,
  Button as ChakraButton,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  Input,
  Select,
  Skeleton,
  Stack,
  Text,
  Textarea,
  type ButtonProps,
  type InputProps,
  type SelectProps,
  type TextareaProps,
} from '@chakra-ui/react';
import {
  forwardRef,
  useEffect,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from 'react';
import { KnowledgeRequestError } from '../client/knowledge-client';
import { enumMessageKey, statusMessageKey, toProblemView, useKnowledgeI18n } from '../i18n';

export function PageHeader(props: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <Flex
      as="header"
      className="page-header"
      align={{ base: 'start', md: 'end' }}
      justify="space-between"
      direction={{ base: 'column', md: 'row' }}
      gap={6}
      pb={5}
      borderBottomWidth="2px"
      borderColor="kn.ink"
      mb={7}
    >
      <Box>
        {props.eyebrow ? (
          <Text
            className="eyebrow"
            m={0}
            mb={3}
            color="kn.primary"
            fontSize="xs"
            fontWeight="700"
            textTransform="uppercase"
          >
            {props.eyebrow}
          </Text>
        ) : null}
        <Heading
          as="h1"
          m={0}
          maxW="760px"
          fontFamily="heading"
          fontSize={{ base: '24px', md: '32px' }}
          lineHeight={{ base: '34px', md: '42px' }}
          letterSpacing={0}
          fontWeight="700"
        >
          {props.title}
        </Heading>
        {props.description ? (
          <Text className="page-description" maxW="700px" mt="14px" mb={0} color="kn.inkMuted">
            {props.description}
          </Text>
        ) : null}
      </Box>
      {props.actions ? (
        <Flex className="page-actions" gap={2} align="center" wrap="wrap" justify="flex-start">
          {props.actions}
        </Flex>
      ) : null}
    </Flex>
  );
}

export function Section(props: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box as="section" className="section" mt={8} borderTopWidth="1px" borderColor="kn.ink" pt={3}>
      <Flex className="section-header" align="flex-start" justify="space-between" gap={5} mb="18px">
        <Box>
          <Heading as="h2" m={0} fontSize="lg" lineHeight="30px" letterSpacing={0}>
            {props.title}
          </Heading>
          {props.meta ? (
            <Text mt={1} mb={0} color="kn.inkMuted" fontSize="xs">
              {props.meta}
            </Text>
          ) : null}
        </Box>
        {props.actions ? (
          <Flex className="section-actions" gap={2} align="center" wrap="wrap">
            {props.actions}
          </Flex>
        ) : null}
      </Flex>
      {props.children}
    </Box>
  );
}

type KnowledgeButtonProps = Omit<ButtonProps, 'colorScheme'> & {
  tone?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  href?: string;
};

const PolymorphicButton = ChakraButton as unknown as ComponentType<KnowledgeButtonProps>;

export function Button(props: KnowledgeButtonProps) {
  const { tone = 'secondary', busy = false, children, href, ...rest } = props;
  const { t } = useKnowledgeI18n();
  const toneProps =
    tone === 'primary'
      ? {
          bg: 'kn.primary',
          color: 'kn.surface',
          borderColor: 'kn.primary',
          _hover: { bg: 'kn.primaryHover', borderColor: 'kn.primaryHover' },
        }
      : tone === 'danger'
        ? {
            variant: 'outline' as const,
            borderColor: 'kn.danger',
            color: 'kn.danger',
            _hover: { bg: 'color-mix(in srgb, var(--kn-danger) 8%, var(--kn-surface))' },
          }
        : {
            variant: 'outline' as const,
            borderColor: 'kn.line',
            color: 'kn.ink',
            _hover: { borderColor: 'kn.primary', color: 'kn.primary' },
          };

  return (
    <PolymorphicButton
      {...toneProps}
      {...rest}
      as={href ? 'a' : undefined}
      href={href}
      minH="36px"
      px="13px"
      py={2}
      borderRadius="sm"
      isLoading={busy}
      loadingText={t('common.working')}
      aria-busy={busy}
    >
      {children}
    </PolymorphicButton>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <FormControl className="field">
      <FormLabel m={0} fontSize="xs" fontWeight="700">
        {props.label}
      </FormLabel>
      {props.children}
      {props.hint ? (
        <FormHelperText m={0} color="kn.inkMuted" fontSize="xs">
          {props.hint}
        </FormHelperText>
      ) : null}
    </FormControl>
  );
}

type KnowledgeInputProps = Omit<InputProps, 'isDisabled' | 'isRequired'> & {
  required?: boolean;
  disabled?: boolean;
};

export const TextInput = forwardRef<HTMLInputElement, KnowledgeInputProps>(
  function TextInput(props, ref) {
    const { className, required, disabled, ...rest } = props;
    return (
      <Input
        {...rest}
        ref={ref}
        isRequired={required}
        isDisabled={disabled}
        className={`text-input${className ? ` ${className}` : ''}`}
        minH="38px"
        px="9px"
        py={2}
        size="sm"
        bg="kn.surface"
        borderRadius="sm"
      />
    );
  },
);

type KnowledgeSelectProps = Omit<SelectProps, 'isDisabled' | 'isRequired'> & {
  required?: boolean;
  disabled?: boolean;
};

export const SelectInput = forwardRef<HTMLSelectElement, KnowledgeSelectProps>(
  function SelectInput(props, ref) {
    const { className, required, disabled, ...rest } = props;
    return (
      <Select
        {...rest}
        ref={ref}
        isRequired={required}
        isDisabled={disabled}
        className={`text-input${className ? ` ${className}` : ''}`}
        minH="38px"
        bg="kn.surface"
        borderRadius="sm"
        size="sm"
      />
    );
  },
);

type KnowledgeTextAreaProps = Omit<TextareaProps, 'isDisabled' | 'isRequired'> & {
  required?: boolean;
  disabled?: boolean;
};

export const TextArea = forwardRef<HTMLTextAreaElement, KnowledgeTextAreaProps>(
  function TextArea(props, ref) {
    const { className, required, disabled, ...rest } = props;
    return (
      <Textarea
        {...rest}
        ref={ref}
        isRequired={required}
        isDisabled={disabled}
        className={`text-input text-area${className ? ` ${className}` : ''}`}
        minH="90px"
        resize="vertical"
        bg="kn.surface"
        borderRadius="sm"
        size="sm"
      />
    );
  },
);

export function StatusTag(props: {
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const { t } = useKnowledgeI18n();
  const tone = props.tone ?? 'neutral';
  const enumKey = enumMessageKey(props.value);
  const label = enumKey ? t(enumKey) : t(statusMessageKey(props.value), { value: props.value });
  const palette = {
    neutral: { color: 'kn.inkMuted', bg: 'kn.surface', borderColor: 'kn.line' },
    success: {
      color: 'kn.secondary',
      bg: 'kn.surface',
      borderColor: 'kn.secondary',
    },
    warning: {
      color: 'kn.ink',
      bg: 'kn.surface',
      borderColor: 'kn.warning',
    },
    danger: {
      color: 'kn.danger',
      bg: 'kn.surface',
      borderColor: 'kn.danger',
    },
  }[tone];

  return (
    <Badge
      variant="outline"
      display="inline-block"
      px="7px"
      py="2px"
      borderRadius="sm"
      fontSize="xs"
      textTransform="uppercase"
      whiteSpace="nowrap"
      {...palette}
    >
      {label}
    </Badge>
  );
}

export function LoadingState(props: { label?: string }) {
  const [visible, setVisible] = useState(false);
  const { t } = useKnowledgeI18n();

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) {
    return <Box role="status" aria-label={t('common.loading')} minH="48px" />;
  }

  return (
    <Stack role="status" className="loading-state" spacing={3} py={10} color="kn.inkMuted">
      <Skeleton height="2px" startColor="kn.primary" endColor="kn.surfaceMuted" />
      <Text m={0}>{props.label ?? t('common.loading')}</Text>
    </Stack>
  );
}

export function EmptyState(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <Box
      className="empty-state"
      py={9}
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="kn.line"
    >
      <Heading as="h3" m={0} fontSize="lg">
        {props.title}
      </Heading>
      <Text maxW="620px" mt={2} mb="18px" color="kn.inkMuted">
        {props.description}
      </Text>
      {props.action}
    </Box>
  );
}

export function ProblemNotice(props: { error: unknown; onRetry?: () => void }) {
  const { t } = useKnowledgeI18n();
  if (!props.error) return null;
  if (props.error instanceof KnowledgeRequestError) {
    const problem = toProblemView(props.error.problem);
    const message = t(problem.messageKey, problem.params);
    return (
      <Alert
        className="problem-notice"
        status="error"
        variant="left-accent"
        bg="color-mix(in srgb, var(--kn-danger) 10%, var(--kn-surface))"
        borderColor="kn.danger"
        alignItems="flex-start"
        borderRadius="sm"
        my="18px"
      >
        <AlertIcon mt={1} />
        <AlertDescription>
          <AlertTitle fontSize="sm">{problem.code}</AlertTitle>
          <Text mt={1}>{message}</Text>
          <Text mt={1} color="kn.inkMuted" fontSize="xs" overflowWrap="anywhere">
            {t('common.trace', { value: problem.traceId })} |{' '}
            {t('common.request', { value: problem.requestId })}
          </Text>
          <Text mt={1} color="kn.inkMuted" fontSize="xs">
            {problem.retryable ? t('common.retryable') : t('common.notRetryable')}
          </Text>
          {problem.retryable && props.onRetry ? (
            <Button mt={2} size="sm" type="button" onClick={props.onRetry}>
              {t('common.retry')}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert
      className="problem-notice"
      status="error"
      variant="left-accent"
      bg="color-mix(in srgb, var(--kn-danger) 10%, var(--kn-surface))"
      borderColor="kn.danger"
      alignItems="flex-start"
      borderRadius="sm"
      my="18px"
    >
      <AlertIcon mt={1} />
      <AlertDescription>
        <AlertTitle fontSize="sm">{t('common.requestFailed')}</AlertTitle>
        <Text mt={1}>{t('errors.unknown')}</Text>
      </AlertDescription>
    </Alert>
  );
}

export function FormBand(props: {
  title: string;
  description?: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <Box
      as="form"
      className="form-band"
      display="grid"
      gridTemplateColumns={{ base: '1fr', xl: 'minmax(180px, 0.7fr) minmax(280px, 1.6fr) auto' }}
      gap={6}
      py={5}
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="kn.line"
      onSubmit={props.onSubmit}
    >
      <Box className="form-intro">
        <Heading as="h2" m={0} fontSize="lg">
          {props.title}
        </Heading>
        {props.description ? (
          <Text mt="6px" mb={0} color="kn.inkMuted">
            {props.description}
          </Text>
        ) : null}
      </Box>
      <Box
        className="form-fields"
        display="grid"
        gridTemplateColumns={{ base: '1fr', md: 'repeat(2, minmax(0, 1fr))' }}
        gap="14px"
      >
        {props.children}
      </Box>
      <Flex className="form-actions" gap={2} align="center" wrap="wrap" justify="flex-start">
        <Button type="submit" tone="primary" busy={props.busy}>
          {props.submitLabel}
        </Button>
      </Flex>
    </Box>
  );
}
