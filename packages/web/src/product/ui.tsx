'use client';

import {
  AddIcon,
  AttachmentIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ExternalLinkIcon,
  InfoOutlineIcon,
  SearchIcon,
  TimeIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Box,
  Flex,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Portal,
  Spinner,
  Text,
  useToast,
} from '@chakra-ui/react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { productErrorView } from './api';
import { productTokens } from './tokens';

export {
  AddIcon,
  AttachmentIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ExternalLinkIcon,
  InfoOutlineIcon,
  SearchIcon,
  TimeIcon,
  WarningIcon,
};

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';

export const ProductButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: ButtonTone;
    size?: 'sm' | 'md' | 'lg';
    busy?: boolean;
  }
>(function ProductButton(
  { tone = 'secondary', size = 'md', busy = false, disabled, children, className, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? 'button'}
      className={`kb2-button kb2-button--${tone} kb2-button--${size}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size="xs" /> : null}
      {children}
    </button>
  );
});

export const ProductIconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    tone?: 'neutral' | 'danger';
    busy?: boolean;
  }
>(function ProductIconButton(
  { label, tone = 'neutral', busy, className, children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? 'button'}
      className={`kb2-icon-button kb2-icon-button--${tone}${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size="xs" /> : children}
    </button>
  );
});

export const ProductInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function ProductInput({ className, ...props }, ref) {
    return (
      <input {...props} ref={ref} className={`kb2-input${className ? ` ${className}` : ''}`} />
    );
  },
);

export const ProductTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function ProductTextarea({ className, ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={`kb2-input kb2-textarea${className ? ` ${className}` : ''}`}
    />
  );
});

export const ProductSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function ProductSelect({ className, ...props }, ref) {
    return (
      <select
        {...props}
        ref={ref}
        className={`kb2-input kb2-select${className ? ` ${className}` : ''}`}
      />
    );
  },
);

export function ProductField(props: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="kb2-field">
      <span className="kb2-field__label">{props.label}</span>
      {props.children}
      {props.error ? <span className="kb2-field__error">{props.error}</span> : null}
      {!props.error && props.hint ? <span className="kb2-field__hint">{props.hint}</span> : null}
    </label>
  );
}

export function StatusTag(props: {
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
  dot?: boolean;
}) {
  return (
    <span className={`kb2-status kb2-status--${props.tone ?? 'neutral'}`}>
      {props.dot ? <span className="kb2-status__dot" aria-hidden="true" /> : null}
      {props.value}
    </span>
  );
}

export function ProductError(props: { error: unknown; onRetry?: () => void }) {
  if (!props.error) return null;
  const view = productErrorView(props.error);
  return (
    <div className="kb2-error-panel" role="alert">
      <WarningIcon boxSize={4} />
      <div>
        <strong>{view.message}</strong>
        <span>
          {view.code}
          {view.requestId ? ` · 请求 ${view.requestId}` : ''}
          {view.traceId ? ` · Trace ${view.traceId}` : ''}
        </span>
      </div>
      {view.retryable && props.onRetry ? (
        <ProductButton size="sm" onClick={props.onRetry}>
          重试
        </ProductButton>
      ) : null}
    </div>
  );
}

export function ProductEmpty(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="kb2-empty">
      <div className="kb2-empty__icon">
        <AttachmentIcon boxSize={6} />
      </div>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
}

export function ProductSkeleton(props: { rows?: number }) {
  return (
    <div className="kb2-skeleton-grid" role="status" aria-label="正在加载知识库">
      {Array.from({ length: props.rows ?? 3 }, (_, index) => (
        <div className="kb2-skeleton-card" key={index}>
          <span className="kb2-skeleton kb2-skeleton--title" />
          <span className="kb2-skeleton kb2-skeleton--line" />
          <span className="kb2-skeleton kb2-skeleton--line kb2-skeleton--short" />
          <span className="kb2-skeleton kb2-skeleton--footer" />
        </div>
      ))}
    </div>
  );
}

export function ProductModal(props: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  finalFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Modal
      isOpen={props.open}
      onClose={props.onClose}
      isCentered
      size={props.size ?? 'md'}
      closeOnOverlayClick={false}
      motionPreset="scale"
      finalFocusRef={props.finalFocusRef}
      returnFocusOnClose={Boolean(props.finalFocusRef)}
    >
      <ModalOverlay bg="rgba(17,24,36,.36)" backdropFilter="blur(2px)" />
      <ModalContent className="kb2-modal" role="dialog" aria-modal="true">
        <ModalHeader>
          <div>
            <strong>{props.title}</strong>
            {props.description ? <span>{props.description}</span> : null}
          </div>
          <ProductIconButton label="关闭弹窗" onClick={props.onClose}>
            <CloseIcon boxSize={3.5} />
          </ProductIconButton>
        </ModalHeader>
        <ModalBody>{props.children}</ModalBody>
        {props.footer ? <ModalFooter>{props.footer}</ModalFooter> : null}
      </ModalContent>
    </Modal>
  );
}

export function ProductMenu(props: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  triggerElement?: HTMLElement | null;
  initialFocus?: 'first' | 'last';
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (!props.triggerElement || !menuRef.current) return;
    const anchor = props.triggerElement.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const minWidth = Math.min(240, window.innerWidth - margin * 2);
    const height = menu.height || 240;
    const width = Math.max(menu.width, minWidth);
    const canOpenBelow = anchor.bottom + 5 + height <= window.innerHeight - margin;
    const top = canOpenBelow ? anchor.bottom + 5 : Math.max(margin, anchor.top - height - 5);
    const left = Math.min(
      Math.max(margin, anchor.right - width),
      window.innerWidth - width - margin,
    );
    setPosition({ top, left, minWidth });
  }, [props.triggerElement]);
  const setMenuNode = useCallback(
    (element: HTMLDivElement | null) => {
      menuRef.current = element;
      if (element) {
        window.requestAnimationFrame(updatePosition);
      }
    },
    [updatePosition],
  );

  useEffect(() => {
    if (!props.open || !props.triggerElement) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [props.open, props.triggerElement, updatePosition]);

  useEffect(() => {
    if (!props.open || !props.initialFocus || !position) return;
    const frame = window.requestAnimationFrame(() => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
          [],
      );
      (props.initialFocus === 'last' ? items.at(-1) : items[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [position, props.initialFocus, props.open]);

  useEffect(() => {
    if (!props.open) return;
    const trigger = props.triggerElement;
    const previousHaspopup = trigger?.getAttribute('aria-haspopup');
    const previousControls = trigger?.getAttribute('aria-controls');
    if (trigger) {
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-controls', 'kb2-product-menu');
    }
    const close = (restoreFocus: boolean) => {
      props.onClose();
      if (restoreFocus) trigger?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
          [],
      );
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(currentIndex + 1 + items.length) % Math.max(items.length, 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(currentIndex - 1 + items.length) % Math.max(items.length, 1)]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (event.key === 'Tab') {
        close(false);
      }
    };
    const onViewportChange = () => updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      document.removeEventListener('pointerdown', onPointerDown);
      if (trigger) {
        if (previousHaspopup == null) trigger.removeAttribute('aria-haspopup');
        else trigger.setAttribute('aria-haspopup', previousHaspopup);
        if (previousControls == null) trigger.removeAttribute('aria-controls');
        else trigger.setAttribute('aria-controls', previousControls);
      }
    };
  }, [props.onClose, props.open, props.triggerElement]);

  if (!props.open) return null;
  const content = (
    <>
      {!props.triggerElement ? (
        <button
          className="kb2-menu-scrim"
          type="button"
          aria-label="关闭菜单"
          onClick={props.onClose}
        />
      ) : null}
      <div
        ref={setMenuNode}
        id="kb2-product-menu"
        className={`kb2-menu kb2-menu--${props.align ?? 'right'}${props.triggerElement ? ' is-fixed' : ''}`}
        role="menu"
        style={
          props.triggerElement
            ? {
                position: 'fixed',
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                minWidth: position?.minWidth,
                visibility: position ? 'visible' : 'hidden',
              }
            : undefined
        }
      >
        {props.children}
      </div>
    </>
  );
  return props.triggerElement ? <Portal>{content}</Portal> : content;
}

export function ProductMenuItem(props: {
  children: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  expanded?: boolean;
  hasPopup?: boolean;
  onMouseEnter?: () => void;
  onFocus?: () => void;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`kb2-menu-item${props.danger ? ' kb2-menu-item--danger' : ''}`}
      disabled={props.disabled}
      aria-expanded={props.expanded}
      aria-haspopup={props.hasPopup ? 'menu' : undefined}
      onMouseEnter={props.onMouseEnter}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      {props.icon ? <span className="kb2-menu-item__icon">{props.icon}</span> : null}
      <span>
        {props.children}
        {props.hint ? <small>{props.hint}</small> : null}
      </span>
    </button>
  );
}

export function useProductToast() {
  const toast = useToast();
  const render = (status: 'success' | 'warning' | 'error', title: string, description?: string) => (
    <Alert
      status={status}
      bg={productTokens.colors.ink}
      color={productTokens.colors.surface}
      borderRadius={productTokens.radius.panel}
    >
      <AlertIcon color={productTokens.colors.surface} />
      <Box flex="1">
        <AlertTitle>{title}</AlertTitle>
        {description ? <AlertDescription>{description}</AlertDescription> : null}
      </Box>
    </Alert>
  );
  return {
    success(title: string) {
      toast({
        duration: 3200,
        isClosable: true,
        position: 'top',
        render: () => render('success', title),
      });
    },
    warning(title: string) {
      toast({
        duration: 4500,
        isClosable: true,
        position: 'top',
        render: () => render('warning', title),
      });
    },
    error(error: unknown) {
      const view = productErrorView(error);
      toast({
        duration: 5200,
        isClosable: true,
        position: 'top',
        render: () => render('error', view.message, view.code),
      });
    },
  };
}

export function ProductPage(props: { children: ReactNode; className?: string }) {
  return (
    <div className={`kb2-page${props.className ? ` ${props.className}` : ''}`}>
      {props.children}
    </div>
  );
}

export function ProductPageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="kb2-page-header">
      <div className="kb2-page-header__main">
        {props.breadcrumbs ? <div className="kb2-breadcrumbs">{props.breadcrumbs}</div> : null}
        <h1>{props.title}</h1>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.actions ? <div className="kb2-page-header__actions">{props.actions}</div> : null}
    </header>
  );
}

export function ProductToolbar(props: { children: ReactNode; summary?: ReactNode }) {
  return (
    <div className="kb2-toolbar">
      <div className="kb2-toolbar__summary">{props.summary}</div>
      <div className="kb2-toolbar__controls">{props.children}</div>
    </div>
  );
}

export function ProductSearchBox(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength?: number;
}) {
  return (
    <label className="kb2-search">
      <SearchIcon boxSize={4} />
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        aria-label={props.placeholder}
      />
    </label>
  );
}

export function ProductCheckbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="kb2-checkbox" title={props.disabled ? props.label : undefined}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        aria-label={props.label}
      />
      <span />
    </label>
  );
}

export function ProductStat(props: { label: string; value: ReactNode }) {
  return (
    <div className="kb2-stat">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

export function ProductTypeIcon(props: {
  kind: 'folder' | 'general' | 'api' | 'feishu' | 'yuque' | 'dingtalk';
}) {
  const icon =
    props.kind === 'folder' ? (
      <AttachmentIcon />
    ) : props.kind === 'general' ? (
      <CopyIcon />
    ) : (
      <ExternalLinkIcon />
    );
  return <span className={`kb2-type-icon kb2-type-icon--${props.kind}`}>{icon}</span>;
}

export function formatDate(value?: string) {
  if (!value) return '后端未提供';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatBytes(value?: number) {
  if (value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function productTypeOf(iconKey?: string): {
  kind: 'folder' | 'general' | 'api' | 'feishu' | 'yuque' | 'dingtalk';
  label: string;
} {
  const key = iconKey ?? '';
  if (key === 'folder') return { kind: 'folder', label: '文件夹' };
  if (key.includes('api')) return { kind: 'api', label: 'API 文件库' };
  if (key.includes('feishu')) return { kind: 'feishu', label: '飞书知识库' };
  if (key.includes('yuque')) return { kind: 'yuque', label: '语雀知识库' };
  if (key.includes('dingtalk')) return { kind: 'dingtalk', label: '钉钉知识库' };
  return { kind: 'general', label: '通用知识库' };
}

export function ProductText(props: { children: ReactNode; className?: string }) {
  return <Text className={props.className}>{props.children}</Text>;
}

export function ProductFlex(props: { children: ReactNode; className?: string }) {
  return <Flex className={props.className}>{props.children}</Flex>;
}

export function ProductBox(props: { children: ReactNode; className?: string }) {
  return <Box className={props.className}>{props.children}</Box>;
}
