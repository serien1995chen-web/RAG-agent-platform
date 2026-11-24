'use client';

import { ChevronDownIcon, SearchIcon } from '@chakra-ui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Model } from './types';

export function ModelSelect(props: {
  label: string;
  models: Model[];
  value: string;
  onChange: (modelId: string) => void;
  required?: boolean;
  unsetLabel?: string;
  twoColumn?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const selected = props.models.find((model) => model.modelId === props.value);
  const providers = useMemo(
    () => [...new Set(props.models.map((model) => model.provider || 'Other'))].sort(),
    [props.models],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return props.models.filter(
      (model) =>
        (!props.twoColumn || !provider || (model.provider || 'Other') === provider) &&
        (!needle ||
          model.displayName.toLocaleLowerCase().includes(needle) ||
          model.modelId.toLocaleLowerCase().includes(needle)),
    );
  }, [props.models, props.twoColumn, provider, query]);

  useEffect(() => {
    if (!open) return;
    setProvider((current) => current || selected?.provider || providers[0] || '');
    const timer = setTimeout(() => {
      const selectedIndex = filtered.findIndex((model) => model.modelId === props.value);
      optionRefs.current[Math.max(selectedIndex, 0)]?.focus();
    }, 20);
    return () => clearTimeout(timer);
  }, [filtered, open, props.value, providers, selected?.provider]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (modelId: string) => {
    props.onChange(modelId);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="kb2-model-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="kb2-model-select__trigger"
        aria-label={`${props.label} ${selected?.displayName ?? props.unsetLabel ?? '请选择模型'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={selected ? '' : 'kb2-model-select__placeholder'}>
          {selected?.displayName ?? props.unsetLabel ?? '请选择模型'}
        </span>
        {props.required ? <span className="kb2-required">*</span> : null}
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="kb2-model-popover">
          <label className="kb2-model-search">
            <SearchIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setOpen(false);
                  triggerRef.current?.focus();
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  optionRefs.current[0]?.focus();
                }
              }}
            />
          </label>
          <div className={`kb2-model-popover__body${props.twoColumn ? ' is-two-column' : ''}`}>
            {props.twoColumn ? (
              <div className="kb2-model-providers" role="tablist" aria-label={`${props.label}厂商`}>
                {providers.map((item) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={provider === item}
                    className={provider === item ? 'is-selected' : ''}
                    key={item}
                    onClick={() => setProvider(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="kb2-model-options" role="listbox" aria-label={props.label}>
              {props.unsetLabel ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={!props.value}
                  className={!props.value ? 'is-selected' : ''}
                  onClick={() => choose('')}
                >
                  <strong>{props.unsetLabel}</strong>
                </button>
              ) : null}
              {filtered.map((model, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={props.value === model.modelId}
                  className={props.value === model.modelId ? 'is-selected' : ''}
                  key={model.modelId}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  onClick={() => choose(model.modelId)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      optionRefs.current[index + 1]?.focus();
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      if (index === 0) triggerRef.current?.focus();
                      else optionRefs.current[index - 1]?.focus();
                    }
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      setOpen(false);
                      triggerRef.current?.focus();
                    }
                  }}
                >
                  <span>
                    <strong>{model.displayName}</strong>
                    <small>{model.modelId}</small>
                  </span>
                  <span className="kb2-model-tags">
                    {model.capabilities.includes('vision') ? <i>多模态</i> : null}
                    {model.tags.map((tag) => (
                      <i key={tag}>
                        {tag === 'beta' ? 'Beta' : tag === 'deprecated' ? '即将下架' : tag}
                      </i>
                    ))}
                  </span>
                </button>
              ))}
              {filtered.length === 0 ? <p className="kb2-model-empty">没有匹配模型</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
